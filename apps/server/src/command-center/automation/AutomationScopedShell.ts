// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeProcess from "node:process";

import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { resolveCommandCenterManagedGitMetadata } from "../../provider/security/CommandCenterProviderIsolation.ts";
import { unsafeHostGitConfigKey } from "../../vcs/HostGitSecurity.ts";
import * as CommandCenterConfig from "../Config.ts";
import { canonicalJson } from "./Digest.ts";
import {
  VerifiedLinuxScopedShell,
  type VerifiedScopedShellExecutionResult,
} from "./VerifiedScopedShell.ts";

export const AUTOMATION_SCOPED_SHELL_MANIFEST_FILE = "scoped-shell-allowlist.json";
export const AUTOMATION_SCOPED_SHELL_MANIFEST_VERSION = 1 as const;

const MAX_MANIFEST_BYTES = FileSystem.Size(1024 * 1024);
const MAX_LOCAL_GIT_CONFIG_BYTES = FileSystem.Size(1024 * 1024);
const MAX_MANIFEST_ENTRIES = 256;
const ALLOWLIST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const NonEmptyString = Schema.String.check(Schema.isNonEmpty());
const Access = Schema.Literals(["read", "write"]);
const AllowedRoot = Schema.Struct({
  canonicalPath: NonEmptyString,
  access: Access,
});
const ManifestEntry = Schema.Struct({
  allowlistId: NonEmptyString,
  spaceId: NonEmptyString,
  repositoryId: NonEmptyString,
  executable: NonEmptyString,
  argv: Schema.Array(Schema.String),
  access: Access,
  cwd: NonEmptyString,
  timeoutMs: Schema.Int,
  stdoutMaxBytes: Schema.Int,
  stderrMaxBytes: Schema.Int,
  retryable: Schema.Boolean,
  idempotent: Schema.Boolean,
  allowedRoots: Schema.Array(AllowedRoot),
});
const Manifest = Schema.Struct({
  schemaVersion: Schema.Literal(AUTOMATION_SCOPED_SHELL_MANIFEST_VERSION),
  entries: Schema.Array(ManifestEntry),
});
type Manifest = typeof Manifest.Type;
type ManifestEntry = typeof ManifestEntry.Type;
type LoadedCommandCenterConfigSpace =
  CommandCenterConfig.LoadedCommandCenterConfig["spaces"][number];

const decodeJson = Schema.decodeUnknownExit(Schema.UnknownFromJsonString);
const decodeManifest = Schema.decodeUnknownExit(Manifest);

export const AutomationScopedShellErrorCode = Schema.Literals([
  "manifest-unavailable",
  "manifest-untrusted",
  "manifest-invalid",
  "allowlist-missing",
  "scope-denied",
  "policy-drift",
  "execution-failed",
]);
export type AutomationScopedShellErrorCode = typeof AutomationScopedShellErrorCode.Type;

export class AutomationScopedShellError extends Schema.TaggedErrorClass<AutomationScopedShellError>()(
  "AutomationScopedShellError",
  {
    code: AutomationScopedShellErrorCode,
    issue: Schema.String,
    retryable: Schema.Boolean,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.issue;
  }
}

export interface AutomationScopedShellRequest {
  readonly executionId: string;
  readonly nodeId: string;
  readonly spaceId: string;
  readonly allowlistId: string;
}

export interface AutomationScopedShellResult extends VerifiedScopedShellExecutionResult {
  readonly spaceId: string;
  readonly repositoryId: string;
  readonly access: "read" | "write";
  readonly policyDigest: string;
}

export class AutomationScopedShell extends Context.Service<
  AutomationScopedShell,
  {
    readonly execute: (
      input: AutomationScopedShellRequest,
    ) => Effect.Effect<AutomationScopedShellResult, AutomationScopedShellError>;
  }
>()("t3/command-center/automation/AutomationScopedShell") {}

interface SecureFileIdentity {
  readonly type: FileSystem.File.Type;
  readonly dev: number;
  readonly ino: number | undefined;
  readonly mode: number;
  readonly nlink: number | undefined;
  readonly uid: number | undefined;
  readonly size: string;
  readonly mtimeMs: number | undefined;
}

