/**
 * Command Center isolation for Codex app-server sessions on orchestration v2.
 *
 * A `cc:` thread runs Codex with an isolated `CODEX_HOME`, an allowlisted
 * environment, locked app-server arguments and a permission profile that
 * denies the host root, disables network and limits writes to the workspace
 * (`provider/security/CommandCenterProviderIsolation.ts` builds those). This
 * module adds the runtime half the v1 session runtime used to own:
 *
 * - `verifyCommandCenterCodexIsolation`: a live `command/exec` probe through
 *   the same app-server command path Codex tools use, run before any model
 *   turn. Anything but the exact success marker fails the session closed.
 * - `ensureCommandCenterWindowsSandbox`: on Windows the elevated native
 *   sandbox must be ready, or its setup must complete successfully, first.
 * - `commandCenterPermissionProfileMismatch`: Codex reporting a different
 *   active permission profile than the one requested is an error.
 */
import * as NodeNet from "node:net";

import type { RuntimeMode, ThreadId } from "@t3tools/contracts";
import type { CodexSettings } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { resolveCommandPath } from "@t3tools/shared/shell";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import {
  COMMAND_CENTER_CODEX_READ_PERMISSION_PROFILE,
  COMMAND_CENTER_CODEX_WRITE_PERMISSION_PROFILE,
  commandCenterCodexIsolation,
  commandCenterProviderEnvironment,
  commandCenterProviderIsolationIssue,
  commandCenterProviderPlatformIssue,
  isCommandCenterThreadId,
  prepareCommandCenterCodexHome,
  resolveCommandCenterCodexRuntimeExecutable,
  resolveCommandCenterManagedGitMetadata,
} from "../../provider/security/CommandCenterProviderIsolation.ts";

const decodeV2CommandExecResponse = Schema.decodeUnknownEffect(
  EffectCodexSchema.V2CommandExecResponse,
);
const decodeV2WindowsSandboxReadinessResponse = Schema.decodeUnknownEffect(
  EffectCodexSchema.V2WindowsSandboxReadinessResponse,
);
const decodeV2WindowsSandboxSetupStartResponse = Schema.decodeUnknownEffect(
  EffectCodexSchema.V2WindowsSandboxSetupStartResponse,
);

export class CodexCommandCenterIsolationProbeError extends Schema.TaggedError<CodexCommandCenterIsolationProbeError>()(
  "CodexCommandCenterIsolationProbeError",
  {
    issue: Schema.String,
    exitCode: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    return this.issue;
  }
}

export class CodexCommandCenterWindowsSandboxSetupError extends Schema.TaggedError<CodexCommandCenterWindowsSandboxSetupError>()(
  "CodexCommandCenterWindowsSandboxSetupError",
  {
    issue: Schema.String,
    mode: Schema.Literals(["elevated", "unelevated"]),
  },
) {
  override get message(): string {
    return this.issue;
  }
}

export class CodexCommandCenterPermissionProfileMismatchError extends Schema.TaggedError<CodexCommandCenterPermissionProfileMismatchError>()(
  "CodexCommandCenterPermissionProfileMismatchError",
  {
    expected: Schema.String,
    actual: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.actual === undefined
      ? `Codex did not activate required permission profile '${this.expected}'.`
      : `Codex activated permission profile '${this.actual}' instead of required profile '${this.expected}'.`;
  }
}

/** Refusal raised inside the Codex adapter for a `cc:` session or turn. */
export class CodexCommandCenterSessionRefusedError extends Schema.TaggedError<CodexCommandCenterSessionRefusedError>()(
  "CodexCommandCenterSessionRefusedError",
  {
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.issue;
  }
}

/**
 * Reads `activePermissionProfile` from a `thread/start`, `thread/resume` or
 * `thread/fork` response. Only a positive mismatch fails: Codex 0.144.x does
 * not echo the field on `thread/start` even when the profile is active, and
 * isolation has already been proven by the live probe before any thread opens.
 */
