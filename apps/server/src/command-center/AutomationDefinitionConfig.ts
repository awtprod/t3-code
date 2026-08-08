import { AutomationId } from "@command-center/core";
import {
  CommandCenterAutomationSourceDefinition,
  CommandCenterError,
  type CommandCenterAutomationAuthoringHealth,
  type CommandCenterAutomationDefinitionCreateInput as CommandCenterAutomationDefinitionCreateInputType,
  type CommandCenterAutomationDefinitionGetInput,
  type CommandCenterAutomationDefinitionSaveInput,
  type CommandCenterAutomationDefinitionSnapshot,
  type CommandCenterAutomationSourceDefinition as CommandCenterAutomationSourceDefinitionType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as NodeCrypto from "node:crypto";

import { ProcessRunner } from "../processRunner.ts";
import {
  hardenedHostGitArguments,
  hardenedHostGitEnvironment,
  resolveTrustedHostExecutable,
  supportsHardenedHostGitAuthoring,
} from "../vcs/HostGitSecurity.ts";
import {
  type AtomicDirectoryIdentity,
  type AtomicFileIdentity,
  makeAtomicTargetExchange,
} from "./AtomicTargetExchange.ts";
import { CommandCenterConfig, type LoadedCommandCenterConfig } from "./Config.ts";
import {
  AUTHORING_LAYOUT_KEY,
  automaticAutomationId,
  automationCreateRequestDigest as requestDigest,
  automationCreateRequestSuffix as requestSuffix,
  preservePrivateSourceFields,
  readAuthoringMarker as authoringMarker,
  sourceFileContents,
} from "./AutomationDefinitionAuthoring.ts";
import {
  type AutomationDefinitionDigest,
  canonicalJson,
  digestAutomationDefinition,
  prepareAutomationSave,
  validateAutomationDefinition,
} from "./automation/index.ts";

const AUTOMATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40,64}$/u;
const AUTOMATION_RELATIVE_PATH_PATTERN = /^automations\/([a-z0-9][a-z0-9-]{0,127})\.json$/u;
const AUTOMATION_TREE_ENTRY_PATTERN =
  /^100644 blob ([a-f0-9]{40,64})\t(automations\/[a-z0-9][a-z0-9-]{0,127}\.json)$/u;
const SOURCE_FILE_MODE_PATTERN =
  /^100644 blob ([a-f0-9]{40,64})\tautomations\/[a-z0-9][a-z0-9-]{0,127}\.json\n?$/u;

function branchRefIsSafe(branchRef: string): boolean {
  if (!branchRef.startsWith("refs/heads/") || branchRef.length > 255) return false;
  const suffix = branchRef.slice("refs/heads/".length);
  const segments = suffix.split("/");
  return (
    segments.length > 0 &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        !segment.startsWith(".") &&
        !segment.endsWith(".") &&
        !segment.endsWith(".lock") &&
        !segment.includes("..") &&
        !segment.includes("@{") &&
        ![...segment].some((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint <= 0x20 || codePoint === 0x7f || "~^:?*[\\".includes(character);
        }),
    )
  );
}

const decodeUnknownJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const decodeSourceDefinition = Schema.decodeUnknownEffect(CommandCenterAutomationSourceDefinition);