const error = (
  code: AutomationScopedShellErrorCode,
  issue: string,
  options: { readonly retryable?: boolean; readonly cause?: unknown } = {},
) =>
  new AutomationScopedShellError({
    code,
    issue,
    retryable: options.retryable ?? false,
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  });

function secureIdentity(info: FileSystem.File.Info): SecureFileIdentity {
  return {
    type: info.type,
    dev: info.dev,
    ino: Option.getOrUndefined(info.ino),
    mode: info.mode,
    nlink: Option.getOrUndefined(info.nlink),
    uid: Option.getOrUndefined(info.uid),
    size: String(info.size),
    mtimeMs: Option.getOrUndefined(Option.map(info.mtime, (value) => value.getTime())),
  };
}

function sameSecureIdentity(left: SecureFileIdentity, right: SecureFileIdentity): boolean {
  return (
    left.type === right.type &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unsupportedKey(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): string | undefined {
  return Object.keys(value)
    .filter((key) => !allowed.has(key))
    .sort()[0];
}

const MANIFEST_KEYS = new Set(["schemaVersion", "entries"]);
const ENTRY_KEYS = new Set([
  "allowlistId",
  "spaceId",
  "repositoryId",
  "executable",
  "argv",
  "access",
  "cwd",
  "timeoutMs",
  "stdoutMaxBytes",
  "stderrMaxBytes",
  "retryable",
  "idempotent",
  "allowedRoots",
]);
const ROOT_KEYS = new Set(["canonicalPath", "access"]);

/** Reject unknown policy fields instead of silently accepting future authority. */
function exactShapeIssue(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  const manifestKey = unsupportedKey(value, MANIFEST_KEYS);
  if (manifestKey !== undefined) return `Manifest contains unsupported field '${manifestKey}'.`;
  if (!Array.isArray(value.entries)) return undefined;
  for (const [entryIndex, candidate] of value.entries.entries()) {
    if (!isObject(candidate)) continue;
    const entryKey = unsupportedKey(candidate, ENTRY_KEYS);
    if (entryKey !== undefined) {
      return `Manifest entry ${entryIndex} contains unsupported field '${entryKey}'.`;
    }
    if (!Array.isArray(candidate.allowedRoots)) continue;
    for (const [rootIndex, root] of candidate.allowedRoots.entries()) {
      if (!isObject(root)) continue;
      const rootKey = unsupportedKey(root, ROOT_KEYS);
      if (rootKey !== undefined) {
        return `Manifest entry ${entryIndex} root ${rootIndex} contains unsupported field '${rootKey}'.`;
      }
    }
  }
  return undefined;
}

function validateManifest(manifest: Manifest): string | undefined {
  if (manifest.entries.length > MAX_MANIFEST_ENTRIES) {
    return `Manifest exceeds the ${MAX_MANIFEST_ENTRIES}-entry safety limit.`;
  }
  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    if (
      !ALLOWLIST_ID_PATTERN.test(entry.allowlistId) ||
      entry.allowlistId !== entry.allowlistId.trim()
    ) {
      return "Manifest contains a malformed allowlist id.";
    }
    if (entry.spaceId !== entry.spaceId.trim() || entry.spaceId.length > 256) {
      return `Manifest entry '${entry.allowlistId}' has a malformed Space binding.`;
    }
    if (entry.repositoryId !== entry.repositoryId.trim() || entry.repositoryId.length > 256) {
      return `Manifest entry '${entry.allowlistId}' has a malformed repository binding.`;
    }
    if (seen.has(entry.allowlistId)) {
      return `Manifest contains duplicate allowlist id '${entry.allowlistId}'.`;
    }
    seen.add(entry.allowlistId);
    if (entry.allowedRoots.length < 1 || entry.allowedRoots.length > 32) {
      return `Manifest entry '${entry.allowlistId}' must contain between 1 and 32 roots.`;
    }
    if (!entry.idempotent) {
      return `Manifest entry '${entry.allowlistId}' must be idempotent in v1.`;
    }
  }
  return undefined;
}

/** Stable across attempts; the private manifest never supplies an idempotency key. */
export function automationScopedShellIdempotencyKey(input: {
  readonly executionId: string;
  readonly nodeId: string;
}): string {
  const digest = NodeCrypto.createHash("sha256")
    .update(input.executionId, "utf8")
    .update("\0", "utf8")
    .update(input.nodeId, "utf8")
    .digest("hex");
  return `automation-shell:${digest}`;
}

function canonicalManifestEntryDigest(entry: ManifestEntry): string {
  const digest = NodeCrypto.createHash("sha256")
    .update(canonicalJson(entry as unknown as Schema.Json), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

function isProvisionableRepositoryRemote(remoteRef: string): boolean {
  const trimmed = remoteRef.trim();
  if (
    trimmed.length === 0 ||
    trimmed !== remoteRef ||
    /[\r\n]/u.test(trimmed) ||
    trimmed.includes("\0")
  ) {
    return false;
  }
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/u.test(trimmed)) {
    const repositoryPath = trimmed.slice(trimmed.indexOf(":") + 1);
    return !repositoryPath.split("/").includes("..");
  }
  try {
    const remote = new URL(trimmed);
    if (remote.hostname.length === 0 || remote.password.length > 0) return false;
    if (remote.search.length > 0 || remote.hash.length > 0) return false;
    if (remote.protocol === "https:") {
      return remote.username.length === 0 && remote.pathname.replace(/^\/+|\/+$/gu, "").length > 0;
    }
    return remote.protocol === "ssh:" && remote.pathname.replace(/^\/+|\/+$/gu, "").length > 0;
  } catch {
    return false;
  }
}

export function automationScopedShellRepositoryDigest(input: {
  readonly spaceId: string;
  readonly repositoryId: string;
  readonly canonicalRemote: string;
}): string {
  return NodeCrypto.createHash("sha256")
    .update(input.spaceId, "utf8")
    .update("\0", "utf8")
    .update(input.repositoryId, "utf8")
    .update("\0", "utf8")
    .update(input.canonicalRemote, "utf8")
    .digest("hex");
}

export const makeAutomationScopedShell = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const commandCenterConfig = yield* CommandCenterConfig.CommandCenterConfig;
  const repositoryIdentityResolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const verifiedShell = yield* VerifiedLinuxScopedShell;

  const loadManifest = Effect.fn("AutomationScopedShell.loadManifest")(function* () {
    const effectiveUid = NodeProcess.geteuid?.();
    if (effectiveUid === undefined) {
      return yield* error(
        "manifest-untrusted",
        "Scoped-shell policy ownership cannot be verified on this platform.",
      );
    }
    if (
      !path.isAbsolute(serverConfig.secretsDir) ||
      path.resolve(serverConfig.secretsDir) !== serverConfig.secretsDir
    ) {
      return yield* error(
        "manifest-untrusted",
        "The configured secrets directory is not an exact absolute path.",
      );
    }
    const canonicalSecrets = yield* fs.realPath(serverConfig.secretsDir).pipe(
      Effect.mapError((cause) =>
        error("manifest-unavailable", "The scoped-shell secrets directory is unavailable.", {
          cause,
        }),
      ),
    );
    if (canonicalSecrets !== serverConfig.secretsDir) {
      return yield* error(
        "manifest-untrusted",
        "The scoped-shell secrets directory must not contain symlinks.",
      );
    }
    const directoryInfo = yield* fs.stat(canonicalSecrets).pipe(
      Effect.mapError((cause) =>
        error("manifest-unavailable", "The scoped-shell secrets directory cannot be inspected.", {
          cause,
        }),
      ),
    );
    if (
      directoryInfo.type !== "Directory" ||
      Option.getOrUndefined(directoryInfo.uid) !== effectiveUid ||
      (directoryInfo.mode & 0o077) !== 0
    ) {
      return yield* error(
        "manifest-untrusted",
        "The scoped-shell secrets directory must be owner-only and owned by the server user.",
      );
    }

    const manifestPath = path.join(canonicalSecrets, AUTOMATION_SCOPED_SHELL_MANIFEST_FILE);
    const canonicalManifest = yield* fs.realPath(manifestPath).pipe(
      Effect.mapError((cause) =>
        error("manifest-unavailable", "The scoped-shell allowlist manifest is unavailable.", {
          cause,
        }),
      ),
    );
    if (canonicalManifest !== manifestPath) {
      return yield* error(
        "manifest-untrusted",
        "The scoped-shell allowlist manifest must be a non-symlink file.",
      );
    }
    const before = yield* fs.stat(canonicalManifest).pipe(
      Effect.mapError((cause) =>
        error("manifest-unavailable", "The scoped-shell allowlist manifest cannot be inspected.", {
          cause,
        }),
      ),
    );
    if (
      before.type !== "File" ||
      Option.getOrUndefined(before.uid) !== effectiveUid ||
      (before.mode & 0o077) !== 0 ||
      (before.mode & 0o400) === 0 ||
      before.size > MAX_MANIFEST_BYTES
    ) {
      return yield* error(
        "manifest-untrusted",
        "The scoped-shell allowlist manifest must be a bounded owner-readable, owner-only regular file.",
      );
    }
    const expectedIdentity = secureIdentity(before);
    const contents = yield* fs.readFileString(canonicalManifest).pipe(
      Effect.mapError((cause) =>
        error("manifest-unavailable", "The scoped-shell allowlist manifest cannot be read.", {
          cause,
        }),
      ),
    );
    const [after, canonicalAfter] = yield* Effect.all([
      fs.stat(canonicalManifest),
      fs.realPath(canonicalManifest),
    ]).pipe(
      Effect.mapError((cause) =>
        error("manifest-untrusted", "The scoped-shell allowlist manifest changed while read.", {
          cause,
        }),
      ),
    );
    if (
      canonicalAfter !== canonicalManifest ||
      !sameSecureIdentity(expectedIdentity, secureIdentity(after))
    ) {
      return yield* error(
        "manifest-untrusted",
        "The scoped-shell allowlist manifest changed while read.",
      );
    }

    const parsed = decodeJson(contents);
    if (Exit.isFailure(parsed)) {
      return yield* error("manifest-invalid", "The scoped-shell allowlist is not valid JSON.", {
        cause: parsed.cause,
      });
    }
    const shapeIssue = exactShapeIssue(parsed.value);
    if (shapeIssue !== undefined) return yield* error("manifest-invalid", shapeIssue);
    const decoded = decodeManifest(parsed.value);
    if (Exit.isFailure(decoded)) {
      return yield* error(
        "manifest-invalid",
        "The scoped-shell allowlist does not match schema version 1.",
        { cause: decoded.cause },
      );
    }
    const issue = validateManifest(decoded.value);
    if (issue !== undefined) return yield* error("manifest-invalid", issue);
    return decoded.value;
  });

  const canonicalBoundPath = Effect.fn("AutomationScopedShell.canonicalBoundPath")(function* (
    target: string,
    description: string,
  ) {
    if (!path.isAbsolute(target) || path.resolve(target) !== target) {
      return yield* error(
        "scope-denied",
        `The scoped-shell ${description} must be an exact absolute path.`,
      );
    }
    const canonical = yield* fs.realPath(target).pipe(
      Effect.mapError((cause) =>
        error("scope-denied", `The scoped-shell ${description} cannot be canonicalized.`, {
          cause,
        }),
      ),
    );
    if (canonical !== target) {
      return yield* error(
        "scope-denied",
        `The scoped-shell ${description} must not contain symlinks.`,
      );
    }
    return canonical;
  });

  const inspectLocalGitConfig = Effect.fn("AutomationScopedShell.inspectLocalGitConfig")(
    function* (input: {
      readonly configPath: string;
      readonly description: string;
      readonly required: boolean;
    }) {
      const canonical = yield* fs.realPath(input.configPath).pipe(
        Effect.map(Option.some),
        Effect.catchTags({
          PlatformError: (cause) =>
            cause.reason._tag === "NotFound"
              ? Effect.succeed(Option.none())
              : Effect.fail(
                  error(
                    "scope-denied",
                    `The scoped-shell ${input.description} cannot be canonicalized.`,
                    { cause },
                  ),
                ),
        }),
      );
      if (Option.isNone(canonical)) {
        if (!input.required) return;
        return yield* error(
          "scope-denied",
          `The scoped-shell ${input.description} is unavailable.`,
        );
      }
      if (canonical.value !== input.configPath) {
        return yield* error(
          "scope-denied",
          `The scoped-shell ${input.description} must not be a symlink.`,
        );
      }
      const before = yield* fs.stat(canonical.value).pipe(
        Effect.mapError((cause) =>
          error("scope-denied", `The scoped-shell ${input.description} cannot be inspected.`, {
            cause,
          }),
        ),
      );
      if (
        before.type !== "File" ||
        Option.getOrUndefined(before.nlink) !== 1 ||
        before.size > MAX_LOCAL_GIT_CONFIG_BYTES
      ) {
        return yield* error(
          "scope-denied",
          `The scoped-shell ${input.description} must be a bounded single-link regular file.`,
        );
      }
      const expectedIdentity = secureIdentity(before);
      const contents = yield* fs.readFileString(canonical.value).pipe(
        Effect.mapError((cause) =>
          error("scope-denied", `The scoped-shell ${input.description} cannot be read.`, {
            cause,
          }),
        ),
      );
      const [after, canonicalAfter] = yield* Effect.all([
        fs.stat(canonical.value),
        fs.realPath(canonical.value),
      ]).pipe(
        Effect.mapError((cause) =>
          error("scope-denied", `The scoped-shell ${input.description} changed while read.`, {
            cause,
          }),
        ),
      );
      if (
        canonicalAfter !== canonical.value ||
        !sameSecureIdentity(expectedIdentity, secureIdentity(after))
      ) {
        return yield* error(
          "scope-denied",
          `The scoped-shell ${input.description} changed while read.`,
        );
      }
      const unsafeKey = unsafeHostGitConfigKey(contents);
      if (unsafeKey === "<malformed>") {
        return yield* error(
          "scope-denied",
          `The scoped-shell ${input.description} does not have a safely inspectable format.`,
        );
      }
      if (unsafeKey !== undefined) {
        return yield* error(
          "scope-denied",
          `The scoped-shell ${input.description} contains executable callback or include key '${unsafeKey}'.`,
        );
      }
    },
  );

  const inspectWritableGitConfiguration = Effect.fn(
    "AutomationScopedShell.inspectWritableGitConfiguration",
  )(function* (metadata: { readonly commonGitDir: string; readonly worktreeGitDir: string }) {
    yield* inspectLocalGitConfig({
      configPath: path.join(metadata.commonGitDir, "config"),
      description: "managed common Git configuration",
      required: true,
    });
    yield* inspectLocalGitConfig({
      configPath: path.join(metadata.worktreeGitDir, "config.worktree"),
      description: "managed worktree Git configuration",
      required: false,
    });
  });

  const resolveRepositoryScope = Effect.fn("AutomationScopedShell.resolveRepositoryScope")(
    function* (entry: ManifestEntry, boundSpace: LoadedCommandCenterConfigSpace) {
      const repository = boundSpace.repositories.find(
        (candidate) => String(candidate.id) === entry.repositoryId,
      );
      if (
        repository === undefined ||
        repository.remoteRef === undefined ||
        !isProvisionableRepositoryRemote(repository.remoteRef)
      ) {
        return yield* error(
          "scope-denied",
          "The scoped-shell repository binding is not provisionable from private configuration.",
        );
      }
      const canonicalRemote = normalizeGitRemoteUrl(repository.remoteRef);
      if (canonicalRemote.length === 0) {
        return yield* error(
          "scope-denied",
          "The scoped-shell repository binding has no canonical identity.",
        );
      }

      const canonicalBaseDir = yield* canonicalBoundPath(
        serverConfig.baseDir,
        "runtime base directory",
      );
      const canonicalRepositoriesDir = yield* canonicalBoundPath(
        path.join(canonicalBaseDir, "repositories"),
        "managed repository directory",
      );
      const repositoryDigest = automationScopedShellRepositoryDigest({
        spaceId: entry.spaceId,
        repositoryId: entry.repositoryId,
        canonicalRemote,
      });
      const canonicalRepositoryRoot = yield* canonicalBoundPath(
        path.join(canonicalRepositoriesDir, repositoryDigest.slice(0, 40)),
        "managed repository checkout",
      );
      const identity = yield* repositoryIdentityResolver.resolve(canonicalRepositoryRoot);
      const canonicalIdentityRoot =
        identity?.rootPath === undefined
          ? undefined
          : yield* canonicalBoundPath(identity.rootPath, "repository identity root");
      if (
        identity === null ||
        identity.canonicalKey !== canonicalRemote ||
        canonicalIdentityRoot !== canonicalRepositoryRoot
      ) {
        return yield* error(
          "scope-denied",
          "The scoped-shell managed checkout does not match its configured repository identity.",
        );
      }

      const canonicalCwd = yield* canonicalBoundPath(entry.cwd, "working directory");
      let gitMetadata:
        | {
            readonly dotGitPath: string;
            readonly commonGitDir: string;
          }
        | undefined;
      if (canonicalCwd !== canonicalRepositoryRoot) {
        const metadata = yield* resolveCommandCenterManagedGitMetadata({
          baseDir: canonicalBaseDir,
          worktreesDir: serverConfig.worktreesDir,
          cwd: canonicalCwd,
          fileSystem: fs,
          path,
        }).pipe(
          Effect.mapError((cause) =>
            error("scope-denied", `The scoped-shell worktree binding is invalid: ${cause.issue}`, {
              cause,
            }),
          ),
        );
        if (
          metadata === undefined ||
          metadata.commonGitDir !== path.join(canonicalRepositoryRoot, ".git")
        ) {
          return yield* error(
            "scope-denied",
            "The scoped-shell working directory is not bound to the selected repository.",
          );
        }
        if (entry.access === "write") {
          yield* inspectWritableGitConfiguration(metadata);
        }
        gitMetadata = {
          dotGitPath: metadata.dotGitPath,
          commonGitDir: metadata.commonGitDir,
        };
      } else if (entry.access === "write") {
        return yield* error(
          "scope-denied",
          "Writable scoped-shell commands require a disposable managed worktree; the primary checkout is read-only.",
        );
      }

      const canonicalAllowedRoots = yield* Effect.forEach(
        entry.allowedRoots,
        (root) => canonicalBoundPath(root.canonicalPath, "allowed root"),
        { concurrency: "unbounded" },
      );
      if (
        canonicalAllowedRoots.some(
          (root) => root !== canonicalCwd && root !== canonicalRepositoryRoot,
        )
      ) {
        return yield* error(
          "scope-denied",
          "Scoped-shell roots must be the exact managed checkout or its bound worktree.",
        );
      }
      if (
        entry.access === "write" &&
        entry.allowedRoots.some(
          (root, index) => root.access === "write" && canonicalAllowedRoots[index] !== canonicalCwd,
        )
      ) {
        return yield* error(
          "scope-denied",
          "Writable scoped-shell roots must be the exact disposable managed worktree.",
        );
      }
      return { canonicalCwd, canonicalAllowedRoots, gitMetadata };
    },
  );

  const pinPolicyDigest = Effect.fn("AutomationScopedShell.pinPolicyDigest")(function* (
    input: AutomationScopedShellRequest,
    policyDigest: string,
  ) {
    const pinned = yield* sql<{ readonly policyDigest: string }>`
      UPDATE command_center_automation_node_checkpoints
      SET scoped_shell_policy_digest = COALESCE(scoped_shell_policy_digest, ${policyDigest})
      WHERE execution_id = ${input.executionId} AND node_id = ${input.nodeId}
        AND node_kind = 'shell.scoped' AND state = 'running'
        AND (
          scoped_shell_policy_digest IS NULL OR scoped_shell_policy_digest = ${policyDigest}
        )
        AND EXISTS (
          SELECT 1 FROM command_center_automation_executions execution
          WHERE execution.id = ${input.executionId}
            AND execution.space_id = ${input.spaceId}
            AND execution.state = 'running'
        )
      RETURNING scoped_shell_policy_digest AS "policyDigest"
    `.pipe(
      Effect.mapError((cause) =>
        error("execution-failed", "The scoped-shell policy digest could not be pinned.", {
          cause,
        }),
      ),
    );
    if (pinned[0]?.policyDigest === policyDigest) return;

    const existing = yield* sql<{ readonly policyDigest: string | null }>`
      SELECT scoped_shell_policy_digest AS "policyDigest"
      FROM command_center_automation_node_checkpoints
      WHERE execution_id = ${input.executionId} AND node_id = ${input.nodeId}
        AND node_kind = 'shell.scoped' AND state = 'running'
        AND EXISTS (
          SELECT 1 FROM command_center_automation_executions execution
          WHERE execution.id = ${input.executionId}
            AND execution.space_id = ${input.spaceId}
            AND execution.state = 'running'
        )
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        error("execution-failed", "The scoped-shell policy checkpoint could not be inspected.", {
          cause,
        }),
      ),
    );
    if (existing[0] === undefined) {
      return yield* error(
        "scope-denied",
        "The scoped-shell request is not backed by its durable automation checkpoint.",
      );
    }
    return yield* error(
      "policy-drift",
      "The scoped-shell allowlist entry changed after execution was first admitted.",
    );
  });

  const execute: AutomationScopedShell["Service"]["execute"] = (input) =>
    Effect.gen(function* () {
      if (
        !ALLOWLIST_ID_PATTERN.test(input.allowlistId) ||
        input.executionId.length < 1 ||
        input.executionId.length > 256 ||
        input.nodeId.length < 1 ||
        input.nodeId.length > 256
      ) {
        return yield* error(
          "manifest-invalid",
          "Scoped-shell execution identifiers are malformed.",
        );
      }
      const manifest = yield* loadManifest();
      const entry = manifest.entries.find(
        (candidate) => candidate.allowlistId === input.allowlistId,
      );
      if (entry === undefined) {
        return yield* error(
          "allowlist-missing",
          `Scoped-shell allowlist id '${input.allowlistId}' is not configured.`,
        );
      }
      if (entry.spaceId !== input.spaceId) {
        return yield* error(
          "scope-denied",
          "The scoped-shell allowlist entry is not bound to this automation Space.",
        );
      }
      const loadedConfig = yield* commandCenterConfig.load;
      if (loadedConfig.health.status !== "loaded") {
        return yield* error(
          "scope-denied",
          "Private Command Center configuration is unavailable for scoped-shell binding.",
        );
      }
      const boundSpace = loadedConfig.spaces.find((space) => String(space.id) === entry.spaceId);
      if (boundSpace === undefined) {
        return yield* error(
          "scope-denied",
          "The scoped-shell Space or repository binding is not present in private configuration.",
        );
      }

      const repositoryScope = yield* resolveRepositoryScope(entry, boundSpace);
      const policyDigest = canonicalManifestEntryDigest(entry);
      // This compare-and-set commits the exact effective manifest entry before
      // any process starts. A crash may re-enter only the same idempotent policy;
      // manifest drift is terminal and cannot silently change replay authority.
      yield* pinPolicyDigest(input, policyDigest);
      const idempotencyKey = automationScopedShellIdempotencyKey(input);
      const result = yield* verifiedShell
        .execute({
          policy: {
            allowlistId: entry.allowlistId,
            executable: entry.executable,
            argv: entry.argv,
            access: entry.access,
            cwd: repositoryScope.canonicalCwd,
            timeoutMs: entry.timeoutMs,
            stdoutMaxBytes: entry.stdoutMaxBytes,
            stderrMaxBytes: entry.stderrMaxBytes,
            retryable: entry.retryable,
            idempotent: entry.idempotent,
            idempotencyKey,
          },
          runtime: {
            allowedRoots: entry.allowedRoots.map((root, index) => ({
              ...root,
              canonicalPath: repositoryScope.canonicalAllowedRoots[index]!,
            })),
            ...(repositoryScope.gitMetadata === undefined
              ? {}
              : { gitMetadata: repositoryScope.gitMetadata }),
          },
        })
        .pipe(
          Effect.mapError((cause) =>
            error("execution-failed", cause.message, {
              cause,
              retryable:
                entry.retryable &&
                entry.idempotent &&
                ["spawn-failed", "output-failed", "timeout"].includes(cause.code),
            }),
          ),
        );
      return {
        ...result,
        spaceId: entry.spaceId,
        repositoryId: entry.repositoryId,
        access: entry.access,
        policyDigest,
      };
    });

  return AutomationScopedShell.of({ execute });
});

export const AutomationScopedShellLayer = Layer.effect(
  AutomationScopedShell,
  makeAutomationScopedShell,
);