const ActivePermissionProfileEcho = Schema.Struct({
  activePermissionProfile: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ id: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
  ),
});
const isActivePermissionProfileEcho = Schema.is(ActivePermissionProfileEcho);

export function commandCenterPermissionProfileMismatch(
  expected: string,
  response: unknown,
): CodexCommandCenterPermissionProfileMismatchError | undefined {
  if (!isActivePermissionProfileEcho(response)) {
    return undefined;
  }
  const actual = response.activePermissionProfile?.id ?? undefined;
  return actual !== undefined && actual !== expected
    ? new CodexCommandCenterPermissionProfileMismatchError({ expected, actual })
    : undefined;
}

export function isCommandCenterPermissionProfile(
  permissionProfile: string | undefined,
): permissionProfile is
  | typeof COMMAND_CENTER_CODEX_READ_PERMISSION_PROFILE
  | typeof COMMAND_CENTER_CODEX_WRITE_PERMISSION_PROFILE {
  return (
    permissionProfile === COMMAND_CENTER_CODEX_READ_PERMISSION_PROFILE ||
    permissionProfile === COMMAND_CENTER_CODEX_WRITE_PERMISSION_PROFILE
  );
}

interface CodexIsolationProbeClient {
  readonly request: (
    method: "command/exec",
    payload: CodexRpc.ClientRequestParamsByMethod["command/exec"],
  ) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>;
}

const COMMAND_CENTER_ISOLATION_PROBE_SUCCESS = "command-center-isolation-ok";
const COMMAND_CENTER_ISOLATION_READ_DENIAL_READY = "command-center-isolation-read-denial-ready";

export function isCommandCenterIsolationProbeAccepted(
  writable: boolean,
  result: { readonly exitCode: number; readonly stdout: string },
): boolean {
  return writable
    ? result.exitCode === 0 && result.stdout.trim() === COMMAND_CENTER_ISOLATION_PROBE_SUCCESS
    : [1, 73].includes(result.exitCode) &&
        result.stdout.trim() === COMMAND_CENTER_ISOLATION_READ_DENIAL_READY;
}

export function buildCommandCenterIsolationProbeScript(
  writable: boolean,
  blockedNetworkPort?: number,
): string {
  const workspaceCheck = writable
    ? [
        'probe_path=".cc-provider-isolation-probe.$$"',
        "trap 'rm -f \"$probe_path\"' EXIT",
        ': > "$probe_path" || exit 73',
        'rm -f "$probe_path"',
        "trap - EXIT",
      ]
    : [
        'probe_path=".cc-provider-isolation-probe.$$"',
        "trap 'rm -f \"$probe_path\"' EXIT",
        `printf '${COMMAND_CENTER_ISOLATION_READ_DENIAL_READY}\\n'`,
        'if : > "$probe_path" 2>/dev/null; then',
        '  rm -f "$probe_path"',
        "  trap - EXIT",
        "  exit 74",
        "fi",
        "exit 73",
      ];
  return [
    "set -eu",
    'test -z "${CC_PROVIDER_ISOLATION_SENTINEL:-}" || exit 70',
    'test -z "${T3_MCP_BEARER_TOKEN:-}" || exit 70',
    'test -z "${OPENAI_API_KEY:-}" || exit 70',
    'test ! -r "$HOME/auth.json" || exit 71',
    'test ! -r "$HOME/.cc-provider-isolation-canary" || exit 80',
    ...(blockedNetworkPort === undefined
      ? []
      : [`if (: > /dev/tcp/127.0.0.1/${blockedNetworkPort}) 2>/dev/null; then`, "  exit 79", "fi"]),
    "if test -e .git; then",
    "  test ! -w .git || exit 75",
    "  /usr/bin/git status --porcelain=v1 >/dev/null",
    "  git_dir=$(/usr/bin/git rev-parse --git-dir 2>/dev/null || true)",
    '  test -z "$git_dir" || test ! -w "$git_dir" || exit 76',
    "  common_git_dir=$(/usr/bin/git rev-parse --git-common-dir 2>/dev/null || true)",
    '  test -z "$common_git_dir" || test ! -w "$common_git_dir" || exit 77',
    "fi",
    ...workspaceCheck,
    `printf '${COMMAND_CENTER_ISOLATION_PROBE_SUCCESS}\\n'`,
  ].join("\n");
}

