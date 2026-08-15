// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import type * as NodeFSP from "node:fs/promises";
import * as NodeProcess from "node:process";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";

export const VERIFIED_SCOPED_SHELL_BWRAP_PATH = "/usr/bin/bwrap";
export const VERIFIED_SCOPED_SHELL_PRLIMIT_PATH = "/usr/bin/prlimit";

/**
 * Host-resource ceilings are intentionally platform-owned rather than
 * manifest-controlled. RLIMIT_NPROC is account-wide, so its effective ceiling
 * is the server's startup task count plus this bounded headroom.
 */
export const VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS = Object.freeze({
  maxConcurrentExecutions: 2,
  maxAdditionalAccountTasks: 16,
  maxAccountTasks: 16_384,
  maxCpuSeconds: 60,
  maxAddressSpaceBytes: 512 * 1024 * 1024,
  maxFileSizeBytes: 256 * 1024 * 1024,
  maxOpenFiles: 256,
  maxCoreFileBytes: 0,
  maxPrivateTmpfsBytes: 64 * 1024 * 1024,
  maxWritableFilesystemDeltaBytes: 512 * 1024 * 1024,
  minWritableFilesystemAvailableBytes: 2 * 1024 * 1024 * 1024,
  writableFilesystemPollIntervalMs: 25,
});

const MAX_ARGUMENT_COUNT = 128;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_SINGLE_ARGUMENT_BYTES = 8 * 1024;
const MAX_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
// Linux O_PATH is intentionally not exposed by Node's fs.constants.
const LINUX_O_PATH = 0o10000000;
const CLEAN_ENVIRONMENT = {
  HOME: "/tmp/home",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PATH: "/usr/bin:/bin",
  TMPDIR: "/tmp",
  TZ: "UTC",
} as const;

export type VerifiedScopedShellAccess = "read" | "write";

/** A server-resolved allowlist entry. No command text is parsed by this service. */
export interface VerifiedScopedShellPolicyEntry {
  readonly allowlistId: string;
  readonly executable: string;
  readonly argv: ReadonlyArray<string>;
  readonly access: VerifiedScopedShellAccess;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly stdoutMaxBytes: number;
  readonly stderrMaxBytes: number;
  readonly retryable: boolean;
  readonly idempotent: boolean;
  readonly idempotencyKey?: string;
}

export interface VerifiedScopedShellAllowedRoot {
  readonly canonicalPath: string;
  /** Maximum access granted to commands whose cwd is inside this root. */
  readonly access: VerifiedScopedShellAccess;
}

/** Git metadata that must remain immutable while a writable worktree is mounted. */
export interface VerifiedScopedShellGitMetadata {
  readonly dotGitPath: string;
  readonly commonGitDir: string;
}

export interface VerifiedScopedShellRuntimePolicy {
  readonly allowedRoots: ReadonlyArray<VerifiedScopedShellAllowedRoot>;
  readonly gitMetadata?: VerifiedScopedShellGitMetadata;
}

export interface VerifiedScopedShellExecuteInput {
  readonly policy: VerifiedScopedShellPolicyEntry;
  readonly runtime: VerifiedScopedShellRuntimePolicy;
}

export interface VerifiedScopedShellExecutionResult {
  readonly allowlistId: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly retryable: boolean;
  readonly idempotent: boolean;
  readonly idempotencyKey?: string;
}

export const VerifiedScopedShellErrorCode = Schema.Literals([
  "unsupported-platform",
  "invalid-policy",
  "path-not-canonical",
  "path-outside-roots",
  "unsafe-runtime-location",
  "bwrap-unavailable",
  "bwrap-untrusted",
  "resource-control-unavailable",
  "resource-control-untrusted",
  "resource-limit-exceeded",
  "path-changed",
  "spawn-failed",
  "output-failed",
  "timeout",
]);
export type VerifiedScopedShellErrorCode = typeof VerifiedScopedShellErrorCode.Type;

export class VerifiedScopedShellError extends Schema.TaggedErrorClass<VerifiedScopedShellError>()(
  "VerifiedScopedShellError",
  {
    code: VerifiedScopedShellErrorCode,
    allowlistId: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.issue;
  }
}

interface FileIdentity {
  readonly path: string;
  readonly type: FileSystem.File.Type;
  readonly dev: number;
  readonly ino: number | undefined;
  readonly mode: number;
  readonly uid: number | undefined;
}

interface OpenedStablePath {
  readonly handle: NodeFSP.FileHandle;
  readonly identity: FileIdentity;
  readonly livePath: string;
}

interface CollectedProcessOutput {
  readonly text: string;
  readonly truncated: boolean;
}

interface SpawnedBubblewrap {
  readonly child: NodeChildProcess.ChildProcess;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
}

interface AdmittedScopedShellExecution {
  readonly policy: VerifiedScopedShellPolicyEntry;
  readonly roots: ReadonlyArray<VerifiedScopedShellAllowedRoot>;
  readonly executable: FileIdentity;
  readonly cwd: FileIdentity;
  readonly bwrap: FileIdentity;
  readonly prlimit: FileIdentity;
  readonly rootIdentities: ReadonlyArray<FileIdentity>;
  readonly gitMetadata:
    | {
        readonly dotGit: FileIdentity;
        readonly commonGitDir: FileIdentity;
      }
    | undefined;
  readonly maxProcesses: number;
}

interface LinuxAccountTaskCount {
  readonly count: number;
  readonly issue?: string;
  readonly cause?: unknown;
}

function failure(
  allowlistId: string,
  code: VerifiedScopedShellErrorCode,
  issue: string,
  cause?: unknown,
): VerifiedScopedShellError {
  return new VerifiedScopedShellError({
    code,
    allowlistId,
    issue,
    ...(cause === undefined ? {} : { cause }),
  });
}

