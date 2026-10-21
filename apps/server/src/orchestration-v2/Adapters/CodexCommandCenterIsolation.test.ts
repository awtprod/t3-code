import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import { CodexSettings, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as CodexClient from "effect-codex-app-server/client";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  COMMAND_CENTER_CODEX_READ_PERMISSION_PROFILE,
  COMMAND_CENTER_CODEX_WRITE_PERMISSION_PROFILE,
} from "../../provider/security/CommandCenterProviderIsolation.ts";
import {
  buildCommandCenterDarwinIsolationProbeScript,
  buildCommandCenterIsolationProbeScript,
  buildCommandCenterWindowsIsolationProbeScript,
  type CommandCenterCodexLaunch,
  commandCenterPermissionProfileMismatch,
  commandCenterRequestCwd,
  commandCenterThreadStartParams,
  commandCenterTurnPermissionProfile,
  commandCenterTurnStartParams,
  ensureCommandCenterWindowsSandbox,
  isCommandCenterIsolationProbeAccepted,
  prepareCommandCenterCodexLaunch,
  verifyCommandCenterCodexIsolation,
} from "./CodexCommandCenterIsolation.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { makeReplayServerConfig } from "./CodexAdapterV2.testkit.ts";

const DEFAULT_SETTINGS = Schema.decodeSync(CodexSettings)({});

const writeLaunch = (permissionProfile: string): CommandCenterCodexLaunch => ({
  permissionProfile,
  platform: "linux",
  cwd: "/workspace",
  appServerArgs: [],
  settings: DEFAULT_SETTINGS,
  environment: {},
});

describe("Command Center native sandbox admission", () => {
  it.effect("skips Windows setup when Codex reports the sandbox ready", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      yield* ensureCommandCenterWindowsSandbox({
        client: {
          request: (method) =>
            Effect.sync(() => {
              calls.push(method);
              return { status: "ready" };
            }),
        },
        cwd: "C:\\workspace",
        mode: "elevated",
        setupCompleted: Effect.never,
      });
      NodeAssert.deepStrictEqual(calls, ["windowsSandbox/readiness"]);
    }),
  );

  it.effect("reports failed elevated setup without offering an unsafe fallback", () =>
    Effect.gen(function* () {
      const error = yield* ensureCommandCenterWindowsSandbox({
        client: {
          request: (method) =>
            Effect.succeed(
              method === "windowsSandbox/readiness"
                ? { status: "notConfigured" }
                : { started: true },
            ),
        },
        cwd: "C:\\workspace",
        mode: "elevated",
        setupCompleted: Effect.succeed({
          mode: "elevated",
          success: false,
          error: "administrator approval was unavailable",
        }),
      }).pipe(Effect.flip);
      NodeAssert.equal(error._tag, "CodexCommandCenterWindowsSandboxSetupError");
      NodeAssert.match(error.issue, /administrator-approved Windows sandbox/u);
      NodeAssert.match(error.issue, /administrator approval was unavailable/u);
    }),
  );

  it.effect("fails closed when Codex declines or cannot start setup", () =>
    Effect.gen(function* () {
      const declined = yield* ensureCommandCenterWindowsSandbox({
        client: {
          request: (method) =>
            Effect.succeed(
              method === "windowsSandbox/readiness"
                ? { status: "notConfigured" }
                : { started: false },
            ),
        },
        cwd: "C:\\workspace",
        mode: "elevated",
        setupCompleted: Effect.never,
      }).pipe(Effect.flip);
      NodeAssert.match(declined.issue, /declined/u);

      const unsupported = yield* ensureCommandCenterWindowsSandbox({
        client: { request: () => Effect.succeed({ unexpected: true }) },
        cwd: "C:\\workspace",
        mode: "elevated",
        setupCompleted: Effect.never,
      }).pipe(Effect.flip);
      NodeAssert.match(unsupported.issue, /native Windows sandbox setup support/u);
    }),
  );

  it("builds native probes without Linux-only process assumptions", () => {
    const linux = buildCommandCenterIsolationProbeScript(true);
    const darwin = buildCommandCenterDarwinIsolationProbeScript(true);
    const windows = buildCommandCenterWindowsIsolationProbeScript(false);
    NodeAssert.doesNotMatch(linux, /\/proc\//u);
    NodeAssert.match(linux, /CC_PROVIDER_ISOLATION_SENTINEL/u);
    NodeAssert.match(linux, /T3_MCP_BEARER_TOKEN/u);
    NodeAssert.match(linux, /OPENAI_API_KEY/u);
    NodeAssert.doesNotMatch(darwin, /\/proc\//u);
    NodeAssert.match(darwin, /HOME\/auth\.json/u);
    NodeAssert.match(windows, /USERPROFILE/u);
    NodeAssert.match(windows, /WriteAllText/u);
    NodeAssert.match(windows, /exit 73/u);
  });

  it("admits both shell-reported and sandbox-enforced read denials after the marker", () => {
    const linux = buildCommandCenterIsolationProbeScript(false);
    NodeAssert.ok(
      linux.indexOf("command-center-isolation-read-denial-ready") <
        linux.indexOf(': > "$probe_path"'),
    );
    NodeAssert.equal(
      isCommandCenterIsolationProbeAccepted(false, {
        exitCode: 1,
        stdout: "command-center-isolation-read-denial-ready\n",
      }),
      true,
    );
    NodeAssert.equal(
      isCommandCenterIsolationProbeAccepted(false, {
        exitCode: 74,
        stdout: "command-center-isolation-read-denial-ready\n",
      }),
      false,
    );
    NodeAssert.equal(
      isCommandCenterIsolationProbeAccepted(false, { exitCode: 1, stdout: "" }),
      false,
    );
  });
});