export function buildCommandCenterDarwinIsolationProbeScript(
  writable: boolean,
  blockedNetworkPort?: number,
): string {
  const workspaceCheck = writable
    ? [
        'probe_path=".cc-provider-isolation-probe.$$"',
        "trap 'rm -f \"$probe_path\"' EXIT",
        ': > "$probe_path" || exit 73',
        'rm -f "$probe_path"',
        "trap - EXIT",
      ]
    : [
        'probe_path=".cc-provider-isolation-probe.$$"',
        "trap 'rm -f \"$probe_path\"' EXIT",
        'if : > "$probe_path" 2>/dev/null; then',
        '  rm -f "$probe_path"',
        "  trap - EXIT",
        "  exit 74",
        "fi",
        `printf '${COMMAND_CENTER_ISOLATION_READ_DENIAL_READY}\\n'`,
        "exit 73",
      ];
  return [
    "set -eu",
    'test -z "${CC_PROVIDER_ISOLATION_SENTINEL:-}" || exit 70',
    'test -z "${T3_MCP_BEARER_TOKEN:-}" || exit 70',
    'test -z "${OPENAI_API_KEY:-}" || exit 70',
    'test ! -r "$HOME/auth.json" || exit 71',
    'test ! -r "$HOME/.cc-provider-isolation-canary" || exit 80',
    ...(blockedNetworkPort === undefined
      ? []
      : [
          `if /usr/bin/nc -z -w 1 127.0.0.1 ${blockedNetworkPort} 2>/dev/null; then`,
          "  exit 79",
          "fi",
        ]),
    "if test -e .git; then",
    "  test ! -w .git || exit 75",
    "  /usr/bin/git status --porcelain=v1 >/dev/null",
    "  git_dir=$(/usr/bin/git rev-parse --git-dir 2>/dev/null || true)",
    '  test -z "$git_dir" || test ! -w "$git_dir" || exit 76',
    "  common_git_dir=$(/usr/bin/git rev-parse --git-common-dir 2>/dev/null || true)",
    '  test -z "$common_git_dir" || test ! -w "$common_git_dir" || exit 77',
    "fi",
    ...workspaceCheck,
    `printf '${COMMAND_CENTER_ISOLATION_PROBE_SUCCESS}\\n'`,
  ].join("\n");
}