function isWithinRoot(path: Path.Path, candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function accessAllows(
  root: VerifiedScopedShellAccess,
  requested: VerifiedScopedShellAccess,
): boolean {
  return root === "write" || requested === "read";
}

function safeSingleLine(value: string, maxBytes: number): boolean {
  return (
    value.length > 0 &&
    !value.includes("\0") &&
    !/[\r\n]/u.test(value) &&
    Buffer.byteLength(value) <= maxBytes
  );
}

function validatePolicyShape(policy: VerifiedScopedShellPolicyEntry): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(policy.allowlistId)) {
    return "Scoped shell allowlist id is malformed.";
  }
  if (policy.access !== "read" && policy.access !== "write") {
    return "Scoped shell access must be read or write.";
  }
  if (
    !Number.isSafeInteger(policy.timeoutMs) ||
    policy.timeoutMs < 1 ||
    policy.timeoutMs > MAX_TIMEOUT_MS
  ) {
    return "Scoped shell timeout is outside the supported range.";
  }
  for (const cap of [policy.stdoutMaxBytes, policy.stderrMaxBytes]) {
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > MAX_OUTPUT_BYTES) {
      return "Scoped shell output cap is outside the supported range.";
    }
  }
  if (
    policy.argv.length > MAX_ARGUMENT_COUNT ||
    policy.argv.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.includes("\0") ||
        Buffer.byteLength(argument) > MAX_SINGLE_ARGUMENT_BYTES,
    ) ||
    policy.argv.reduce((bytes, argument) => bytes + Buffer.byteLength(argument), 0) >
      MAX_ARGUMENT_BYTES
  ) {
    return "Scoped shell argv is malformed or exceeds its size limit.";
  }
  if (policy.retryable && !policy.idempotent) {
    return "Retryable scoped shell entries must be idempotent.";
  }
  if (
    policy.idempotent &&
    (policy.idempotencyKey === undefined || !safeSingleLine(policy.idempotencyKey, 256))
  ) {
    return "Idempotent scoped shell entries require a bounded idempotency key.";
  }
  if (!policy.idempotent && policy.idempotencyKey !== undefined) {
    return "Non-idempotent scoped shell entries cannot declare an idempotency key.";
  }
  return undefined;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.path === right.path &&
    left.type === right.type &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid
  );
}

function identity(path: string, info: FileSystem.File.Info): FileIdentity {
  return {
    path,
    type: info.type,
    dev: info.dev,
    ino: Option.getOrUndefined(info.ino),
    mode: info.mode,
    uid: Option.getOrUndefined(info.uid),
  };
}

function nodeIdentity(path: string, info: NodeFS.Stats): FileIdentity {
  return {
    path,
    type: info.isFile()
      ? "File"
      : info.isDirectory()
        ? "Directory"
        : info.isSymbolicLink()
          ? "SymbolicLink"
          : "Unknown",
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    uid: info.uid,
  };
}

function isTransientProcError(cause: unknown): boolean {
  return (
    cause !== null &&
    typeof cause === "object" &&
    "code" in cause &&
    (cause.code === "ENOENT" || cause.code === "ESRCH")
  );
}

/**
 * RLIMIT_NPROC is counted per real Unix account and includes threads. Capture
 * that account's task baseline before any scoped command can run, then grant a
 * small fixed amount of additional headroom shared by all executions.
 */
function inspectLinuxAccountTaskCount(effectiveUid: number): LinuxAccountTaskCount {
  try {
    let count = 0;
    for (const entry of NodeFS.readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9]+$/u.test(entry.name)) continue;
      const processPath = `/proc/${entry.name}`;
      let processInfo: NodeFS.Stats;
      try {
        processInfo = NodeFS.statSync(processPath);
      } catch (cause) {
        if (isTransientProcError(cause)) continue;
        return {
          count: 0,
          issue: "Linux account task ownership could not be inspected.",
          cause,
        };
      }
      if (processInfo.uid !== effectiveUid) continue;

      let status: string;
      try {
        status = NodeFS.readFileSync(`${processPath}/status`, "utf8");
      } catch (cause) {
        if (isTransientProcError(cause)) continue;
        return {
          count: 0,
          issue: "Linux account task status could not be inspected.",
          cause,
        };
      }
      const uidMatch = /^Uid:\s+([0-9]+)(?:\s|$)/mu.exec(status);
      const threadsMatch = /^Threads:\s+([0-9]+)(?:\s|$)/mu.exec(status);
      if (uidMatch === null || threadsMatch === null) {
        return {
          count: 0,
          issue: "Linux account task status was malformed.",
        };
      }
      if (Number(uidMatch[1]) !== effectiveUid) continue;
      const threads = Number(threadsMatch[1]);
      if (!Number.isSafeInteger(threads) || threads < 1) {
        return {
          count: 0,
          issue: "Linux account thread count was outside the supported range.",
        };
      }
      count += threads;
      if (!Number.isSafeInteger(count)) {
        return {
          count: 0,
          issue: "Linux account task count exceeded the supported range.",
        };
      }
    }
    return { count };
  } catch (cause) {
    return {
      count: 0,
      issue: "The Linux process table is unavailable for resource admission.",
      cause,
    };
  }
}

export function buildVerifiedScopedShellBwrapArguments(input: {
  readonly executableFd: number;
  readonly argv: ReadonlyArray<string>;
  readonly cwdFd: number;
  readonly access: VerifiedScopedShellAccess;
  readonly gitMetadata?: {
    readonly dotGitFd: number;
    readonly commonGitDirFd: number;
    readonly commonGitDirPath: string;
  };
}): ReadonlyArray<string> {
  return [
    "--unshare-all",
    "--unshare-user",
    "--disable-userns",
    // Node already launches the resource controller as a detached session
    // leader with no controlling terminal. Do not let Bubblewrap split the
    // sandbox command into a second host PGID: every termination path must be
    // able to signal and observe the entire process tree through one PGID.
    "--die-with-parent",
    "--cap-drop",
    "ALL",
    "--hostname",
    "command-center",
    "--clearenv",
    ...Object.entries(CLEAN_ENVIRONMENT).flatMap(([name, value]) => ["--setenv", name, value]),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--size",
    String(VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS.maxPrivateTmpfsBytes),
    "--tmpfs",
    "/tmp",
    "--dir",
    "/tmp/home",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind-try",
    "/bin",
    "/bin",
    "--ro-bind-try",
    "/lib",
    "/lib",
    "--ro-bind-try",
    "/lib64",
    "/lib64",
    "--ro-bind-try",
    "/sbin",
    "/sbin",
    "--ro-bind-fd",
    String(input.executableFd),
    "/command",
    "--dir",
    "/workspace",
    input.access === "write" ? "--bind-fd" : "--ro-bind-fd",
    String(input.cwdFd),
    "/workspace",
    ...(input.gitMetadata === undefined
      ? []
      : [
          // A linked worktree's `.git` file points to this absolute host path.
          // Expose the shared metadata read-only so Git inspection still works,
          // while overlaying the pointer itself as an immutable mount point.
          "--dir",
          input.gitMetadata.commonGitDirPath.slice(
            0,
            input.gitMetadata.commonGitDirPath.lastIndexOf("/"),
          ) || "/",
          "--ro-bind-fd",
          String(input.gitMetadata.commonGitDirFd),
          input.gitMetadata.commonGitDirPath,
          "--ro-bind-fd",
          String(input.gitMetadata.dotGitFd),
          "/workspace/.git",
        ]),
    "--chdir",
    "/workspace",
    "--remount-ro",
    "/",
    "--",
    "/command",
    ...input.argv,
  ];
}

