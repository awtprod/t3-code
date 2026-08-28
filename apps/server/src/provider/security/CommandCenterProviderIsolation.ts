// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeModule from "node:module";

import type { ProviderDriverKind, RuntimeMode, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { trustedHostExecutablePath, unsafeHostGitConfigKey } from "../../vcs/HostGitSecurity.ts";

export const COMMAND_CENTER_THREAD_ID_PREFIX = "cc:";
export const COMMAND_CENTER_INTERACTIVE_THREAD_ID_PREFIX = "cc:interactive:";
export const COMMAND_CENTER_AUTOMATION_THREAD_ID_PREFIX = "cc:automation:";
export const COMMAND_CENTER_ROUTER_THREAD_ID_PREFIX = "cc:router:";

export type CommandCenterExecutionClass = "router" | "interactive" | "automation" | "legacy";

export const COMMAND_CENTER_CODEX_READ_PERMISSION_PROFILE = "command-center-isolated-read-v1";
export const COMMAND_CENTER_CODEX_WRITE_PERMISSION_PROFILE = "command-center-isolated-write-v1";

const COMMAND_CENTER_CODEX_LINUX_RUNTIME_ALIASES = [
  "codex-linux-sandbox",
  "apply_patch",
  "applypatch",
  "codex-execve-wrapper",
] as const;
const COMMAND_CENTER_CODEX_DARWIN_RUNTIME_ALIASES = [
  "apply_patch",
  "applypatch",
  "codex-execve-wrapper",
] as const;

const MAX_LOCAL_GIT_CONFIG_BYTES = FileSystem.Size(1024 * 1024);

interface SecureControlFileIdentity {
  readonly type: FileSystem.File.Type;
  readonly dev: number;
  readonly ino: number | undefined;
  readonly mode: number;
  readonly nlink: number | undefined;
  readonly uid: number | undefined;
  readonly size: string;
  readonly mtimeMs: number | undefined;
}

function secureControlFileIdentity(info: FileSystem.File.Info): SecureControlFileIdentity {
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

function sameControlFileIdentity(
  left: SecureControlFileIdentity,
  right: SecureControlFileIdentity,
): boolean {
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

export interface CommandCenterCodexIsolation {
  readonly permissionProfile: string;
  readonly appServerArgs: ReadonlyArray<string>;
  readonly windowsSandboxMode?: "elevated";
}

export interface CommandCenterManagedGitMetadata {
  readonly dotGitPath: string;
  readonly worktreeGitDir: string;
  readonly commonGitDir: string;
}

const COMMAND_CENTER_PROVIDER_ENV_PASSTHROUGH = [
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "SYSTEMROOT",
  "WINDIR",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "TZ",
] as const;

const COMMAND_CENTER_SHELL_ENV_INCLUDE_ONLY = [
  ...COMMAND_CENTER_PROVIDER_ENV_PASSTHROUGH,
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "GIT_OPTIONAL_LOCKS",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_TERMINAL_PROMPT",
  "GCM_INTERACTIVE",
] as const;

export interface CommandCenterProviderEnvironmentInput {
  readonly source: NodeJS.ProcessEnv;
  readonly homePath: string;
  readonly helperBinPath: string;
  /** Optional packaged-tool directory next to the admitted native Codex runtime. */
  readonly runtimeSupportPath?: string;
  readonly tempPath: string;
  readonly xdgConfigPath: string;
  readonly xdgCachePath: string;
  readonly xdgDataPath: string;
  readonly appDataPath: string;
  readonly localAppDataPath: string;
  /** Host roots the provider can mutate and which must never contribute PATH tools. */
  readonly writableRoots: ReadonlyArray<string>;
  readonly mcpBearerToken?: string;
}

function readEnvironmentValue(source: NodeJS.ProcessEnv, expectedName: string): string | undefined {
  const direct = source[expectedName];
  if (direct !== undefined) return direct;
  const match = Object.entries(source).find(
    ([name, value]) => value !== undefined && name.toUpperCase() === expectedName,
  );
  return match?.[1];
}

/** Construct the complete, allowlisted environment for a Command Center Codex process. */
export function commandCenterProviderEnvironment(
  input: CommandCenterProviderEnvironmentInput,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of COMMAND_CENTER_PROVIDER_ENV_PASSTHROUGH) {
    const value = readEnvironmentValue(input.source, name);
    if (value !== undefined) environment[name] = value;
  }
  const trustedPath = trustedHostExecutablePath({
    sourceEnvironment:
      input.runtimeSupportPath === undefined
        ? input.source
        : {
            ...input.source,
            PATH: [input.runtimeSupportPath, readEnvironmentValue(input.source, "PATH")]
              .filter((entry): entry is string => entry !== undefined)
              .join(NodePath.delimiter),
          },
    writableRoots: input.writableRoots,
  });
  const providerPath = [input.helperBinPath, ...trustedPath.split(NodePath.delimiter)]
    .filter((component) => component.length > 0 && NodePath.isAbsolute(component))
    .join(NodePath.delimiter);
  return {
    ...environment,
    PATH: providerPath.length > 0 ? providerPath : "/dev/null",
    CODEX_HOME: input.homePath,
    HOME: input.homePath,
    USERPROFILE: input.homePath,
    APPDATA: input.appDataPath,
    LOCALAPPDATA: input.localAppDataPath,
    XDG_CONFIG_HOME: input.xdgConfigPath,
    XDG_CACHE_HOME: input.xdgCachePath,
    XDG_DATA_HOME: input.xdgDataPath,
    TMPDIR: input.tempPath,
    TMP: input.tempPath,
    TEMP: input.tempPath,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    ...(input.mcpBearerToken === undefined ? {} : { T3_MCP_BEARER_TOKEN: input.mcpBearerToken }),
  };
}

export class CommandCenterManagedWorktreeIsolationError extends Schema.TaggedErrorClass<CommandCenterManagedWorktreeIsolationError>()(
  "CommandCenterManagedWorktreeIsolationError",
  {
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.issue;
  }
}

export class CommandCenterCodexHomeIsolationError extends Schema.TaggedErrorClass<CommandCenterCodexHomeIsolationError>()(
  "CommandCenterCodexHomeIsolationError",
  {
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.issue;
  }
}

export interface CommandCenterManagedWorktreeInput {
  readonly baseDir: string;
  readonly worktreesDir: string;
  readonly cwd: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

export interface CommandCenterCodexHomeLayout {
  readonly homePath: string;
  readonly helperBinPath: string;
  readonly tempPath: string;
  readonly xdgConfigPath: string;
  readonly xdgCachePath: string;
  readonly xdgDataPath: string;
  readonly appDataPath: string;
  readonly localAppDataPath: string;
}

export interface PrepareCommandCenterCodexHomeInput {
  readonly stateDir: string;
  readonly sourceHomePath: string;
  readonly threadId: ThreadId | string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly crypto: Crypto.Crypto;
  readonly runtimeExecutablePath: string;
  readonly platform: NodeJS.Platform;
  /** Canonicalized below; the native runtime must not be replaceable by a provider turn. */
  readonly writableRoots: ReadonlyArray<string>;
}

export interface ResolveCommandCenterCodexRuntimeInput {
  readonly commandPath: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

export function isCommandCenterThreadId(threadId: ThreadId | string): boolean {
  return String(threadId).startsWith(COMMAND_CENTER_THREAD_ID_PREFIX);
}

export function commandCenterExecutionClass(
  threadId: ThreadId | string,
): CommandCenterExecutionClass | undefined {
  const value = String(threadId);
  if (value.startsWith(COMMAND_CENTER_ROUTER_THREAD_ID_PREFIX)) return "router";
  if (value.startsWith(COMMAND_CENTER_INTERACTIVE_THREAD_ID_PREFIX)) return "interactive";
  if (value.startsWith(COMMAND_CENTER_AUTOMATION_THREAD_ID_PREFIX)) return "automation";
  return value.startsWith(COMMAND_CENTER_THREAD_ID_PREFIX) ? "legacy" : undefined;
}

export function commandCenterProviderPlatformIssue(
  platform: NodeJS.Platform,
  threadId: ThreadId | string,
): string | undefined {
  if (platform === "linux") return undefined;
  if (
    (platform === "darwin" || platform === "win32") &&
    (commandCenterExecutionClass(threadId) === "interactive" ||
      commandCenterExecutionClass(threadId) === "router")
  ) {
    return undefined;
  }
  if (platform === "darwin" || platform === "win32") {
    return "Unattended Command Center automation currently requires a verified Linux host; native macOS and Windows support is limited to user-started chats.";
  }
  return `Command Center provider isolation is not supported on '${platform}'.`;
}

export function commandCenterProviderIsolationIssue(input: {
  readonly threadId: ThreadId | string;
  readonly provider: ProviderDriverKind | string;
  readonly runtimeMode: RuntimeMode;
}): string | undefined {
  if (!isCommandCenterThreadId(input.threadId)) return undefined;
  if (
    commandCenterExecutionClass(input.threadId) === "router" &&
    input.runtimeMode !== "approval-required"
  ) {
    return "Command Center router threads are permanently read-only.";
  }
  if (String(input.provider) !== "codex" && String(input.provider) !== "kimi") {
    return "Command Center runs require Codex or a verified native Kimi provider because the selected provider does not expose a host-filesystem isolation profile.";
  }
  if (input.runtimeMode === "full-access") {
    return "Command Center runs cannot use full-access provider sessions.";
  }
  return undefined;
}

function permissionProfileToml(input: {
  readonly description: string;
  readonly workspaceAccess: "read" | "write";
  readonly managedGitMetadata?: CommandCenterManagedGitMetadata;
  readonly runtimeExecutablePath: string;
  readonly codexHome: Pick<CommandCenterCodexHomeLayout, "homePath" | "helperBinPath">;
}): string {
  const access = input.workspaceAccess;
  const managedGitEntries =
    input.managedGitMetadata === undefined
      ? ""
      : `,${JSON.stringify(input.managedGitMetadata.dotGitPath)}="read",${JSON.stringify(input.managedGitMetadata.commonGitDir)}="read"`;
  const privateHomeEntries = `,${JSON.stringify(input.codexHome.homePath)}="deny",${JSON.stringify(input.codexHome.helperBinPath)}="read"`;
  const runtimeExecutableEntry = `,${JSON.stringify(input.runtimeExecutablePath)}="read"`;
  return [
    `{description=${JSON.stringify(input.description)}`,
    `filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="${access}"}${privateHomeEntries}${managedGitEntries}${runtimeExecutableEntry}}`,
    "network={enabled=false}}",
  ].join(",");
}

function shellEnvironmentPolicyToml(): string {
  const includeOnly = COMMAND_CENTER_SHELL_ENV_INCLUDE_ONLY.map((name) =>
    JSON.stringify(name),
  ).join(",");
  return `{inherit="all",ignore_default_excludes=false,include_only=[${includeOnly}],set={GIT_OPTIONAL_LOCKS="0",GIT_CONFIG_NOSYSTEM="1",GIT_TERMINAL_PROMPT="0",GCM_INTERACTIVE="never"}}`;
}

function isNotFound(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === "NotFound";
}

function isWithinRoot(path: Path.Path, candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function isSameResolvedPath(path: Path.Path, left: string, right: string): boolean {
  return path.relative(left, right) === "" && path.relative(right, left) === "";
}

function safeManagedComponent(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function singleLine(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.includes("\0") || /[\r\n]/u.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function pointerPath(input: {
  readonly path: Path.Path;
  readonly parent: string;
  readonly raw: string;
}): string | undefined {
  const value = singleLine(input.raw);
  if (value === undefined) return undefined;
  return input.path.resolve(input.parent, value);
}

function managedWorktreeError(
  issue: string,
  cause?: unknown,
): CommandCenterManagedWorktreeIsolationError {
  return new CommandCenterManagedWorktreeIsolationError({
    issue,
    ...(cause === undefined ? {} : { cause }),
  });
}

function codexHomeError(issue: string, cause?: unknown): CommandCenterCodexHomeIsolationError {
  return new CommandCenterCodexHomeIsolationError({
    issue,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** Resolve the native executable behind the official Codex npm launcher without executing it. */
export const resolveCommandCenterCodexRuntimeExecutable = Effect.fn(
  "CommandCenterProviderIsolation.resolveCodexRuntimeExecutable",
)(function* (input: ResolveCommandCenterCodexRuntimeInput) {
  const { fileSystem, path } = input;
  const canonicalCommandPath = yield* fileSystem
    .realPath(input.commandPath)
    .pipe(
      Effect.mapError((cause) =>
        codexHomeError("Command Center could not canonicalize the Codex runtime launcher.", cause),
      ),
    );
  if (
    (input.platform === "win32" && path.extname(canonicalCommandPath).toLowerCase() === ".exe") ||
    (input.platform !== "win32" && path.basename(canonicalCommandPath) !== "codex.js")
  ) {
    return canonicalCommandPath;
  }
  const targets: Readonly<
    Record<string, readonly [packageName: string, triple: string, executableName: string]>
  > = {
    "linux:arm64": ["@openai/codex-linux-arm64", "aarch64-unknown-linux-musl", "codex"],
    "linux:x64": ["@openai/codex-linux-x64", "x86_64-unknown-linux-musl", "codex"],
    "darwin:arm64": ["@openai/codex-darwin-arm64", "aarch64-apple-darwin", "codex"],
    "darwin:x64": ["@openai/codex-darwin-x64", "x86_64-apple-darwin", "codex"],
    "win32:arm64": ["@openai/codex-win32-arm64", "aarch64-pc-windows-msvc", "codex.exe"],
    "win32:x64": ["@openai/codex-win32-x64", "x86_64-pc-windows-msvc", "codex.exe"],
  };
  const target = targets[`${input.platform}:${input.architecture}`];
  if (target === undefined) {
    return yield* codexHomeError(
      `Command Center does not support the '${input.architecture}' ${input.platform} Codex runtime architecture.`,
    );
  }
  const codexLauncherPath =
    path.basename(canonicalCommandPath) === "codex.js"
      ? canonicalCommandPath
      : path.join(
          path.dirname(canonicalCommandPath),
          "node_modules",
          "@openai",
          "codex",
          "bin",
          "codex.js",
        );
  if (!(yield* fileSystem.exists(codexLauncherPath))) {
    return yield* codexHomeError(
      "Command Center requires the official native Codex package; the configured launcher does not have a verifiable @openai/codex installation.",
    );
  }
  const [packageName, triple, executableName] = target;
  const packageJsonPath = yield* Effect.try({
    try: () => NodeModule.createRequire(codexLauncherPath).resolve(`${packageName}/package.json`),
    catch: (cause) =>
      codexHomeError(
        `Command Center could not resolve the native ${packageName} package. Reinstall or update @openai/codex.`,
        cause,
      ),
  });
  const platformVendorRoot = path.join(path.dirname(packageJsonPath), "vendor", triple);
  const nativeExecutableCandidates = [
    path.join(platformVendorRoot, "bin", executableName),
    path.join(platformVendorRoot, "codex", executableName),
  ];
  for (const candidate of nativeExecutableCandidates) {
    if (yield* fileSystem.exists(candidate)) {
      return yield* fileSystem
        .realPath(candidate)
        .pipe(
          Effect.mapError((cause) =>
            codexHomeError("Command Center could not canonicalize the native codex.exe.", cause),
          ),
        );
    }
  }
  return yield* codexHomeError(
    `Command Center found the ${input.platform} Codex package but not its native ${executableName}. Reinstall @openai/codex with optional dependencies enabled.`,
  );
});

function isNotSymlink(error: PlatformError.PlatformError): boolean {
  const cause = error.reason.cause;
  return (
    error.reason._tag === "Unknown" &&
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "EINVAL"
  );
}

/**
 * Prepare a per-thread Codex home under runtime storage. Only authentication is
 * copied from the user's normal Codex home; config, plugins, skills, and session
 * state are never imported.
 */
export const prepareCommandCenterCodexHome = Effect.fn(
  "CommandCenterProviderIsolation.prepareCodexHome",
)(function* (input: PrepareCommandCenterCodexHomeInput) {
  const { fileSystem, path } = input;
  const threadDigest = Encoding.encodeHex(
    yield* input.crypto
      .digest("SHA-256", new TextEncoder().encode(String(input.threadId)))
      .pipe(
        Effect.mapError((cause) =>
          codexHomeError("Command Center could not derive its isolated Codex home.", cause),
        ),
      ),
  );
  const digest = Encoding.encodeHex(
    yield* input.crypto
      .digest(
        "SHA-256",
        new TextEncoder().encode(
          input.platform === "win32" ? "windows-control-v1" : String(input.threadId),
        ),
      )
      .pipe(
        Effect.mapError((cause) =>
          codexHomeError("Command Center could not derive its isolated Codex home.", cause),
        ),
      ),
  );
  const canonicalStateDir = yield* fileSystem
    .realPath(input.stateDir)
    .pipe(
      Effect.mapError((cause) =>
        codexHomeError("Command Center could not canonicalize its runtime state directory.", cause),
      ),
    );
  const homesRoot = path.join(canonicalStateDir, "provider-homes", "codex-command-center");
  const homePath = path.join(homesRoot, digest);
  const codexTempPath = path.join(homePath, "tmp");
  const threadStatePath =
    input.platform === "win32" ? path.join(homePath, "thread-state", threadDigest) : homePath;
  const layout = {
    homePath,
    helperBinPath: path.join(homePath, "provider-bin"),
    tempPath: path.join(threadStatePath, "tmp"),
    xdgConfigPath: path.join(threadStatePath, "xdg-config"),
    xdgCachePath: path.join(threadStatePath, "xdg-cache"),
    xdgDataPath: path.join(threadStatePath, "xdg-data"),
    appDataPath: path.join(threadStatePath, "app-data"),
    localAppDataPath: path.join(threadStatePath, "local-app-data"),
  } satisfies CommandCenterCodexHomeLayout;

  const makePrivateDirectory = (directoryPath: string) =>
    fileSystem.makeDirectory(directoryPath, { recursive: true, mode: 0o700 }).pipe(
      Effect.andThen(fileSystem.chmod(directoryPath, 0o700)),
      Effect.mapError((cause) =>
        codexHomeError("Command Center could not create its isolated Codex home.", cause),
      ),
    );
  yield* Effect.forEach(
    [
      homesRoot,
      layout.homePath,
      codexTempPath,
      threadStatePath,
      layout.helperBinPath,
      layout.tempPath,
      layout.xdgConfigPath,
      layout.xdgCachePath,
      layout.xdgDataPath,
      layout.appDataPath,
      layout.localAppDataPath,
    ],
    makePrivateDirectory,
    { concurrency: 1, discard: true },
  );

  const canonicalHomesRoot = yield* fileSystem
    .realPath(homesRoot)
    .pipe(
      Effect.mapError((cause) =>
        codexHomeError("Command Center could not verify its isolated Codex home root.", cause),
      ),
    );
  const canonicalHomePath = yield* fileSystem
    .realPath(layout.homePath)
    .pipe(
      Effect.mapError((cause) =>
        codexHomeError("Command Center could not verify its isolated Codex home.", cause),
      ),
    );
  if (
    !isSameResolvedPath(path, canonicalHomesRoot, homesRoot) ||
    !isSameResolvedPath(path, canonicalHomePath, layout.homePath) ||
    !isWithinRoot(path, canonicalHomePath, canonicalHomesRoot)
  ) {
    return yield* codexHomeError("Command Center's isolated Codex home contains a symlink escape.");
  }

  const optionalStat = (target: string) =>
    fileSystem.stat(target).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        PlatformError: (cause) =>
          isNotFound(cause)
            ? Effect.succeed(Option.none())
            : Effect.fail(
                codexHomeError("Command Center could not inspect its isolated Codex home.", cause),
              ),
      }),
    );
  // Fail closed only on `config.toml`: Codex never writes one itself, so its
  // presence in a reused isolated home is a genuine ambient-config injection
  // signal. `plugins`/`marketplaces` are NOT tripwires — Codex 0.144.x syncs a
  // curated-plugin cache into CODEX_HOME on startup even with
  // `features.remote_plugin=false` / `plugins={}` set, so a reused home always
  // contains `plugins/` after its first session. Plugin/marketplace *loading* is
  // already disabled by the isolation appServerArgs and constrained by the
  // sandbox permission profile (verified live by verifyCommandCenterCodexIsolation
  // before every turn), so the on-disk cache is inert. (`skills/`, also created
  // by Codex, has always been tolerated here for the same reason.)
  for (const forbiddenEntry of ["config.toml"] as const) {
    if (Option.isSome(yield* optionalStat(path.join(layout.homePath, forbiddenEntry)))) {
      return yield* codexHomeError(
        `Command Center refuses an isolated Codex home containing '${forbiddenEntry}'.`,
      );
    }
  }

  const canonicalRuntimeExecutable = yield* fileSystem
    .realPath(input.runtimeExecutablePath)
    .pipe(
      Effect.mapError((cause) =>
        codexHomeError("Command Center could not verify its Codex runtime executable.", cause),
      ),
    );
  const runtimeStat = yield* fileSystem
    .stat(canonicalRuntimeExecutable)
    .pipe(
      Effect.mapError((cause) =>
        codexHomeError("Command Center could not inspect its Codex runtime executable.", cause),
      ),
    );
  if (
    runtimeStat.type !== "File" ||
    (input.platform !== "win32" && (runtimeStat.mode & 0o111) === 0)
  ) {
    return yield* codexHomeError(
      "Command Center requires the Codex runtime to be a regular executable file.",
    );
  }
  const runtimeHeader = yield* Effect.scoped(
    Effect.gen(function* () {
      const runtimeFile = yield* fileSystem.open(canonicalRuntimeExecutable, { flag: "r" });
      return yield* runtimeFile.readAlloc(4);
    }),
  ).pipe(
    Effect.mapError((cause) =>
      codexHomeError("Command Center could not inspect its Codex runtime format.", cause),
    ),
  );
  const header = Option.getOrUndefined(runtimeHeader);
  const headerMagic = header === undefined ? "" : Encoding.encodeHex(header);
  const expectedNativeFormat =
    (input.platform === "linux" && headerMagic === "7f454c46") ||
    (input.platform === "darwin" &&
      [
        "feedface",
        "feedfacf",
        "cefaedfe",
        "cffaedfe",
        "cafebabe",
        "bebafeca",
        "cafebabf",
        "bfbafeca",
      ].includes(headerMagic)) ||
    (input.platform === "win32" && header?.[0] === 0x4d && header[1] === 0x5a);
  if (!expectedNativeFormat) {
    return yield* codexHomeError(
      `Command Center requires a native Codex runtime for '${input.platform}'; script, shim, and cross-platform launchers are blocked.`,
    );
  }
  const canonicalWritableRoots = yield* Effect.forEach(
    input.writableRoots,
    (root) =>
      fileSystem
        .realPath(root)
        .pipe(
          Effect.mapError((cause) =>
            codexHomeError("Command Center could not verify a provider-writable root.", cause),
          ),
        ),
    { concurrency: 1 },
  );
  if (canonicalWritableRoots.some((root) => isWithinRoot(path, canonicalRuntimeExecutable, root))) {
    return yield* codexHomeError(
      "Command Center refuses a Codex runtime located under a provider-writable root.",
    );
  }
  const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const writePrivateFile = Effect.fn("CommandCenterProviderIsolation.writePrivateFile")(function* (
    targetPath: string,
    contents: Uint8Array,
    mode: number,
  ) {
    const temporaryPath = path.join(
      path.dirname(targetPath),
      `.cc-${yield* input.crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) =>
          codexHomeError("Command Center could not stage its native sandbox helper.", cause),
        ),
      )}.tmp`,
    );
    yield* fileSystem.writeFile(temporaryPath, contents, { flag: "wx", mode }).pipe(
      Effect.andThen(fileSystem.chmod(temporaryPath, mode)),
      Effect.andThen(fileSystem.rename(temporaryPath, targetPath)),
      Effect.andThen(fileSystem.chmod(targetPath, mode)),
      Effect.mapError((cause) =>
        codexHomeError("Command Center could not install its native sandbox helper.", cause),
      ),
      Effect.ensuring(fileSystem.remove(temporaryPath, { force: true }).pipe(Effect.ignore)),
    );
  });
  yield* writePrivateFile(
    path.join(layout.homePath, ".cc-provider-isolation-canary"),
    new TextEncoder().encode("Command Center private provider state.\n"),
    0o600,
  );

  if (input.platform === "linux" || input.platform === "darwin") {
    const expectedEnv = "/usr/bin/env";
    const expectedBash = input.platform === "linux" ? "/usr/bin/bash" : "/bin/bash";
    const [canonicalEnv, canonicalBash, canonicalNetcat] = yield* Effect.all([
      fileSystem.realPath(expectedEnv),
      fileSystem.realPath(expectedBash),
      input.platform === "darwin" ? fileSystem.realPath("/usr/bin/nc") : Effect.void,
    ]).pipe(
      Effect.mapError((cause) =>
        codexHomeError(
          `Command Center requires canonical ${expectedEnv} and ${expectedBash} helpers on ${input.platform}.`,
          cause,
        ),
      ),
    );
    if (
      canonicalEnv !== expectedEnv ||
      canonicalBash !== expectedBash ||
      (input.platform === "darwin" && canonicalNetcat !== "/usr/bin/nc")
    ) {
      return yield* codexHomeError(
        `Command Center refuses non-canonical ${input.platform} environment or shell helpers.`,
      );
    }
    const aliases =
      input.platform === "linux"
        ? COMMAND_CENTER_CODEX_LINUX_RUNTIME_ALIASES
        : COMMAND_CENTER_CODEX_DARWIN_RUNTIME_ALIASES;
    const helperWrapper = (alias: (typeof aliases)[number]) =>
      [
        `#!${expectedBash}`,
        "set -euo pipefail",
        `canonical_codex=${shellQuote(canonicalRuntimeExecutable)}`,
        `isolated_home=${shellQuote(layout.homePath)}`,
        `exec ${expectedEnv} -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$isolated_home" LANG=C.UTF-8 ${expectedBash} -c 'exec -a ${alias} "$@"' _ "$canonical_codex" "$@"`,
        "",
      ].join("\n");
    yield* Effect.forEach(
      aliases,
      (alias) =>
        writePrivateFile(
          path.join(layout.helperBinPath, alias),
          new TextEncoder().encode(helperWrapper(alias)),
          0o500,
        ),
      { concurrency: 1, discard: true },
    );
  } else if (input.platform === "win32") {
    const escapedRuntime = canonicalRuntimeExecutable.replaceAll("%", "%%");
    const applyPatchWrapper = new TextEncoder().encode(
      `@echo off\r\n"${escapedRuntime}" --codex-run-as-apply-patch %*\r\n`,
    );
    yield* Effect.forEach(
      ["apply_patch.bat", "applypatch.bat"],
      (alias) => writePrivateFile(path.join(layout.helperBinPath, alias), applyPatchWrapper, 0o600),
      { concurrency: 1, discard: true },
    );
  }
  if (input.platform !== "win32") {
    // Codex normally creates an argv0 alias under this path. A mode-000 regular
    // file makes that update fail closed and forces the documented PATH helper
    // lookup, where the scrubbed wrapper above is first.
    yield* writePrivateFile(path.join(codexTempPath, "arg0"), new Uint8Array(), 0o000);
  }

  const sourceAuthPath = path.join(path.resolve(input.sourceHomePath), "auth.json");
  const targetAuthPath = path.join(layout.homePath, "auth.json");
  const sourceAuthStat = yield* optionalStat(sourceAuthPath);
  if (Option.isSome(sourceAuthStat)) {
    if (sourceAuthStat.value.type !== "File") {
      return yield* codexHomeError(
        "Command Center's source Codex authentication entry is not a file.",
      );
    }
    const auth = yield* fileSystem
      .readFile(sourceAuthPath)
      .pipe(
        Effect.mapError((cause) =>
          codexHomeError("Command Center could not read Codex authentication state.", cause),
        ),
      );
    const temporaryAuthPath = path.join(
      layout.homePath,
      `.auth-${yield* input.crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) =>
          codexHomeError("Command Center could not stage isolated Codex authentication.", cause),
        ),
      )}.tmp`,
    );
    yield* fileSystem.writeFile(temporaryAuthPath, auth, { flag: "wx", mode: 0o600 }).pipe(
      Effect.andThen(fileSystem.chmod(temporaryAuthPath, 0o600)),
      Effect.andThen(fileSystem.rename(temporaryAuthPath, targetAuthPath)),
      Effect.andThen(fileSystem.chmod(targetAuthPath, 0o600)),
      Effect.mapError((cause) =>
        codexHomeError("Command Center could not copy Codex authentication privately.", cause),
      ),
      Effect.ensuring(fileSystem.remove(temporaryAuthPath, { force: true }).pipe(Effect.ignore)),
    );
  }

  const targetAuthStat = yield* optionalStat(targetAuthPath);
  if (Option.isNone(targetAuthStat)) {
    // Fail closed. Without `auth.json` the session still starts, and the first
    // model call fails far downstream as an opaque provider 401 that says
    // nothing about which home Command Center actually read.
    return yield* codexHomeError(
      `Command Center found no Codex credentials to isolate: ${sourceAuthPath} does not exist. ` +
        "Sign in with Codex for this identity, or point the provider instance's CODEX_HOME " +
        "setting at the home that holds its auth.json.",
    );
  }
  if (targetAuthStat.value.type !== "File") {
    return yield* codexHomeError(
      "Command Center's isolated Codex authentication entry is not a private file.",
    );
  }
  const linkState = yield* fileSystem.readLink(targetAuthPath).pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (cause) =>
        isNotSymlink(cause)
          ? Effect.succeed(Option.none())
          : Effect.fail(
              codexHomeError(
                "Command Center could not verify isolated Codex authentication.",
                cause,
              ),
            ),
    }),
  );
  if (Option.isSome(linkState)) {
    return yield* codexHomeError("Command Center refuses symlinked isolated Codex authentication.");
  }
  yield* fileSystem
    .chmod(targetAuthPath, 0o600)
    .pipe(
      Effect.mapError((cause) =>
        codexHomeError("Command Center could not protect isolated Codex authentication.", cause),
      ),
    );

  return layout;
});

/**
 * Resolve the one extra filesystem grant needed by a linked Git worktree.
 *
 * Command Center only trusts worktrees under its runtime base directory and only
 * when their canonical Git metadata belongs to a managed checkout with the exact
 * shape `<baseDir>/repositories/<digest>/.git`. Any linked worktree outside this
 * topology is rejected instead of inheriting ambient repository access.
 */
export const resolveCommandCenterManagedGitMetadata = Effect.fn(
  "CommandCenterProviderIsolation.resolveManagedGitMetadata",
)(function* (input: CommandCenterManagedWorktreeInput) {
  const { fileSystem, path } = input;
  const canonicalize = (target: string, issue: string) =>
    fileSystem
      .realPath(target)
      .pipe(Effect.mapError((cause) => managedWorktreeError(issue, cause)));
  const read = (target: string, issue: string) =>
    fileSystem
      .readFileString(target)
      .pipe(Effect.mapError((cause) => managedWorktreeError(issue, cause)));
  const statOptional = (target: string) =>
    fileSystem.stat(target).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        PlatformError: (cause) =>
          isNotFound(cause)
            ? Effect.succeed(Option.none())
            : Effect.fail(
                managedWorktreeError(
                  "Command Center could not inspect the workspace Git metadata.",
                  cause,
                ),
              ),
      }),
    );
  const requireSingleLinkControlFile = Effect.fn(
    "CommandCenterProviderIsolation.requireSingleLinkControlFile",
  )(function* (target: string, issue: string) {
    const [info, canonical] = yield* Effect.all([
      fileSystem.stat(target),
      fileSystem.realPath(target),
    ]).pipe(Effect.mapError((cause) => managedWorktreeError(issue, cause)));
    if (
      info.type !== "File" ||
      Option.getOrUndefined(info.nlink) !== 1 ||
      !isSameResolvedPath(path, canonical, target)
    ) {
      return yield* managedWorktreeError(issue);
    }
  });
  const inspectLocalGitConfig = Effect.fn("CommandCenterProviderIsolation.inspectLocalGitConfig")(
    function* (config: {
      readonly target: string;
      readonly description: string;
      readonly required: boolean;
    }) {
      const canonical = yield* fileSystem.realPath(config.target).pipe(
        Effect.map(Option.some),
        Effect.catchTags({
          PlatformError: (cause) =>
            isNotFound(cause)
              ? Effect.succeed(Option.none())
              : Effect.fail(
                  managedWorktreeError(
                    `Command Center could not canonicalize its ${config.description}.`,
                    cause,
                  ),
                ),
        }),
      );
      if (Option.isNone(canonical)) {
        if (!config.required) return;
        return yield* managedWorktreeError(
          `Command Center's ${config.description} is unavailable.`,
        );
      }
      if (!isSameResolvedPath(path, canonical.value, config.target)) {
        return yield* managedWorktreeError(
          `Command Center's ${config.description} must not be a symlink.`,
        );
      }
      const before = yield* fileSystem
        .stat(canonical.value)
        .pipe(
          Effect.mapError((cause) =>
            managedWorktreeError(
              `Command Center could not inspect its ${config.description}.`,
              cause,
            ),
          ),
        );
      if (
        before.type !== "File" ||
        Option.getOrUndefined(before.nlink) !== 1 ||
        before.size > MAX_LOCAL_GIT_CONFIG_BYTES
      ) {
        return yield* managedWorktreeError(
          `Command Center's ${config.description} must be a bounded single-link regular file.`,
        );
      }
      const expectedIdentity = secureControlFileIdentity(before);
      const contents = yield* fileSystem
        .readFileString(canonical.value)
        .pipe(
          Effect.mapError((cause) =>
            managedWorktreeError(`Command Center could not read its ${config.description}.`, cause),
          ),
        );
      const [after, canonicalAfter] = yield* Effect.all([
        fileSystem.stat(canonical.value),
        fileSystem.realPath(canonical.value),
      ]).pipe(
        Effect.mapError((cause) =>
          managedWorktreeError(
            `Command Center's ${config.description} changed while it was inspected.`,
            cause,
          ),
        ),
      );
      if (
        !isSameResolvedPath(path, canonicalAfter, canonical.value) ||
        !sameControlFileIdentity(expectedIdentity, secureControlFileIdentity(after))
      ) {
        return yield* managedWorktreeError(
          `Command Center's ${config.description} changed while it was inspected.`,
        );
      }
      const unsafeKey = unsafeHostGitConfigKey(contents);
      if (unsafeKey === "<malformed>") {
        return yield* managedWorktreeError(
          `Command Center's ${config.description} does not have a safely inspectable format.`,
        );
      }
      if (unsafeKey !== undefined) {
        return yield* managedWorktreeError(
          `Command Center's ${config.description} contains executable callback or include key '${unsafeKey}'.`,
        );
      }
    },
  );

  const [canonicalBaseDir, canonicalCwd, canonicalWorktreesDir] = yield* Effect.all([
    canonicalize(
      input.baseDir,
      "Command Center could not canonicalize its runtime base directory.",
    ),
    canonicalize(input.cwd, "Command Center could not canonicalize the provider workspace."),
    canonicalize(
      input.worktreesDir,
      "Command Center could not canonicalize its managed worktree directory.",
    ),
  ]);
  const expectedWorktreesDir = path.join(canonicalBaseDir, "worktrees");
  if (!isSameResolvedPath(path, canonicalWorktreesDir, expectedWorktreesDir)) {
    return yield* managedWorktreeError(
      "Command Center's managed worktree directory escapes its runtime base directory.",
    );
  }

  const dotGitPath = path.join(canonicalCwd, ".git");
  const dotGitStat = yield* statOptional(dotGitPath);
  const inManagedWorktrees =
    !isSameResolvedPath(path, canonicalCwd, canonicalWorktreesDir) &&
    isWithinRoot(path, canonicalCwd, canonicalWorktreesDir);

  if (!inManagedWorktrees) {
    if (Option.isSome(dotGitStat) && dotGitStat.value.type === "File") {
      return yield* managedWorktreeError(
        "Command Center refuses linked Git metadata outside its managed worktree directory.",
      );
    }
    return undefined;
  }

  if (Option.isNone(dotGitStat) || dotGitStat.value.type !== "File") {
    return yield* managedWorktreeError(
      "The managed Command Center worktree does not contain a valid Git metadata pointer.",
    );
  }
  yield* requireSingleLinkControlFile(
    dotGitPath,
    "The managed Command Center worktree Git metadata pointer must be a single-link regular file.",
  );

  const dotGitPointer = singleLine(
    yield* read(
      dotGitPath,
      "Command Center could not read the managed worktree Git metadata pointer.",
    ),
  );
  const gitDirValue = dotGitPointer?.match(/^gitdir:\s+(.+)$/u)?.[1];
  const gitDirCandidate =
    gitDirValue === undefined
      ? undefined
      : pointerPath({ path, parent: canonicalCwd, raw: gitDirValue });
  if (gitDirCandidate === undefined) {
    return yield* managedWorktreeError(
      "The managed Command Center worktree has a malformed Git metadata pointer.",
    );
  }
  const canonicalGitDir = yield* canonicalize(
    gitDirCandidate,
    "Command Center could not canonicalize the managed worktree Git directory.",
  );
  if (!isSameResolvedPath(path, path.normalize(gitDirCandidate), canonicalGitDir)) {
    return yield* managedWorktreeError(
      "The managed Command Center worktree Git directory contains a symlink escape.",
    );
  }

  const commonDirPointerPath = path.join(canonicalGitDir, "commondir");
  yield* requireSingleLinkControlFile(
    commonDirPointerPath,
    "The managed Command Center common Git directory pointer must be a single-link regular file.",
  );
  const commonDirValue = yield* read(
    commonDirPointerPath,
    "Command Center could not read the managed worktree common Git directory pointer.",
  );
  const commonDirCandidate = pointerPath({
    path,
    parent: canonicalGitDir,
    raw: commonDirValue,
  });
  if (commonDirCandidate === undefined) {
    return yield* managedWorktreeError(
      "The managed Command Center worktree has a malformed common Git directory pointer.",
    );
  }
  const canonicalCommonDir = yield* canonicalize(
    commonDirCandidate,
    "Command Center could not canonicalize the managed common Git directory.",
  );
  if (!isSameResolvedPath(path, path.normalize(commonDirCandidate), canonicalCommonDir)) {
    return yield* managedWorktreeError(
      "The managed Command Center common Git directory contains a symlink escape.",
    );
  }

  const repositoriesDir = path.join(canonicalBaseDir, "repositories");
  const canonicalRepositoriesDir = yield* canonicalize(
    repositoriesDir,
    "Command Center could not canonicalize its managed repository directory.",
  );
  if (!isSameResolvedPath(path, canonicalRepositoriesDir, repositoriesDir)) {
    return yield* managedWorktreeError(
      "Command Center's managed repository directory contains a symlink escape.",
    );
  }
  const commonRelative = path.relative(canonicalRepositoriesDir, canonicalCommonDir);
  const commonSegments = commonRelative.split(path.sep);
  if (
    commonSegments.length !== 2 ||
    !safeManagedComponent(commonSegments[0] ?? "") ||
    commonSegments[1] !== ".git" ||
    !isWithinRoot(path, canonicalCommonDir, canonicalRepositoriesDir)
  ) {
    return yield* managedWorktreeError(
      "The managed Command Center worktree Git metadata is outside its managed repository checkout.",
    );
  }

  const gitDirRelative = path.relative(canonicalCommonDir, canonicalGitDir);
  const gitDirSegments = gitDirRelative.split(path.sep);
  if (
    gitDirSegments.length !== 2 ||
    gitDirSegments[0] !== "worktrees" ||
    !safeManagedComponent(gitDirSegments[1] ?? "") ||
    !isWithinRoot(path, canonicalGitDir, canonicalCommonDir)
  ) {
    return yield* managedWorktreeError(
      "The managed Command Center worktree has an invalid per-worktree Git metadata directory.",
    );
  }

  const reversePointerPath = path.join(canonicalGitDir, "gitdir");
  yield* requireSingleLinkControlFile(
    reversePointerPath,
    "The managed Command Center reverse Git metadata pointer must be a single-link regular file.",
  );
  const reversePointerCandidate = pointerPath({
    path,
    parent: canonicalGitDir,
    raw: yield* read(
      reversePointerPath,
      "Command Center could not read the managed worktree reverse Git metadata pointer.",
    ),
  });
  if (reversePointerCandidate === undefined) {
    return yield* managedWorktreeError(
      "The managed Command Center worktree has a malformed reverse Git metadata pointer.",
    );
  }
  const canonicalReversePointer = yield* canonicalize(
    reversePointerCandidate,
    "Command Center could not canonicalize the managed worktree reverse Git metadata pointer.",
  );
  const canonicalDotGitPath = yield* canonicalize(
    dotGitPath,
    "Command Center could not canonicalize the workspace Git metadata pointer.",
  );
  if (
    !isSameResolvedPath(path, path.normalize(reversePointerCandidate), canonicalReversePointer) ||
    !isSameResolvedPath(path, canonicalReversePointer, canonicalDotGitPath)
  ) {
    return yield* managedWorktreeError(
      "The managed Command Center worktree Git metadata pointers do not round-trip safely.",
    );
  }

  yield* inspectLocalGitConfig({
    target: path.join(canonicalCommonDir, "config"),
    description: "managed common Git configuration",
    required: true,
  });
  yield* inspectLocalGitConfig({
    target: path.join(canonicalGitDir, "config.worktree"),
    description: "managed worktree Git configuration",
    required: false,
  });

  return {
    dotGitPath: canonicalDotGitPath,
    worktreeGitDir: canonicalGitDir,
    commonGitDir: canonicalCommonDir,
  } satisfies CommandCenterManagedGitMetadata;
});

export function commandCenterCodexIsolation(
  runtimeMode: RuntimeMode,
  managedGitMetadata?: CommandCenterManagedGitMetadata,
  runtimeExecutablePath?: string,
  codexHome?: Pick<CommandCenterCodexHomeLayout, "homePath" | "helperBinPath">,
  platform: NodeJS.Platform = "linux",
): CommandCenterCodexIsolation | undefined {
  if (
    runtimeMode === "full-access" ||
    runtimeExecutablePath === undefined ||
    codexHome === undefined
  ) {
    return undefined;
  }
  const writable = runtimeMode === "auto-accept-edits" || runtimeMode === "auto";
  const permissionProfile = writable
    ? COMMAND_CENTER_CODEX_WRITE_PERMISSION_PROFILE
    : COMMAND_CENTER_CODEX_READ_PERMISSION_PROFILE;
  const profile = permissionProfileToml({
    description: writable
      ? "Command Center isolated writable workspace"
      : "Command Center isolated read-only workspace",
    workspaceAccess: writable ? "write" : "read",
    runtimeExecutablePath,
    codexHome,
    ...(managedGitMetadata === undefined ? {} : { managedGitMetadata }),
  });
  return {
    permissionProfile,
    ...(platform === "win32" ? { windowsSandboxMode: "elevated" as const } : {}),
    appServerArgs: [
      "--strict-config",
      "-c",
      "mcp_servers={}",
      "-c",
      "hooks={}",
      "-c",
      "plugins={}",
      "-c",
      "marketplaces={}",
      "-c",
      "projects={}",
      "-c",
      "notify=[]",
      "-c",
      `shell_environment_policy=${shellEnvironmentPolicyToml()}`,
      "--disable",
      "apps",
      "--disable",
      "remote_plugin",
      "--disable",
      "plugin_sharing",
      "--disable",
      "hooks",
      "--disable",
      "browser_use",
      "--disable",
      "browser_use_external",
      "--disable",
      "browser_use_full_cdp_access",
      "--disable",
      "computer_use",
      "--disable",
      "image_generation",
      "-c",
      `default_permissions=${JSON.stringify(permissionProfile)}`,
      "-c",
      `permissions.${permissionProfile}=${profile}`,
      ...(platform === "win32" ? ["-c", 'windows.sandbox="elevated"'] : []),
    ],
  };
}