export function buildCommandCenterWindowsIsolationProbeScript(
  writable: boolean,
  blockedNetworkPort?: number,
): string {
  const workspaceCheck = writable
    ? [
        "$probePath = Join-Path (Get-Location) '.cc-provider-isolation-probe'",
        "try { [IO.File]::WriteAllText($probePath, '') } catch { exit 73 }",
        "Remove-Item -LiteralPath $probePath -Force",
      ]
    : [
        "$probePath = Join-Path (Get-Location) '.cc-provider-isolation-probe'",
        "try { [IO.File]::WriteAllText($probePath, ''); Remove-Item -LiteralPath $probePath -Force; exit 74 } catch {}",
        `Write-Output '${COMMAND_CENTER_ISOLATION_READ_DENIAL_READY}'`,
        "exit 73",
      ];
  return [
    "$ErrorActionPreference = 'Stop'",
    "if ($env:CC_PROVIDER_ISOLATION_SENTINEL -or $env:T3_MCP_BEARER_TOKEN -or $env:OPENAI_API_KEY) { exit 70 }",
    "$authPath = Join-Path $env:USERPROFILE 'auth.json'",
    "try { $stream = [IO.File]::OpenRead($authPath); $stream.Dispose(); exit 71 } catch {}",
    "$canaryPath = Join-Path $env:USERPROFILE '.cc-provider-isolation-canary'",
    "try { $stream = [IO.File]::OpenRead($canaryPath); $stream.Dispose(); exit 80 } catch {}",
    ...(blockedNetworkPort === undefined
      ? []
      : [
          `try { $client = [Net.Sockets.TcpClient]::new(); $client.Connect('127.0.0.1', ${blockedNetworkPort}); $client.Dispose(); exit 79 } catch {}`,
        ]),
    "if (Test-Path -LiteralPath '.git') {",
    "  $gitEntry = Get-Item -LiteralPath '.git' -Force",
    "  if ($gitEntry.PSIsContainer) {",
    "    $gitProbe = Join-Path $gitEntry.FullName '.cc-provider-isolation-probe'",
    "    try { [IO.File]::WriteAllText($gitProbe, ''); Remove-Item -LiteralPath $gitProbe -Force; exit 75 } catch {}",
    "  } else {",
    "    try { $stream = [IO.File]::Open($gitEntry.FullName, 'Open', 'Write'); $stream.Dispose(); exit 75 } catch {}",
    "  }",
    "  & git status --porcelain=v1 *> $null",
    "  if ($LASTEXITCODE -ne 0) { exit 78 }",
    "}",
    ...workspaceCheck,
    `Write-Output '${COMMAND_CENTER_ISOLATION_PROBE_SUCCESS}'`,
  ].join("\n");
}

const acquireCommandCenterNetworkProbe = Effect.callback<
  { readonly server: NodeNet.Server; readonly port: number },
  CodexCommandCenterIsolationProbeError
>((resume) => {
  const server = NodeNet.createServer((socket) => socket.destroy());
  server.unref();
  server.once("error", (cause) =>
    resume(
      Effect.fail(
        new CodexCommandCenterIsolationProbeError({
          issue: `Command Center could not open its local network-isolation probe: ${cause.message}`,
        }),
      ),
    ),
  );
  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    resume(
      port > 0
        ? Effect.succeed({ server, port })
        : Effect.fail(
            new CodexCommandCenterIsolationProbeError({
              issue: "Command Center received an invalid local network-isolation probe port.",
            }),
          ),
    );
  });
  return Effect.sync(() => server.close());
});

const releaseCommandCenterNetworkProbe = (probe: {
  readonly server: NodeNet.Server;
  readonly port: number;
}) =>
  Effect.callback<void>((resume) => {
    probe.server.close(() => resume(Effect.void));
  });

/**
 * Exercise the admitted profile through the same app-server command path used
 * by Codex tools before any untrusted model turn can run.
 */