export function buildVerifiedScopedShellPrlimitArguments(input: {
  readonly bwrapFd: number;
  readonly bwrapArguments: ReadonlyArray<string>;
  readonly timeoutMs: number;
  readonly maxProcesses: number;
}): ReadonlyArray<string> {
  const maxCpuSeconds = Math.max(
    1,
    Math.min(
      VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS.maxCpuSeconds,
      Math.ceil(input.timeoutMs / 1_000),
    ),
  );
  const exact = (value: number): string => `${value}:${value}`;
  return [
    `--nproc=${exact(input.maxProcesses)}`,
    `--cpu=${exact(maxCpuSeconds)}`,
    `--as=${exact(VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS.maxAddressSpaceBytes)}`,
    `--fsize=${exact(VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS.maxFileSizeBytes)}`,
    `--nofile=${exact(VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS.maxOpenFiles)}`,
    `--core=${exact(VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS.maxCoreFileBytes)}`,
    "--",
    `/proc/self/fd/${input.bwrapFd}`,
    ...input.bwrapArguments,
  ];
}

export function verifiedScopedShellWritableFilesystemLimitExceeded(input: {
  readonly baselineAvailableBytes: bigint;
  readonly currentAvailableBytes: bigint;
}): boolean {
  const consumed = input.baselineAvailableBytes - input.currentAvailableBytes;
  return (
    input.currentAvailableBytes <
      BigInt(VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS.minWritableFilesystemAvailableBytes) ||
    consumed > BigInt(VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS.maxWritableFilesystemDeltaBytes)
  );
}

const childIsReaped = (child: NodeChildProcess.ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;

const awaitSpawnedPid = (
  child: NodeChildProcess.ChildProcess,
): Effect.Effect<number | undefined> => {
  if (child.pid !== undefined) return Effect.succeed(child.pid);
  if (childIsReaped(child)) return Effect.sync(() => undefined);
  return Effect.callback((resume) => {
    let settled = false;
    const cleanup = () => {
      child.removeListener("spawn", onSpawn);
      child.removeListener("exit", onGone);
      child.removeListener("error", onGone);
    };
    const finish = (pid: number | undefined) => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(Effect.succeed(pid));
    };
    const onSpawn = () => finish(child.pid);
    const onGone = () => finish(undefined);
    child.once("spawn", onSpawn);
    child.once("exit", onGone);
    child.once("error", onGone);
    if (child.pid !== undefined || childIsReaped(child)) finish(child.pid);
    return Effect.sync(cleanup);
  });
};

/** Resolve only after Node has observed and reaped its direct child. */
const awaitReaped = (child: NodeChildProcess.ChildProcess): Effect.Effect<void> => {
  if (childIsReaped(child)) return Effect.void;
  return Effect.callback((resume) => {
    let settled = false;
    const cleanup = () => {
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(Effect.void);
    };
    const onExit = () => finish();
    const onError = () => {
      // A pre-spawn error means no child exists. A late observation error is
      // not a reap signal, so keep the caller fail-closed until `exit` arrives.
      if (child.pid === undefined) finish();
    };
    child.once("exit", onExit);
    child.on("error", onError);
    if (childIsReaped(child)) finish();
    return Effect.sync(cleanup);
  });
};

const processGroupIsAlive = (pid: number): boolean => {
  try {
    NodeProcess.kill(-pid, 0);
    return true;
  } catch (cause) {
    return !(
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "ESRCH"
    );
  }
};

/** A detached descendant keeps the caller occupied even after the direct child exits. */
const awaitProcessGroupGone = (pid: number): Effect.Effect<void> => {
  const poll: Effect.Effect<void> = Effect.suspend(() =>
    processGroupIsAlive(pid) ? Effect.sleep("10 millis").pipe(Effect.andThen(poll)) : Effect.void,
  );
  return poll;
};

const signalProcessGroup = (child: NodeChildProcess.ChildProcess, signal: NodeJS.Signals): void => {
  const pid = child.pid;
  if (pid === undefined || !processGroupIsAlive(pid)) return;
  try {
    NodeProcess.kill(-pid, signal);
  } catch {
    // Detached PGID signalling is authoritative. The direct-child fallback is
    // best effort only; awaitProcessGroupGone keeps the caller permanently
    // fail-closed if any descendant remains.
    try {
      child.kill(signal);
    } catch {
      // The process may have exited between the state check and signal.
    }
  }
};

const terminateProcessGroupAndReap = (
  child: NodeChildProcess.ChildProcess,
  mode: "graceful" | "immediate",
): Effect.Effect<void> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const pid = yield* awaitSpawnedPid(child);
      if (pid === undefined) {
        yield* awaitReaped(child);
        return;
      }
      const awaitTreeReaped = Effect.all([awaitReaped(child), awaitProcessGroupGone(pid)], {
        concurrency: "unbounded",
        discard: true,
      });
      if (mode === "graceful") {
        signalProcessGroup(child, "SIGTERM");
        const graceful = yield* awaitTreeReaped.pipe(Effect.timeoutOption("1 second"));
        if (Option.isSome(graceful)) return;
      }
      signalProcessGroup(child, "SIGKILL");
      // SIGKILL has no timeout escape hatch. Retaining the semaphore permit,
      // scope, and pinned descriptors forever is safer than admitting
      // replacement work while the group or unreaped child still exists.
      yield* awaitTreeReaped;
    }),
  );

export class VerifiedLinuxScopedShell extends Context.Service<
  VerifiedLinuxScopedShell,
  {
    readonly execute: (
      input: VerifiedScopedShellExecuteInput,
    ) => Effect.Effect<VerifiedScopedShellExecutionResult, VerifiedScopedShellError>;
  }