const configError = (message: string, cause?: unknown) =>
  new CommandCenterError({
    reason: "config",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const persistenceError = (message: string, cause?: unknown) =>
  new CommandCenterError({
    reason: "persistence",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const validationError = (message: string, cause?: unknown) =>
  new CommandCenterError({
    reason: "validation",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const conflictError = (message: string) =>
  new CommandCenterError({
    reason: "conflict",
    message,
  });

const notFoundError = (message: string) =>
  new CommandCenterError({
    reason: "not_found",
    message,
  });

export interface AutomationDefinitionCommitAuditInput {
  readonly operation: "created" | "updated";
  readonly requestId?: string;
  readonly automationId: string;
  readonly spaceId: string;
  readonly previousConfigCommitSha: string;
  readonly configCommitSha: string;
  readonly previousDefinitionDigest: string | null;
  readonly definitionDigest: string;
}

export interface AutomationDefinitionConfigShape {
  readonly authoringHealth: Effect.Effect<CommandCenterAutomationAuthoringHealth>;
  readonly create: <E, R>(
    input: CommandCenterAutomationDefinitionCreateInputType,
    recordAudit: (input: AutomationDefinitionCommitAuditInput) => Effect.Effect<void, E, R>,
  ) => Effect.Effect<CommandCenterAutomationDefinitionSnapshot, CommandCenterError | E, R>;
  readonly get: (
    input: CommandCenterAutomationDefinitionGetInput,
  ) => Effect.Effect<CommandCenterAutomationDefinitionSnapshot, CommandCenterError>;
  readonly save: <E, R>(
    input: CommandCenterAutomationDefinitionSaveInput,
    recordAudit: (input: AutomationDefinitionCommitAuditInput) => Effect.Effect<void, E, R>,
  ) => Effect.Effect<CommandCenterAutomationDefinitionSnapshot, CommandCenterError | E, R>;
}

export class AutomationDefinitionConfig extends Context.Service<
  AutomationDefinitionConfig,
  AutomationDefinitionConfigShape
>()("@awtprod/command-center/command-center/AutomationDefinitionConfig") {}

interface LoadedCommittedSource {
  readonly configDirectory: string;
  readonly relativePath: string;
  readonly targetPath: string;
  readonly commitSha: string;
  readonly blobSha: string;
  readonly definition: CommandCenterAutomationSourceDefinitionType;
  readonly definitionDigest: AutomationDefinitionDigest;
  readonly originalContents: string;
}

interface LoadedSource extends LoadedCommittedSource {
  readonly branchRef: string;
}

interface AuthoredTargetIdentity {
  readonly dev: number;
  readonly ino: number | undefined;
  readonly size: string;
  readonly contents: string;
}

interface AuthoredTargetTransaction {
  readonly authoredTarget: AtomicFileIdentity;
  readonly authoredContents: string;
  readonly originalTarget: AtomicFileIdentity;
  readonly targetDirectory: string;
  readonly targetDirectoryIdentity: AtomicDirectoryIdentity;
  readonly displacedOriginalPath: string;
  readonly recoveryDirectory: string;
  readonly recoveryDirectoryIdentity: AtomicDirectoryIdentity;
}

function sameAtomicFileIdentity(left: AtomicFileIdentity, right: AtomicFileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.sha256 === right.sha256
  );
}

export const make = Effect.gen(function* () {
  const config = yield* CommandCenterConfig;
  const runner = yield* ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const writeLock = yield* Semaphore.make(1);
  const atomicTargetExchange = yield* makeAtomicTargetExchange();
  const atomicAuthoringPreflight = yield* Effect.cached(atomicTargetExchange.preflight());
  let verifiedAuthoringGitExecutable: string | undefined;

  /** Publish service-owned bytes through pinned dirfds and RENAME_NOREPLACE. */
  const writeNewAtomically = Effect.fn("AutomationDefinitionConfig.writeNewAtomically")(function* (
    configDirectory: string,
    filePath: string,
    contents: string,
  ) {
    const targetDirectory = path.dirname(filePath);
    const targetDirectoryIdentity = yield* atomicTargetExchange.captureDirectory(targetDirectory);
    const recovery = yield* makeTargetRecoveryDirectory({ configDirectory, targetPath: filePath });
    return yield* atomicTargetExchange.publishContents({
      mode: "create",
      manifestId: "publish-create",
      targetDirectory,
      targetName: path.basename(filePath),
      recoveryDirectory: recovery.recoveryDirectory,
      recoveryName: "authored",
      expectedTargetDirectory: targetDirectoryIdentity,
      expectedRecoveryDirectory: recovery.recoveryDirectoryIdentity,
      contents: Buffer.from(contents, "utf8"),
    });
  });

  const captureAuthoredTarget = Effect.fn("AutomationDefinitionConfig.captureAuthoredTarget")(
    function* (filePath: string, intendedContents: string) {
      const realTarget = yield* fs
        .realPath(filePath)
        .pipe(
          Effect.mapError((cause) =>
            persistenceError("Could not resolve the authored automation target.", cause),
          ),
        );
      if (path.resolve(realTarget) !== path.resolve(filePath)) {
        return yield* conflictError("The authored automation target became a symbolic link.");
      }
      const info = yield* fs
        .stat(filePath)
        .pipe(
          Effect.mapError((cause) =>
            persistenceError("Could not inspect the authored automation target.", cause),
          ),
        );
      const contents = yield* fs
        .readFileString(filePath)
        .pipe(
          Effect.mapError((cause) =>
            persistenceError("Could not reread the authored automation target.", cause),
          ),
        );
      if (info.type !== "File" || contents !== intendedContents) {
        return yield* conflictError(
          "The authored automation target changed before it could be committed.",
        );
      }
      return {
        dev: info.dev,
        ino: Option.getOrUndefined(info.ino),
        size: String(info.size),
        contents,
      } satisfies AuthoredTargetIdentity;
    },
  );

  const requireAuthoredTargetIdentity = Effect.fn(
    "AutomationDefinitionConfig.requireAuthoredTargetIdentity",
  )(function* (filePath: string, expected: AuthoredTargetIdentity) {
    const current = yield* captureAuthoredTarget(filePath, expected.contents).pipe(
      Effect.mapError(() =>
        conflictError(
          "The automation target changed concurrently; rollback was stopped for manual review.",
        ),
      ),
    );
    if (
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      current.size !== expected.size
    ) {
      return yield* conflictError(
        "The automation target identity changed concurrently; rollback was stopped for manual review.",
      );
    }
  });

  const runGit = Effect.fn("AutomationDefinitionConfig.git")(function* (
    configDirectory: string,
    args: ReadonlyArray<string>,
    extraEnv: NodeJS.ProcessEnv = {},
    stdin?: string,
  ) {
    const gitExecutable = resolveTrustedHostExecutable("git", {
      writableRoots: [configDirectory],
    });
    if (gitExecutable === undefined) {
      return yield* persistenceError(
        "Could not resolve Git outside the writable private automation checkout.",
      );
    }
    const gitEnvironment = {
      ...hardenedHostGitEnvironment([], { writableRoots: [configDirectory] }),
      LANG: "C",
      LC_ALL: "C",
    } satisfies NodeJS.ProcessEnv;
    if (verifiedAuthoringGitExecutable !== gitExecutable) {
      const version = yield* runner
        .run({
          command: gitExecutable,
          args: hardenedHostGitArguments(["--version"]),
          env: gitEnvironment,
          extendEnv: false,
          timeout: "5 seconds",
          maxOutputBytes: 8 * 1024,
        })
        .pipe(
          Effect.mapError((cause) =>
            persistenceError(
              "Could not verify the private automation checkout Git version.",
              cause,
            ),
          ),
        );
      if (version.code !== 0 || !supportsHardenedHostGitAuthoring(version.stdout)) {
        return yield* persistenceError(
          "Private automation authoring requires Git 2.36 or newer for safe fsmonitor and durable fsync controls.",
        );
      }
      verifiedAuthoringGitExecutable = gitExecutable;
    }
    return yield* runner
      .run({
        command: gitExecutable,
        // This service validates and audits the exact committed blob itself.
        // Ambient signing, global attributes, and checkout-local hooks must not
        // execute code or change local-only authoring semantics.
        args: hardenedHostGitArguments([
          "-C",
          configDirectory,
          "-c",
          "core.attributesFile=/dev/null",
          "-c",
          "core.fsync=all",
          "-c",
          "core.fsyncMethod=fsync",
          ...args,
        ]),
        env: {
          ...gitEnvironment,
          ...extraEnv,
        },
        extendEnv: false,
        ...(stdin === undefined ? {} : { stdin }),
        timeout: "15 seconds",
        maxOutputBytes: 4 * 1024 * 1024,
      })
      .pipe(
        Effect.mapError((cause) =>
          persistenceError("Could not update the private automation checkout.", cause),
        ),
      );
  });

  const requireGitSuccess = Effect.fn("AutomationDefinitionConfig.requireGitSuccess")(function* (
    configDirectory: string,
    args: ReadonlyArray<string>,
    message: string,
    extraEnv: NodeJS.ProcessEnv = {},
    stdin?: string,
  ) {
    const result = yield* runGit(configDirectory, args, extraEnv, stdin);
    if (result.code !== 0) return yield* persistenceError(message);
    return result.stdout;
  });

  const requireReadGitSuccess = Effect.fn("AutomationDefinitionConfig.requireReadGitSuccess")(
    function* (configDirectory: string, args: ReadonlyArray<string>, message: string) {
      const gitExecutable = resolveTrustedHostExecutable("git", {
        writableRoots: [configDirectory],
      });
      if (gitExecutable === undefined) {
        return yield* configError("Could not resolve Git outside the private config checkout.");
      }
      const result = yield* runner
        .run({
          command: gitExecutable,
          args: hardenedHostGitArguments(["-C", configDirectory, ...args]),
          env: hardenedHostGitEnvironment([], { writableRoots: [configDirectory] }),
          extendEnv: false,
          timeout: "10 seconds",
          maxOutputBytes: 4 * 1024 * 1024,
        })
        .pipe(
          Effect.mapError((cause) =>
            configError("Could not inspect the private config checkout.", cause),
          ),
        );
      if (result.code !== 0) return yield* configError(message);
      return result.stdout;
    },
  );

  const readPinnedBranch = Effect.fn("AutomationDefinitionConfig.readPinnedBranch")(function* (
    configDirectory: string,
  ) {
    const symbolic = yield* runGit(configDirectory, ["symbolic-ref", "--quiet", "HEAD"]);
    if (symbolic.code !== 0) {
      return yield* configError(
        "Automation authoring requires a checked-out named branch; detached HEAD is not allowed.",
      );
    }
    const branchRef = symbolic.stdout.trim();
    if (!branchRefIsSafe(branchRef)) {
      return yield* configError("The private configuration branch reference is not safe.");
    }
    const checked = yield* runGit(configDirectory, ["check-ref-format", branchRef]);
    if (checked.code !== 0) {
      return yield* configError("The private configuration branch reference is invalid.");
    }
    return branchRef;
  });

  const requirePinnedBranch = Effect.fn("AutomationDefinitionConfig.requirePinnedBranch")(
    function* (configDirectory: string, branchRef: string, expectedCommitSha: string) {
      const currentBranch = yield* readPinnedBranch(configDirectory).pipe(
        Effect.mapError(() =>
          conflictError("The private configuration branch changed during automation authoring."),
        ),
      );
      if (currentBranch !== branchRef) {
        return yield* conflictError(
          "The private configuration branch changed during automation authoring.",
        );
      }
      const currentCommit = (yield* requireGitSuccess(
        configDirectory,
        ["rev-parse", "--verify", `${branchRef}^{commit}`],
        "Could not verify the pinned private configuration branch.",
      ))
        .trim()
        .toLowerCase();
      if (currentCommit !== expectedCommitSha) {
        return yield* conflictError(
          "The pinned private configuration branch advanced during automation authoring.",
        );
      }
    },
  );

  /**
   * Build a one-file commit from an isolated index. `hash-object --no-filters`
   * is deliberate: a private checkout may contain hostile clean filters, and
   * authoring must never execute checkout-provided programs.
   */
  const commitFileWithPlumbing = Effect.fn("AutomationDefinitionConfig.commitFileWithPlumbing")(
    function* (input: {
      readonly configDirectory: string;
      readonly parentCommitSha: string;
      readonly relativePath: string;
      readonly contents: string;
      readonly message: string;
    }) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const tempDirectory = yield* fs
            .makeTempDirectoryScoped({ prefix: "command-center-config-index-" })
            .pipe(
              Effect.mapError((cause) =>
                persistenceError("Could not allocate the isolated automation commit index.", cause),
              ),
            );
          const tempIndex = path.join(tempDirectory, "index");
          const emptyWorktree = path.join(tempDirectory, "worktree");
          const isolatedGitDirectory = path.join(tempDirectory, "git");
          yield* fs
            .makeDirectory(emptyWorktree)
            .pipe(
              Effect.mapError((cause) =>
                persistenceError("Could not isolate the automation commit worktree.", cause),
              ),
            );
          yield* fs
            .makeDirectory(isolatedGitDirectory)
            .pipe(
              Effect.mapError((cause) =>
                persistenceError("Could not isolate the automation Git metadata.", cause),
              ),
            );
          yield* fs
            .makeDirectory(path.join(isolatedGitDirectory, "refs", "heads"), { recursive: true })
            .pipe(
              Effect.mapError((cause) =>
                persistenceError("Could not prepare isolated automation Git references.", cause),
              ),
            );
          yield* fs
            .writeFileString(
              path.join(isolatedGitDirectory, "HEAD"),
              "ref: refs/heads/command-center\n",
            )
            .pipe(
              Effect.mapError((cause) =>
                persistenceError("Could not prepare isolated automation Git metadata.", cause),
              ),
            );
          const indexEnv = {
            GIT_DIR: isolatedGitDirectory,
            GIT_INDEX_FILE: tempIndex,
            GIT_OBJECT_DIRECTORY: path.join(input.configDirectory, ".git", "objects"),
            GIT_WORK_TREE: emptyWorktree,
          };

          yield* requireGitSuccess(
            input.configDirectory,
            ["read-tree", input.parentCommitSha],
            "Could not initialize the isolated automation commit index.",
            indexEnv,
          );
          const blobSha = (yield* requireGitSuccess(
            input.configDirectory,
            ["hash-object", "-w", "--no-filters", "--stdin"],
            "Could not write the validated automation blob.",
            indexEnv,
            input.contents,
          ))
            .trim()
            .toLowerCase();
          if (!COMMIT_SHA_PATTERN.test(blobSha)) {
            return yield* persistenceError("Git returned an invalid automation blob identifier.");
          }

          yield* requireGitSuccess(
            input.configDirectory,
            [
              "update-index",
              "--info-only",
              "--add",
              "--cacheinfo",
              `100644,${blobSha},${input.relativePath}`,
            ],
            "Could not add the automation blob to the isolated commit index.",
            indexEnv,
          );
          const treeSha = (yield* requireGitSuccess(
            input.configDirectory,
            ["write-tree"],
            "Could not write the isolated automation commit tree.",
            indexEnv,
          ))
            .trim()
            .toLowerCase();
          if (!COMMIT_SHA_PATTERN.test(treeSha)) {
            return yield* persistenceError("Git returned an invalid automation tree identifier.");
          }

          const commitSha = (yield* requireGitSuccess(
            input.configDirectory,
            ["commit-tree", treeSha, "-p", input.parentCommitSha, "-m", input.message],
            "Could not create the local automation config commit.",
            {
              ...indexEnv,
              GIT_AUTHOR_NAME: "Command Center",
              GIT_AUTHOR_EMAIL: "command-center@localhost",
              GIT_COMMITTER_NAME: "Command Center",
              GIT_COMMITTER_EMAIL: "command-center@localhost",
            },
          ))
            .trim()
            .toLowerCase();
          if (!COMMIT_SHA_PATTERN.test(commitSha) || commitSha === input.parentCommitSha) {
            return yield* persistenceError(
              "The local automation commit was not created correctly.",
            );
          }

          return { commitSha, blobSha } as const;
        }),
      );
    },
  );

  const publishCommit = Effect.fn("AutomationDefinitionConfig.publishCommit")(function* (
    configDirectory: string,
    branchRef: string,
    commitSha: string,
    parentCommitSha: string,
  ) {
    yield* requirePinnedBranch(configDirectory, branchRef, parentCommitSha);
    let updateFailure: CommandCenterError | undefined;
    const update = yield* runGit(configDirectory, [
      "update-ref",
      branchRef,
      commitSha,
      parentCommitSha,
    ]).pipe(
      Effect.catch((cause) => {
        updateFailure = cause;
        return Effect.void;
      }),
    );
    const readback = yield* runGit(configDirectory, [
      "rev-parse",
      "--verify",
      `${branchRef}^{commit}`,
    ]).pipe(
      Effect.mapError((cause) =>
        conflictError(
          `The private config ref publication outcome could not be read back; preserve the authored target and index for manual recovery (${String(cause)}).`,
        ),
      ),
    );
    const currentCommitSha = readback.stdout.trim().toLowerCase();
    if (readback.code !== 0 || !COMMIT_SHA_PATTERN.test(currentCommitSha)) {
      return yield* conflictError(
        "The private config ref publication outcome is unreadable; preserve authored state for manual recovery.",
      );
    }
    if (currentCommitSha === commitSha) return;
    if (currentCommitSha !== parentCommitSha) {
      return yield* conflictError(
        "The private config branch moved to a third commit during publication; preserve authored state for manual recovery.",
      );
    }
    if (updateFailure !== undefined) return yield* updateFailure;
    if (update === undefined || update.code !== 0) {
      return yield* persistenceError(
        "The private config checkout changed before the audited automation commit could be published.",
      );
    }
    return yield* persistenceError(
      "Git reported ref publication success but authoritative readback still showed the parent commit.",
    );
  });

  const requireRollbackAuthority = Effect.fn("AutomationDefinitionConfig.requireRollbackAuthority")(
    function* (configDirectory: string, branchRef: string, parentCommitSha: string) {
      const currentBranch = yield* readPinnedBranch(configDirectory).pipe(
        Effect.mapError(() =>
          conflictError(
            "The checked-out private config branch changed; local authored state was preserved for manual recovery.",
          ),
        ),
      );
      if (currentBranch !== branchRef) {
        return yield* conflictError(
          "The checked-out private config branch changed; local authored state was preserved for manual recovery.",
        );
      }
      const readback = yield* runGit(configDirectory, [
        "rev-parse",
        "--verify",
        `${branchRef}^{commit}`,
      ]).pipe(
        Effect.mapError(() =>
          conflictError(
            "The private config branch could not be read before rollback; local authored state was preserved.",
          ),
        ),
      );
      const currentCommitSha = readback.stdout.trim().toLowerCase();
      if (readback.code !== 0 || currentCommitSha !== parentCommitSha) {
        return yield* conflictError(
          "The private config branch no longer matches the rollback parent; local authored state was preserved.",
        );
      }
    },
  );

  const rewriteRealIndexEntry = Effect.fn("AutomationDefinitionConfig.rewriteRealIndexEntry")(
    function* (input: {
      readonly configDirectory: string;
      readonly relativePath: string;
      readonly blobSha?: string;
      readonly expectedBlobSha: string | null;
    }) {
      const recovery = yield* makeTargetRecoveryDirectory({
        configDirectory: input.configDirectory,
        targetPath: path.join(input.configDirectory, ".git", "index"),
      });
      const { gitDirectory, gitDirectoryIdentity } = recovery;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const tempDirectory = yield* fs
            .makeTempDirectoryScoped({ prefix: "command-center-index-" })
            .pipe(
              Effect.mapError((cause) =>
                persistenceError("Could not prepare an isolated real-index update.", cause),
              ),
            );
          const tempIndex = path.join(tempDirectory, "index");
          const emptyWorktree = path.join(tempDirectory, "worktree");
          const isolatedGitDirectory = path.join(tempDirectory, "git");
          const realIndex = path.join(gitDirectory, "index");
          yield* fs
            .makeDirectory(emptyWorktree)
            .pipe(
              Effect.mapError((cause) =>
                persistenceError("Could not isolate the automation index worktree.", cause),
              ),
            );
          yield* fs
            .makeDirectory(isolatedGitDirectory)
            .pipe(
              Effect.mapError((cause) =>
                persistenceError("Could not isolate the automation index metadata.", cause),
              ),
            );
          yield* fs
            .makeDirectory(path.join(isolatedGitDirectory, "refs", "heads"), { recursive: true })
            .pipe(
              Effect.mapError((cause) =>
                persistenceError("Could not prepare isolated index Git references.", cause),
              ),
            );
          yield* fs
            .writeFileString(
              path.join(isolatedGitDirectory, "HEAD"),
              "ref: refs/heads/command-center\n",
            )
            .pipe(
              Effect.mapError((cause) =>
                persistenceError("Could not prepare isolated index Git metadata.", cause),
              ),
            );
          const expectedIndex = yield* atomicTargetExchange.captureFile(realIndex);
          yield* fs
            .copyFile(realIndex, tempIndex)
            .pipe(
              Effect.mapError((cause) =>
                persistenceError("Could not copy the private configuration index.", cause),
              ),
            );
          const [currentIndex, copiedIndex] = yield* Effect.all([
            atomicTargetExchange.captureFile(realIndex),
            atomicTargetExchange.captureFile(tempIndex),
          ]);
          if (
            !sameAtomicFileIdentity(currentIndex, expectedIndex) ||
            copiedIndex.size !== expectedIndex.size ||
            copiedIndex.sha256 !== expectedIndex.sha256
          ) {
            return yield* conflictError(
              "The private configuration index changed while its isolated update was prepared.",
            );
          }
          const isolatedEnv = {
            GIT_DIR: isolatedGitDirectory,
            GIT_INDEX_FILE: tempIndex,
            GIT_OBJECT_DIRECTORY: path.join(gitDirectory, "objects"),
            GIT_WORK_TREE: emptyWorktree,
          };
          const currentEntry = yield* requireGitSuccess(
            input.configDirectory,
            ["ls-files", "--stage", "--", input.relativePath],
            "Could not compare the private configuration index entry.",
            isolatedEnv,
          );
          const expectedEntry =
            input.expectedBlobSha === null
              ? ""
              : `100644 ${input.expectedBlobSha} 0\t${input.relativePath}\n`;
          if (currentEntry !== expectedEntry) {
            return yield* conflictError(
              "The automation index entry changed concurrently; manual review is required.",
            );
          }
          yield* requireGitSuccess(
            input.configDirectory,
            input.blobSha === undefined
              ? ["update-index", "--force-remove", "--", input.relativePath]
              : [
                  "update-index",
                  "--info-only",
                  "--add",
                  "--cacheinfo",
                  `100644,${input.blobSha},${input.relativePath}`,
                ],
            "Could not update the isolated private configuration index.",
            isolatedEnv,
          );
          const contents = yield* fs
            .readFile(tempIndex)
            .pipe(
              Effect.mapError((cause) =>
                persistenceError("Could not read the isolated private configuration index.", cause),
              ),
            );
          yield* atomicTargetExchange.publishIndex({
            manifestId: "publish-index",
            gitDirectory,
            recoveryDirectory: recovery.recoveryDirectory,
            indexName: "index",
            lockName: "index.lock",
            expectedGitDirectory: gitDirectoryIdentity,
            expectedRecoveryDirectory: recovery.recoveryDirectoryIdentity,
            expectedIndex,
            contents,
          });
        }),
      );
    },
  );

  const setRealIndexEntry = (
    configDirectory: string,
    relativePath: string,
    blobSha: string,
    expectedBlobSha: string | null,
  ) => rewriteRealIndexEntry({ configDirectory, relativePath, blobSha, expectedBlobSha });

  const removeRealIndexEntry = (
    configDirectory: string,
    relativePath: string,
    expectedBlobSha: string,
  ) => rewriteRealIndexEntry({ configDirectory, relativePath, expectedBlobSha });

  const requireRealIndexEntry = Effect.fn("AutomationDefinitionConfig.requireRealIndexEntry")(
    function* (configDirectory: string, relativePath: string, expectedBlobSha: string | null) {
      const currentEntry = yield* requireGitSuccess(
        configDirectory,
        ["ls-files", "--stage", "--", relativePath],
        "Could not inspect the automation index during guarded rollback.",
      );
      const expectedEntry =
        expectedBlobSha === null ? "" : `100644 ${expectedBlobSha} 0\t${relativePath}\n`;
      if (currentEntry !== expectedEntry) {
        return yield* conflictError(
          "The automation index changed concurrently; rollback was stopped for manual review.",
        );
      }
    },
  );

  const resolveReadableCheckout = Effect.fn("AutomationDefinitionConfig.resolveReadableCheckout")(
    function* () {
      const loaded = yield* config.load;
      if (loaded.health.status !== "loaded") {
        return yield* configError("Private Command Center configuration is not available.");
      }

      const configured = yield* fs
        .realPath(config.configDirectory)
        .pipe(
          Effect.mapError((cause) =>
            configError("The private configuration checkout could not be resolved.", cause),
          ),
        );
      const gitRootOutput = yield* requireReadGitSuccess(
        configured,
        ["rev-parse", "--show-toplevel"],
        "Private configuration is not a Git checkout.",
      );
      const gitRoot = yield* fs
        .realPath(gitRootOutput.trim())
        .pipe(
          Effect.mapError((cause) =>
            configError("The private configuration Git root could not be resolved.", cause),
          ),
        );
      if (path.resolve(configured) !== path.resolve(gitRoot)) {
        return yield* configError("Private configuration must point at the checkout root.");
      }
      return { configDirectory: configured, loaded };
    },
  );

  const resolveCheckout = Effect.fn("AutomationDefinitionConfig.resolveCheckout")(function* () {
    const checkout = yield* resolveReadableCheckout();
    const branchRef = yield* readPinnedBranch(checkout.configDirectory);
    return { ...checkout, branchRef };
  });

  const loadCommittedSource = Effect.fn("AutomationDefinitionConfig.loadCommittedSource")(
    function* (
      input: CommandCenterAutomationDefinitionGetInput,
      checkout: {
        readonly configDirectory: string;
        readonly loaded: LoadedCommandCenterConfig;
      },
      commitReference: string,
    ) {
      if (!checkout.loaded.spaces.some((space) => space.id === input.spaceId)) {
        return yield* notFoundError("The requested automation Space was not found.");
      }

      const commitSha = (yield* requireReadGitSuccess(
        checkout.configDirectory,
        ["rev-parse", "--verify", `${commitReference}^{commit}`],
        "Private configuration does not have a committed definition.",
      ))
        .trim()
        .toLowerCase();
      if (!COMMIT_SHA_PATTERN.test(commitSha)) {
        return yield* configError("Private configuration returned an invalid commit identifier.");
      }

      const tree = yield* requireReadGitSuccess(
        checkout.configDirectory,
        ["ls-tree", "-rz", "--full-tree", commitSha, "--", "automations"],
        "Could not list committed automation definitions.",
      );
      const entries = tree
        .split("\0")
        .flatMap((entry) => {
          const match = AUTOMATION_TREE_ENTRY_PATTERN.exec(entry);
          return match === null ? [] : [{ blobSha: match[1]!, relativePath: match[2]! }];
        })
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
      const matches: LoadedCommittedSource[] = [];
      for (const entry of entries) {
        const targetPath = path.resolve(checkout.configDirectory, entry.relativePath);
        const relativeTarget = path.relative(checkout.configDirectory, targetPath);
        if (relativeTarget !== entry.relativePath || path.isAbsolute(relativeTarget)) {
          return yield* validationError(
            "Automation configuration path escaped its safe directory.",
          );
        }
        const originalContents = yield* requireReadGitSuccess(
          checkout.configDirectory,
          ["show", `${commitSha}:${entry.relativePath}`],
          "Could not read the committed automation definition.",
        );
        const parsed = yield* decodeUnknownJsonString(originalContents).pipe(
          Effect.mapError((cause) =>
            configError("The committed automation definition is not valid JSON.", cause),
          ),
        );
        const definition = yield* decodeSourceDefinition(parsed).pipe(
          Effect.mapError((cause) =>
            configError("The committed automation definition has an invalid shape.", cause),
          ),
        );
        if (definition.id !== input.automationId || definition.spaceId !== input.spaceId) continue;
        const validated = validateAutomationDefinition(parsed);
        if (!validated.ok) {
          return yield* configError(
            `The committed automation definition is invalid: ${validated.issues
              .map((issue) => issue.message)
              .join("; ")}`,
          );
        }
        matches.push({
          configDirectory: checkout.configDirectory,
          relativePath: entry.relativePath,
          targetPath,
          commitSha,
          blobSha: entry.blobSha,
          definition,
          definitionDigest: digestAutomationDefinition(validated.definition),
          originalContents,
        });
      }
      if (matches.length === 0) {
        return yield* notFoundError("The requested committed automation definition was not found.");
      }
      if (matches.length > 1) {
        return yield* configError(
          "The committed configuration contains duplicate automation identities.",
        );
      }
      return matches[0]!;
    },
  );

  const loadSource = Effect.fn("AutomationDefinitionConfig.loadSource")(function* (
    input: CommandCenterAutomationDefinitionGetInput,
  ) {
    if (!AUTOMATION_ID_PATTERN.test(input.automationId)) {
      return yield* validationError("Automation id is not safe for a configuration file name.");
    }
    const checkout = yield* resolveCheckout();
    const source = yield* loadCommittedSource(input, checkout, checkout.branchRef);
    return { ...source, branchRef: checkout.branchRef };
  });

  const toSnapshot = (
    source: Pick<LoadedSource, "definition" | "definitionDigest" | "commitSha">,
    authoringHealth?: {
      readonly status: "available" | "unavailable";
      readonly message?: string;
    },
  ): CommandCenterAutomationDefinitionSnapshot => ({
    automationId: source.definition.id,
    spaceId: source.definition.spaceId,
    definition: source.definition,
    definitionDigest: source.definitionDigest,
    configCommitSha: source.commitSha,
    ...(authoringHealth === undefined ? {} : { authoringHealth }),
  });

  const readAuthoringHealth = (configDirectory: string) =>
    readPinnedBranch(configDirectory).pipe(
      Effect.andThen(atomicAuthoringPreflight),
      Effect.as({ status: "available" as const }),
      Effect.catch((cause) =>
        Effect.succeed({ status: "unavailable" as const, message: cause.message }),
      ),
    );

  const ensureTargetClean = Effect.fn("AutomationDefinitionConfig.ensureTargetClean")(function* (
    source: LoadedSource,
  ) {
    const conflicts = yield* requireGitSuccess(
      source.configDirectory,
      ["ls-files", "-u", "--", source.relativePath],
      "Could not inspect the automation definition for conflicts.",
    );
    if (conflicts.trim().length > 0) {
      return yield* conflictError("The automation definition has unresolved Git conflicts.");
    }
    const indexEntry = yield* requireGitSuccess(
      source.configDirectory,
      ["ls-files", "--stage", "--", source.relativePath],
      "Could not inspect the automation definition index entry.",
    );
    if (indexEntry !== `100644 ${source.blobSha} 0\t${source.relativePath}\n`) {
      return yield* conflictError(
        "The automation definition index does not match its committed source.",
      );
    }
    const realTarget = yield* fs
      .realPath(source.targetPath)
      .pipe(
        Effect.mapError((cause) =>
          configError("The automation definition file could not be resolved.", cause),
        ),
      );
    if (path.resolve(realTarget) !== path.resolve(source.targetPath)) {
      return yield* configError("Symbolic-link automation definition targets are not allowed.");
    }
    const workingContents = yield* fs
      .readFileString(source.targetPath)
      .pipe(
        Effect.mapError((cause) =>
          configError("The automation definition working file could not be read.", cause),
        ),
      );
    if (workingContents !== source.originalContents) {
      return yield* conflictError(
        "The automation definition already has uncommitted changes. Resolve them before saving.",
      );
    }
  });

  const targetExistsOrIsLink = Effect.fn("AutomationDefinitionConfig.targetExistsOrIsLink")(
    function* (targetPath: string) {
      if (yield* fs.exists(targetPath).pipe(Effect.orElseSucceed(() => false))) return true;
      return yield* fs.readLink(targetPath).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
    },
  );

  const makeTargetRecoveryDirectory = Effect.fn(
    "AutomationDefinitionConfig.makeTargetRecoveryDirectory",
  )(function* (input: { readonly configDirectory: string; readonly targetPath: string }) {
    const expectedGitDirectory = path.join(input.configDirectory, ".git");
    const gitDirectory = yield* fs
      .realPath(expectedGitDirectory)
      .pipe(
        Effect.mapError((cause) =>
          configError("The private configuration Git metadata could not be resolved.", cause),
        ),
      );
    if (path.resolve(gitDirectory) !== path.resolve(expectedGitDirectory)) {
      return yield* configError(
        "Automation authoring requires private Git metadata inside the config checkout.",
      );
    }
    const gitDirectoryIdentity = yield* atomicTargetExchange.captureDirectory(gitDirectory);
    const safePrefix = `${path.basename(input.targetPath).replace(/[^a-zA-Z0-9._-]/gu, "-")}.`;
    const recovery = yield* atomicTargetExchange.prepareRecoveryDirectory({
      gitDirectory,
      expectedGitDirectory: gitDirectoryIdentity,
      rootName: "command-center-recovery",
      transactionPrefix: safePrefix,
    });
    return {
      gitDirectory,
      gitDirectoryIdentity,
      recoveryDirectory: recovery.recoveryDirectory,
      recoveryDirectoryIdentity: recovery.recoveryDirectoryIdentity,
    } as const;
  });

  /**
   * Publish through one dirfd-relative renameat2(RENAME_EXCHANGE). Both the
   * target and staged file have a pathname before and after the syscall, and
   * the helper exchanges them back through the same pinned descriptors if any
   * inode, digest, or canonical-parent check fails.
   */
  const installTargetWithPreservation = Effect.fn(
    "AutomationDefinitionConfig.installTargetWithPreservation",
  )(function* (source: LoadedSource, intendedContents: string) {
    const recovery = yield* makeTargetRecoveryDirectory({
      configDirectory: source.configDirectory,
      targetPath: source.targetPath,
    });
    const { recoveryDirectory, recoveryDirectoryIdentity } = recovery;
    const stagedPath = path.join(recoveryDirectory, "authored");
    const targetDirectory = path.dirname(source.targetPath);
    const [targetDirectoryIdentity, originalTarget] = yield* Effect.all([
      atomicTargetExchange.captureDirectory(targetDirectory),
      atomicTargetExchange.captureFile(source.targetPath),
    ]);
    const expectedOriginalSha = NodeCrypto.createHash("sha256")
      .update(source.originalContents, "utf8")
      .digest("hex");
    if (
      originalTarget.sha256 !== expectedOriginalSha ||
      originalTarget.size !== String(Buffer.byteLength(source.originalContents, "utf8"))
    ) {
      return yield* conflictError(
        "The automation target changed before its atomic exchange; no filesystem mutation occurred.",
      );
    }
    const published = yield* atomicTargetExchange.publishContents({
      mode: "update",
      manifestId: "publish",
      targetDirectory,
      targetName: path.basename(source.targetPath),
      recoveryDirectory,
      recoveryName: path.basename(stagedPath),
      expectedTargetDirectory: targetDirectoryIdentity,
      expectedRecoveryDirectory: recoveryDirectoryIdentity,
      expectedTarget: originalTarget,
      contents: Buffer.from(intendedContents, "utf8"),
    });
    if (published.recovery === undefined) {
      return yield* persistenceError(
        "The atomic automation update did not preserve its original target.",
      );
    }

    return {
      authoredTarget: published.target,
      authoredContents: intendedContents,
      originalTarget: published.recovery,
      targetDirectory,
      targetDirectoryIdentity,
      displacedOriginalPath: stagedPath,
      recoveryDirectory,
      recoveryDirectoryIdentity,
    } satisfies AuthoredTargetTransaction;
  });

  const requireAtomicTargetIdentity = Effect.fn(
    "AutomationDefinitionConfig.requireAtomicTargetIdentity",
  )(function* (filePath: string, expected: AtomicFileIdentity) {
    const actual = yield* atomicTargetExchange.captureFile(filePath);
    if (!sameAtomicFileIdentity(actual, expected)) {
      return yield* conflictError(
        "The automation target changed concurrently; publication stopped for manual review.",
      );
    }
  });

  const replaceTargetWithContents = Effect.fn(
    "AutomationDefinitionConfig.replaceTargetWithContents",
  )(function* (input: {
    readonly configDirectory: string;
    readonly targetPath: string;
    readonly expectedTarget: AtomicFileIdentity;
    readonly contents: string;
    readonly manifestId: string;
  }) {
    const recovery = yield* makeTargetRecoveryDirectory({
      configDirectory: input.configDirectory,
      targetPath: input.targetPath,
    });
    const targetDirectory = path.dirname(input.targetPath);
    const targetDirectoryIdentity = yield* atomicTargetExchange.captureDirectory(targetDirectory);
    const currentTarget = yield* atomicTargetExchange.captureFile(input.targetPath);
    if (!sameAtomicFileIdentity(currentTarget, input.expectedTarget)) {
      return yield* conflictError(
        "The automation target changed before guarded content restoration.",
      );
    }
    return yield* atomicTargetExchange.publishContents({
      mode: "update",
      manifestId: input.manifestId,
      targetDirectory,
      targetName: path.basename(input.targetPath),
      recoveryDirectory: recovery.recoveryDirectory,
      recoveryName: "authored",
      expectedTargetDirectory: targetDirectoryIdentity,
      expectedRecoveryDirectory: recovery.recoveryDirectoryIdentity,
      expectedTarget: currentTarget,
      contents: Buffer.from(input.contents, "utf8"),
    });
  });

  const restoreTarget = Effect.fn("AutomationDefinitionConfig.restoreTarget")(function* (
    source: LoadedSource,
    transaction: AuthoredTargetTransaction,
    authoredBlobSha: string | undefined,
    indexUpdated = false,
  ) {
    if (indexUpdated && authoredBlobSha === undefined) {
      return yield* persistenceError(
        "The authored automation blob is unavailable for guarded index rollback.",
      );
    }
    yield* requireRealIndexEntry(
      source.configDirectory,
      source.relativePath,
      indexUpdated ? authoredBlobSha! : source.blobSha,
    );

    const restored = yield* replaceTargetWithContents({
      configDirectory: source.configDirectory,
      targetPath: source.targetPath,
      expectedTarget: transaction.authoredTarget,
      contents: source.originalContents,
      manifestId: "rollback-target",
    });

    if (indexUpdated) {
      yield* setRealIndexEntry(
        source.configDirectory,
        source.relativePath,
        source.blobSha,
        authoredBlobSha!,
      ).pipe(
        Effect.catch((cause) =>
          replaceTargetWithContents({
            configDirectory: source.configDirectory,
            targetPath: source.targetPath,
            expectedTarget: restored.target,
            contents: transaction.authoredContents,
            manifestId: "restore-authored-target",
          }).pipe(Effect.andThen(Effect.fail(cause))),
        ),
      );
    }
  });

  const get: AutomationDefinitionConfigShape["get"] = (input) =>
    Effect.gen(function* () {
      if (!AUTOMATION_ID_PATTERN.test(input.automationId)) {
        return yield* validationError("Automation id is not safe for a configuration file name.");
      }
      const checkout = yield* resolveReadableCheckout();
      const source = yield* loadCommittedSource(input, checkout, "HEAD");
      return toSnapshot(source, yield* readAuthoringHealth(checkout.configDirectory));
    });

  const authoringHealth: AutomationDefinitionConfigShape["authoringHealth"] =
    resolveReadableCheckout().pipe(
      Effect.flatMap((checkout) => readAuthoringHealth(checkout.configDirectory)),
      Effect.catch((cause) =>
        Effect.succeed({ status: "unavailable" as const, message: cause.message }),
      ),
    );

  const restoreCreatedTarget = Effect.fn("AutomationDefinitionConfig.restoreCreatedTarget")(
    function* (input: {
      readonly configDirectory: string;
      readonly relativePath: string;
      readonly targetPath: string;
      readonly authoredTarget: AuthoredTargetIdentity;
      readonly authoredBlobSha?: string;
      readonly indexUpdated: boolean;
    }) {
      if (input.indexUpdated && input.authoredBlobSha === undefined) {
        return yield* persistenceError(
          "The authored automation blob is unavailable for guarded index rollback.",
        );
      }
      yield* requireRealIndexEntry(
        input.configDirectory,
        input.relativePath,
        input.indexUpdated ? input.authoredBlobSha! : null,
      );
      yield* requireAuthoredTargetIdentity(input.targetPath, input.authoredTarget);
      if (input.indexUpdated) {
        yield* removeRealIndexEntry(
          input.configDirectory,
          input.relativePath,
          input.authoredBlobSha!,
        );
      }
      const recovery = yield* makeTargetRecoveryDirectory({
        configDirectory: input.configDirectory,
        targetPath: input.targetPath,
      });
      const targetDirectory = path.dirname(input.targetPath);
      const [targetDirectoryIdentity, currentTarget] = yield* Effect.all([
        atomicTargetExchange.captureDirectory(targetDirectory),
        atomicTargetExchange.captureFile(input.targetPath),
      ]);
      const expectedSha = NodeCrypto.createHash("sha256")
        .update(input.authoredTarget.contents, "utf8")
        .digest("hex");
      if (
        input.authoredTarget.ino === undefined ||
        currentTarget.dev !== String(input.authoredTarget.dev) ||
        currentTarget.ino !== String(input.authoredTarget.ino) ||
        currentTarget.size !== input.authoredTarget.size ||
        currentTarget.sha256 !== expectedSha
      ) {
        return yield* conflictError(
          "The new automation target changed before guarded preservation; manual review is required.",
        );
      }
      yield* atomicTargetExchange.preserveCreated({
        manifestId: "preserve-created",
        sourceDirectory: targetDirectory,
        sourceName: path.basename(input.targetPath),
        recoveryDirectory: recovery.recoveryDirectory,
        recoveryName: "created",
        expectedSourceDirectory: targetDirectoryIdentity,
        expectedRecoveryDirectory: recovery.recoveryDirectoryIdentity,
        expectedSource: currentTarget,
      });
    },
  );

  const createUnlocked = Effect.fn("AutomationDefinitionConfig.create")(function* <E, R>(
    input: CommandCenterAutomationDefinitionCreateInputType,
    recordAudit: (input: AutomationDefinitionCommitAuditInput) => Effect.Effect<void, E, R>,
  ) {
    yield* atomicTargetExchange.preflight();
    if (Object.hasOwn(input.layout, AUTHORING_LAYOUT_KEY)) {
      return yield* validationError("Automation layout contains a reserved authoring field.");
    }
    const checkout = yield* resolveCheckout();
    if (!checkout.loaded.spaces.some((space) => space.id === input.spaceId)) {
      return yield* notFoundError("The requested automation Space was not found.");
    }
    const automationsDirectory = path.join(checkout.configDirectory, "automations");
    const canonicalAutomationsDirectory = yield* fs
      .realPath(automationsDirectory)
      .pipe(
        Effect.mapError((cause) =>
          configError("The private automation directory could not be resolved.", cause),
        ),
      );
    if (path.resolve(canonicalAutomationsDirectory) !== path.resolve(automationsDirectory)) {
      return yield* configError("The private automation directory must not be a symbolic link.");
    }

    const originalCommitSha = (yield* requireGitSuccess(
      checkout.configDirectory,
      ["rev-parse", "--verify", `${checkout.branchRef}^{commit}`],
      "Private configuration does not have a committed base revision.",
    ))
      .trim()
      .toLowerCase();
    if (!COMMIT_SHA_PATTERN.test(originalCommitSha)) {
      return yield* configError("Private configuration returned an invalid commit identifier.");
    }

    const creationRequestDigest = requestDigest(input);
    const committedAutomationPaths = (yield* requireGitSuccess(
      checkout.configDirectory,
      ["ls-tree", "-r", "--name-only", originalCommitSha, "--", "automations"],
      "Could not inspect committed automation authoring receipts.",
    ))
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
    let existingRequest: LoadedSource | undefined;
    for (const relativePath of committedAutomationPaths) {
      const pathMatch = AUTOMATION_RELATIVE_PATH_PATTERN.exec(relativePath);
      if (pathMatch === null) continue;
      const contents = yield* requireGitSuccess(
        checkout.configDirectory,
        ["show", `${originalCommitSha}:${relativePath}`],
        "Could not inspect a committed automation authoring receipt.",
      );
      const parsedDefinition = yield* decodeUnknownJsonString(contents).pipe(
        Effect.andThen(decodeSourceDefinition),
        Effect.orElseSucceed(() => undefined),
      );
      if (parsedDefinition === undefined || parsedDefinition.spaceId !== input.spaceId) continue;
      const marker = authoringMarker(parsedDefinition);
      if (marker?.requestId !== input.requestId) continue;
      if (marker.requestDigest !== creationRequestDigest) {
        return yield* conflictError(
          "The automation authoring request id is already bound to different input in this Space.",
        );
      }
      const source = yield* loadSource({
        automationId: AutomationId.make(pathMatch[1]!),
        spaceId: input.spaceId,
      });
      if (source.branchRef !== checkout.branchRef || source.commitSha !== originalCommitSha) {
        return yield* conflictError(
          "The private configuration branch changed while resolving the authoring request.",
        );
      }
      if (existingRequest !== undefined && existingRequest.relativePath !== source.relativePath) {
        return yield* configError(
          "The committed configuration contains duplicate automation authoring request ids.",
        );
      }
      existingRequest = source;
    }
    if (existingRequest !== undefined) {
      return toSnapshot(existingRequest, { status: "available" });
    }

    const requestedBaseId = input.preferredAutomationId ?? automaticAutomationId(input.name);
    if (!AUTOMATION_ID_PATTERN.test(requestedBaseId)) {
      return yield* validationError("Preferred automation id is not a safe configuration id.");
    }

    const inspectCandidate = Effect.fn("AutomationDefinitionConfig.inspectCreateCandidate")(
      function* (automationId: string) {
        const relativePath = `automations/${automationId}.json`;
        const targetPath = path.resolve(checkout.configDirectory, relativePath);
        const relativeTarget = path.relative(checkout.configDirectory, targetPath);
        if (relativeTarget !== relativePath || path.isAbsolute(relativeTarget)) {
          return yield* validationError(
            "Automation configuration path escaped its safe directory.",
          );
        }
        const sourceMode = yield* requireGitSuccess(
          checkout.configDirectory,
          ["ls-tree", originalCommitSha, "--", relativePath],
          "Could not inspect the new automation target.",
        );
        if (sourceMode.trim().length === 0) {
          if (yield* targetExistsOrIsLink(targetPath)) {
            return yield* conflictError(
              "An untracked file or symbolic link already occupies the new automation target.",
            );
          }
          const indexEntry = yield* requireGitSuccess(
            checkout.configDirectory,
            ["ls-files", "--stage", "--", relativePath],
            "Could not inspect the new automation index entry.",
          );
          if (indexEntry.length > 0) {
            return yield* conflictError(
              "The new automation target is already present in the index.",
            );
          }
          return { status: "available" as const, automationId, relativePath, targetPath };
        }
        if (!SOURCE_FILE_MODE_PATTERN.test(sourceMode)) {
          return yield* configError("The occupied automation target is not a regular config file.");
        }
        const source = yield* loadSource({
          automationId: AutomationId.make(automationId),
          spaceId: input.spaceId,
        });
        const marker = authoringMarker(source.definition);
        if (marker?.requestId === input.requestId) {
          if (marker.requestDigest !== creationRequestDigest) {
            return yield* conflictError(
              "The automation authoring request id is already bound to different input.",
            );
          }
          yield* ensureTargetClean(source);
          return { status: "duplicate" as const, source };
        }
        return { status: "occupied" as const };
      },
    );

    const initialCandidate = yield* inspectCandidate(requestedBaseId);
    if (initialCandidate.status === "duplicate") {
      return toSnapshot(initialCandidate.source, { status: "available" });
    }
    let candidate: Extract<typeof initialCandidate, { readonly status: "available" }>;
    if (initialCandidate.status === "occupied") {
      if (input.preferredAutomationId !== undefined) {
        return yield* conflictError("The preferred automation id is already committed.");
      }
      const suffix = requestSuffix(input.requestId);
      const suffixedId = `${requestedBaseId.slice(0, 116).replace(/-+$/gu, "")}-${suffix}`;
      const suffixedCandidate = yield* inspectCandidate(suffixedId);
      if (suffixedCandidate.status === "duplicate") {
        return toSnapshot(suffixedCandidate.source, { status: "available" });
      }
      if (suffixedCandidate.status === "occupied") {
        return yield* conflictError("The deterministic automation id is already committed.");
      }
      candidate = suffixedCandidate;
    } else {
      candidate = initialCandidate;
    }

    const definition = yield* decodeSourceDefinition({
      $schema: "../schemas/automation.schema.json",
      schemaVersion: 1,
      id: candidate.automationId,
      name: input.name,
      spaceId: input.spaceId,
      // Creation never grants execution authority. Enabling is a separate save
      // and, for MCP callers, requires cc.automations.run on the same scope.
      enabled: false,
      trigger: input.trigger,
      nodes: input.nodes,
      edges: input.edges,
      layout: {
        ...input.layout,
        [AUTHORING_LAYOUT_KEY]: {
          requestId: input.requestId,
          requestDigest: creationRequestDigest,
        },
      },
      policy: { requireApprovalForExternalWrites: true },
    }).pipe(
      Effect.mapError((cause) => validationError("The new automation shape is invalid.", cause)),
    );
    const validated = validateAutomationDefinition(definition);
    if (!validated.ok) {
      return yield* validationError(
        `The new automation definition is invalid: ${validated.issues
          .map((issue) => issue.message)
          .join("; ")}`,
      );
    }
    const definitionDigest = digestAutomationDefinition(validated.definition);
    const intendedContents = sourceFileContents(definition);

    yield* requirePinnedBranch(checkout.configDirectory, checkout.branchRef, originalCommitSha);
    const rechecked = yield* inspectCandidate(candidate.automationId);
    if (rechecked.status !== "available") {
      return yield* conflictError("The new automation target changed before it was written.");
    }

    let committedSha: string | undefined;
    let committedBlobSha: string | undefined;
    let committedDefinition: CommandCenterAutomationSourceDefinitionType | undefined;
    let authoredTarget: AuthoredTargetIdentity | undefined;
    let wroteTarget = false;
    let indexUpdated = false;
    const commitFlow = Effect.gen(function* () {
      yield* writeNewAtomically(checkout.configDirectory, candidate.targetPath, intendedContents);
      wroteTarget = true;
      authoredTarget = yield* captureAuthoredTarget(candidate.targetPath, intendedContents);
      const commit = yield* commitFileWithPlumbing({
        configDirectory: checkout.configDirectory,
        parentCommitSha: originalCommitSha,
        relativePath: candidate.relativePath,
        contents: intendedContents,
        message: `Create automation ${candidate.automationId}`,
      });
      committedSha = commit.commitSha;
      committedBlobSha = commit.blobSha;
      yield* requireAuthoredTargetIdentity(candidate.targetPath, authoredTarget);
      const committedPaths = (yield* requireGitSuccess(
        checkout.configDirectory,
        ["diff-tree", "--no-commit-id", "--name-only", "-r", committedSha],
        "Could not verify the local automation config commit.",
      ))
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean);
      if (committedPaths.length !== 1 || committedPaths[0] !== candidate.relativePath) {
        return yield* persistenceError(
          "The local config commit included a file outside the new automation.",
        );
      }
      const committedMode = yield* requireGitSuccess(
        checkout.configDirectory,
        ["ls-tree", committedSha, "--", candidate.relativePath],
        "Could not verify the committed automation file mode.",
      );
      if (!SOURCE_FILE_MODE_PATTERN.test(committedMode)) {
        return yield* persistenceError(
          "The local automation commit did not contain a regular file.",
        );
      }
      const committedContents = yield* requireGitSuccess(
        checkout.configDirectory,
        ["show", `${committedSha}:${candidate.relativePath}`],
        "Could not verify the committed automation definition contents.",
      );
      if (committedContents !== intendedContents) {
        return yield* persistenceError(
          "The committed automation blob does not exactly match the service-owned bytes.",
        );
      }
      const committedParsed = yield* decodeUnknownJsonString(committedContents).pipe(
        Effect.mapError((cause) =>
          persistenceError("The committed automation definition is not valid JSON.", cause),
        ),
      );
      committedDefinition = yield* decodeSourceDefinition(committedParsed).pipe(
        Effect.mapError((cause) =>
          persistenceError("The committed automation definition has an invalid shape.", cause),
        ),
      );
      const committedValidation = validateAutomationDefinition(committedParsed);
      if (
        !committedValidation.ok ||
        digestAutomationDefinition(committedValidation.definition) !== definitionDigest
      ) {
        return yield* persistenceError(
          "The local commit contents did not match the validated new automation.",
        );
      }
      yield* recordAudit({
        operation: "created",
        requestId: input.requestId,
        automationId: candidate.automationId,
        spaceId: input.spaceId,
        previousConfigCommitSha: originalCommitSha,
        configCommitSha: committedSha,
        previousDefinitionDigest: null,
        definitionDigest,
      });
      yield* requireAuthoredTargetIdentity(candidate.targetPath, authoredTarget);
      yield* requirePinnedBranch(checkout.configDirectory, checkout.branchRef, originalCommitSha);
      yield* requireAuthoredTargetIdentity(candidate.targetPath, authoredTarget);
      yield* setRealIndexEntry(
        checkout.configDirectory,
        candidate.relativePath,
        commit.blobSha,
        null,
      );
      indexUpdated = true;
      yield* requireAuthoredTargetIdentity(candidate.targetPath, authoredTarget);
      yield* requirePinnedBranch(checkout.configDirectory, checkout.branchRef, originalCommitSha);
      // This CAS is intentionally the final effectful publication step. The
      // commit object and its audit record already exist before HEAD can move.
      yield* publishCommit(
        checkout.configDirectory,
        checkout.branchRef,
        committedSha,
        originalCommitSha,
      );
    });

    yield* Effect.uninterruptible(
      commitFlow.pipe(
        Effect.catch((cause) => {
          const localRollback: Effect.Effect<void, CommandCenterError> = wroteTarget
            ? authoredTarget === undefined
              ? Effect.fail(
                  conflictError(
                    "The new automation target could not be identity-bound; manual review is required.",
                  ),
                )
              : restoreCreatedTarget({
                  configDirectory: checkout.configDirectory,
                  relativePath: candidate.relativePath,
                  targetPath: candidate.targetPath,
                  authoredTarget,
                  indexUpdated,
                  ...(committedBlobSha === undefined ? {} : { authoredBlobSha: committedBlobSha }),
                })
            : Effect.void;
          const rollback = wroteTarget
            ? requireRollbackAuthority(
                checkout.configDirectory,
                checkout.branchRef,
                originalCommitSha,
              ).pipe(Effect.andThen(localRollback))
            : localRollback;
          return rollback.pipe(
            Effect.mapError((rollbackCause) =>
              rollbackCause.reason === "conflict"
                ? rollbackCause
                : persistenceError(
                    "Automation create failed and its local rollback also failed; manual review is required.",
                    { createCause: cause, rollbackCause },
                  ),
            ),
            Effect.andThen(Effect.fail(cause)),
          );
        }),
      ),
    );

    return {
      automationId: AutomationId.make(candidate.automationId),
      spaceId: input.spaceId,
      definition: committedDefinition!,
      definitionDigest,
      configCommitSha: committedSha!,
      authoringHealth: { status: "available" },
    } satisfies CommandCenterAutomationDefinitionSnapshot;
  });

  const create: AutomationDefinitionConfigShape["create"] = (input, recordAudit) =>
    writeLock.withPermits(1)(createUnlocked(input, recordAudit));

  const saveUnlocked = Effect.fn("AutomationDefinitionConfig.save")(function* <E, R>(
    input: CommandCenterAutomationDefinitionSaveInput,
    recordAudit: (input: AutomationDefinitionCommitAuditInput) => Effect.Effect<void, E, R>,
  ) {
    const source = yield* loadSource(input);
    yield* ensureTargetClean(source);

    if (input.definition.id !== input.automationId || input.definition.spaceId !== input.spaceId) {
      return yield* validationError(
        "Automation identity and Space cannot be changed while saving.",
      );
    }

    const decodedInputDefinition = yield* decodeSourceDefinition(input.definition).pipe(
      Effect.mapError((cause) =>
        validationError("The automation definition has an invalid editable shape.", cause),
      ),
    );
    const nextDefinition = preservePrivateSourceFields(source.definition, decodedInputDefinition);
    const prepared = prepareAutomationSave({
      expectedDigest: input.expectedDefinitionDigest as AutomationDefinitionDigest,
      currentDefinition: source.definition,
      nextDefinition,
    });
    if (prepared.status === "conflict") {
      return yield* conflictError(
        "The committed automation changed after it was opened. Reload before saving.",
      );
    }
    if (prepared.status === "invalid") {
      return yield* validationError(
        `The ${prepared.target} automation definition is invalid: ${prepared.issues
          .map((issue) => issue.message)
          .join("; ")}`,
      );
    }
    if (prepared.nextDigest === source.definitionDigest) {
      return toSnapshot(source, yield* readAuthoringHealth(source.configDirectory));
    }

    yield* requirePinnedBranch(source.configDirectory, source.branchRef, source.commitSha);
    yield* ensureTargetClean(source);

    const intendedContents = sourceFileContents(nextDefinition);
    let targetTransaction: AuthoredTargetTransaction | undefined;
    let committedSha: string | undefined;
    let committedBlobSha: string | undefined;
    let committedDefinition: CommandCenterAutomationSourceDefinitionType | undefined;
    let indexUpdated = false;
    const commitFlow = Effect.gen(function* () {
      const installed = yield* installTargetWithPreservation(source, intendedContents);
      targetTransaction = installed;
      const authoredTarget = installed.authoredTarget;
      const commit = yield* commitFileWithPlumbing({
        configDirectory: source.configDirectory,
        parentCommitSha: source.commitSha,
        relativePath: source.relativePath,
        contents: intendedContents,
        message: `Update automation ${input.automationId}`,
      });
      committedSha = commit.commitSha;
      committedBlobSha = commit.blobSha;
      yield* requireAtomicTargetIdentity(source.targetPath, authoredTarget);
      const committedPaths = (yield* requireGitSuccess(
        source.configDirectory,
        ["diff-tree", "--no-commit-id", "--name-only", "-r", committedSha],
        "Could not verify the local automation config commit.",
      ))
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean);
      if (committedPaths.length !== 1 || committedPaths[0] !== source.relativePath) {
        return yield* persistenceError(
          "The local config commit included a file outside the selected automation.",
        );
      }

      const committedContents = yield* requireGitSuccess(
        source.configDirectory,
        ["show", `${committedSha}:${source.relativePath}`],
        "Could not verify the committed automation definition contents.",
      );
      if (committedContents !== intendedContents) {
        return yield* persistenceError(
          "The committed automation blob does not exactly match the service-owned bytes.",
        );
      }
      const committedParsed = yield* decodeUnknownJsonString(committedContents).pipe(
        Effect.mapError((cause) =>
          persistenceError("The committed automation definition is not valid JSON.", cause),
        ),
      );
      committedDefinition = yield* decodeSourceDefinition(committedParsed).pipe(
        Effect.mapError((cause) =>
          persistenceError("The committed automation definition has an invalid shape.", cause),
        ),
      );
      const committedValidation = validateAutomationDefinition(committedParsed);
      if (!committedValidation.ok) {
        return yield* persistenceError(
          "The local commit contains an invalid automation definition.",
        );
      }
      if (
        digestAutomationDefinition(committedValidation.definition) !== prepared.nextDigest ||
        committedDefinition.$schema !== source.definition.$schema ||
        canonicalJson(committedDefinition.policy) !== canonicalJson(source.definition.policy)
      ) {
        return yield* persistenceError(
          "The local commit contents did not match the validated automation definition.",
        );
      }

      yield* recordAudit({
        operation: "updated",
        automationId: input.automationId,
        spaceId: input.spaceId,
        previousConfigCommitSha: source.commitSha,
        configCommitSha: committedSha,
        previousDefinitionDigest: source.definitionDigest,
        definitionDigest: prepared.nextDigest,
      });
      yield* requireAtomicTargetIdentity(source.targetPath, authoredTarget);
      yield* requirePinnedBranch(source.configDirectory, source.branchRef, source.commitSha);
      yield* setRealIndexEntry(
        source.configDirectory,
        source.relativePath,
        commit.blobSha,
        source.blobSha,
      );
      indexUpdated = true;
      yield* requireAtomicTargetIdentity(source.targetPath, authoredTarget);
      yield* requirePinnedBranch(source.configDirectory, source.branchRef, source.commitSha);
      yield* requireAtomicTargetIdentity(source.targetPath, authoredTarget);
      // Keep publication last: a visible config commit must already have an
      // append-only audit record for the exact definition digest.
      yield* publishCommit(
        source.configDirectory,
        source.branchRef,
        committedSha,
        source.commitSha,
      );
    });

    yield* Effect.uninterruptible(
      commitFlow.pipe(
        Effect.catch((cause) => {
          if (targetTransaction === undefined) return Effect.fail(cause);
          return requireRollbackAuthority(
            source.configDirectory,
            source.branchRef,
            source.commitSha,
          ).pipe(
            Effect.andThen(
              restoreTarget(source, targetTransaction, committedBlobSha, indexUpdated),
            ),
            Effect.mapError((rollbackCause) =>
              rollbackCause.reason === "conflict"
                ? rollbackCause
                : persistenceError(
                    "Automation save failed and its local rollback also failed; manual review is required.",
                    { saveCause: cause, rollbackCause },
                  ),
            ),
            Effect.andThen(Effect.fail(cause)),
          );
        }),
      ),
    );

    return {
      automationId: input.automationId,
      spaceId: input.spaceId,
      definition: committedDefinition!,
      definitionDigest: prepared.nextDigest,
      configCommitSha: committedSha!,
      authoringHealth: { status: "available" },
    } satisfies CommandCenterAutomationDefinitionSnapshot;
  });

  const save: AutomationDefinitionConfigShape["save"] = (input, recordAudit) =>
    writeLock.withPermits(1)(saveUnlocked(input, recordAudit));

  return AutomationDefinitionConfig.of({ authoringHealth, create, get, save });
});

export const layer = Layer.effect(AutomationDefinitionConfig, make);