export const verifyCommandCenterCodexIsolation = Effect.fn("CodexCommandCenterIsolation.verify")(
  function* (input: {
    readonly client: CodexIsolationProbeClient;
    readonly cwd: string;
    readonly permissionProfile: string;
    readonly platform: NodeJS.Platform;
  }) {
    const writable = input.permissionProfile === COMMAND_CENTER_CODEX_WRITE_PERMISSION_PROFILE;
    if (!writable && input.permissionProfile !== COMMAND_CENTER_CODEX_READ_PERMISSION_PROFILE) {
      return yield* new CodexCommandCenterIsolationProbeError({
        issue: "Command Center received an unknown Codex isolation profile.",
      });
    }
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const networkProbe = yield* Effect.acquireRelease(
          acquireCommandCenterNetworkProbe,
          releaseCommandCenterNetworkProbe,
        );
        const command =
          input.platform === "win32"
            ? [
                "powershell.exe",
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                buildCommandCenterWindowsIsolationProbeScript(writable, networkProbe.port),
              ]
            : input.platform === "darwin"
              ? [
                  "/bin/bash",
                  "-c",
                  buildCommandCenterDarwinIsolationProbeScript(writable, networkProbe.port),
                ]
              : [
                  "/usr/bin/bash",
                  "-c",
                  buildCommandCenterIsolationProbeScript(writable, networkProbe.port),
                ];
        return yield* input.client
          .request("command/exec", {
            command,
            cwd: input.cwd,
            timeoutMs: 10_000,
          })
          .pipe(
            Effect.flatMap(decodeV2CommandExecResponse),
            Effect.mapError((cause) =>
              Schema.isSchemaError(cause)
                ? CodexErrors.CodexAppServerProtocolParseError.fromSchemaError(
                    "decode-response-payload",
                    cause,
                    { method: "command/exec" },
                  )
                : cause,
            ),
          );
      }),
    );
    const accepted = isCommandCenterIsolationProbeAccepted(writable, result);
    if (!accepted) {
      return yield* new CodexCommandCenterIsolationProbeError({
        issue:
          "Command Center blocked the Codex session because its live filesystem, process, or environment isolation probe failed.",
        exitCode: result.exitCode,
      });
    }
  },
);

interface CodexWindowsSandboxSetupClient {
  readonly request: (
    method: "windowsSandbox/readiness" | "windowsSandbox/setupStart",
    payload: unknown,
  ) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>;
}