>()(
  "@awtprod/command-center/command-center/automation/VerifiedScopedShell/VerifiedLinuxScopedShell",
) {}

interface VerifiedLinuxScopedShellTestingOptions {
  readonly spawnSettlementDelayMs: number;
}

const makeVerifiedLinuxScopedShellWithOptions = Effect.fn("VerifiedLinuxScopedShell.make")(
  function* (testing: VerifiedLinuxScopedShellTestingOptions | undefined) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcessPlatform;
    const effectiveUid = NodeProcess.geteuid?.();
    const startupAccountTasks =
      platform === "linux" && effectiveUid !== undefined
        ? inspectLinuxAccountTaskCount(effectiveUid)
        : {
            count: 0,
            issue: "Linux account task limits cannot be established on this platform.",
          };
    const executionSlots = yield* Semaphore.make(
      VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS.maxConcurrentExecutions,
    );

    const canonicalIdentity = Effect.fn("VerifiedLinuxScopedShell.canonicalIdentity")(function* (
      allowlistId: string,
      target: string,
      kind: "bwrap" | "prlimit" | "executable" | "cwd" | "root" | "git-pointer" | "git-common-dir",
    ) {
      if (
        !path.isAbsolute(target) ||
        path.resolve(target) !== target ||
        path.normalize(target) !== target ||
        !safeSingleLine(target, 4096)
      ) {
        return yield* failure(
          allowlistId,
          "path-not-canonical",
          `Scoped shell ${kind} path is not an exact canonical absolute path.`,
        );
      }
      const canonical = yield* fileSystem
        .realPath(target)
        .pipe(
          Effect.mapError((cause) =>
            failure(
              allowlistId,
              kind === "bwrap"
                ? "bwrap-unavailable"
                : kind === "prlimit"
                  ? "resource-control-unavailable"
                  : "path-not-canonical",
              kind === "bwrap"
                ? "The canonical Bubblewrap runtime is unavailable."
                : kind === "prlimit"
                  ? "The canonical Linux resource limiter is unavailable."
                  : `Scoped shell ${kind} path could not be canonicalized.`,
              cause,
            ),
          ),
        );
      if (canonical !== target) {
        return yield* failure(
          allowlistId,
          "path-not-canonical",
          `Scoped shell ${kind} path contains a symlink or canonicalization escape.`,
        );
      }
      const info = yield* fileSystem
        .stat(canonical)
        .pipe(
          Effect.mapError((cause) =>
            failure(
              allowlistId,
              kind === "bwrap"
                ? "bwrap-unavailable"
                : kind === "prlimit"
                  ? "resource-control-unavailable"
                  : "path-not-canonical",
              kind === "bwrap"
                ? "The canonical Bubblewrap runtime could not be inspected."
                : kind === "prlimit"
                  ? "The canonical Linux resource limiter could not be inspected."
                  : `Scoped shell ${kind} path could not be inspected.`,
              cause,
            ),
          ),
        );
      return identity(canonical, info);
    });

    const admit = Effect.fn("VerifiedLinuxScopedShell.admit")(function* (
      input: VerifiedScopedShellExecuteInput,
    ) {
      const allowlistId =
        typeof input.policy.allowlistId === "string" ? input.policy.allowlistId : "invalid";
      if (platform !== "linux") {
        return yield* failure(
          allowlistId,
          "unsupported-platform",
          "Verified scoped shell execution is supported only on Linux.",
        );
      }
      if (effectiveUid === 0) {
        return yield* failure(
          allowlistId,
          "unsafe-runtime-location",
          "Verified scoped shell refuses to run from a root-owned server process.",
        );
      }
      const shapeIssue = validatePolicyShape(input.policy);
      if (shapeIssue !== undefined) {
        return yield* failure(allowlistId, "invalid-policy", shapeIssue);
      }
      const currentAccountTasks =
        effectiveUid === undefined
          ? {
              count: 0,
              issue: "Linux account task ownership cannot be established.",
            }
          : inspectLinuxAccountTaskCount(effectiveUid);
      if (
        startupAccountTasks.issue !== undefined ||
        currentAccountTasks.issue !== undefined ||
        startupAccountTasks.count < 1 ||
        currentAccountTasks.count < 1 ||
        Math.min(startupAccountTasks.count, currentAccountTasks.count) +
          VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS.maxAdditionalAccountTasks >
          VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS.maxAccountTasks
      ) {
        return yield* failure(
          allowlistId,
          "resource-control-unavailable",
          startupAccountTasks.issue ??
            currentAccountTasks.issue ??
            "The server account already exceeds the safe scoped-shell task ceiling.",
          startupAccountTasks.cause ?? currentAccountTasks.cause,
        );
      }
      const maxProcesses =
        Math.min(startupAccountTasks.count, currentAccountTasks.count) +
        VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS.maxAdditionalAccountTasks;
      if (currentAccountTasks.count >= maxProcesses) {
        return yield* failure(
          allowlistId,
          "resource-control-unavailable",
          "The server account has no safe task headroom for scoped-shell execution.",
        );
      }
      if (input.runtime.allowedRoots.length < 1 || input.runtime.allowedRoots.length > 32) {
        return yield* failure(
          allowlistId,
          "invalid-policy",
          "Scoped shell runtime must provide between 1 and 32 allowed roots.",
        );
      }
      if (
        input.runtime.allowedRoots.some((root) => root.access !== "read" && root.access !== "write")
      ) {
        return yield* failure(
          allowlistId,
          "invalid-policy",
          "Scoped shell allowed-root access is malformed.",
        );
      }

      const executable = yield* canonicalIdentity(
        allowlistId,
        input.policy.executable,
        "executable",
      );
      if (executable.type !== "File" || (executable.mode & 0o111) === 0) {
        return yield* failure(
          allowlistId,
          "invalid-policy",
          "Scoped shell executable must be a regular executable file.",
        );
      }
      if ((executable.mode & 0o022) !== 0) {
        return yield* failure(
          allowlistId,
          "unsafe-runtime-location",
          "Scoped shell executable must not be group- or world-writable.",
        );
      }

      const cwd = yield* canonicalIdentity(allowlistId, input.policy.cwd, "cwd");
      if (cwd.type !== "Directory") {
        return yield* failure(
          allowlistId,
          "invalid-policy",
          "Scoped shell cwd must be a directory.",
        );
      }
      const rootIdentities = yield* Effect.forEach(
        input.runtime.allowedRoots,
        (root) => canonicalIdentity(allowlistId, root.canonicalPath, "root"),
        { concurrency: 1 },
      );
      if (rootIdentities.some((root) => root.type !== "Directory")) {
        return yield* failure(
          allowlistId,
          "invalid-policy",
          "Scoped shell allowed roots must be directories.",
        );
      }
      const roots = input.runtime.allowedRoots.map((root, index) => ({
        ...root,
        canonicalPath: rootIdentities[index]?.path ?? root.canonicalPath,
      }));
      if (
        !roots.some(
          (root) =>
            isWithinRoot(path, cwd.path, root.canonicalPath) &&
            accessAllows(root.access, input.policy.access),
        )
      ) {
        return yield* failure(
          allowlistId,
          "path-outside-roots",
          "Scoped shell cwd is outside compatible runtime allowed roots.",
        );
      }

      const gitMetadata =
        input.runtime.gitMetadata === undefined
          ? undefined
          : {
              dotGit: yield* canonicalIdentity(
                allowlistId,
                input.runtime.gitMetadata.dotGitPath,
                "git-pointer",
              ),
              commonGitDir: yield* canonicalIdentity(
                allowlistId,
                input.runtime.gitMetadata.commonGitDir,
                "git-common-dir",
              ),
            };
      if (input.policy.access === "write" && gitMetadata === undefined) {
        return yield* failure(
          allowlistId,
          "invalid-policy",
          "Writable scoped shell execution requires pinned linked-worktree Git metadata.",
        );
      }
      if (gitMetadata !== undefined) {
        const expectedDotGitPath = path.join(cwd.path, ".git");
        if (
          gitMetadata.dotGit.path !== expectedDotGitPath ||
          (gitMetadata.dotGit.type !== "File" && gitMetadata.dotGit.type !== "Directory") ||
          gitMetadata.commonGitDir.type !== "Directory" ||
          (input.policy.access === "write" && gitMetadata.dotGit.type !== "File")
        ) {
          return yield* failure(
            allowlistId,
            "invalid-policy",
            "Scoped shell Git metadata does not describe the exact workspace pointer and common directory.",
          );
        }
        if (
          roots.some(
            (root) =>
              root.access === "write" &&
              isWithinRoot(path, gitMetadata.commonGitDir.path, root.canonicalPath),
          )
        ) {
          return yield* failure(
            allowlistId,
            "unsafe-runtime-location",
            "Scoped shell shared Git metadata must remain outside every writable runtime root.",
          );
        }
      }

      const bwrap = yield* canonicalIdentity(
        allowlistId,
        VERIFIED_SCOPED_SHELL_BWRAP_PATH,
        "bwrap",
      );
      if (
        bwrap.path !== VERIFIED_SCOPED_SHELL_BWRAP_PATH ||
        bwrap.type !== "File" ||
        (bwrap.mode & 0o111) === 0 ||
        (bwrap.mode & 0o022) !== 0
      ) {
        return yield* failure(
          allowlistId,
          "bwrap-untrusted",
          "The canonical Bubblewrap runtime is not a trusted executable file.",
        );
      }
      const prlimit = yield* canonicalIdentity(
        allowlistId,
        VERIFIED_SCOPED_SHELL_PRLIMIT_PATH,
        "prlimit",
      );
      if (
        prlimit.path !== VERIFIED_SCOPED_SHELL_PRLIMIT_PATH ||
        prlimit.type !== "File" ||
        (prlimit.mode & 0o111) === 0 ||
        (prlimit.mode & 0o022) !== 0
      ) {
        return yield* failure(
          allowlistId,
          "resource-control-untrusted",
          "The canonical Linux resource limiter is not a trusted executable file.",
        );
      }
      const writableRoots = roots.filter((root) => root.access === "write");
      if (
        writableRoots.some(
          (root) =>
            isWithinRoot(path, bwrap.path, root.canonicalPath) ||
            isWithinRoot(path, prlimit.path, root.canonicalPath) ||
            isWithinRoot(path, executable.path, root.canonicalPath),
        )
      ) {
        return yield* failure(
          allowlistId,
          "unsafe-runtime-location",
          "Bubblewrap, the resource limiter, and the scoped executable must be outside every writable runtime root.",
        );
      }
      if (executable.uid !== 0) {
        return yield* failure(
          allowlistId,
          "unsafe-runtime-location",
          "Scoped shell executables must be root-owned and immutable to the server user.",
        );
      }
      if (bwrap.uid !== 0) {
        return yield* failure(
          allowlistId,
          "bwrap-untrusted",
          "The canonical Bubblewrap runtime must be owned by root.",
        );
      }
      if (prlimit.uid !== 0) {
        return yield* failure(
          allowlistId,
          "resource-control-untrusted",
          "The canonical Linux resource limiter must be owned by root.",
        );
      }

      return {
        policy: {
          ...input.policy,
          executable: executable.path,
          cwd: cwd.path,
          argv: [...input.policy.argv],
        },
        roots,
        executable,
        cwd,
        bwrap,
        prlimit,
        rootIdentities,
        gitMetadata,
        maxProcesses,
      } satisfies AdmittedScopedShellExecution;
    });

    const revalidate = Effect.fn("VerifiedLinuxScopedShell.revalidate")(function* (
      admitted: AdmittedScopedShellExecution,
    ) {
      const current = yield* Effect.all(
        [
          canonicalIdentity(admitted.policy.allowlistId, admitted.executable.path, "executable"),
          canonicalIdentity(admitted.policy.allowlistId, admitted.cwd.path, "cwd"),
          canonicalIdentity(admitted.policy.allowlistId, admitted.bwrap.path, "bwrap"),
          canonicalIdentity(admitted.policy.allowlistId, admitted.prlimit.path, "prlimit"),
          ...admitted.roots.map((root) =>
            canonicalIdentity(admitted.policy.allowlistId, root.canonicalPath, "root"),
          ),
          ...(admitted.gitMetadata === undefined
            ? []
            : [
                canonicalIdentity(
                  admitted.policy.allowlistId,
                  admitted.gitMetadata.dotGit.path,
                  "git-pointer",
                ),
                canonicalIdentity(
                  admitted.policy.allowlistId,
                  admitted.gitMetadata.commonGitDir.path,
                  "git-common-dir",
                ),
              ]),
        ],
        { concurrency: 1 },
      );
      const expected = [
        admitted.executable,
        admitted.cwd,
        admitted.bwrap,
        admitted.prlimit,
        ...admitted.rootIdentities,
        ...(admitted.gitMetadata === undefined
          ? []
          : [admitted.gitMetadata.dotGit, admitted.gitMetadata.commonGitDir]),
      ];
      if (
        current.length !== expected.length ||
        current.some((entry, index) => !sameIdentity(entry, expected[index] as FileIdentity))
      ) {
        return yield* failure(
          admitted.policy.allowlistId,
          "path-changed",
          "Scoped shell paths changed after admission; execution was blocked.",
        );
      }
    });

    const openStablePath = Effect.fn("VerifiedLinuxScopedShell.openStablePath")(function* (
      admitted: AdmittedScopedShellExecution,
      expected: FileIdentity,
      kind: "bwrap" | "prlimit" | "executable" | "cwd" | "root" | "git-pointer" | "git-common-dir",
    ) {
      const flags =
        LINUX_O_PATH |
        NodeFS.constants.O_NOFOLLOW |
        (expected.type === "Directory" ? NodeFS.constants.O_DIRECTORY : 0);
      const handle = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => NodeFS.promises.open(expected.path, flags),
          catch: (cause) =>
            failure(
              admitted.policy.allowlistId,
              "path-changed",
              `Scoped shell ${kind} could not be pinned to an open file descriptor.`,
              cause,
            ),
        }),
        (opened) => Effect.tryPromise(() => opened.close()).pipe(Effect.catch(() => Effect.void)),
      );
      const current = yield* Effect.tryPromise({
        try: () => handle.stat(),
        catch: (cause) =>
          failure(
            admitted.policy.allowlistId,
            "path-changed",
            `Scoped shell ${kind} descriptor could not be inspected.`,
            cause,
          ),
      });
      const currentIdentity = nodeIdentity(expected.path, current);
      if (!sameIdentity(currentIdentity, expected)) {
        return yield* failure(
          admitted.policy.allowlistId,
          "path-changed",
          `Scoped shell ${kind} changed while its descriptor was opened.`,
        );
      }
      const livePath = yield* fileSystem
        .realPath(`/proc/self/fd/${handle.fd}`)
        .pipe(
          Effect.mapError((cause) =>
            failure(
              admitted.policy.allowlistId,
              "path-changed",
              `Scoped shell ${kind} descriptor no longer names a stable path.`,
              cause,
            ),
          ),
        );
      if (livePath !== expected.path) {
        return yield* failure(
          admitted.policy.allowlistId,
          "path-changed",
          `Scoped shell ${kind} moved after validation; execution was blocked.`,
        );
      }
      return { handle, identity: currentIdentity, livePath } satisfies OpenedStablePath;
    });

    const availableFilesystemBytes = Effect.fn("VerifiedLinuxScopedShell.availableFilesystemBytes")(
      function* (allowlistId: string, stableDirectoryFd: number) {
        const stats = yield* Effect.tryPromise({
          try: () =>
            NodeFS.promises.statfs(`/proc/self/fd/${stableDirectoryFd}`, {
              bigint: true,
            }),
          catch: (cause) =>
            failure(
              allowlistId,
              "resource-control-unavailable",
              "The writable workspace filesystem could not be inspected.",
              cause,
            ),
        });
        const available = stats.bavail * stats.bsize;
        if (available < 0n) {
          return yield* failure(
            allowlistId,
            "resource-control-unavailable",
            "The writable workspace filesystem reported an invalid capacity.",
          );
        }
        return available;
      },
    );

    const collectOutput = Effect.fn("VerifiedLinuxScopedShell.collectOutput")(
      (
        allowlistId: string,
        stream: NodeJS.ReadableStream,
        maxBytes: number,
      ): Effect.Effect<CollectedProcessOutput, VerifiedScopedShellError> =>
        Effect.callback((resume) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          let truncated = false;
          let settled = false;
          const cleanup = () => {
            stream.removeListener("data", onData);
            stream.removeListener("end", onEnd);
            stream.removeListener("error", onError);
          };
          const finish = (
            effect: Effect.Effect<CollectedProcessOutput, VerifiedScopedShellError>,
          ) => {
            if (settled) return;
            settled = true;
            cleanup();
            resume(effect);
          };
          const onData = (chunk: unknown) => {
            const buffer = Buffer.isBuffer(chunk)
              ? chunk
              : typeof chunk === "string"
                ? Buffer.from(chunk)
                : Buffer.from(chunk as Uint8Array);
            const remaining = maxBytes - bytes;
            if (remaining <= 0) {
              truncated = true;
              return;
            }
            const kept = buffer.byteLength > remaining ? buffer.subarray(0, remaining) : buffer;
            chunks.push(kept);
            bytes += kept.byteLength;
            if (kept.byteLength !== buffer.byteLength) truncated = true;
          };
          const onEnd = () =>
            finish(
              Effect.succeed({
                text: Buffer.concat(chunks, bytes).toString("utf8"),
                truncated,
              }),
            );
          const onError = (cause: unknown) =>
            finish(
              Effect.fail(
                failure(
                  allowlistId,
                  "output-failed",
                  "Verified scoped shell could not collect bounded process output.",
                  cause,
                ),
              ),
            );
          stream.on("data", onData);
          stream.once("end", onEnd);
          stream.once("error", onError);
          return Effect.sync(cleanup);
        }),
    );

    const awaitExit = Effect.fn("VerifiedLinuxScopedShell.awaitExit")((
      allowlistId: string,
      child: NodeChildProcess.ChildProcess,
    ): Effect.Effect<number, VerifiedScopedShellError> => {
      if (child.exitCode !== null) return Effect.succeed(child.exitCode);
      return Effect.callback((resume) => {
        let settled = false;
        const cleanup = () => {
          child.removeListener("exit", onExit);
          child.removeListener("error", onError);
        };
        const finish = (effect: Effect.Effect<number, VerifiedScopedShellError>) => {
          if (settled) return;
          settled = true;
          cleanup();
          resume(effect);
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          if (code !== null) {
            finish(Effect.succeed(code));
            return;
          }
          finish(
            Effect.fail(
              failure(
                allowlistId,
                "output-failed",
                `Verified scoped shell exited after signal ${signal ?? "unknown"}.`,
              ),
            ),
          );
        };
        const onError = (cause: Error) =>
          finish(
            Effect.fail(
              failure(
                allowlistId,
                "output-failed",
                "Verified scoped shell process observation failed.",
                cause,
              ),
            ),
          );
        child.once("exit", onExit);
        child.once("error", onError);
        return Effect.sync(cleanup);
      });
    });

    const spawnBubblewrap = Effect.fn("VerifiedLinuxScopedShell.spawnBubblewrap")(
      (
        admitted: AdmittedScopedShellExecution,
        args: ReadonlyArray<string>,
        executableFd: number,
        cwdFd: number,
        bwrapFd: number,
        prlimitFd: number,
        metadataFds: ReadonlyArray<number>,
      ): Effect.Effect<SpawnedBubblewrap, VerifiedScopedShellError, Scope.Scope> =>
        Effect.gen(function* () {
          const owned = yield* Effect.acquireRelease(
            Effect.try({
              try: () => {
                // Ownership begins in the same uninterruptible acquisition in
                // which the OS child is created. Never wait for Node's async
                // `spawn` event before installing the release finalizer.
                const child = NodeChildProcess.spawn("/proc/self/fd/6", args, {
                  cwd: "/",
                  env: CLEAN_ENVIRONMENT,
                  shell: false,
                  detached: true,
                  stdio: [
                    "ignore",
                    "pipe",
                    "pipe",
                    executableFd,
                    cwdFd,
                    bwrapFd,
                    prlimitFd,
                    ...metadataFds,
                  ],
                });
                const state: { spawned: boolean; error: Error | undefined } = {
                  spawned: false,
                  error: undefined,
                };
                const onSpawn = () => {
                  state.spawned = true;
                };
                const onError = (cause: Error) => {
                  state.error ??= cause;
                };
                // These trackers also prevent an unhandled async spawn error
                // before the scoped use installs its result observers.
                child.once("spawn", onSpawn);
                child.on("error", onError);
                return { child, state, onSpawn, onError };
              },
              catch: (cause) =>
                failure(
                  admitted.policy.allowlistId,
                  "spawn-failed",
                  "Verified scoped shell could not create the pinned resource controller.",
                  cause,
                ),
            }),
            (resource) =>
              (resource.child.pid === undefined && resource.state.error !== undefined
                ? Effect.void
                : terminateProcessGroupAndReap(resource.child, "graceful")
              ).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    resource.child.removeListener("spawn", resource.onSpawn);
                    resource.child.removeListener("error", resource.onError);
                  }),
                ),
              ),
          );

          return yield* Effect.callback<SpawnedBubblewrap, VerifiedScopedShellError>((resume) => {
            // Execute the root-owned resource controller from an inherited,
            // already-verified descriptor. It in turn executes Bubblewrap from
            // another inherited descriptor after applying hard RLIMITs.
            const child = owned.child;
            let settled = false;
            const cleanup = () => {
              child.removeListener("spawn", onSpawn);
              child.removeListener("error", onError);
            };
            const settleSpawn = () => {
              if (settled) return;
              settled = true;
              cleanup();
              if (child.stdout === null || child.stderr === null) {
                resume(
                  Effect.fail(
                    failure(
                      admitted.policy.allowlistId,
                      "spawn-failed",
                      "Verified scoped shell did not create bounded output pipes.",
                    ),
                  ),
                );
                return;
              }
              const spawned = Effect.succeed({
                child,
                stdout: child.stdout,
                stderr: child.stderr,
              });
              const delay = testing?.spawnSettlementDelayMs ?? 0;
              resume(
                delay <= 0
                  ? spawned
                  : Effect.sleep(Duration.millis(delay)).pipe(Effect.andThen(spawned)),
              );
            };
            const onSpawn = () => settleSpawn();
            const onError = (cause: Error) => {
              if (settled) return;
              settled = true;
              cleanup();
              resume(
                Effect.fail(
                  failure(
                    admitted.policy.allowlistId,
                    "spawn-failed",
                    "Verified scoped shell could not start the pinned resource controller.",
                    cause,
                  ),
                ),
              );
            };
            child.once("spawn", onSpawn);
            child.once("error", onError);
            if (owned.state.error !== undefined) {
              onError(owned.state.error);
            } else if (owned.state.spawned) {
              settleSpawn();
            }
            return Effect.sync(cleanup);
          });
        }),
    );

    const executeWithResources: VerifiedLinuxScopedShell["Service"]["execute"] = (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          const admitted = yield* admit(input);
          yield* revalidate(admitted);

          // Every policy path is pinned before Bubblewrap is spawned. Bubblewrap
          // receives only duplicated descriptors for executable and cwd, never
          // the pathname strings that were subject to validation.
          const executable = yield* openStablePath(admitted, admitted.executable, "executable");
          const cwd = yield* openStablePath(admitted, admitted.cwd, "cwd");
          const bwrap = yield* openStablePath(admitted, admitted.bwrap, "bwrap");
          const prlimit = yield* openStablePath(admitted, admitted.prlimit, "prlimit");
          const openedRoots = yield* Effect.forEach(
            admitted.rootIdentities,
            (root) => openStablePath(admitted, root, "root"),
            { concurrency: 1 },
          );
          const gitMetadata =
            admitted.gitMetadata === undefined
              ? undefined
              : {
                  dotGit: yield* openStablePath(
                    admitted,
                    admitted.gitMetadata.dotGit,
                    "git-pointer",
                  ),
                  commonGitDir: yield* openStablePath(
                    admitted,
                    admitted.gitMetadata.commonGitDir,
                    "git-common-dir",
                  ),
                };

          if (
            !openedRoots.some(
              (root, index) =>
                isWithinRoot(path, cwd.livePath, root.livePath) &&
                accessAllows(admitted.roots[index]!.access, admitted.policy.access),
            )
          ) {
            return yield* failure(
              admitted.policy.allowlistId,
              "path-changed",
              "Scoped shell cwd descriptor is no longer inside a compatible root descriptor.",
            );
          }
          const writableRootPaths = openedRoots.flatMap((root, index) =>
            admitted.roots[index]!.access === "write" ? [root.livePath] : [],
          );
          if (
            writableRootPaths.some(
              (root) =>
                isWithinRoot(path, executable.livePath, root) ||
                isWithinRoot(path, bwrap.livePath, root) ||
                isWithinRoot(path, prlimit.livePath, root),
            )
          ) {
            return yield* failure(
              admitted.policy.allowlistId,
              "unsafe-runtime-location",
              "Pinned runtime executables and resource controls must remain outside writable root descriptors.",
            );
          }

          const filesystemBaseline =
            admitted.policy.access === "write"
              ? yield* availableFilesystemBytes(admitted.policy.allowlistId, cwd.handle.fd)
              : undefined;
          if (
            filesystemBaseline !== undefined &&
            filesystemBaseline <
              BigInt(
                VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS.minWritableFilesystemAvailableBytes +
                  VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS.maxWritableFilesystemDeltaBytes,
              )
          ) {
            return yield* failure(
              admitted.policy.allowlistId,
              "resource-control-unavailable",
              "The writable workspace filesystem does not have the required safety reserve.",
            );
          }

          const childExecutableFd = 3;
          const childCwdFd = 4;
          const childBwrapFd = 5;
          const childDotGitFd = 7;
          const childCommonGitDirFd = 8;
          const bwrapArguments = buildVerifiedScopedShellBwrapArguments({
            executableFd: childExecutableFd,
            argv: admitted.policy.argv,
            cwdFd: childCwdFd,
            access: admitted.policy.access,
            ...(gitMetadata === undefined
              ? {}
              : {
                  gitMetadata: {
                    dotGitFd: childDotGitFd,
                    commonGitDirFd: childCommonGitDirFd,
                    commonGitDirPath: gitMetadata.commonGitDir.livePath,
                  },
                }),
          });
          const args = buildVerifiedScopedShellPrlimitArguments({
            bwrapFd: childBwrapFd,
            bwrapArguments,
            timeoutMs: admitted.policy.timeoutMs,
            maxProcesses: admitted.maxProcesses,
          });
          const spawned = yield* spawnBubblewrap(
            admitted,
            args,
            executable.handle.fd,
            cwd.handle.fd,
            bwrap.handle.fd,
            prlimit.handle.fd,
            gitMetadata === undefined
              ? []
              : [gitMetadata.dotGit.handle.fd, gitMetadata.commonGitDir.handle.fd],
          );
          const filesystemFailure = yield* Ref.make<VerifiedScopedShellError | undefined>(
            undefined,
          );
          const filesystemMonitor =
            filesystemBaseline === undefined
              ? Option.none()
              : Option.some(
                  yield* Effect.forever(
                    Effect.sleep(
                      Duration.millis(
                        VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS.writableFilesystemPollIntervalMs,
                      ),
                    ).pipe(
                      Effect.andThen(
                        availableFilesystemBytes(admitted.policy.allowlistId, cwd.handle.fd),
                      ),
                      Effect.flatMap((available) => {
                        if (
                          !verifiedScopedShellWritableFilesystemLimitExceeded({
                            baselineAvailableBytes: filesystemBaseline,
                            currentAvailableBytes: available,
                          })
                        ) {
                          return Effect.void;
                        }
                        return Effect.fail(
                          failure(
                            admitted.policy.allowlistId,
                            "resource-limit-exceeded",
                            "Verified scoped shell exceeded the writable filesystem budget.",
                          ),
                        );
                      }),
                    ),
                  ).pipe(
                    Effect.catch((cause) =>
                      Ref.set(filesystemFailure, cause).pipe(
                        Effect.andThen(
                          Effect.sync(() => signalProcessGroup(spawned.child, "SIGKILL")),
                        ),
                      ),
                    ),
                    Effect.forkScoped,
                  ),
                );
          const output = yield* Effect.all(
            [
              collectOutput(
                admitted.policy.allowlistId,
                spawned.stdout,
                admitted.policy.stdoutMaxBytes,
              ),
              collectOutput(
                admitted.policy.allowlistId,
                spawned.stderr,
                admitted.policy.stderrMaxBytes,
              ),
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.forkScoped);
          const completed = yield* awaitExit(admitted.policy.allowlistId, spawned.child).pipe(
            Effect.catch((cause) =>
              Ref.get(filesystemFailure).pipe(
                Effect.flatMap((resourceFailure) =>
                  Effect.fail(resourceFailure === undefined ? cause : resourceFailure),
                ),
              ),
            ),
            Effect.timeoutOption(Duration.millis(admitted.policy.timeoutMs)),
          );
          if (Option.isNone(completed)) {
            yield* terminateProcessGroupAndReap(spawned.child, "immediate");
            return yield* failure(
              admitted.policy.allowlistId,
              "timeout",
              "Verified scoped shell exceeded its policy timeout.",
            );
          }
          if (Option.isSome(filesystemMonitor)) {
            yield* Fiber.interrupt(filesystemMonitor.value);
          }
          const resourceFailure = yield* Ref.get(filesystemFailure);
          if (resourceFailure !== undefined) return yield* resourceFailure;
          const [stdout, stderr] = yield* Fiber.join(output);
          return {
            allowlistId: admitted.policy.allowlistId,
            exitCode: Number(completed.value),
            stdout: stdout.text,
            stderr: stderr.text,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
            retryable: admitted.policy.retryable,
            idempotent: admitted.policy.idempotent,
            ...(admitted.policy.idempotencyKey === undefined
              ? {}
              : { idempotencyKey: admitted.policy.idempotencyKey }),
          } satisfies VerifiedScopedShellExecutionResult;
        }),
      );

    const execute: VerifiedLinuxScopedShell["Service"]["execute"] = (input) =>
      executionSlots
        .withPermitsIfAvailable(1)(executeWithResources(input))
        .pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  failure(
                    typeof input.policy.allowlistId === "string"
                      ? input.policy.allowlistId
                      : "invalid",
                    "spawn-failed",
                    "Verified scoped shell concurrency is at capacity; no command was started.",
                  ),
                ),
              onSome: Effect.succeed,
            }),
          ),
        );

    return VerifiedLinuxScopedShell.of({ execute });
  },
);

export const makeVerifiedLinuxScopedShell = () =>
  makeVerifiedLinuxScopedShellWithOptions(undefined);

/** Security lifecycle seams exposed only for deterministic adversarial tests. */
export const __testing = {
  makeWithSpawnSettlementDelay: (spawnSettlementDelayMs: number) =>
    makeVerifiedLinuxScopedShellWithOptions({ spawnSettlementDelayMs }),
  processGroupIsAlive,
  terminateProcessGroupAndReap,
};

export const VerifiedLinuxScopedShellLayer = Layer.effect(
  VerifiedLinuxScopedShell,
  makeVerifiedLinuxScopedShell(),
);