describe("Command Center live isolation probe", () => {
  const probeClient = (result: { exitCode: number; stdout: string; stderr?: string }) => {
    const commands: Array<unknown> = [];
    return {
      commands,
      client: {
        request: (_method: "command/exec", payload: unknown) =>
          Effect.sync(() => {
            commands.push(payload);
            return {
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr ?? "",
            };
          }),
      },
    };
  };

  it.effect("passes only on the exact success marker from the writable profile", () =>
    Effect.gen(function* () {
      const ok = probeClient({ exitCode: 0, stdout: "command-center-isolation-ok\n" });
      yield* verifyCommandCenterCodexIsolation({
        client: ok.client,
        cwd: "/workspace",
        permissionProfile: COMMAND_CENTER_CODEX_WRITE_PERMISSION_PROFILE,
        platform: "linux",
      });
      NodeAssert.equal(ok.commands.length, 1);
      const command = (ok.commands[0] as { readonly command: ReadonlyArray<string> }).command;
      NodeAssert.equal(command[0], "/usr/bin/bash");
      NodeAssert.match(command.at(-1) ?? "", /\/dev\/tcp\/127\.0\.0\.1\/\d+/u);
    }),
  );

  it.effect("fails the session closed when the probe sees a leak", () =>
    Effect.gen(function* () {
      // Exit 70: the sentinel, the MCP bearer or an API key was visible to the command.
      const leaked = probeClient({ exitCode: 70, stdout: "" });
      const error = yield* verifyCommandCenterCodexIsolation({
        client: leaked.client,
        cwd: "/workspace",
        permissionProfile: COMMAND_CENTER_CODEX_WRITE_PERMISSION_PROFILE,
        platform: "linux",
      }).pipe(Effect.flip);
      NodeAssert.equal(error._tag, "CodexCommandCenterIsolationProbeError");
      if (error._tag === "CodexCommandCenterIsolationProbeError") {
        NodeAssert.equal(error.exitCode, 70);
      }

      // A read-only profile that could write is refused even with a success marker.
      const wrote = probeClient({ exitCode: 0, stdout: "command-center-isolation-ok\n" });
      const readError = yield* verifyCommandCenterCodexIsolation({
        client: wrote.client,
        cwd: "/workspace",
        permissionProfile: COMMAND_CENTER_CODEX_READ_PERMISSION_PROFILE,
        platform: "linux",
      }).pipe(Effect.flip);
      NodeAssert.equal(readError._tag, "CodexCommandCenterIsolationProbeError");

      const unknown = probeClient({ exitCode: 0, stdout: "command-center-isolation-ok\n" });
      const unknownError = yield* verifyCommandCenterCodexIsolation({
        client: unknown.client,
        cwd: "/workspace",
        permissionProfile: "acme-profile",
        platform: "linux",
      }).pipe(Effect.flip);
      NodeAssert.equal(unknownError._tag, "CodexCommandCenterIsolationProbeError");
      NodeAssert.equal(unknown.commands.length, 0);
    }),
  );
});