export const ensureCommandCenterWindowsSandbox = Effect.fn(
  "CodexCommandCenterIsolation.ensureWindowsSandbox",
)(function* (input: {
  readonly client: CodexWindowsSandboxSetupClient;
  readonly cwd: string;
  readonly mode: "elevated";
  readonly setupCompleted: Effect.Effect<
    EffectCodexSchema.V2WindowsSandboxSetupCompletedNotification,
    never
  >;
}) {
  const setupError = (issue: string) =>
    new CodexCommandCenterWindowsSandboxSetupError({
      issue,
      mode: input.mode,
    });
  const readiness = yield* input.client.request("windowsSandbox/readiness", undefined).pipe(
    Effect.flatMap(decodeV2WindowsSandboxReadinessResponse),
    Effect.mapError((cause) =>
      setupError(
        `Command Center requires a Codex installation with native Windows sandbox setup support: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
    ),
  );
  if (readiness.status === "ready") return;

  const started = yield* input.client
    .request("windowsSandbox/setupStart", { mode: input.mode, cwd: input.cwd })
    .pipe(
      Effect.flatMap(decodeV2WindowsSandboxSetupStartResponse),
      Effect.mapError((cause) =>
        setupError(
          `Codex could not start ${input.mode} Windows sandbox setup: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      ),
    );
  if (!started.started) {
    return yield* setupError(`Codex declined to start ${input.mode} Windows sandbox setup.`);
  }

  const completed = yield* input.setupCompleted.pipe(
    Effect.timeout("2 minutes"),
    Effect.mapError(() =>
      setupError(`Timed out waiting for ${input.mode} Windows sandbox setup to complete.`),
    ),
  );
  if (completed.mode !== input.mode) {
    return yield* setupError(
      `Codex completed '${completed.mode}' Windows sandbox setup while '${input.mode}' was required.`,
    );
  }
  if (!completed.success) {
    const safeError = completed.error?.split(/\r?\n/u)[0]?.trim();
    return yield* setupError(
      `Command Center requires Codex's administrator-approved Windows sandbox to enforce workspace-only filesystem access. Approve the administrator prompt and try again.${safeError ? ` Codex reported: ${safeError}` : ""}`,
    );
  }
});

/** Everything an isolated `cc:` Codex app-server launch needs. */
export interface CommandCenterCodexLaunch {
  readonly permissionProfile: string;
  readonly platform: NodeJS.Platform;
  readonly windowsSandboxMode?: "elevated";
  /** Locked isolation arguments appended after the user's launch arguments. */
  readonly appServerArgs: ReadonlyArray<string>;
  /** Canonical native runtime and isolated home; replaces the user's settings. */
  readonly settings: CodexSettings;
  /** The complete allowlisted environment; the spawn must not extend it. */
  readonly environment: NodeJS.ProcessEnv;
}

const refused = (issue: string, cause?: unknown) =>
  new CodexCommandCenterSessionRefusedError({
    issue,
    ...(cause === undefined ? {} : { cause }),
  });

const issueOf = (cause: unknown, fallback: string): string =>
  typeof cause === "object" &&
  cause !== null &&
  "issue" in cause &&
  typeof (cause as { readonly issue: unknown }).issue === "string"
    ? (cause as { readonly issue: string }).issue
    : fallback;

/**
 * Builds the isolated launch for a Command Center thread, or `undefined` for
 * any other thread. Fails closed: a non-Codex provider, full-access mode, an
 * unsupported platform, an unresolvable native runtime, or an isolated home
 * that cannot be prepared all refuse the session before anything spawns.
 */
export const prepareCommandCenterCodexLaunch = Effect.fn(
  "CodexCommandCenterIsolation.prepareLaunch",
)(function* (input: {
  readonly threadId: ThreadId;
  readonly runtimeMode: RuntimeMode;
  readonly cwd: string | null;
  readonly settings: CodexSettings;
  readonly sourceEnvironment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly stateDir: string;
  readonly baseDir: string;
  readonly worktreesDir: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly crypto: Crypto.Crypto;
  readonly homeDirectory: string;
  /** Test seam: the `codex` launcher to canonicalize instead of a PATH lookup. */
  readonly runtimeCommandPath?: string;
}) {
  if (!isCommandCenterThreadId(input.threadId)) {
    return undefined;
  }
  const { fileSystem, path } = input;
  const admissionIssue = commandCenterProviderIsolationIssue({
    threadId: input.threadId,
    provider: "codex",
    runtimeMode: input.runtimeMode,
  });
  if (admissionIssue !== undefined) return yield* refused(admissionIssue);
  const platformIssue = commandCenterProviderPlatformIssue(input.platform, input.threadId);
  if (platformIssue !== undefined) return yield* refused(platformIssue);
  if (input.cwd === null || !path.isAbsolute(input.cwd)) {
    return yield* refused("Command Center Codex sessions need an absolute workspace directory.");
  }
  const cwd = input.cwd;

  const managedGitMetadata = yield* resolveCommandCenterManagedGitMetadata({
    baseDir: input.baseDir,
    worktreesDir: input.worktreesDir,
    cwd,
    fileSystem,
    path,
  }).pipe(Effect.mapError((cause) => refused(cause.issue, cause)));

  const commandPath =
    input.runtimeCommandPath ??
    (yield* resolveCommandPath("codex", {
      env: input.sourceEnvironment,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) =>
        refused("Command Center could not find the Codex runtime launcher.", cause),
      ),
    ));
  if (commandPath === null || commandPath === undefined) {
    return yield* refused("Command Center could not find the Codex runtime launcher.");
  }
  const runtimeExecutable = yield* resolveCommandCenterCodexRuntimeExecutable({
    commandPath,
    platform: input.platform,
    architecture: input.architecture,
    fileSystem,
    path,
  }).pipe(
    Effect.mapError((cause) =>
      refused(
        issueOf(
          cause,
          "Command Center could not resolve the Codex runtime executable for its isolated permission profile.",
        ),
        cause,
      ),
    ),
  );

  const configuredHome = input.settings.homePath.trim();
  const environmentHome = input.sourceEnvironment.CODEX_HOME?.trim();
  const userHome =
    input.sourceEnvironment.HOME?.trim() || input.sourceEnvironment.USERPROFILE?.trim();
  const sourceHomePath =
    configuredHome.length > 0
      ? path.resolve(expandHomePath(configuredHome, input.homeDirectory))
      : environmentHome
        ? path.resolve(expandHomePath(environmentHome, input.homeDirectory))
        : userHome
          ? path.join(path.resolve(userHome), ".codex")
          : path.join(input.homeDirectory, ".codex");
  const writableRoots = [cwd, input.worktreesDir];
  const home = yield* prepareCommandCenterCodexHome({
    stateDir: input.stateDir,
    sourceHomePath,
    threadId: input.threadId,
    fileSystem,
    path,
    crypto: input.crypto,
    runtimeExecutablePath: runtimeExecutable,
    platform: input.platform,
    writableRoots,
  }).pipe(Effect.mapError((cause) => refused(cause.issue, cause)));

  const isolation = commandCenterCodexIsolation(
    input.runtimeMode,
    managedGitMetadata,
    runtimeExecutable,
    home,
    input.platform,
  );
  if (isolation === undefined) {
    return yield* refused(
      "Command Center could not establish its isolated Codex permission profile.",
    );
  }
  const environment = commandCenterProviderEnvironment({
    source: input.sourceEnvironment,
    ...home,
    ...(input.platform === "win32"
      ? { runtimeSupportPath: path.join(path.dirname(path.dirname(runtimeExecutable)), "path") }
      : {}),
    writableRoots,
  });
  return {
    permissionProfile: isolation.permissionProfile,
    platform: input.platform,
    ...(isolation.windowsSandboxMode === undefined
      ? {}
      : { windowsSandboxMode: isolation.windowsSandboxMode }),
    appServerArgs: isolation.appServerArgs,
    settings: { ...input.settings, binaryPath: runtimeExecutable, homePath: home.homePath },
    environment,
  } satisfies CommandCenterCodexLaunch;
});

/** The permission profile a `cc:` turn must run under, or why it cannot run. */
export function commandCenterTurnPermissionProfile(
  launch: CommandCenterCodexLaunch,
  runtimeMode: RuntimeMode,
): { readonly permissionProfile: string } | { readonly issue: string } {
  if (runtimeMode === "full-access") {
    return { issue: "Command Center runs cannot use full-access provider sessions." };
  }
  const wanted =
    runtimeMode === "auto-accept-edits" || runtimeMode === "auto"
      ? COMMAND_CENTER_CODEX_WRITE_PERMISSION_PROFILE
      : COMMAND_CENTER_CODEX_READ_PERMISSION_PROFILE;
  // The app-server was launched, and probed, with exactly one profile.
  return wanted === launch.permissionProfile
    ? { permissionProfile: wanted }
    : {
        issue:
          "This Command Center session was isolated for a different runtime mode; start a new session to change it.",
      };
}

/**
 * `turn/start` params for a `cc:` turn: the admitted permission profile with
 * approvals off. Caller sandbox, reviewer and approval overrides are dropped,
 * so a turn can never widen what the probed profile allows.
 */
export function commandCenterTurnStartParams<
  P extends { readonly approvalsReviewer?: unknown; readonly sandboxPolicy?: unknown },
>(
  params: P,
  permissionProfile: string,
): Omit<P, "approvalsReviewer" | "sandboxPolicy" | "approvalPolicy"> & {
  readonly approvalPolicy: "never";
  readonly permissions: string;
} {
  const {
    approvalsReviewer: _reviewer,
    sandboxPolicy: _sandbox,
    approvalPolicy: _approval,
    ...rest
  } = params as P & { readonly approvalPolicy?: unknown };
  return { ...rest, approvalPolicy: "never", permissions: permissionProfile };
}

/** `thread/start` params for a `cc:` thread, same rule as turns. */
export function commandCenterThreadStartParams<P extends object>(
  params: P,
  permissionProfile: string,
): P & { readonly approvalPolicy: "never"; readonly permissions: string } {
  return { ...params, approvalPolicy: "never", permissions: permissionProfile };
}