describe("Command Center permission profile on thread and turn start", () => {
  it("sends the admitted profile with approvals off and drops caller sandbox overrides", () => {
    const turn = commandCenterTurnStartParams(
      {
        threadId: "native-thread",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
        model: "gpt-acme",
      },
      COMMAND_CENTER_CODEX_WRITE_PERMISSION_PROFILE,
    );
    NodeAssert.deepStrictEqual(turn, {
      threadId: "native-thread",
      model: "gpt-acme",
      approvalPolicy: "never",
      permissions: COMMAND_CENTER_CODEX_WRITE_PERMISSION_PROFILE,
    });
    NodeAssert.deepStrictEqual(
      commandCenterThreadStartParams(
        { cwd: "/workspace" },
        COMMAND_CENTER_CODEX_READ_PERMISSION_PROFILE,
      ),
      {
        cwd: "/workspace",
        approvalPolicy: "never",
        permissions: COMMAND_CENTER_CODEX_READ_PERMISSION_PROFILE,
      },
    );
  });

  it("treats only a different active profile as a mismatch", () => {
    const expected = COMMAND_CENTER_CODEX_WRITE_PERMISSION_PROFILE;
    NodeAssert.equal(commandCenterPermissionProfileMismatch(expected, { thread: {} }), undefined);
    NodeAssert.equal(
      commandCenterPermissionProfileMismatch(expected, { activePermissionProfile: null }),
      undefined,
    );
    NodeAssert.equal(
      commandCenterPermissionProfileMismatch(expected, {
        activePermissionProfile: { id: expected },
      }),
      undefined,
    );
    const mismatch = commandCenterPermissionProfileMismatch(expected, {
      activePermissionProfile: { id: ":workspace" },
    });
    NodeAssert.equal(mismatch?._tag, "CodexCommandCenterPermissionProfileMismatchError");
    NodeAssert.equal(mismatch?.actual, ":workspace");
  });

  it("refuses full-access and runtime-mode switches away from the probed profile", () => {
    const launch = writeLaunch(COMMAND_CENTER_CODEX_WRITE_PERMISSION_PROFILE);
    NodeAssert.deepStrictEqual(commandCenterTurnPermissionProfile(launch, "auto-accept-edits"), {
      permissionProfile: COMMAND_CENTER_CODEX_WRITE_PERMISSION_PROFILE,
    });
    NodeAssert.ok("issue" in commandCenterTurnPermissionProfile(launch, "full-access"));
    NodeAssert.ok("issue" in commandCenterTurnPermissionProfile(launch, "approval-required"));
  });

  it("keeps every cc: request in the workspace the app-server was spawned in", () => {
    const launch = writeLaunch(COMMAND_CENTER_CODEX_WRITE_PERMISSION_PROFILE);
    NodeAssert.deepStrictEqual(commandCenterRequestCwd(launch, "/workspace"), {
      cwd: "/workspace",
    });
    // No cwd on the request: pinned to the spawn workspace, never Codex's default.
    NodeAssert.deepStrictEqual(commandCenterRequestCwd(launch, null), { cwd: "/workspace" });
    NodeAssert.deepStrictEqual(commandCenterRequestCwd(launch, undefined), { cwd: "/workspace" });
    // Another workspace (a worktree handoff) needs a new session.
    for (const cwd of ["/workspace/other", "/workspace/", "/", "workspace"]) {
      const decision = commandCenterRequestCwd(launch, cwd);
      NodeAssert.ok("issue" in decision, cwd);
      NodeAssert.match(decision.issue, /different workspace/u);
    }
  });
});

it.layer(NodeServices.layer)("Command Center isolated Codex launch", (it) => {
  const writeFile = Effect.fn("CodexCommandCenterIsolation.test.writeFile")(function* (
    filePath: string,
    contents: string | Uint8Array,
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
    if (typeof contents === "string") yield* fileSystem.writeFileString(filePath, contents);
    else yield* fileSystem.writeFile(filePath, contents);
  });

  /** A canonical npm `@openai/codex` layout with a Linux x64 native runtime. */
  const fixture = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cc-codex-launch-" });
    const packageRoot = path.join(root, "runtime", "node_modules", "@openai", "codex");
    const commandPath = path.join(packageRoot, "bin", "codex.js");
    const platformRoot = path.join(packageRoot, "node_modules", "@openai", "codex-linux-x64");
    yield* writeFile(commandPath, "#!/usr/bin/env node\n");
    yield* writeFile(
      path.join(platformRoot, "package.json"),
      '{"name":"@openai/codex-linux-x64","version":"0.0.0"}\n',
    );
    const nativePath = path.join(
      platformRoot,
      "vendor",
      "x86_64-unknown-linux-musl",
      "bin",
      "codex",
    );
    yield* writeFile(nativePath, Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]));
    yield* fileSystem.chmod(nativePath, 0o755);
    const sourceHome = path.join(root, "source-home");
    yield* writeFile(path.join(sourceHome, "auth.json"), '{"token":"test-only"}\n');
    const workspace = path.join(root, "workspace");
    yield* fileSystem.makeDirectory(workspace, { recursive: true });
    const stateDir = path.join(root, "state");
    yield* fileSystem.makeDirectory(stateDir, { recursive: true });
    yield* fileSystem.makeDirectory(path.join(root, "base"), { recursive: true });
    yield* fileSystem.makeDirectory(path.join(root, "base", "worktrees"), { recursive: true });
    return { root, commandPath, sourceHome, workspace, stateDir };
  });

  const prepare = (input: {
    readonly threadId: string;
    readonly runtimeMode: "approval-required" | "auto-accept-edits" | "full-access";
    readonly platform?: NodeJS.Platform;
    readonly cwd?: string | null;
  }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const paths = yield* fixture;
      return yield* prepareCommandCenterCodexLaunch({
        threadId: ThreadId.make(input.threadId),
        runtimeMode: input.runtimeMode,
        cwd: input.cwd === undefined ? paths.workspace : input.cwd,
        settings: { ...DEFAULT_SETTINGS, homePath: paths.sourceHome },
        sourceEnvironment: {
          PATH: "/usr/bin:/bin",
          HOME: paths.root,
          OPENAI_API_KEY: "acme-key",
          T3_MCP_BEARER_TOKEN: "acme-bearer",
          GH_TOKEN: "acme-gh",
        },
        platform: input.platform ?? "linux",
        architecture: "x64",
        stateDir: paths.stateDir,
        baseDir: path.join(paths.root, "base"),
        worktreesDir: path.join(paths.root, "base", "worktrees"),
        fileSystem,
        path,
        crypto,
        homeDirectory: paths.root,
        runtimeCommandPath: paths.commandPath,
      }).pipe(Effect.map((launch) => ({ launch, paths })));
    });

  it.effect("leaves ordinary threads on the user's own launch", () =>
    Effect.gen(function* () {
      const { launch } = yield* prepare({ threadId: "thread-acme", runtimeMode: "full-access" });
      NodeAssert.equal(launch, undefined);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "launches a cc: thread isolated: native runtime, private home, scrubbed env, locked args",
    () =>
      Effect.gen(function* () {
        const { launch, paths } = yield* prepare({
          threadId: "cc:interactive:acme",
          runtimeMode: "auto-accept-edits",
        });
        NodeAssert.ok(launch !== undefined);
        const fileSystem = yield* FileSystem.FileSystem;
        NodeAssert.equal(launch.permissionProfile, COMMAND_CENTER_CODEX_WRITE_PERMISSION_PROFILE);
        // The app-server spawn cwd and probe cwd: the thread's own workspace.
        NodeAssert.equal(launch.cwd, paths.workspace);
        NodeAssert.ok(launch.settings.binaryPath.endsWith("/bin/codex"));
        NodeAssert.notEqual(launch.settings.homePath, paths.sourceHome);
        NodeAssert.ok(
          launch.settings.homePath.startsWith(yield* fileSystem.realPath(paths.stateDir)),
        );
        // Allowlisted environment: no ambient credentials survive.
        NodeAssert.equal(launch.environment.OPENAI_API_KEY, undefined);
        NodeAssert.equal(launch.environment.T3_MCP_BEARER_TOKEN, undefined);
        NodeAssert.equal(launch.environment.GH_TOKEN, undefined);
        NodeAssert.equal(launch.environment.CODEX_HOME, launch.settings.homePath);
        NodeAssert.equal(launch.environment.HOME, launch.settings.homePath);
        // Locked app-server args: strict config, no MCP/hooks/plugins, deny root, no network.
        const args = launch.appServerArgs.join(" ");
        NodeAssert.ok(launch.appServerArgs.includes("--strict-config"));
        NodeAssert.match(args, /-c mcp_servers=\{\}/u);
        NodeAssert.match(args, /":root"="deny"/u);
        NodeAssert.match(args, /network=\{enabled=false\}/u);
        NodeAssert.match(
          args,
          new RegExp(`default_permissions="${COMMAND_CENTER_CODEX_WRITE_PERMISSION_PROFILE}"`, "u"),
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "refuses full-access, unsupported platforms, unattended macOS and a missing workspace",
    () =>
      Effect.gen(function* () {
        const refusal = (input: Parameters<typeof prepare>[0]) =>
          prepare(input).pipe(
            Effect.flip,
            Effect.map((error) => {
              NodeAssert.equal(error._tag, "CodexCommandCenterSessionRefusedError");
              return error.issue;
            }),
          );
        NodeAssert.match(
          yield* refusal({ threadId: "cc:automation:acme", runtimeMode: "full-access" }),
          /full-access/u,
        );
        NodeAssert.match(
          yield* refusal({
            threadId: "cc:automation:acme",
            runtimeMode: "approval-required",
            platform: "freebsd",
          }),
          /not supported/u,
        );
        NodeAssert.match(
          yield* refusal({
            threadId: "cc:automation:acme",
            runtimeMode: "approval-required",
            platform: "darwin",
          }),
          /Linux host/u,
        );
        NodeAssert.match(
          yield* refusal({
            threadId: "cc:interactive:acme",
            runtimeMode: "approval-required",
            cwd: null,
          }),
          /absolute workspace/u,
        );
        NodeAssert.match(
          yield* refusal({
            threadId: "cc:interactive:acme",
            runtimeMode: "approval-required",
            cwd: "workspace",
          }),
          /absolute workspace/u,
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "spawns, probes and runs a cc: session only in its workspace and refuses another cwd",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const paths = yield* fixture;
        const otherWorkspace = path.join(paths.root, "other-workspace");
        yield* fileSystem.makeDirectory(otherWorkspace, { recursive: true });

        const opened: Array<
          Parameters<CodexAdapterV2.CodexAppServerClientFactoryShape["open"]>[0]
        > = [];
        const requests: Array<{ readonly method: string; readonly cwd: unknown }> = [];
        const nativeThreadId = "acme-native-thread";
        const respond = (method: string, params: unknown) =>
          Effect.sync(() => {
            requests.push({
              method,
              cwd: (params as { readonly cwd?: unknown } | undefined)?.cwd,
            });
            if (method === "command/exec") {
              return { exitCode: 0, stdout: "command-center-isolation-ok\n", stderr: "" };
            }
            if (method === "thread/start") {
              return {
                thread: {
                  id: nativeThreadId,
                  sessionId: nativeThreadId,
                  forkedFromId: null,
                  preview: "",
                  projectId: null,
                  ephemeral: false,
                  modelProvider: "openai",
                  createdAt: 1782622440,
                  updatedAt: 1782622440,
                  status: { type: "idle" },
                  path: `/tmp/${nativeThreadId}.jsonl`,
                  cwd: paths.workspace,
                  cliVersion: "0.159.1",
                  source: "vscode",
                  threadSource: null,
                  agentNickname: null,
                  agentRole: null,
                  gitInfo: null,
                  name: null,
                  turns: [],
                },
                model: "gpt-5.4",
                modelProvider: "openai",
                serviceTier: null,
                cwd: paths.workspace,
                instructionSources: [],
                approvalPolicy: "never",
                approvalsReviewer: "user",
                sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
                reasoningEffort: "medium",
              };
            }
            return {};
          });
        const client = {
          raw: { request: respond },
          request: respond,
          notify: () => Effect.void,
          handleServerRequest: () => Effect.void,
          handleServerNotification: () => Effect.void,
          handleUnknownServerRequest: () => Effect.void,
          handleUnknownServerNotification: () => Effect.void,
        } as unknown as CodexClient.CodexAppServerClient["Service"];

        const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
          instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
          settings: { ...DEFAULT_SETTINGS, homePath: paths.sourceHome },
          environment: { PATH: "/usr/bin:/bin", HOME: paths.root },
          clientFactory: {
            open: (openInput) =>
              Effect.sync(() => {
                opened.push(openInput);
                return client;
              }),
          },
          crypto: yield* Crypto.Crypto,
          fileSystem,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          serverConfig: yield* makeReplayServerConfig("cc-codex-spawn-cwd").pipe(Effect.orDie),
          commandCenterPlatform: "linux",
          commandCenterArchitecture: "x64",
          commandCenterRuntimeCommandPath: paths.commandPath,
        });
        const threadId = ThreadId.make("cc:interactive:acme");
        const modelSelection = {
          instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
          model: "gpt-5.4",
        };
        const policy = (cwd: string) =>
          ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "auto-accept-edits",
            interactionMode: "default",
            cwd,
          });
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-cc-acme"),
          modelSelection,
          runtimePolicy: policy(paths.workspace),
        });

        // The app-server is spawned in the workspace, and probed there.
        NodeAssert.equal(opened.length, 1);
        NodeAssert.equal(opened[0]?.commandCenterIsolation?.cwd, paths.workspace);
        NodeAssert.deepStrictEqual(
          requests.filter((request) => request.method === "command/exec"),
          [{ method: "command/exec", cwd: paths.workspace }],
        );

        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy: policy(paths.workspace),
        });
        NodeAssert.deepStrictEqual(
          requests.filter((request) => request.method === "thread/start"),
          [{ method: "thread/start", cwd: paths.workspace }],
        );

        // Reusing the session from another workspace never reaches Codex.
        const sent = requests.length;
        const startError = yield* runtime
          .ensureThread({ threadId, modelSelection, runtimePolicy: policy(otherWorkspace) })
          .pipe(Effect.flip);
        NodeAssert.equal(
          (startError.cause as { readonly _tag?: unknown } | undefined)?._tag,
          "CodexCommandCenterSessionRefusedError",
        );
        const resumeError = yield* runtime
          .resumeThread({
            threadId,
            providerThread,
            modelSelection,
            runtimePolicy: policy(otherWorkspace),
          })
          .pipe(Effect.flip);
        NodeAssert.equal(
          (resumeError.cause as { readonly _tag?: unknown } | undefined)?._tag,
          "CodexCommandCenterSessionRefusedError",
        );
        NodeAssert.equal(requests.length, sent);
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer)),
      ),
  );
});
