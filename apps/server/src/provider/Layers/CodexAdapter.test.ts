// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  ApprovalRequestId,
  CodexSettings,
  EnvironmentId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderTurnTargetIdentity,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  SandboxId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, vi } from "@effect/vitest";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as CodexErrors from "effect-codex-app-server/errors";

import { ServerConfig } from "../../config.ts";
import { clearMcpProviderSession, setMcpProviderSession } from "../../mcp/McpProviderSession.ts";
import {
  bindSandboxProviderTarget,
  makeSandboxProviderBindingOwner,
  unbindSandboxProviderTarget,
} from "../../sandbox/SandboxProviderProcess.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import type { CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  CodexSessionRuntimeIsolationProbeError,
  CodexSessionRuntimeThreadIdMissingError,
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeError,
  type CodexSessionRuntimeSendTurnInput,
  type CodexSessionRuntimeShape,
  type CodexThreadSnapshot,
} from "./CodexSessionRuntime.ts";
import { makeCodexAdapter } from "./CodexAdapter.ts";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

// Test-local service tag so the rest of the file can keep using `yield* CodexAdapter`.
class CodexAdapter extends Context.Service<CodexAdapter, CodexAdapterShape>()(
  "@awtprod/command-center/provider/Layers/CodexAdapter.test/CodexAdapter",
) {}

const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.make(value);

class FakeCodexRuntime implements CodexSessionRuntimeShape {
  private readonly eventQueue = Effect.runSync(Queue.unbounded<ProviderEvent, Cause.Done>());
  private readonly now = "2026-01-01T00:00:00.000Z";

  // When set, close() emits this terminal event and ENDS the event queue before
  // resolving, mirroring the real CodexSessionRuntime.close (emit session/closed
  // → Queue.end). Used to exercise the adapter's stop-path drain-sync.
  public closeEmits: ProviderEvent | undefined = undefined;
  public currentSession: ProviderSession | undefined;
  public interruptTurnFailure: CodexSessionRuntimeError | undefined;
  public sendTurnFailure: CodexSessionRuntimeError | undefined;
  public startFailure: CodexSessionRuntimeError | undefined;
  public readonly interruptTurnCalls: Array<
    readonly [TurnId | undefined, ProviderTurnTargetIdentity | undefined]
  > = [];
  public readonly sendTurnCalls: Array<CodexSessionRuntimeSendTurnInput> = [];

  public readonly startImpl = vi.fn(() =>
    Promise.resolve({
      provider: ProviderDriverKind.make("codex"),
      status: "ready" as const,
      runtimeMode: this.options.runtimeMode,
      sessionGeneration: "generation-current",
      threadId: this.options.threadId,
      cwd: this.options.cwd,
      ...(this.options.model ? { model: this.options.model } : {}),
      resumeCursor: this.options.resumeCursor ?? { threadId: "provider-thread-1" },
      createdAt: this.now,
      updatedAt: this.now,
    } satisfies ProviderSession),
  );

  public readonly sendTurnImpl = vi.fn(
    (_input: CodexSessionRuntimeSendTurnInput): Promise<ProviderTurnStartResult> =>
      Promise.resolve({
        threadId: this.options.threadId,
        turnId: asTurnId("turn-1"),
      }),
  );

  public readonly compactThread = Effect.void;

  public readonly interruptTurnImpl = vi.fn(
    (_turnId?: TurnId, _target?: ProviderTurnTargetIdentity): Promise<void> =>
      Promise.resolve(undefined),
  );

  public readonly readThreadImpl = vi.fn((): Promise<CodexThreadSnapshot> =>
    Promise.resolve({
      threadId: "provider-thread-1",
      turns: [],
    }),
  );

  public readonly rollbackThreadImpl = vi.fn((_numTurns: number): Promise<CodexThreadSnapshot> =>
    Promise.resolve({
      threadId: "provider-thread-1",
      turns: [],
    }),
  );

  public readonly uploadFeedbackImpl = vi.fn((_reason?: string) =>
    Promise.resolve({ threadId: "provider-thread-1" }),
  );

  public readonly respondToRequestImpl = vi.fn(
    (_requestId: ApprovalRequestId, _decision: ProviderApprovalDecision): Promise<void> =>
      Promise.resolve(undefined),
  );

  public readonly respondToUserInputImpl = vi.fn(
    (_requestId: ApprovalRequestId, _answers: ProviderUserInputAnswers): Promise<void> =>
      Promise.resolve(undefined),
  );

  public readonly closeImpl = vi.fn(() => Promise.resolve(undefined));

  readonly options: CodexSessionRuntimeOptions;

  constructor(options: CodexSessionRuntimeOptions) {
    this.options = options;
  }

  start() {
    if (this.startFailure !== undefined) {
      return Effect.fail(this.startFailure);
    }
    return Effect.promise(() => this.startImpl()).pipe(
      Effect.tap((session) =>
        Effect.sync(() => {
          this.currentSession = session;
        }),
      ),
    );
  }

  get getSession() {
    return this.currentSession
      ? Effect.succeed(this.currentSession)
      : Effect.promise(() => this.startImpl());
  }

  sendTurn(input: CodexSessionRuntimeSendTurnInput) {
    this.sendTurnCalls.push(input);
    if (this.sendTurnFailure !== undefined) {
      return Effect.fail(this.sendTurnFailure);
    }
    return Effect.promise(() => this.sendTurnImpl(input));
  }

  interruptTurn(turnId?: TurnId, target?: ProviderTurnTargetIdentity) {
    this.interruptTurnCalls.push([turnId, target]);
    if (this.interruptTurnFailure !== undefined) {
      return Effect.fail(this.interruptTurnFailure);
    }
    return Effect.promise(() => this.interruptTurnImpl(turnId, target));
  }

  readThread = Effect.promise(() => this.readThreadImpl());

  rollbackThread(numTurns: number) {
    return Effect.promise(() => this.rollbackThreadImpl(numTurns));
  }

  uploadFeedback(reason?: string) {
    return Effect.promise(() => this.uploadFeedbackImpl(reason));
  }

  respondToRequest(requestId: ApprovalRequestId, decision: ProviderApprovalDecision) {
    return Effect.promise(() => this.respondToRequestImpl(requestId, decision));
  }

  respondToUserInput(requestId: ApprovalRequestId, answers: ProviderUserInputAnswers) {
    return Effect.promise(() => this.respondToUserInputImpl(requestId, answers));
  }

  get events() {
    return Stream.fromQueue(this.eventQueue);
  }

  close = Effect.suspend(() => {
    const queue = this.eventQueue;
    const terminal = this.closeEmits;
    const impl = this.closeImpl;
    return Effect.gen(function* () {
      if (terminal) {
        yield* Queue.offer(queue, terminal);
      }
      // The real CodexSessionRuntime.close ALWAYS ends the outward event queue
      // (Queue.end) after emitting any terminal, so the adapter's event fiber
      // completes and the stop path's drain-join returns deterministically.
      yield* Queue.end(queue);
      yield* Effect.promise(() => impl());
    });
  });

  emit(event: ProviderEvent) {
    return Queue.offer(this.eventQueue, event).pipe(Effect.asVoid);
  }
}

function makeRuntimeFactory(input?: {
  readonly startFailures?: ReadonlyArray<CodexSessionRuntimeError | undefined>;
}) {
  const runtimes: Array<FakeCodexRuntime> = [];
  const factory = vi.fn((runtimeOptions: CodexSessionRuntimeOptions) => {
    const runtime = new FakeCodexRuntime(runtimeOptions);
    runtime.startFailure = input?.startFailures?.[runtimes.length];
    runtimes.push(runtime);
    return Effect.succeed(runtime);
  });

  return {
    factory,
    get runtimes(): ReadonlyArray<FakeCodexRuntime> {
      return runtimes;
    },
    get lastRuntime(): FakeCodexRuntime | undefined {
      return runtimes.at(-1);
    },
  };
}

const TestCodexRpcRequest = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});
const decodeTestCodexRpcRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(TestCodexRpcRequest),
);
const encodeTestCodexRpcResponse = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const makeCodexAppServerSpawner = Effect.fn("makeCodexAppServerSpawner")(function* () {
  const requests: Array<typeof TestCodexRpcRequest.Type> = [];
  const stdout = yield* Queue.unbounded<Uint8Array>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let inputBuffer = "";

  const stdin = Sink.forEach((chunk: Uint8Array) =>
    Effect.gen(function* () {
      inputBuffer += decoder.decode(chunk, { stream: true });
      const lines = inputBuffer.split("\n");
      inputBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim().length === 0) continue;
        const request = decodeTestCodexRpcRequest(line);
        requests.push(request);
        if (request.id === undefined) continue;

        const result = (() => {
          switch (request.method) {
            case "initialize":
              return {
                userAgent: "mock-codex-app-server",
                codexHome: process.cwd(),
                platformFamily: "unix",
                platformOs: "linux",
              };
            case "config/mcpServer/reload":
              return {};
            case "thread/resume":
              return {
                cwd: process.cwd(),
                model: "gpt-5.3-codex",
                modelProvider: "openai",
                approvalPolicy: "never",
                approvalsReviewer: "user",
                sandbox: { type: "readOnly" },
                thread: {
                  id: "provider-thread-resumed",
                  cliVersion: "0.0.0-test",
                  createdAt: 1_776_470_400,
                  cwd: process.cwd(),
                  ephemeral: false,
                  modelProvider: "openai",
                  preview: "",
                  projectId: null,
                  sessionId: "session-test",
                  updatedAt: 1_776_470_400,
                  source: "cli",
                  turns: [],
                  status: { type: "idle" },
                },
              };
            case "turn/start":
              return {
                turn: {
                  id: `turn-${String(requests.length)}`,
                  items: [],
                  status: "inProgress",
                },
              };
            default:
              return undefined;
          }
        })();
        const response =
          result === undefined
            ? {
                id: request.id,
                error: { code: -32601, message: `Unhandled request: ${request.method}` },
              }
            : { id: request.id, result };
        yield* Queue.offer(stdout, encoder.encode(`${encodeTestCodexRpcResponse(response)}\n`));
      }
    }),
  );
  const handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.never,
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin,
    stdout: Stream.fromQueue(stdout),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

  return {
    requests,
    spawner: ChildProcessSpawner.make(() => Effect.succeed(handle)),
  };
});

function makeScopedRuntimeFactory(options?: { readonly failConstruction?: boolean }) {
  const runtimes: Array<FakeCodexRuntime> = [];
  const releasedThreadIds: Array<ThreadId> = [];

  const factory = vi.fn((runtimeOptions: CodexSessionRuntimeOptions) =>
    Effect.gen(function* () {
      yield* Scope.Scope;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          releasedThreadIds.push(runtimeOptions.threadId);
        }),
      );

      if (options?.failConstruction) {
        return yield* new CodexErrors.CodexAppServerSpawnError({
          command: `${runtimeOptions.binaryPath} app-server`,
          cause: new Error("runtime construction failed"),
        });
      }

      const runtime = new FakeCodexRuntime(runtimeOptions);
      runtimes.push(runtime);
      return runtime;
    }),
  );

  return {
    factory,
    releasedThreadIds,
    get lastRuntime(): FakeCodexRuntime | undefined {
      return runtimes.at(-1);
    },
  };
}

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  recordImportedTranscript: () => Effect.die("unused"),
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeedNone,
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

const validationRuntimeFactory = makeRuntimeFactory();
// Isolation requires a source auth.json before any session starts, so these
// validation cases need a real home even though none of them assert on auth.
const validationSourceHomePath = NodeFS.mkdtempSync(
  NodePath.join(NodeOS.tmpdir(), "cc-codex-validation-home-"),
);
NodeFS.writeFileSync(
  NodePath.join(validationSourceHomePath, "auth.json"),
  '{"token":"test-only"}\n',
);
const validationLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: validationRuntimeFactory.factory,
        commandCenterSourceHomePath: validationSourceHomePath,
        commandCenterRuntimeExecutablePath: process.execPath,
      });
    }),
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "codex-adapter-validation-" }),
    ),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

validationLayer("CodexAdapterLive validation", (it) => {
  it.effect("returns validation error for non-codex provider on startSession", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("claudeAgent"),
          threadId: asThreadId("thread-1"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.deepStrictEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: ProviderDriverKind.make("codex"),
          operation: "startSession",
          issue: "Expected provider 'codex' but received 'claudeAgent'.",
        }),
      );
      NodeAssert.equal(validationRuntimeFactory.factory.mock.calls.length, 0);
    }),
  );
  it.effect("rejects full-access Command Center sessions before spawning Codex", () =>
    Effect.gen(function* () {
      validationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("cc:thread-full-access"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterValidationError");
      NodeAssert.match(result.failure.issue, /cannot use full-access/u);
      NodeAssert.equal(validationRuntimeFactory.factory.mock.calls.length, 0);
    }),
  );
  it.effect("injects the admitted profile and scrubbed helper into Command Center Codex", () =>
    Effect.gen(function* () {
      validationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("cc:thread-isolated"),
        runtimeMode: "auto-accept-edits",
        cwd: validationSourceHomePath,
      });

      const runtimeOptions = validationRuntimeFactory.factory.mock.calls[0]?.[0];
      NodeAssert.equal(runtimeOptions?.permissionProfile, "command-center-isolated-write-v1");
      NodeAssert.ok(runtimeOptions?.appServerArgs?.includes("--strict-config"));
      NodeAssert.match(runtimeOptions?.appServerArgs?.join(" ") ?? "", /":root"="deny"/u);
      NodeAssert.match(
        runtimeOptions?.appServerArgs?.join(" ") ?? "",
        /":workspace_roots"=\{"\."="write"\}/u,
      );
      NodeAssert.match(
        runtimeOptions?.appServerArgs?.join(" ") ?? "",
        /network=\{enabled=false\}/u,
      );
      NodeAssert.ok(runtimeOptions?.homePath?.includes("provider-homes/codex-command-center"));
      NodeAssert.match(runtimeOptions?.environment?.PATH ?? "", /provider-bin/u);
      NodeAssert.equal("OPENAI_API_KEY" in (runtimeOptions?.environment ?? {}), false);
    }),
  );
  it.effect("hands a sandboxed Codex only the host subscription access token", () =>
    Effect.gen(function* () {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-sandbox-home-"));
      NodeFS.writeFileSync(
        NodePath.join(home, "auth.json"),
        '{"auth_mode":"chatgpt","tokens":{"access_token":"access-test-only","account_id":"account-test-only","id_token":"id-must-stay-on-host","refresh_token":"refresh-must-stay-on-host"}}',
        { mode: 0o600 },
      );
      const threadId = asThreadId("thread-sandbox-subscription");
      const owner = makeSandboxProviderBindingOwner();
      bindSandboxProviderTarget(
        {
          kind: "sandbox",
          threadId,
          sandboxId: SandboxId.make("sandbox-subscription"),
          runtimeRef: "t3-thread-sandbox-subscription",
          runtime: "podman",
          workspaceCwd: "/workspace/repo",
        },
        owner,
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unbindSandboxProviderTarget(threadId, owner);
          NodeFS.rmSync(home, { recursive: true, force: true });
        }),
      );

      const runtimeFactory = makeRuntimeFactory();
      const adapter = yield* makeCodexAdapter(decodeCodexSettings({}), {
        makeRuntime: runtimeFactory.factory,
        commandCenterSourceHomePath: home,
      });
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });

      const external = runtimeFactory.lastRuntime?.options.externalChatgptAuth;
      NodeAssert.deepStrictEqual(external?.initial, {
        accessToken: "access-test-only",
        chatgptAccountId: "account-test-only",
      });
      NodeAssert.deepStrictEqual(Object.keys(external?.initial ?? {}).sort(), [
        "accessToken",
        "chatgptAccountId",
      ]);
    }).pipe(Effect.scoped),
  );
  it.effect("delivers scoped MCP auth only to the parent behind the scrubbed helper", () =>
    Effect.gen(function* () {
      validationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("cc:thread-scoped-mcp");
      setMcpProviderSession({
        environmentId: EnvironmentId.make("environment-test"),
        threadId,
        providerSessionId: "provider-session-test",
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://127.0.0.1:3773/api/mcp/session-test",
        authorizationHeader: "Bearer scoped-test-token",
      });

      yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId,
          runtimeMode: "approval-required",
          cwd: validationSourceHomePath,
        })
        .pipe(Effect.ensuring(Effect.sync(() => clearMcpProviderSession(threadId))));

      const runtimeOptions = validationRuntimeFactory.factory.mock.calls[0]?.[0];
      const args = runtimeOptions?.appServerArgs ?? [];
      const resetIndex = args.indexOf("mcp_servers={}");
      const scopedIndex = args.findIndex((argument) =>
        argument.startsWith("mcp_servers.t3-code.url="),
      );
      NodeAssert.ok(resetIndex >= 0);
      NodeAssert.ok(scopedIndex > resetIndex);
      NodeAssert.equal(runtimeOptions?.environment?.T3_MCP_BEARER_TOKEN, "scoped-test-token");
      NodeAssert.equal("OPENAI_API_KEY" in (runtimeOptions?.environment ?? {}), false);
    }),
  );
  it.effect("preserves preview availability for legacy and preview MCP sessions", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      for (const fixture of [
        { name: "legacy", capabilities: undefined },
        { name: "preview", capabilities: new Set(["preview"] as const) },
      ]) {
        validationRuntimeFactory.factory.mockClear();
        const threadId = asThreadId(`thread-${fixture.name}-mcp-capabilities`);
        setMcpProviderSession({
          environmentId: EnvironmentId.make("environment-test"),
          threadId,
          providerSessionId: `provider-session-${fixture.name}`,
          providerInstanceId: ProviderInstanceId.make("codex"),
          endpoint: `http://127.0.0.1:3773/api/mcp/session-${fixture.name}`,
          authorizationHeader: `Bearer ${fixture.name}-test-token`,
          ...(fixture.capabilities ? { capabilities: fixture.capabilities } : {}),
        });

        yield* adapter
          .startSession({
            provider: ProviderDriverKind.make("codex"),
            threadId,
            runtimeMode: "approval-required",
          })
          .pipe(Effect.ensuring(Effect.sync(() => clearMcpProviderSession(threadId))));

        const runtimeOptions = validationRuntimeFactory.factory.mock.calls[0]?.[0];
        NodeAssert.equal(runtimeOptions?.browserToolsAvailable, true);
      }
    }),
  );
  it.effect("omits preview instructions through resumed database-only runtimes", () =>
    Effect.gen(function* () {
      const mockAppServer = yield* makeCodexAppServerSpawner();
      const adapter = yield* makeCodexAdapter(decodeCodexSettings({}), {
        commandCenterSourceHomePath: validationSourceHomePath,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, mockAppServer.spawner),
      );
      const threadId = asThreadId("thread-database-only-mcp");
      setMcpProviderSession({
        environmentId: EnvironmentId.make("environment-test"),
        threadId,
        providerSessionId: "provider-session-database-only",
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://127.0.0.1:3773/api/mcp/session-database-only",
        authorizationHeader: "Bearer database-only-test-token",
        capabilities: new Set(["database.read"]),
      });
      yield* Effect.addFinalizer(() =>
        adapter
          .stopAll()
          .pipe(
            Effect.ignore,
            Effect.ensuring(Effect.sync(() => clearMcpProviderSession(threadId))),
          ),
      );

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "approval-required",
        resumeCursor: { threadId: "provider-thread-resumed" },
      });
      NodeAssert.deepStrictEqual(session.resumeCursor, {
        threadId: "provider-thread-resumed",
      });

      for (const interactionMode of ["plan", "default"] as const) {
        yield* adapter.sendTurn({
          threadId,
          input: "Use the database tools",
          attachments: [],
          interactionMode,
        });
      }

      NodeAssert.equal(
        mockAppServer.requests.filter((request) => request.method === "config/mcpServer/reload")
          .length,
        1,
      );
      NodeAssert.equal(
        mockAppServer.requests.filter((request) => request.method === "thread/resume").length,
        1,
      );
      const turnRequests = mockAppServer.requests.filter(
        (request) => request.method === "turn/start",
      );
      NodeAssert.equal(turnRequests.length, 2);
      for (const request of turnRequests) {
        const params = request.params as {
          readonly collaborationMode?: {
            readonly settings?: { readonly developer_instructions?: string };
          };
        };
        const instructions = params.collaborationMode?.settings?.developer_instructions ?? "";
        NodeAssert.match(instructions, /<collaboration_mode>/u);
        NodeAssert.doesNotMatch(instructions, /preview_status/u);
        NodeAssert.doesNotMatch(instructions, /preview_open/u);
      }
    }),
  );
  it.effect("maps codex model options before starting a session", () =>
    Effect.gen(function* () {
      validationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
          { id: "serviceTier", value: "priority" },
        ]),
        runtimeMode: "full-access",
      });

      NodeAssert.deepStrictEqual(validationRuntimeFactory.factory.mock.calls[0]?.[0], {
        binaryPath: "codex",
        cwd: process.cwd(),
        launchArgs: "",
        model: "gpt-5.3-codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        serviceTier: "priority",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
    }),
  );
});

it.effect("fails closed when elevated Windows Command Center isolation cannot be verified", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cc-windows-fallback-"));
  const runtimePath = NodePath.join(tempDir, "codex.exe");
  const sourceHomePath = NodePath.join(tempDir, "codex-home");
  const workspacePath = NodePath.join(tempDir, "workspace");
  NodeFS.mkdirSync(sourceHomePath, { recursive: true });
  NodeFS.mkdirSync(workspacePath, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(sourceHomePath, "auth.json"), '{"token":"test-only"}\n');
  NodeFS.writeFileSync(runtimePath, Uint8Array.from([0x4d, 0x5a, 0x00, 0x00]));

  const runtimeFactory = makeRuntimeFactory({
    startFailures: [
      new CodexSessionRuntimeIsolationProbeError({
        issue: "The elevated live isolation probe failed.",
        exitCode: 79,
      }),
    ],
  });
  const layer = Layer.effect(
    CodexAdapter,
    makeCodexAdapter(decodeCodexSettings({}), {
      makeRuntime: runtimeFactory.factory,
      commandCenterSourceHomePath: sourceHomePath,
      commandCenterRuntimeExecutablePath: runtimePath,
      commandCenterPlatform: "win32",
      commandCenterArchitecture: "x64",
    }),
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "codex-adapter-windows-fallback-" }),
    ),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    const threadId = asThreadId("cc:interactive:windows-fallback");
    const result = yield* adapter
      .startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "approval-required",
        cwd: workspacePath,
      })
      .pipe(Effect.result);

    NodeAssert.equal(result._tag, "Failure");
    NodeAssert.equal(result.failure._tag, "ProviderAdapterProcessError");
    NodeAssert.match(result.failure.message, /elevated live isolation probe failed/u);
    NodeAssert.equal(runtimeFactory.runtimes.length, 1);
    NodeAssert.equal(runtimeFactory.runtimes[0]?.options.windowsSandboxMode, "elevated");
    NodeAssert.equal(runtimeFactory.runtimes[0]?.closeImpl.mock.calls.length, 1);
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

const sessionRuntimeFactory = makeRuntimeFactory();
const sessionErrorLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: sessionRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

sessionErrorLayer("CodexAdapterLive session errors", (it) => {
  it.effect("maps missing adapter sessions to ProviderAdapterSessionNotFoundError", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "hello",
          attachments: [],
        })
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
      NodeAssert.equal(result.failure.provider, "codex");
      NodeAssert.equal(result.failure.threadId, "sess-missing");
    }),
  );

  it.effect("compacts the active Codex thread and emits compacted state", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-compact");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      const compactedEventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "thread.state.changed"),
        Stream.runHead,
        Effect.forkChild,
      );
      NodeAssert.ok(adapter.compaction?.type === "native");
      yield* adapter.compaction.start(threadId);
      yield* runtime.emit({
        id: asEventId("evt-compaction-item-completed"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId,
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "provider-thread-1",
          turnId: "provider-compact-turn",
          item: {
            id: "provider-compact-item",
            type: "contextCompaction",
          },
        },
      });
      const event = Option.getOrThrow(yield* Fiber.join(compactedEventFiber));
      NodeAssert.ok(event.type === "thread.state.changed");
      NodeAssert.equal(event.payload.state, "compacted");
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("uploads feedback for the active Codex thread", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-feedback");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);

      const result = yield* adapter.uploadFeedback({
        threadId,
        reason: "The agent stopped early.",
      });

      NodeAssert.deepStrictEqual(result, { feedbackId: "provider-thread-1" });
      NodeAssert.deepStrictEqual(runtime.uploadFeedbackImpl.mock.calls, [
        ["The agent stopped early."],
      ]);
    }),
  );

  it.effect("rejects feedback for an unknown Codex thread", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .uploadFeedback({ threadId: asThreadId("thread-feedback-missing") })
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
    }),
  );

  it.effect("maps codex model options before sending a turn", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-missing"),
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      runtime.sendTurnImpl.mockClear();

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "hello",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "priority" },
          ]),
          attachments: [],
        }),
      );

      NodeAssert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0], {
        input: "hello",
        model: "gpt-5.3-codex",
        effort: "high",
        serviceTier: "priority",
      });
    }),
  );

  it.effect(
    "matches targeted interrupts by Codex cursor, falling back to runtime generation without one",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        const threadId = asThreadId("sess-targeted-interrupt");
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId,
          runtimeMode: "full-access",
        });
        const runtime = sessionRuntimeFactory.lastRuntime;
        NodeAssert.ok(runtime);
        runtime.interruptTurnImpl.mockClear();

        const mismatchedCursorTarget: ProviderTurnTargetIdentity = {
          sessionGeneration: "generation-current",
          resumeCursor: { threadId: "provider-thread-other" },
        };
        yield* adapter.interruptTurn(
          threadId,
          asTurnId("turn-cursor-mismatch"),
          mismatchedCursorTarget,
        );
        NodeAssert.equal(runtime.interruptTurnImpl.mock.calls.length, 0);

        const matchingCursorAcrossGeneration: ProviderTurnTargetIdentity = {
          sessionGeneration: "generation-historical",
          resumeCursor: { threadId: "provider-thread-1" },
        };
        const historicalTurnId = asTurnId("turn-historical");
        yield* adapter.interruptTurn(threadId, historicalTurnId, matchingCursorAcrossGeneration);
        NodeAssert.deepStrictEqual(runtime.interruptTurnImpl.mock.calls, [
          [historicalTurnId, matchingCursorAcrossGeneration],
        ]);

        const matchingGenerationWithoutCursor: ProviderTurnTargetIdentity = {
          sessionGeneration: "generation-current",
        };
        const generationTurnId = asTurnId("turn-generation-match");
        yield* adapter.interruptTurn(threadId, generationTurnId, matchingGenerationWithoutCursor);
        NodeAssert.deepStrictEqual(runtime.interruptTurnImpl.mock.calls.at(-1), [
          generationTurnId,
          matchingGenerationWithoutCursor,
        ]);

        yield* adapter.interruptTurn(threadId, asTurnId("turn-generation-mismatch"), {
          sessionGeneration: "generation-other",
        });
        NodeAssert.equal(runtime.interruptTurnImpl.mock.calls.length, 2);
      }),
  );

  it.effect("succeeds when a matching targeted interrupt's target is gone", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("sess-target-gone-interrupt");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      runtime.interruptTurnFailure = new CodexErrors.CodexAppServerRequestError({
        code: -32600,
        errorMessage: "no active turn to interrupt",
        method: "turn/interrupt",
        operation: "receive-response",
      });
      const turnId = asTurnId("turn-completed");
      const target: ProviderTurnTargetIdentity = {
        sessionGeneration: "generation-current",
        resumeCursor: { threadId: "provider-thread-1" },
      };

      const result = yield* adapter.interruptTurn(threadId, turnId, target).pipe(Effect.result);

      NodeAssert.equal(result._tag, "Success");
      NodeAssert.deepStrictEqual(runtime.interruptTurnCalls, [[turnId, target]]);
    }),
  );

  it.effect("maps an unrelated targeted interrupt request error instead of swallowing it", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("sess-targeted-interrupt-request-error");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      runtime.interruptTurnFailure = new CodexErrors.CodexAppServerRequestError({
        code: -32603,
        errorMessage: "internal error while interrupting turn",
        method: "turn/interrupt",
        operation: "receive-response",
      });
      const target: ProviderTurnTargetIdentity = {
        sessionGeneration: "generation-current",
        resumeCursor: { threadId: "provider-thread-1" },
      };

      const result = yield* adapter
        .interruptTurn(threadId, asTurnId("turn-historical"), target)
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        NodeAssert.equal(result.failure._tag, "ProviderAdapterRequestError");
        NodeAssert.equal(result.failure.method, "turn/interrupt");
        NodeAssert.strictEqual(result.failure.cause, runtime.interruptTurnFailure);
      }
    }),
  );

  it.effect("keeps a request rejection as a failure for an ordinary interrupt", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("sess-ordinary-interrupt");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      runtime.interruptTurnFailure = new CodexErrors.CodexAppServerRequestError({
        code: -32602,
        errorMessage: "turn cannot be interrupted",
        method: "turn/interrupt",
        operation: "receive-response",
      });

      const result = yield* adapter
        .interruptTurn(threadId, asTurnId("turn-current"))
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        NodeAssert.equal(result.failure._tag, "ProviderAdapterRequestError");
      }
    }),
  );

  it.effect(
    "propagates a missing provider thread id for both targeted and ordinary interrupts",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        const threadId = asThreadId("sess-thread-id-missing-interrupt");
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId,
          runtimeMode: "full-access",
        });
        const runtime = sessionRuntimeFactory.lastRuntime;
        NodeAssert.ok(runtime);
        runtime.interruptTurnFailure = new CodexSessionRuntimeThreadIdMissingError({
          threadId,
        });

        const targeted = yield* adapter
          .interruptTurn(threadId, asTurnId("turn-historical"), {
            sessionGeneration: "generation-current",
            resumeCursor: { threadId: "provider-thread-1" },
          })
          .pipe(Effect.result);
        NodeAssert.equal(targeted._tag, "Failure");
        if (targeted._tag === "Failure") {
          NodeAssert.equal(targeted.failure._tag, "ProviderAdapterSessionNotFoundError");
        }

        const ordinary = yield* adapter
          .interruptTurn(threadId, asTurnId("turn-current"))
          .pipe(Effect.result);
        NodeAssert.equal(ordinary._tag, "Failure");
        if (ordinary._tag === "Failure") {
          NodeAssert.equal(ordinary.failure._tag, "ProviderAdapterSessionNotFoundError");
        }
      }),
  );

  it.effect("returns the immutable interrupt target captured by the successful runtime send", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("sess-send-target");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      const target: ProviderTurnTargetIdentity = {
        sessionGeneration: "generation-at-send",
        resumeCursor: { threadId: "provider-thread-at-send" },
      };
      runtime.sendTurnImpl.mockResolvedValue({
        threadId,
        turnId: asTurnId("turn-with-target"),
        resumeCursor: { threadId: "provider-thread-at-send" },
        target,
      });
      runtime.currentSession = {
        ...(runtime.currentSession as ProviderSession),
        sessionGeneration: "generation-replaced-after-send",
        resumeCursor: { threadId: "provider-thread-replaced-after-send" },
      };

      const started = yield* adapter.sendTurn({
        threadId,
        input: "capture target",
        turnRequestSequence: 51,
      });

      NodeAssert.deepStrictEqual(started.target, target);
    }),
  );

  it.effect("passes image attachments to Codex by path instead of base64", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-image-attachment");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      runtime.sendTurnImpl.mockClear();

      const serverConfig = yield* ServerConfig;
      const attachmentsDir = serverConfig.attachmentsDir;
      const attachmentId = "attachment-local-image-1";
      const attachmentPath = NodePath.join(attachmentsDir, `${attachmentId}.png`);
      NodeFS.writeFileSync(attachmentPath, Buffer.alloc(4, 0x89));

      try {
        yield* adapter.sendTurn({
          threadId,
          input: "Use this image.",
          attachments: [
            {
              type: "image",
              id: attachmentId,
              name: "generated.png",
              mimeType: "image/png",
              sizeBytes: NodeFS.statSync(attachmentPath).size,
            },
          ],
        });

        const input = runtime.sendTurnImpl.mock.calls[0]?.[0];
        NodeAssert.ok(input);
        NodeAssert.deepStrictEqual(input.attachments, [
          {
            type: "localImage",
            path: attachmentPath,
          },
        ]);
      } finally {
        NodeFS.rmSync(attachmentPath, { force: true });
      }
    }),
  );

  it.effect("passes configured launch args into the session runtime", () => {
    const runtimeFactory = makeRuntimeFactory();
    const layer = Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        const codexConfig = decodeCodexSettings({ launchArgs: "--strict-config --enable foo" });
        return yield* makeCodexAdapter(codexConfig, {
          makeRuntime: runtimeFactory.factory,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-launch-args"),
        runtimeMode: "full-access",
      });

      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      NodeAssert.equal(runtime.options.launchArgs, "--strict-config --enable foo");
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses T3CODE_CODEX_LAUNCH_ARGS for the session runtime", () => {
    const runtimeFactory = makeRuntimeFactory();
    const layer = Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        const codexConfig = decodeCodexSettings({ launchArgs: "--enable settings-feature" });
        return yield* makeCodexAdapter(codexConfig, {
          environment: { T3CODE_CODEX_LAUNCH_ARGS: " --strict-config --enable env-feature " },
          makeRuntime: runtimeFactory.factory,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-launch-args-env"),
        runtimeMode: "full-access",
      });

      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      NodeAssert.equal(runtime.options.launchArgs, "--strict-config --enable env-feature");
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps codex model options for the adapter's bound custom instance id", () => {
    const customInstanceId = ProviderInstanceId.make("codex_personal");
    const customRuntimeFactory = makeRuntimeFactory();
    const customLayer = Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        const codexConfig = decodeCodexSettings({});
        return yield* makeCodexAdapter(codexConfig, {
          instanceId: customInstanceId,
          makeRuntime: customRuntimeFactory.factory,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-custom-instance"),
        runtimeMode: "full-access",
      });
      const runtime = customRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      runtime.sendTurnImpl.mockClear();

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId("sess-custom-instance"),
          input: "hello",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("codex_personal"),
            "gpt-5.3-codex",
            [
              { id: "reasoningEffort", value: "high" },
              { id: "serviceTier", value: "flex" },
            ],
          ),
          attachments: [],
        }),
      );

      NodeAssert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0], {
        input: "hello",
        model: "gpt-5.3-codex",
        effort: "high",
        serviceTier: "flex",
      });
    }).pipe(Effect.provide(customLayer));
  });

  it.effect("stamps each turn.started with the request its own send named", () => {
    const correlationRuntimeFactory = makeRuntimeFactory();
    const correlationLayer = Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        const codexConfig = decodeCodexSettings({});
        return yield* makeCodexAdapter(codexConfig, {
          makeRuntime: correlationRuntimeFactory.factory,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    const threadId = asThreadId("sess-correlate");

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = correlationRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      runtime.sendTurnImpl.mockImplementation((input) =>
        Promise.resolve({
          threadId,
          turnId: asTurnId(input.input === "first" ? "turn-first" : "turn-second"),
        }),
      );

      yield* adapter.sendTurn({ threadId, input: "first", turnRequestSequence: 11 });
      yield* adapter.sendTurn({ threadId, input: "second", turnRequestSequence: 22 });

      const startedFiber = yield* Stream.take(adapter.streamEvents, 2).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      // The provider announces the SECOND turn first. Positional correlation
      // would hand it request 11; only the id-keyed association gets it right.
      for (const turnId of ["turn-second", "turn-first"]) {
        yield* runtime.emit({
          id: asEventId(`evt-started-${turnId}`),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "turn/started",
          threadId,
          turnId: asTurnId(turnId),
        });
      }

      const started = yield* Fiber.join(startedFiber);
      NodeAssert.deepStrictEqual(
        started.map((event) => [
          event.turnId,
          event.type === "turn.started" ? event.payload.turnRequestSequence : undefined,
        ]),
        [
          ["turn-second", 22],
          ["turn-first", 11],
        ],
      );
    }).pipe(Effect.provide(correlationLayer));
  });

  // --- The parked in-flight slot -------------------------------------------
  //
  // `turn.started` is built on the event fiber, which never sees the send that
  // caused it, so a send parks its request sequence in an in-flight slot until
  // the `turn/start` response names the turn id. A notification that finds no
  // id-keyed entry claims that parked slot — correct only when the entry is
  // missing because the response has not landed yet. A turn whose entry was
  // already consumed, or evicted once the map hit its bound, also has no entry,
  // and would otherwise take the slot of an unrelated send that is genuinely
  // mid-RPC, stamping that send's placeholder onto the wrong turn.

  /** Builds a layer + runtime factory for one correlation scenario. */
  const makeCorrelationScenario = () => {
    const runtimeFactory = makeRuntimeFactory();
    const layer = Layer.effect(
      CodexAdapter,
      makeCodexAdapter(decodeCodexSettings({}), { makeRuntime: runtimeFactory.factory }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );
    return { runtimeFactory, layer };
  };

  /**
   * Collects `turn.started` stamps as they are published, so a test can wait
   * for one to be observed before taking the next step. Ordering between an
   * emitted notification and a later send response is the whole subject here,
   * so it cannot be left to a batched read at the end.
   */
  const collectTurnStartedStamps = (adapter: CodexAdapterShape) =>
    Effect.gen(function* () {
      const stamps: Array<readonly [string, number | undefined]> = [];
      const fiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          if (event.type === "turn.started") {
            stamps.push([String(event.turnId), event.payload.turnRequestSequence]);
          }
        }),
      ).pipe(Effect.forkChild);
      const awaitCount = (count: number) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 500; attempt += 1) {
            if (stamps.length >= count) {
              return;
            }
            yield* Effect.sleep("2 millis");
          }
          throw new Error(`Timed out waiting for ${count} turn.started events.`);
        });
      return { stamps, fiber, awaitCount };
    });

  it.effect(
    "preserves an ambiguous turn/start correlation until its late notification unblocks sends",
    () => {
      const { runtimeFactory, layer } = makeCorrelationScenario();
      const threadId = asThreadId("sess-ambiguous-turn-start");

      return Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId,
          runtimeMode: "full-access",
        });
        const runtime = runtimeFactory.lastRuntime;
        NodeAssert.ok(runtime);
        const collector = yield* collectTurnStartedStamps(adapter);

        runtime.sendTurnFailure = new CodexErrors.CodexAppServerProtocolParseError({
          operation: "decode-response-payload",
          method: "turn/start",
        });
        const ambiguous = yield* adapter
          .sendTurn({
            threadId,
            input: "ambiguous",
            turnRequestSequence: 101,
          })
          .pipe(Effect.result);
        NodeAssert.equal(ambiguous._tag, "Failure");
        NodeAssert.equal(runtime.sendTurnCalls.length, 1);

        runtime.sendTurnFailure = undefined;
        const blocked = yield* adapter
          .sendTurn({
            threadId,
            input: "must-not-overwrite",
            turnRequestSequence: 202,
          })
          .pipe(Effect.result);
        NodeAssert.equal(blocked._tag, "Failure");
        if (blocked._tag === "Failure") {
          NodeAssert.equal(blocked.failure._tag, "ProviderAdapterRequestError");
        }
        NodeAssert.equal(runtime.sendTurnCalls.length, 1);

        yield* runtime.emit({
          id: asEventId("evt-started-after-ambiguous-failure"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "turn/started",
          threadId,
          turnId: asTurnId("turn-original"),
        });
        yield* collector.awaitCount(1);
        NodeAssert.deepStrictEqual(collector.stamps, [["turn-original", 101]]);

        runtime.sendTurnImpl.mockResolvedValue({
          threadId,
          turnId: asTurnId("turn-later"),
        });
        yield* adapter.sendTurn({
          threadId,
          input: "now-unblocked",
          turnRequestSequence: 202,
        });
        NodeAssert.equal(runtime.sendTurnCalls.length, 2);
        yield* runtime.emit({
          id: asEventId("evt-started-after-unblock"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:01.000Z",
          method: "turn/started",
          threadId,
          turnId: asTurnId("turn-later"),
        });
        yield* collector.awaitCount(2);
        NodeAssert.deepStrictEqual(collector.stamps, [
          ["turn-original", 101],
          ["turn-later", 202],
        ]);

        yield* Fiber.interrupt(collector.fiber);
      }).pipe(Effect.provide(layer), TestClock.withLive);
    },
  );

  it.effect("clears an unresolved correlation when the session is replaced", () => {
    const { runtimeFactory, layer } = makeCorrelationScenario();
    const threadId = asThreadId("sess-replaced-ambiguous-turn-start");

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const originalRuntime = runtimeFactory.lastRuntime;
      NodeAssert.ok(originalRuntime);
      originalRuntime.sendTurnFailure = new CodexErrors.CodexAppServerProtocolParseError({
        operation: "decode-response-payload",
        method: "turn/start",
      });

      const ambiguous = yield* adapter
        .sendTurn({
          threadId,
          input: "ambiguous",
          turnRequestSequence: 101,
        })
        .pipe(Effect.result);
      NodeAssert.equal(ambiguous._tag, "Failure");

      originalRuntime.sendTurnFailure = undefined;
      const blocked = yield* adapter
        .sendTurn({
          threadId,
          input: "blocked-on-original",
          turnRequestSequence: 202,
        })
        .pipe(Effect.result);
      NodeAssert.equal(blocked._tag, "Failure");
      NodeAssert.equal(originalRuntime.sendTurnCalls.length, 1);

      yield* adapter.stopSession(threadId);
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const replacementRuntime = runtimeFactory.lastRuntime;
      NodeAssert.ok(replacementRuntime);
      NodeAssert.notStrictEqual(replacementRuntime, originalRuntime);
      replacementRuntime.sendTurnImpl.mockResolvedValue({
        threadId,
        turnId: asTurnId("turn-replacement"),
      });
      const collector = yield* collectTurnStartedStamps(adapter);

      yield* adapter.sendTurn({
        threadId,
        input: "replacement-send",
        turnRequestSequence: 303,
      });
      NodeAssert.equal(replacementRuntime.sendTurnCalls.length, 1);
      yield* replacementRuntime.emit({
        id: asEventId("evt-started-replacement"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "turn/started",
        threadId,
        turnId: asTurnId("turn-replacement"),
      });
      yield* collector.awaitCount(1);
      NodeAssert.deepStrictEqual(collector.stamps, [["turn-replacement", 303]]);

      yield* Fiber.interrupt(collector.fiber);
    }).pipe(Effect.provide(layer), TestClock.withLive);
  });

  it.effect("clears correlation immediately when Codex explicitly rejects turn/start", () => {
    const { runtimeFactory, layer } = makeCorrelationScenario();
    const threadId = asThreadId("sess-explicit-turn-start-rejection");

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      const collector = yield* collectTurnStartedStamps(adapter);

      runtime.sendTurnFailure = new CodexErrors.CodexAppServerRequestError({
        code: -32602,
        errorMessage: "turn rejected",
        method: "turn/start",
        operation: "receive-response",
      });
      const rejected = yield* adapter
        .sendTurn({
          threadId,
          input: "rejected",
          turnRequestSequence: 303,
        })
        .pipe(Effect.result);
      NodeAssert.equal(rejected._tag, "Failure");

      runtime.sendTurnFailure = undefined;
      runtime.sendTurnImpl.mockResolvedValue({
        threadId,
        turnId: asTurnId("turn-after-rejection"),
      });
      yield* adapter.sendTurn({
        threadId,
        input: "accepted",
        turnRequestSequence: 404,
      });
      NodeAssert.equal(runtime.sendTurnCalls.length, 2);
      yield* runtime.emit({
        id: asEventId("evt-started-after-explicit-rejection"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "turn/started",
        threadId,
        turnId: asTurnId("turn-after-rejection"),
      });
      yield* collector.awaitCount(1);
      NodeAssert.deepStrictEqual(collector.stamps, [["turn-after-rejection", 404]]);

      yield* Fiber.interrupt(collector.fiber);
    }).pipe(Effect.provide(layer), TestClock.withLive);
  });

  it.effect("does not let a duplicate turn/started claim a live send's parked slot", () => {
    const { runtimeFactory, layer } = makeCorrelationScenario();
    const threadId = asThreadId("sess-duplicate-started");

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);

      // The second send's RPC is held open so its request sequence sits in the
      // parked slot for the duration of the duplicate notification below.
      let releaseSecondSend: ((turnId: TurnId) => void) | undefined;
      let secondSendEntered = false;
      runtime.sendTurnImpl.mockImplementation((input) => {
        if (input.input === "first") {
          return Promise.resolve({ threadId, turnId: asTurnId("turn-first") });
        }
        secondSendEntered = true;
        return new Promise<ProviderTurnStartResult>((resolve) => {
          releaseSecondSend = (turnId) => resolve({ threadId, turnId });
        });
      });

      const collector = yield* collectTurnStartedStamps(adapter);

      yield* adapter.sendTurn({ threadId, input: "first", turnRequestSequence: 11 });
      yield* runtime.emit({
        id: asEventId("evt-started-first"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "turn/started",
        threadId,
        turnId: asTurnId("turn-first"),
      });
      yield* collector.awaitCount(1);

      const secondSendFiber = yield* adapter
        .sendTurn({ threadId, input: "second", turnRequestSequence: 22 })
        .pipe(Effect.forkChild);
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 500; attempt += 1) {
          if (secondSendEntered) {
            return;
          }
          yield* Effect.sleep("2 millis");
        }
        throw new Error("Timed out waiting for the second send to reach its RPC.");
      });

      // A duplicate for a turn already stamped above. Its correlation is spent,
      // so it must carry no sequence rather than take request 22.
      yield* runtime.emit({
        id: asEventId("evt-started-first-duplicate"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:01.000Z",
        method: "turn/started",
        threadId,
        turnId: asTurnId("turn-first"),
      });
      yield* collector.awaitCount(2);

      NodeAssert.ok(releaseSecondSend);
      releaseSecondSend(asTurnId("turn-second"));
      yield* Fiber.join(secondSendFiber);
      yield* runtime.emit({
        id: asEventId("evt-started-second"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:02.000Z",
        method: "turn/started",
        threadId,
        turnId: asTurnId("turn-second"),
      });
      yield* collector.awaitCount(3);

      NodeAssert.deepStrictEqual(collector.stamps, [
        ["turn-first", 11],
        ["turn-first", undefined],
        // Still reaches the turn it was sent for, which is what the duplicate
        // would otherwise have taken from it.
        ["turn-second", 22],
      ]);

      yield* Fiber.interrupt(collector.fiber);
    }).pipe(Effect.provide(layer), TestClock.withLive);
  });

  it.effect("does not let an evicted correlation claim a live send's parked slot", () => {
    const { runtimeFactory, layer } = makeCorrelationScenario();
    const threadId = asThreadId("sess-evicted-correlation");
    // One more than CODEX_TURN_REQUEST_CORRELATION_LIMIT, so recording the last
    // send evicts the first — none of them are announced, which is exactly the
    // leak the bound exists to cap.
    const unannouncedSendCount = 65;

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);

      let releaseLiveSend: ((turnId: TurnId) => void) | undefined;
      let liveSendEntered = false;
      runtime.sendTurnImpl.mockImplementation((input) => {
        if (input.input === "live") {
          liveSendEntered = true;
          return new Promise<ProviderTurnStartResult>((resolve) => {
            releaseLiveSend = (turnId) => resolve({ threadId, turnId });
          });
        }
        return Promise.resolve({ threadId, turnId: asTurnId(`turn-${input.input}`) });
      });

      const collector = yield* collectTurnStartedStamps(adapter);

      for (let index = 0; index < unannouncedSendCount; index += 1) {
        yield* adapter.sendTurn({
          threadId,
          input: String(index),
          turnRequestSequence: 100 + index,
        });
      }

      const liveSendFiber = yield* adapter
        .sendTurn({ threadId, input: "live", turnRequestSequence: 999 })
        .pipe(Effect.forkChild);
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 500; attempt += 1) {
          if (liveSendEntered) {
            return;
          }
          yield* Effect.sleep("2 millis");
        }
        throw new Error("Timed out waiting for the live send to reach its RPC.");
      });

      // turn-0's entry was evicted to make room. It is not "waiting on a
      // response", so it must not be handed request 999.
      yield* runtime.emit({
        id: asEventId("evt-started-evicted"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "turn/started",
        threadId,
        turnId: asTurnId("turn-0"),
      });
      yield* collector.awaitCount(1);

      NodeAssert.ok(releaseLiveSend);
      releaseLiveSend(asTurnId("turn-live"));
      yield* Fiber.join(liveSendFiber);
      yield* runtime.emit({
        id: asEventId("evt-started-live"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:01.000Z",
        method: "turn/started",
        threadId,
        turnId: asTurnId("turn-live"),
      });
      yield* collector.awaitCount(2);

      NodeAssert.deepStrictEqual(collector.stamps, [
        ["turn-0", undefined],
        ["turn-live", 999],
      ]);

      yield* Fiber.interrupt(collector.fiber);
    }).pipe(Effect.provide(layer), TestClock.withLive);
  });

  it.effect("stops stamping from the parked slot once a resolved id is forgotten", () => {
    const { runtimeFactory, layer } = makeCorrelationScenario();
    const threadId = asThreadId("sess-resolved-set-overflow");
    // One more than CODEX_RESOLVED_TURN_ID_LIMIT, so the oldest resolved id is
    // evicted. The sibling test above stays under the bound and shows the
    // fallback still working; this one crosses it.
    //
    // Past that point the set can no longer answer "was this turn already
    // spoken for?", which is the only question that makes the parked slot safe
    // to hand out. So the fallback retires rather than guessing — a turn that
    // genuinely raced loses its stamp, instead of taking a stamp that belongs
    // to a live unrelated send.
    const resolvedSendCount = 513;

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);

      let releaseLiveSend: ((turnId: TurnId) => void) | undefined;
      let liveSendEntered = false;
      runtime.sendTurnImpl.mockImplementation((input) => {
        if (input.input === "live") {
          liveSendEntered = true;
          return new Promise<ProviderTurnStartResult>((resolve) => {
            releaseLiveSend = (turnId) => resolve({ threadId, turnId });
          });
        }
        return Promise.resolve({ threadId, turnId: asTurnId(`turn-${input.input}`) });
      });

      const collector = yield* collectTurnStartedStamps(adapter);

      // Every one of these resolves its turn id, so each lands in the
      // resolved-id set and the last pushes it over the bound.
      for (let index = 0; index < resolvedSendCount; index += 1) {
        yield* adapter.sendTurn({
          threadId,
          input: String(index),
          turnRequestSequence: 100 + index,
        });
      }

      const liveSendFiber = yield* adapter
        .sendTurn({ threadId, input: "live", turnRequestSequence: 999 })
        .pipe(Effect.forkChild);
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 500; attempt += 1) {
          if (liveSendEntered) {
            return;
          }
          yield* Effect.sleep("2 millis");
        }
        throw new Error("Timed out waiting for the live send to reach its RPC.");
      });

      // A notification for a turn the set has forgotten. Before the trust flag
      // this reached the parked slot and walked off with request 999 — the live
      // send's sequence, stamped onto an unrelated turn.
      yield* runtime.emit({
        id: asEventId("evt-started-forgotten"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "turn/started",
        threadId,
        turnId: asTurnId("turn-0"),
      });
      yield* collector.awaitCount(1);

      NodeAssert.ok(releaseLiveSend);
      releaseLiveSend(asTurnId("turn-live"));
      yield* Fiber.join(liveSendFiber);
      yield* runtime.emit({
        id: asEventId("evt-started-live-after-overflow"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:01.000Z",
        method: "turn/started",
        threadId,
        turnId: asTurnId("turn-live"),
      });
      yield* collector.awaitCount(2);

      // The live send keeps its own sequence: retiring the fallback costs a
      // raced stamp, never a correct one, because the id-keyed path is
      // untouched.
      NodeAssert.deepStrictEqual(collector.stamps, [
        ["turn-0", undefined],
        ["turn-live", 999],
      ]);

      yield* Fiber.interrupt(collector.fiber);
    }).pipe(Effect.provide(layer), TestClock.withLive);
  });

  it.effect("still stamps a turn/started that genuinely beat its send response", () => {
    const { runtimeFactory, layer } = makeCorrelationScenario();
    const threadId = asThreadId("sess-notification-first");

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);

      let releaseSend: ((turnId: TurnId) => void) | undefined;
      let sendEntered = false;
      runtime.sendTurnImpl.mockImplementation(() => {
        sendEntered = true;
        return new Promise<ProviderTurnStartResult>((resolve) => {
          releaseSend = (turnId) => resolve({ threadId, turnId });
        });
      });

      const collector = yield* collectTurnStartedStamps(adapter);

      const sendFiber = yield* adapter
        .sendTurn({ threadId, input: "only", turnRequestSequence: 7 })
        .pipe(Effect.forkChild);
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 500; attempt += 1) {
          if (sendEntered) {
            return;
          }
          yield* Effect.sleep("2 millis");
        }
        throw new Error("Timed out waiting for the send to reach its RPC.");
      });

      // The notification wins the race with the response. This is the one case
      // the parked slot exists for, and the guards above must not break it.
      yield* runtime.emit({
        id: asEventId("evt-started-race"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "turn/started",
        threadId,
        turnId: asTurnId("turn-raced"),
      });
      yield* collector.awaitCount(1);

      NodeAssert.ok(releaseSend);
      releaseSend(asTurnId("turn-raced"));
      yield* Fiber.join(sendFiber);

      NodeAssert.deepStrictEqual(collector.stamps, [["turn-raced", 7]]);

      yield* Fiber.interrupt(collector.fiber);
    }).pipe(Effect.provide(layer), TestClock.withLive);
  });

  it.effect("does not let a duplicate of a raced turn/started re-claim a parked slot", () => {
    const { runtimeFactory, layer } = makeCorrelationScenario();
    const threadId = asThreadId("sess-raced-duplicate");

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);

      let releaseFirstSend: ((turnId: TurnId) => void) | undefined;
      let releaseSecondSend: ((turnId: TurnId) => void) | undefined;
      let sendsEntered = 0;
      runtime.sendTurnImpl.mockImplementation((input) => {
        sendsEntered += 1;
        return new Promise<ProviderTurnStartResult>((resolve) => {
          const release = (turnId: TurnId) => resolve({ threadId, turnId });
          if (input.input === "first") {
            releaseFirstSend = release;
          } else {
            releaseSecondSend = release;
          }
        });
      });

      const collector = yield* collectTurnStartedStamps(adapter);
      const awaitSends = (count: number) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 500; attempt += 1) {
            if (sendsEntered >= count) {
              return;
            }
            yield* Effect.sleep("2 millis");
          }
          throw new Error(`Timed out waiting for ${count} sends to reach their RPC.`);
        });

      const firstSendFiber = yield* adapter
        .sendTurn({ threadId, input: "first", turnRequestSequence: 11 })
        .pipe(Effect.forkChild);
      yield* awaitSends(1);

      // The notification wins the race, so this turn takes the parked slot
      // without ever getting an id-keyed entry — the one path that would leave
      // it unrecorded as "already answered for".
      yield* runtime.emit({
        id: asEventId("evt-started-raced"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "turn/started",
        threadId,
        turnId: asTurnId("turn-raced"),
      });
      yield* collector.awaitCount(1);

      NodeAssert.ok(releaseFirstSend);
      releaseFirstSend(asTurnId("turn-raced"));
      yield* Fiber.join(firstSendFiber);

      const secondSendFiber = yield* adapter
        .sendTurn({ threadId, input: "second", turnRequestSequence: 22 })
        .pipe(Effect.forkChild);
      yield* awaitSends(2);

      // A duplicate of the raced turn must not take the second send's slot.
      yield* runtime.emit({
        id: asEventId("evt-started-raced-duplicate"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:01.000Z",
        method: "turn/started",
        threadId,
        turnId: asTurnId("turn-raced"),
      });
      yield* collector.awaitCount(2);

      NodeAssert.ok(releaseSecondSend);
      releaseSecondSend(asTurnId("turn-second"));
      yield* Fiber.join(secondSendFiber);
      yield* runtime.emit({
        id: asEventId("evt-started-second"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:02.000Z",
        method: "turn/started",
        threadId,
        turnId: asTurnId("turn-second"),
      });
      yield* collector.awaitCount(3);

      NodeAssert.deepStrictEqual(collector.stamps, [
        ["turn-raced", 11],
        ["turn-raced", undefined],
        ["turn-second", 22],
      ]);

      yield* Fiber.interrupt(collector.fiber);
    }).pipe(Effect.provide(layer), TestClock.withLive);
  });
});

const lifecycleRuntimeFactory = makeRuntimeFactory();
const lifecycleLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: lifecycleRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

function startLifecycleRuntime() {
  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    yield* adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      runtimeMode: "full-access",
    });
    const runtime = lifecycleRuntimeFactory.lastRuntime;
    NodeAssert.ok(runtime);
    return { adapter, runtime };
  });
}

function codexTokenUsageEvent(input: {
  readonly id: string;
  readonly turnId: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly last?: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly cacheCreationTokens: number;
    readonly outputTokens: number;
    readonly reasoningTokens: number;
  };
}): ProviderEvent {
  const totalTokens = input.inputTokens + input.outputTokens;
  const last = input.last ?? input;
  return {
    id: asEventId(input.id),
    kind: "notification",
    provider: ProviderDriverKind.make("codex"),
    threadId: asThreadId("thread-1"),
    turnId: asTurnId(input.turnId),
    createdAt: "2026-01-01T00:00:00.000Z",
    method: "thread/tokenUsage/updated",
    payload: {
      threadId: "thread-1",
      turnId: input.turnId,
      tokenUsage: {
        total: {
          inputTokens: input.inputTokens,
          cachedInputTokens: input.cachedInputTokens,
          cacheWriteInputTokens: input.cacheCreationTokens,
          outputTokens: input.outputTokens,
          reasoningOutputTokens: input.reasoningTokens,
          totalTokens,
        },
        last: {
          inputTokens: last.inputTokens,
          cachedInputTokens: last.cachedInputTokens,
          cacheWriteInputTokens: last.cacheCreationTokens,
          outputTokens: last.outputTokens,
          reasoningOutputTokens: last.reasoningTokens,
          totalTokens: last.inputTokens + last.outputTokens,
        },
      },
    },
  };
}

function codexTurnEvent(method: "turn/started" | "turn/completed", turnId: string): ProviderEvent {
  return {
    id: asEventId(`evt-${method}-${turnId}`),
    kind: "notification",
    provider: ProviderDriverKind.make("codex"),
    threadId: asThreadId("thread-1"),
    turnId: asTurnId(turnId),
    createdAt: "2026-01-01T00:00:00.000Z",
    method,
    payload:
      method === "turn/started"
        ? {}
        : {
            threadId: "thread-1",
            turn: { id: turnId, items: [], status: "completed" },
          },
  };
}

lifecycleLayer("CodexAdapterLive lifecycle", (it) => {
  it.effect("calculates one Codex turn total from cumulative counters", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* runtime.emit(codexTurnEvent("turn/started", "turn-usage"));
      yield* runtime.emit(
        codexTokenUsageEvent({
          id: "evt-usage-1",
          turnId: "turn-usage",
          inputTokens: 100,
          cachedInputTokens: 40,
          cacheCreationTokens: 10,
          outputTokens: 20,
          reasoningTokens: 8,
        }),
      );
      // Codex can repeat both notifications without new work.
      yield* runtime.emit(codexTurnEvent("turn/started", "turn-usage"));
      yield* runtime.emit(
        codexTokenUsageEvent({
          id: "evt-usage-duplicate",
          turnId: "turn-usage",
          inputTokens: 100,
          cachedInputTokens: 40,
          cacheCreationTokens: 10,
          outputTokens: 20,
          reasoningTokens: 8,
        }),
      );
      yield* runtime.emit({
        id: asEventId("evt-collab-activity"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-usage"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "collabAgent/activity",
        payload: {
          agentThreadId: "child-1",
          agentPath: "/root/child-1",
          activityKind: "started",
        },
      });
      yield* runtime.emit(
        codexTokenUsageEvent({
          id: "evt-usage-2",
          turnId: "turn-usage",
          inputTokens: 150,
          cachedInputTokens: 60,
          cacheCreationTokens: 15,
          outputTokens: 30,
          reasoningTokens: 12,
        }),
      );
      yield* runtime.emit(codexTurnEvent("turn/completed", "turn-usage"));

      const completed = yield* Fiber.join(completedFiber);
      NodeAssert.equal(completed._tag, "Some");
      if (completed._tag === "Some" && completed.value.type === "turn.completed") {
        NodeAssert.deepStrictEqual(completed.value.payload.tokenUsage, {
          usageStatus: "complete",
          usageScope: "main_agent",
          inputTokens: 150,
          cachedInputTokens: 60,
          cacheCreationTokens: 15,
          outputTokens: 30,
          reasoningTokens: 12,
          hasSubagents: true,
        });
      }
    }),
  );

  it.effect("does not charge a late prior-turn update to the next Codex turn", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* runtime.emit(codexTurnEvent("turn/started", "turn-first"));
      yield* runtime.emit(
        codexTokenUsageEvent({
          id: "evt-late-1",
          turnId: "turn-first",
          inputTokens: 100,
          cachedInputTokens: 40,
          cacheCreationTokens: 10,
          outputTokens: 20,
          reasoningTokens: 8,
        }),
      );
      yield* runtime.emit(codexTurnEvent("turn/completed", "turn-first"));
      yield* runtime.emit(codexTurnEvent("turn/started", "turn-second"));
      // A late update for the finished turn lands after the next turn starts.
      yield* runtime.emit(
        codexTokenUsageEvent({
          id: "evt-late-2",
          turnId: "turn-first",
          inputTokens: 150,
          cachedInputTokens: 60,
          cacheCreationTokens: 15,
          outputTokens: 30,
          reasoningTokens: 12,
        }),
      );
      yield* runtime.emit(
        codexTokenUsageEvent({
          id: "evt-late-3",
          turnId: "turn-second",
          inputTokens: 170,
          cachedInputTokens: 65,
          cacheCreationTokens: 16,
          outputTokens: 35,
          reasoningTokens: 14,
        }),
      );
      yield* runtime.emit(codexTurnEvent("turn/completed", "turn-second"));

      const completed = Array.from(yield* Fiber.join(completedFiber));
      const second = completed[1];
      NodeAssert.equal(second?.type, "turn.completed");
      if (second?.type === "turn.completed") {
        NodeAssert.deepStrictEqual(second.payload.tokenUsage, {
          usageStatus: "complete",
          usageScope: "main_agent",
          inputTokens: 20,
          cachedInputTokens: 5,
          cacheCreationTokens: 1,
          outputTokens: 5,
          reasoningTokens: 2,
          hasSubagents: false,
        });
      }
    }),
  );

  it.effect("clamps Codex cache and reasoning subsets to their totals", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* runtime.emit(codexTurnEvent("turn/started", "turn-clamp"));
      yield* runtime.emit(
        codexTokenUsageEvent({
          id: "evt-clamp-1",
          turnId: "turn-clamp",
          inputTokens: 100,
          cachedInputTokens: 140,
          cacheCreationTokens: 120,
          outputTokens: 20,
          reasoningTokens: 30,
        }),
      );
      yield* runtime.emit(codexTurnEvent("turn/completed", "turn-clamp"));

      const completed = yield* Fiber.join(completedFiber);
      NodeAssert.equal(completed._tag, "Some");
      if (completed._tag === "Some" && completed.value.type === "turn.completed") {
        NodeAssert.deepStrictEqual(completed.value.payload.tokenUsage, {
          usageStatus: "complete",
          usageScope: "main_agent",
          inputTokens: 100,
          cachedInputTokens: 100,
          cacheCreationTokens: 100,
          outputTokens: 20,
          reasoningTokens: 20,
          hasSubagents: false,
        });
      }
    }),
  );

  it.effect("counts the last response when Codex resets its running total mid-turn", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* runtime.emit(codexTurnEvent("turn/started", "turn-reset"));
      yield* runtime.emit(
        codexTokenUsageEvent({
          id: "evt-reset-1",
          turnId: "turn-reset",
          inputTokens: 5_000,
          cachedInputTokens: 4_000,
          cacheCreationTokens: 100,
          outputTokens: 500,
          reasoningTokens: 200,
          last: {
            inputTokens: 100,
            cachedInputTokens: 80,
            cacheCreationTokens: 10,
            outputTokens: 20,
            reasoningTokens: 8,
          },
        }),
      );
      // Codex restarted its cumulative total. The new total is smaller than
      // the previous one, so only `last` is counted for this update.
      yield* runtime.emit(
        codexTokenUsageEvent({
          id: "evt-reset-2",
          turnId: "turn-reset",
          inputTokens: 150,
          cachedInputTokens: 90,
          cacheCreationTokens: 5,
          outputTokens: 30,
          reasoningTokens: 12,
        }),
      );
      yield* runtime.emit(codexTurnEvent("turn/completed", "turn-reset"));

      const completed = yield* Fiber.join(completedFiber);
      NodeAssert.equal(completed._tag, "Some");
      if (completed._tag === "Some" && completed.value.type === "turn.completed") {
        NodeAssert.deepStrictEqual(completed.value.payload.tokenUsage, {
          usageStatus: "complete",
          usageScope: "main_agent",
          inputTokens: 250,
          cachedInputTokens: 170,
          cacheCreationTokens: 15,
          outputTokens: 50,
          reasoningTokens: 20,
          hasSubagents: false,
        });
      }
    }),
  );

  it.effect("uses the last response usage when no prior Codex total exists", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        resumeCursor: { threadId: "provider-thread-1" },
        runtimeMode: "full-access",
      });
      const runtime = lifecycleRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      const firstCompletionsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      // Resumed thread: the cumulative total already holds old history, so the
      // first update must count only `last`.
      yield* runtime.emit(codexTurnEvent("turn/started", "turn-resumed"));
      yield* runtime.emit(
        codexTokenUsageEvent({
          id: "evt-resume-baseline",
          turnId: "turn-resumed",
          inputTokens: 1_000,
          cachedInputTokens: 400,
          cacheCreationTokens: 100,
          outputTokens: 200,
          reasoningTokens: 80,
          last: {
            inputTokens: 300,
            cachedInputTokens: 120,
            cacheCreationTokens: 30,
            outputTokens: 60,
            reasoningTokens: 24,
          },
        }),
      );
      yield* runtime.emit(codexTurnEvent("turn/completed", "turn-resumed"));

      yield* runtime.emit(codexTurnEvent("turn/started", "turn-after-resume"));
      yield* runtime.emit(
        codexTokenUsageEvent({
          id: "evt-after-resume",
          turnId: "turn-after-resume",
          inputTokens: 1_100,
          cachedInputTokens: 440,
          cacheCreationTokens: 110,
          outputTokens: 220,
          reasoningTokens: 88,
        }),
      );
      yield* runtime.emit(codexTurnEvent("turn/completed", "turn-after-resume"));

      const firstCompletions = Array.from(yield* Fiber.join(firstCompletionsFiber));

      yield* adapter.rollbackThread(asThreadId("thread-1"), 1);
      const rollbackCompletionFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      // Rollback drops the baseline and Codex shrinks its total, so the first
      // update after it counts only `last` again.
      yield* runtime.emit(codexTurnEvent("turn/started", "turn-after-rollback"));
      yield* runtime.emit(
        codexTokenUsageEvent({
          id: "evt-after-rollback",
          turnId: "turn-after-rollback",
          inputTokens: 1_050,
          cachedInputTokens: 420,
          cacheCreationTokens: 105,
          outputTokens: 210,
          reasoningTokens: 84,
          last: {
            inputTokens: 50,
            cachedInputTokens: 20,
            cacheCreationTokens: 5,
            outputTokens: 10,
            reasoningTokens: 4,
          },
        }),
      );
      yield* runtime.emit(codexTurnEvent("turn/completed", "turn-after-rollback"));

      const rollbackCompletion = yield* Fiber.join(rollbackCompletionFiber);
      const completions = [
        ...firstCompletions,
        ...(rollbackCompletion._tag === "Some" ? [rollbackCompletion.value] : []),
      ];
      NodeAssert.deepStrictEqual(
        completions.map((event) =>
          event.type === "turn.completed" ? event.payload.tokenUsage : undefined,
        ),
        [
          {
            usageStatus: "complete",
            usageScope: "main_agent",
            inputTokens: 300,
            cachedInputTokens: 120,
            cacheCreationTokens: 30,
            outputTokens: 60,
            reasoningTokens: 24,
            hasSubagents: false,
          },
          {
            usageStatus: "complete",
            usageScope: "main_agent",
            inputTokens: 100,
            cachedInputTokens: 40,
            cacheCreationTokens: 10,
            outputTokens: 20,
            reasoningTokens: 8,
            hasSubagents: false,
          },
          {
            usageStatus: "complete",
            usageScope: "main_agent",
            inputTokens: 50,
            cachedInputTokens: 20,
            cacheCreationTokens: 5,
            outputTokens: 10,
            reasoningTokens: 4,
            hasSubagents: false,
          },
        ],
      );
    }),
  );

  it.effect("carries child model metadata through every task event", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 10)).pipe(
        Effect.forkChild,
      );

      const cases = [
        ["collabAgent/started", {}],
        ["collabAgent/activity", { activityKind: "started" }],
        ["collabAgent/turnStarted", {}],
        ["collabAgent/turnCompleted", { turn: { status: "completed" } }],
        ["collabAgent/statusChanged", { status: { type: "active", activeFlags: [] } }],
        ["collabAgent/tokenUsage", { tokenUsage: { total: { totalTokens: 42 } } }],
        ["collabAgent/item", { item: { type: "commandExecution", command: "pwd" } }],
        ["collabAgent/closed", {}],
        ["collabAgent/metadataUpdated", {}],
      ] as const;

      for (const [index, [method, extra]] of cases.entries()) {
        yield* runtime.emit({
          id: asEventId(`evt-child-model-${index}`),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-1"),
          payload: {
            agentThreadId: "child-model",
            agentPath: "/root/model-check",
            model: " gpt-5.6-sol ",
            effort: " high ",
            ...extra,
          },
        });
      }
      yield* runtime.emit({
        id: asEventId("evt-child-model-blank"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "collabAgent/metadataUpdated",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        payload: {
          agentThreadId: "child-model",
          model: "  ",
          effort: "",
        },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      NodeAssert.deepStrictEqual(
        events.map((event) => event.type),
        [
          "task.started",
          "task.started",
          "task.updated",
          "task.updated",
          "task.updated",
          "task.progress",
          "task.progress",
          "task.updated",
          "task.updated",
          "task.updated",
        ],
      );
      for (const event of events.slice(0, -1)) {
        const payload = event.payload as Record<string, unknown>;
        NodeAssert.equal(payload.model, "gpt-5.6-sol");
        NodeAssert.equal(payload.effort, "high");
      }

      const metadataPayload = events[8]?.payload as Record<string, unknown>;
      NodeAssert.equal("status" in metadataPayload, false);
      const blankMetadataPayload = events[9]?.payload as Record<string, unknown>;
      NodeAssert.equal("status" in blankMetadataPayload, false);
      NodeAssert.equal("model" in blankMetadataPayload, false);
      NodeAssert.equal("effort" in blankMetadataPayload, false);
    }),
  );

  it.effect("does not reactivate an idle child after a parent interaction", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 3)).pipe(
        Effect.forkChild,
      );

      const childEvent = (id: string, method: string, payload: Record<string, unknown>) => ({
        id: asEventId(id),
        kind: "notification" as const,
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        payload,
      });

      yield* runtime.emit(
        childEvent("evt-child-running", "collabAgent/turnStarted", {
          agentThreadId: "child-1",
          agentPath: "/root/audit",
        }),
      );
      yield* runtime.emit(
        childEvent("evt-child-idle", "collabAgent/turnCompleted", {
          agentThreadId: "child-1",
          agentPath: "/root/audit",
          turn: { status: "completed" },
        }),
      );
      yield* runtime.emit(
        childEvent("evt-child-interacted", "collabAgent/activity", {
          agentThreadId: "child-1",
          agentPath: "/root/audit",
          activityKind: "interacted",
        }),
      );
      yield* runtime.emit(
        childEvent("evt-other-child-running", "collabAgent/turnStarted", {
          agentThreadId: "child-2",
          agentPath: "/root/other",
        }),
      );

      const events = Array.from(yield* Fiber.join(eventsFiber));
      NodeAssert.deepStrictEqual(
        events.map((event) =>
          event.type === "task.updated"
            ? { taskId: event.payload.taskId, status: event.payload.status }
            : { type: event.type },
        ),
        [
          { taskId: "child-1", status: "running" },
          { taskId: "child-1", status: "idle" },
          { taskId: "child-2", status: "running" },
        ],
      );
    }),
  );

  it.effect("keeps passive child activity from asserting execution liveness", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
        Effect.forkChild,
      );
      const emitCollabEvent = (id: string, method: string, payload: Record<string, unknown>) =>
        runtime.emit({
          id: asEventId(id),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("parent-turn-1"),
          payload: {
            agentThreadId: "child-thread-1",
            nickname: "reviewer",
            role: "worker",
            agentPath: "/agents/reviewer",
            ...payload,
          },
        } satisfies ProviderEvent);

      yield* emitCollabEvent("evt-child-started", "collabAgent/activity", {
        activityKind: "started",
      });
      yield* emitCollabEvent("evt-child-completed", "collabAgent/turnCompleted", {
        turn: { status: "completed" },
      });
      yield* emitCollabEvent("evt-child-late-completed", "collabAgent/activity", {
        activityKind: "completed",
      });
      yield* emitCollabEvent("evt-child-idle-interacted", "collabAgent/activity", {
        activityKind: "interacted",
      });
      yield* emitCollabEvent("evt-child-follow-up", "collabAgent/turnStarted", {});
      yield* emitCollabEvent("evt-child-running-interacted", "collabAgent/activity", {
        activityKind: "interacted",
      });
      yield* emitCollabEvent("evt-child-standalone-completed", "collabAgent/activity", {
        activityKind: "completed",
      });
      yield* emitCollabEvent("evt-child-unknown-activity", "collabAgent/activity", {
        activityKind: "futureKind",
      });
      yield* emitCollabEvent("evt-child-status-active", "collabAgent/statusChanged", {
        status: { type: "active", activeFlags: [] },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      NodeAssert.deepStrictEqual(
        events.map((event) => [
          event.eventId,
          event.type,
          "status" in event.payload ? event.payload.status : undefined,
        ]),
        [
          ["evt-child-started", "task.started", undefined],
          ["evt-child-completed", "task.updated", "idle"],
          ["evt-child-late-completed", "task.updated", "idle"],
          ["evt-child-follow-up", "task.updated", "running"],
          ["evt-child-standalone-completed", "task.updated", "idle"],
          ["evt-child-status-active", "task.updated", "running"],
        ],
      );
      const expectedIdentity = {
        taskId: "child-thread-1",
        role: "worker",
        title: "reviewer",
        agentPath: "/agents/reviewer",
        timelineBypass: true,
      };
      NodeAssert.deepStrictEqual(events[0]?.payload, {
        ...expectedIdentity,
        description: "reviewer",
      });
      for (const event of events.slice(1)) {
        const status = "status" in event.payload ? event.payload.status : undefined;
        NodeAssert.deepStrictEqual(event.payload, {
          ...expectedIdentity,
          status,
        });
      }
    }),
  );

  it.effect("maps completed agent message items to canonical item.completed events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-msg-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("msg_1"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "msg_1",
            text: "done",
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "item.completed");
      if (firstEvent.value.type !== "item.completed") {
        return;
      }
      NodeAssert.equal(firstEvent.value.itemId, "msg_1");
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.itemType, "assistant_message");
    }),
  );

  it.effect("labels MCP lifecycle entries with server and tool names", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-mcp-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("mcp_1"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "mcpToolCall",
            id: "mcp_1",
            server: "t3-code",
            tool: "preview_status",
            arguments: {},
            durationMs: 12,
            error: null,
            result: { content: [{ type: "text", text: "attached" }] },
            status: "completed",
          },
        },
      });
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "item.completed") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.itemType, "mcp_tool_call");
      NodeAssert.equal(firstEvent.value.payload.title, "t3-code · preview_status");
      NodeAssert.deepStrictEqual(firstEvent.value.payload.data, {
        completedAtMs: 1_778_000_000_000,
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "mcpToolCall",
          id: "mcp_1",
          server: "t3-code",
          tool: "preview_status",
          arguments: {},
          durationMs: 12,
          error: null,
          result: { content: [{ type: "text", text: "attached" }] },
          status: "completed",
        },
      });
    }),
  );

  it.effect("presents browser and computer-use calls with Codex-style titles and sources", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 3)).pipe(
        Effect.forkChild,
      );
      const longIntentTitle = `  ${"a".repeat(39)}   ${"a".repeat(38)}😀bc  `;
      const serializedOverContractUrl = `https://example.com/?query=${"😀".repeat(400)}`;

      yield* runtime.emit({
        id: asEventId("evt-computer-start"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/started",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("computer_1"),
        payload: {
          startedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "mcpToolCall",
            id: "computer_1",
            server: "node_repl",
            tool: "js",
            arguments: {
              code: 'await sky.click({ app: "Finder", x: 10, y: 20 })',
              title: longIntentTitle,
            },
            durationMs: null,
            error: null,
            result: {
              _meta: {
                "codex/toolSurface": {
                  kind: "computerUse",
                  app: { kind: "appId", appId: "com.apple.finder" },
                },
              },
              content: [],
            },
            status: "inProgress",
          },
        },
      });
      yield* runtime.emit({
        id: asEventId("evt-browser-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:01.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("browser_1"),
        payload: {
          completedAtMs: 1_778_000_001_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "mcpToolCall",
            id: "browser_1",
            server: "node_repl",
            tool: "js",
            arguments: { code: "await tab.playwright.domSnapshot()", title: "Inspect checkout" },
            durationMs: 12,
            error: null,
            result: {
              _meta: {
                "codex/toolSurface": {
                  kind: "browserUse",
                  backend: "chrome",
                  openTabs: [
                    {
                      pageUrl: "https://www.mathworks.com/help/matlab/",
                      faviconUrl: "https://www.mathworks.com/favicon.ico",
                      faviconUrlDark: "https://www.mathworks.com/favicon-dark.ico",
                      url: "https://www.mathworks.com/help/matlab/",
                    },
                  ],
                },
                browser_use: { url: serializedOverContractUrl },
              },
              content: [],
            },
            status: "completed",
          },
        },
      });
      yield* runtime.emit({
        id: asEventId("evt-computer-use-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:02.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("computer_2"),
        payload: {
          completedAtMs: 1_778_000_002_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "mcpToolCall",
            id: "computer_2",
            server: "computer-use",
            tool: "type_text",
            arguments: { text: "Hello world", app: "TextEdit" },
            durationMs: 12,
            error: null,
            result: {
              _meta: {
                "codex/toolSurface": {
                  kind: "computerUse",
                  app: { kind: "displayName", displayName: "TextEdit" },
                },
              },
              content: [],
            },
            status: "completed",
          },
        },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      NodeAssert.deepStrictEqual(
        events.map((event) => ({
          type: event.type,
          title: "title" in event.payload ? event.payload.title : undefined,
          toolSurface: "toolSurface" in event.payload ? event.payload.toolSurface : undefined,
          toolIcon: "toolIcon" in event.payload ? event.payload.toolIcon : undefined,
          toolSource: "toolSource" in event.payload ? event.payload.toolSource : undefined,
        })),
        [
          {
            type: "item.started",
            title: `${"a".repeat(39)} ${"a".repeat(38)}😀…`,
            toolSurface: "computer",
            toolIcon: {
              _tag: "native-app",
              app: { _tag: "app-id", appId: "com.apple.finder" },
            },
            toolSource: {
              key: "native-app:com.apple.finder",
              name: "Finder",
              kind: "computer",
              icon: {
                _tag: "native-app",
                app: { _tag: "app-id", appId: "com.apple.finder" },
              },
            },
          },
          {
            type: "item.completed",
            title: "Inspect checkout",
            toolSurface: "browser",
            toolIcon: {
              _tag: "website",
              pageUrl: "https://www.mathworks.com/help/matlab/",
              faviconUrl: "https://www.mathworks.com/favicon.ico",
              faviconUrlDark: "https://www.mathworks.com/favicon-dark.ico",
            },
            toolSource: {
              key: "browser-use:chrome",
              name: "Chrome",
              kind: "integration",
              icon: {
                _tag: "native-app",
                app: { _tag: "display-name", displayName: "Google Chrome" },
              },
            },
          },
          {
            type: "item.completed",
            title: "Typed text in TextEdit",
            toolSurface: "computer",
            toolIcon: {
              _tag: "native-app",
              app: { _tag: "display-name", displayName: "TextEdit" },
            },
            toolSource: {
              key: "native-app-name:textedit",
              name: "TextEdit",
              kind: "computer",
              icon: {
                _tag: "native-app",
                app: { _tag: "display-name", displayName: "TextEdit" },
              },
            },
          },
        ],
      );
    }),
  );

  it.effect("preserves failed and declined outcomes on completed tool items", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const maxLengthAppId = `com.${"a".repeat(508)}`;
      const collidingMaxLengthAppId = `com.${"a".repeat(507)}b`;
      const longAppSourceKeys: string[] = [];
      const items = [
        {
          type: "commandExecution",
          id: "failed-command",
          command: "vp test run",
          commandActions: [],
          cwd: "/tmp",
          exitCode: 1,
          status: "failed",
        },
        {
          type: "mcpToolCall",
          id: "failed-mcp",
          server: "simulator",
          tool: "build",
          arguments: {},
          error: { message: "Build failed" },
          status: "failed",
        },
        {
          type: "mcpToolCall",
          id: "failed-computer",
          server: "computer-use",
          tool: "click",
          arguments: { app: "Finder" },
          error: { message: "Click failed" },
          result: {
            _meta: {
              "codex/toolSurface": {
                kind: "computerUse",
                app: { kind: "appId", appId: maxLengthAppId },
              },
            },
            content: [],
          },
          status: "failed",
        },
        {
          type: "mcpToolCall",
          id: "failed-computer-collision",
          server: "computer-use",
          tool: "click",
          arguments: { app: "Other" },
          error: { message: "Click failed" },
          result: {
            _meta: {
              "codex/toolSurface": {
                kind: "computerUse",
                app: { kind: "appId", appId: collidingMaxLengthAppId },
              },
            },
            content: [],
          },
          status: "failed",
        },
        {
          type: "fileChange",
          id: "declined-change",
          changes: [],
          status: "declined",
        },
      ] as const;

      for (const item of items) {
        const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

        yield* runtime.emit({
          id: asEventId(`evt-${item.id}`),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "item/completed",
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-1"),
          itemId: asItemId(item.id),
          payload: {
            completedAtMs: 1_778_000_000_000,
            threadId: "thread-1",
            turnId: "turn-1",
            item,
          },
        });

        const firstEvent = yield* Fiber.join(firstEventFiber);
        NodeAssert.equal(firstEvent._tag, "Some");
        if (firstEvent._tag !== "Some" || firstEvent.value.type !== "item.completed") {
          return;
        }
        NodeAssert.equal(firstEvent.value.payload.status, item.status);
        if (item.id.startsWith("failed-computer")) {
          NodeAssert.equal(firstEvent.value.payload.title, "computer-use · click");
          const sourceKey = firstEvent.value.payload.toolSource?.key;
          NodeAssert.equal(sourceKey?.length, 512);
          if (sourceKey) longAppSourceKeys.push(sourceKey);
        }
      }
      NodeAssert.equal(new Set(longAppSourceKeys).size, 2);
    }),
  );

  it.effect("maps completed plan items to canonical proposed-plan completion events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-plan-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "plan",
            id: "plan_1",
            text: "## Final plan\n\n- one\n- two",
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "turn.proposed.completed");
      if (firstEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.planMarkdown, "## Final plan\n\n- one\n- two");
    }),
  );

  it.effect("maps plan deltas to canonical proposed-plan delta events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-plan-delta"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/plan/delta",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "plan_1",
          delta: "## Final plan",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "turn.proposed.delta");
      if (firstEvent.value.type !== "turn.proposed.delta") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.delta, "## Final plan");
    }),
  );

  it.effect("maps app permission approval requests to permission_approval request types", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-app-permission-request"),
        kind: "request",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/permissions/requestApproval",
        requestId: ApprovalRequestId.make("req-perm-1"),
        requestKind: "permission",
        turnId: asTurnId("turn-1"),
        itemId: asItemId("app_1"),
        payload: {
          cwd: "/tmp/project",
          itemId: "app_1",
          permissions: { network: { enabled: true } },
          reason: "Fetch data from api.example.com",
          startedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "request.opened");
      if (firstEvent.value.type !== "request.opened") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.requestType, "permission_approval");
      NodeAssert.equal(firstEvent.value.payload.detail, "Fetch data from api.example.com");
    }),
  );

  it.effect("maps session/closed lifecycle events to canonical session.exited runtime events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-session-closed"),
        kind: "session",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "session/closed",
        message: "Session stopped",
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "session.exited");
      if (firstEvent.value.type !== "session.exited") {
        return;
      }
      NodeAssert.equal(firstEvent.value.threadId, "thread-1");
      NodeAssert.equal(firstEvent.value.payload.reason, "Session stopped");
    }),
  );

  it.effect(
    "drains a terminal event emitted during close before stopSession tears down the event fiber",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();

        // The runtime emits its terminal session/closed AS PART of close() and
        // then ends its event queue — exactly the real ordering. The adapter's
        // event fiber (forked into the session scope that stopSession tears down)
        // must drain that final event into the outward stream BEFORE it is
        // interrupted, or the canonical session.exited is silently dropped.
        runtime.closeEmits = {
          id: asEventId("evt-session-closed-drain"),
          kind: "session",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "session/closed",
          message: "Session stopped",
        };

        // Subscribe before stopping so a miss is due to drop, not late subscription.
        const terminalFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

        yield* adapter.stopSession(asThreadId("thread-1"));

        // With the drain-sync, stopSession awaits the event fiber draining the
        // ended queue, so the terminal is delivered and runHead resolves. Without
        // it, the fiber is interrupted mid-drain, the event is dropped, and this
        // join never resolves (the negative control surfaces as a test timeout).
        const terminal = yield* Fiber.join(terminalFiber);

        NodeAssert.equal(terminal._tag, "Some");
        if (terminal._tag !== "Some") {
          return;
        }
        NodeAssert.equal(terminal.value.type, "session.exited");
      }),
  );

  it.effect("maps retryable Codex error notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-retryable-error"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "error",
        turnId: asTurnId("turn-1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          error: {
            message: "Reconnecting... 2/5",
          },
          willRetry: true,
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.message, "Reconnecting... 2/5");
    }),
  );

  it.effect("maps a native resume fallback to a visible runtime warning", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-resume-fallback"),
        kind: "session",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "session/resume-fallback",
        message: "Codex could not resume its native conversation and started a fresh one.",
        payload: {
          requestedThreadId: "stale-thread",
          providerThreadId: "fresh-thread",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      NodeAssert.equal(
        firstEvent.value.payload.message,
        "Codex could not resume its native conversation and started a fresh one.",
      );
      NodeAssert.deepStrictEqual(firstEvent.value.payload.detail, {
        requestedThreadId: "stale-thread",
        providerThreadId: "fresh-thread",
      });
    }),
  );

  it.effect("maps process stderr notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-process-stderr"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "process/stderr",
        turnId: asTurnId("turn-1"),
        message: "The filename or extension is too long. (os error 206)",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(
        firstEvent.value.payload.message,
        "The filename or extension is too long. (os error 206)",
      );
    }),
  );

  it.effect("maps realtime started notifications with upstream realtime session ids", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-realtime-started"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "thread/realtime/started",
        payload: {
          threadId: "thread-1",
          realtimeSessionId: "realtime-session-1",
          version: "v2",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "thread.realtime.started");
      if (firstEvent.value.type !== "thread.realtime.started") {
        return;
      }
      NodeAssert.equal(firstEvent.value.threadId, "thread-1");
      NodeAssert.equal(firstEvent.value.payload.realtimeSessionId, "realtime-session-1");
    }),
  );

  it.effect("maps fatal websocket stderr notifications to runtime.error", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-process-stderr-websocket"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "process/stderr",
        turnId: asTurnId("turn-1"),
        message:
          "2026-03-31T18:14:06.833399Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 503 Service Unavailable, url: wss://chatgpt.com/backend-api/codex/responses",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "runtime.error");
      if (firstEvent.value.type !== "runtime.error") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.class, "provider_error");
      NodeAssert.equal(
        firstEvent.value.payload.message,
        "2026-03-31T18:14:06.833399Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 503 Service Unavailable, url: wss://chatgpt.com/backend-api/codex/responses",
      );
    }),
  );

  it.effect("preserves request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-request-resolved"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "serverRequest/resolved",
        requestKind: "command",
        requestId: ApprovalRequestId.make("req-1"),
        payload: {
          threadId: "thread-1",
          requestId: "req-1",
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.requestType, "command_execution_approval");
    }),
  );

  it.effect("surfaces a sandbox permission request with the paths it asks for", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-permissions-request"),
        kind: "request",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/permissions/requestApproval",
        requestKind: "file-change",
        requestId: ApprovalRequestId.make("req-perm-1"),
        payload: {
          cwd: "/workspace",
          itemId: "item-1",
          permissions: {
            fileSystem: {
              entries: [{ access: "write", path: { type: "path", path: "/workspace/dist" } }],
            },
          },
          reason: "write build output",
          startedAtMs: 0,
          threadId: "thread-1",
          turnId: "turn-1",
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "request.opened");
      if (firstEvent.value.type !== "request.opened") {
        return;
      }
      // Before this method was mapped it fell through to "unknown", which the
      // web and mobile approval folds silently drop.
      NodeAssert.equal(firstEvent.value.payload.requestType, "permissions_approval");
      NodeAssert.match(firstEvent.value.payload.detail ?? "", /write: \/workspace\/dist/u);
      NodeAssert.match(firstEvent.value.payload.detail ?? "", /write build output/u);
    }),
  );

  it.effect("names the edited files in an apply-patch approval without a reason", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-apply-patch"),
        kind: "request",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-08-24T00:00:00.000Z",
        method: "applyPatchApproval",
        requestKind: "file-change",
        requestId: ApprovalRequestId.make("req-patch"),
        turnId: asTurnId("turn-1"),
        payload: {
          callId: "call-1",
          conversationId: "provider-thread-1",
          fileChanges: {
            "/tmp/removed.md": { type: "delete", content: "gone" },
            "/tmp/added.ts": { type: "add", content: "export {};" },
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "request.opened") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.requestType, "apply_patch_approval");
      NodeAssert.equal(
        firstEvent.value.payload.detail,
        "add /tmp/added.ts\ndelete /tmp/removed.md",
      );
    }),
  );

  it.effect("keeps the reason when an apply-patch approval carries one", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-apply-patch-reason"),
        kind: "request",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-08-24T00:00:00.000Z",
        method: "applyPatchApproval",
        requestKind: "file-change",
        requestId: ApprovalRequestId.make("req-patch-reason"),
        turnId: asTurnId("turn-1"),
        payload: {
          callId: "call-2",
          conversationId: "provider-thread-1",
          reason: "Needs to rewrite the changelog",
          fileChanges: { "/tmp/CHANGELOG.md": { type: "add", content: "x" } },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "request.opened") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.detail, "Needs to rewrite the changelog");
    }),
  );

  it.effect("falls back to the grant root for a file-change approval without a reason", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-file-change"),
        kind: "request",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-08-24T00:00:00.000Z",
        method: "item/fileChange/requestApproval",
        requestKind: "file-change",
        requestId: ApprovalRequestId.make("req-file-change"),
        turnId: asTurnId("turn-1"),
        payload: {
          itemId: "item-1",
          grantRoot: "/tmp/workspace",
          startedAtMs: 0,
          threadId: "provider-thread-1",
          turnId: "turn-1",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "request.opened") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.requestType, "file_change_approval");
      NodeAssert.equal(firstEvent.value.payload.detail, "/tmp/workspace");
    }),
  );

  it.effect("prefers the edited files over a blank apply-patch reason", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-apply-patch-blank"),
        kind: "request",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-08-24T00:00:00.000Z",
        method: "applyPatchApproval",
        requestKind: "file-change",
        requestId: ApprovalRequestId.make("req-patch-blank"),
        turnId: asTurnId("turn-1"),
        payload: {
          callId: "call-3",
          conversationId: "provider-thread-1",
          reason: "   ",
          fileChanges: {
            "/tmp/moved.ts": { type: "update", unified_diff: "@@", move_path: "/tmp/renamed.ts" },
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "request.opened") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.detail, "update /tmp/moved.ts -> /tmp/renamed.ts");
    }),
  );

  it.effect("caps the described files in an oversized apply-patch approval", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const fileChanges = Object.fromEntries(
        Array.from({ length: 25 }, (_unused, index) => [
          `/tmp/file-${String(index).padStart(2, "0")}.ts`,
          { type: "add", content: "x" },
        ]),
      );

      yield* runtime.emit({
        id: asEventId("evt-apply-patch-many"),
        kind: "request",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-08-24T00:00:00.000Z",
        method: "applyPatchApproval",
        requestKind: "file-change",
        requestId: ApprovalRequestId.make("req-patch-many"),
        turnId: asTurnId("turn-1"),
        payload: { callId: "call-4", conversationId: "provider-thread-1", fileChanges },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "request.opened") {
        return;
      }
      const detail = firstEvent.value.payload.detail ?? "";
      NodeAssert.equal(detail.split("\n").length, 21);
      NodeAssert.ok(detail.endsWith("+5 more"));
    }),
  );

  it.effect("leaves an apply-patch approval without changes or a reason undetailed", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-apply-patch-empty"),
        kind: "request",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-08-24T00:00:00.000Z",
        method: "applyPatchApproval",
        requestKind: "file-change",
        requestId: ApprovalRequestId.make("req-patch-empty"),
        turnId: asTurnId("turn-1"),
        payload: { callId: "call-5", conversationId: "provider-thread-1", fileChanges: {} },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "request.opened") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.detail, undefined);
    }),
  );

  it.effect("maps MCP elicitation requests into app access approvals", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-mcp-elicitation"),
        kind: "request",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-08-24T00:00:00.000Z",
        method: "mcpServer/elicitation/request",
        requestKind: "mcp-elicitation",
        requestId: ApprovalRequestId.make("req-safari"),
        turnId: asTurnId("turn-1"),
        payload: {
          mode: "form",
          message: "Allow ChatGPT to use Safari?",
          serverName: "computer-use",
          threadId: "provider-thread-1",
          turnId: "turn-1",
          _meta: { app_name: "Safari", persist: ["session", "always"] },
          requestedSchema: { type: "object", properties: {} },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "request.opened") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.requestType, "mcp_elicitation_approval");
      NodeAssert.equal(firstEvent.value.payload.appName, "computer-use");
      NodeAssert.equal(firstEvent.value.payload.detail, "Allow ChatGPT to use Safari?");
      NodeAssert.deepStrictEqual(firstEvent.value.payload.options, [
        { decision: "cancel", label: "Cancel" },
        { decision: "decline", label: "Decline" },
        { decision: "acceptForSession", label: "Always allow this session" },
        { decision: "acceptAlways", label: "Always allow" },
        { decision: "accept", label: "Approve" },
      ]);
    }),
  );

  it.effect("preserves MCP elicitation type when an app access request resolves", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-mcp-elicitation-resolved"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-08-24T00:00:00.000Z",
        method: "item/requestApproval/decision",
        requestKind: "mcp-elicitation",
        requestId: ApprovalRequestId.make("req-safari"),
        payload: { decision: "acceptAlways" },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "request.resolved") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.requestType, "mcp_elicitation_approval");
      NodeAssert.equal(firstEvent.value.payload.decision, "acceptAlways");
    }),
  );

  it.effect("preserves file-read request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-file-read-request-resolved"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "serverRequest/resolved",
        requestKind: "file-read",
        requestId: ApprovalRequestId.make("req-file-read-1"),
        payload: {
          threadId: "thread-1",
          requestId: "req-file-read-1",
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.requestType, "file_read_approval");
    }),
  );

  it.effect("preserves explicit empty multi-select user-input answers", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-user-input-empty"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/tool/requestUserInput/answered",
        payload: {
          answers: {
            scope: {
              answers: [],
            },
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "user-input.resolved");
      if (firstEvent.value.type !== "user-input.resolved") {
        return;
      }
      NodeAssert.deepEqual(firstEvent.value.payload.answers, {
        scope: [],
      });
    }),
  );

  it.effect("maps windowsSandbox/setupCompleted to session state and warning on failure", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );

      const event: ProviderEvent = {
        id: asEventId("evt-windows-sandbox-failed"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "windowsSandbox/setupCompleted",
        message: "Sandbox setup failed",
        payload: {
          mode: "unelevated",
          success: false,
          error: "unsupported environment",
        },
      };

      yield* runtime.emit(event);
      const events = Array.from(yield* Fiber.join(eventsFiber));

      NodeAssert.equal(events.length, 2);

      const firstEvent = events[0];
      const secondEvent = events[1];

      NodeAssert.equal(firstEvent?.type, "session.state.changed");
      if (firstEvent?.type === "session.state.changed") {
        NodeAssert.equal(firstEvent.payload.state, "error");
        NodeAssert.equal(firstEvent.payload.reason, "Sandbox setup failed");
      }

      NodeAssert.equal(secondEvent?.type, "runtime.warning");
      if (secondEvent?.type === "runtime.warning") {
        NodeAssert.equal(secondEvent.payload.message, "Sandbox setup failed");
      }
    }),
  );

  it.effect(
    "maps requestUserInput requests and answered notifications to canonical user-input events",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
          Effect.forkChild,
        );

        yield* runtime.emit({
          id: asEventId("evt-user-input-requested"),
          kind: "request",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "item/tool/requestUserInput",
          requestId: ApprovalRequestId.make("req-user-input-1"),
          payload: {
            isBlocking: true,
            itemId: "item-user-input-1",
            threadId: "thread-1",
            turnId: "turn-1",
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "workspace-write",
                    description: "Allow workspace writes only",
                  },
                ],
              },
            ],
          },
        } satisfies ProviderEvent);
        yield* runtime.emit({
          id: asEventId("evt-user-input-resolved"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "item/tool/requestUserInput/answered",
          requestId: ApprovalRequestId.make("req-user-input-1"),
          payload: {
            answers: {
              sandbox_mode: {
                answers: ["workspace-write"],
              },
            },
          },
        } satisfies ProviderEvent);

        const events = Array.from(yield* Fiber.join(eventsFiber));
        NodeAssert.equal(events[0]?.type, "user-input.requested");
        if (events[0]?.type === "user-input.requested") {
          NodeAssert.equal(events[0].requestId, "req-user-input-1");
          NodeAssert.equal(events[0].payload.questions[0]?.id, "sandbox_mode");
          NodeAssert.equal(events[0].payload.questions[0]?.multiSelect, false);
        }

        NodeAssert.equal(events[1]?.type, "user-input.resolved");
        if (events[1]?.type === "user-input.resolved") {
          NodeAssert.equal(events[1].requestId, "req-user-input-1");
          NodeAssert.deepEqual(events[1].payload.answers, {
            sandbox_mode: "workspace-write",
          });
        }
      }),
  );

  it.effect("maps async agent questions without ending the turn", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );
      yield* runtime.emit({
        id: asEventId("evt-async-question"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        payload: {
          completedAtMs: 0,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "async-question-1",
            text: "Which package manager?\n- pnpm\n- npm\n\nWhat should it be named?",
            phase: "final_answer",
            delivery: "async",
            questions: [
              { title: "Which package manager?", options: ["pnpm", "npm"] },
              { title: "What should it be named?" },
            ],
          },
        },
      });
      yield* runtime.emit({
        id: asEventId("evt-async-continued"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:01.000Z",
        method: "item/agentMessage/delta",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "message-2",
          delta: "I will keep working.",
        },
      });
      const events = Array.from(yield* Fiber.join(eventsFiber));
      NodeAssert.equal(events[0]?.type, "user-input.requested");
      NodeAssert.equal(events[0]?.requestId, "codex-async:thread-1:async-question-1");
      NodeAssert.deepEqual(events[0]?.payload, {
        responseMode: "message",
        questions: [
          {
            id: "0",
            header: "Question",
            question: "Which package manager?",
            options: [
              { label: "pnpm", description: "" },
              { label: "npm", description: "" },
            ],
            allowCustomAnswer: true,
            multiSelect: false,
          },
          {
            id: "1",
            header: "Question",
            question: "What should it be named?",
            options: [],
            allowCustomAnswer: true,
            multiSelect: false,
          },
        ],
      });
      NodeAssert.equal(events[1]?.type, "content.delta");
    }),
  );

  it.effect("keeps requestUserInput questions whose options have an empty description", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 1)).pipe(
        Effect.forkChild,
      );

      yield* runtime.emit({
        id: asEventId("evt-user-input-requested-empty-description"),
        kind: "request",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/tool/requestUserInput",
        requestId: ApprovalRequestId.make("req-user-input-2"),
        payload: {
          isBlocking: true,
          itemId: "item-user-input-2",
          threadId: "thread-1",
          turnId: "turn-1",
          questions: [
            {
              id: "option_preference",
              header: "Preference",
              question: "Alpha or beta?",
              options: [
                { label: "Option alpha", description: "" },
                { label: "Option beta", description: "" },
              ],
            },
          ],
        },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      NodeAssert.equal(events[0]?.type, "user-input.requested");
      if (events[0]?.type === "user-input.requested") {
        NodeAssert.deepEqual(events[0].payload.questions[0]?.options, [
          { label: "Option alpha", description: "" },
          { label: "Option beta", description: "" },
        ]);
      }
    }),
  );

  it.effect("unwraps Codex token usage payloads for context window events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-codex-thread-token-usage-updated"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "thread/tokenUsage/updated",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              inputTokens: 11_833,
              cachedInputTokens: 3456,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 11_839,
            },
            last: {
              inputTokens: 120,
              cachedInputTokens: 0,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 126,
            },
            modelContextWindow: 258_400,
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "thread.token-usage.updated");
      if (firstEvent.value.type !== "thread.token-usage.updated") {
        return;
      }

      NodeAssert.deepEqual(firstEvent.value.payload.usage, {
        usedTokens: 126,
        totalProcessedTokens: 11_839,
        maxTokens: 258_400,
        inputTokens: 120,
        cachedInputTokens: 0,
        outputTokens: 6,
        reasoningOutputTokens: 0,
        lastUsedTokens: 126,
        lastInputTokens: 120,
        lastCachedInputTokens: 0,
        lastOutputTokens: 6,
        lastReasoningOutputTokens: 0,
        compactsAutomatically: true,
      });
    }),
  );

  // Production calls startSession from a request fiber that finishes as soon as
  // the session exists. `Effect.forkChild` made the runtime event consumer a
  // child of that fiber, and Effect interrupts a fiber's children when it
  // completes, so the consumer died on return and every event the session
  // emitted afterwards was dropped. The other tests here start the session from
  // the test fiber, which never completes, so the consumer survived and the bug
  // stayed invisible. Starting it in a fiber that finishes reproduces
  // production.
  it.effect("keeps consuming runtime events after the startSession fiber completes", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const startSessionFiber = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-outlives-start"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Fiber.join(startSessionFiber);

      const runtime = lifecycleRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);

      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      yield* runtime.emit({
        id: asEventId("evt-after-start-session"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-outlives-start"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("msg_after_start"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-outlives-start",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "msg_after_start",
            text: "emitted after startSession returned",
          },
        },
      });

      const firstEvent = yield* Fiber.join(firstEventFiber).pipe(Effect.timeout("10 seconds"));
      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "item.completed");
      // Live clock so the timeout above is real: under the default test clock it
      // waits on virtual time that never advances, and a regression would hang
      // until the suite timeout instead of failing here.
    }).pipe(TestClock.withLive),
  );
});

const scopedLifecycleRuntimeFactory = makeScopedRuntimeFactory();
const scopedLifecycleLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: scopedLifecycleRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

scopedLifecycleLayer("CodexAdapterLive scoped lifecycle", (it) => {
  it.effect("closes the externally owned session scope on stopSession", () =>
    Effect.gen(function* () {
      scopedLifecycleRuntimeFactory.releasedThreadIds.length = 0;
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-stop"),
        runtimeMode: "full-access",
      });

      const runtime = scopedLifecycleRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);

      yield* adapter.stopSession(asThreadId("thread-stop"));

      NodeAssert.equal(runtime.closeImpl.mock.calls.length, 1);
      NodeAssert.deepStrictEqual(scopedLifecycleRuntimeFactory.releasedThreadIds, [
        asThreadId("thread-stop"),
      ]);
      NodeAssert.equal(yield* adapter.hasSession(asThreadId("thread-stop")), false);
    }),
  );
});

const scopedFailureRuntimeFactory = makeScopedRuntimeFactory({ failConstruction: true });
const scopedFailureLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: scopedFailureRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

scopedFailureLayer("CodexAdapterLive scoped startup failure", (it) => {
  it.effect("closes the externally owned session scope when startSession fails", () =>
    Effect.gen(function* () {
      scopedFailureRuntimeFactory.releasedThreadIds.length = 0;
      const adapter = yield* CodexAdapter;

      const result = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-fail"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterProcessError");
      NodeAssert.deepStrictEqual(scopedFailureRuntimeFactory.releasedThreadIds, [
        asThreadId("thread-fail"),
      ]);
      NodeAssert.equal(yield* adapter.hasSession(asThreadId("thread-fail")), false);
    }),
  );
});

it.effect("flushes managed native logs when the adapter layer shuts down", () =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-codex-adapter-native-log-"),
    );
    const basePath = NodePath.join(tempDir, "provider-native.ndjson");
    const runtimeFactory = makeRuntimeFactory();
    const scope = yield* Scope.make("sequential");
    let scopeClosed = false;

    try {
      const layer = Layer.effect(
        CodexAdapter,
        Effect.gen(function* () {
          const codexConfig = decodeCodexSettings({});
          return yield* makeCodexAdapter(codexConfig, {
            makeRuntime: runtimeFactory.factory,
            nativeEventLogPath: basePath,
          });
        }),
      ).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );
      const context = yield* Layer.buildWithScope(layer, scope);
      const adapter = yield* Effect.service(CodexAdapter).pipe(Effect.provide(context));

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-logger"),
        runtimeMode: "full-access",
      });

      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);

      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      yield* runtime.emit({
        id: asEventId("evt-native-log"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-logger"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "process/stderr",
        message: "native flush test",
      } satisfies ProviderEvent);
      yield* Fiber.join(firstEventFiber);

      yield* Scope.close(scope, Exit.void);
      scopeClosed = true;

      const threadLogPath = NodePath.join(tempDir, "provider-native.thread-logger.log");
      NodeAssert.equal(NodeFS.existsSync(threadLogPath), true);
      const contents = NodeFS.readFileSync(threadLogPath, "utf8");
      NodeAssert.match(contents, /NTIVE: .*"message":"native flush test"/);
    } finally {
      if (!scopeClosed) {
        yield* Scope.close(scope, Exit.void);
      }
      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }
  }),
);

const usageLimitRuntimeFactory = makeRuntimeFactory();
const usageLimitLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: usageLimitRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const USAGE_LIMIT_NOW = "2026-01-01T00:00:00.000Z";
const USAGE_LIMIT_NOW_SECONDS = Date.parse(USAGE_LIMIT_NOW) / 1000;
const CODEX_OUT_OF_CREDITS =
  "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.";

function startUsageLimitRuntime() {
  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    yield* adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      runtimeMode: "full-access",
    });
    const runtime = usageLimitRuntimeFactory.lastRuntime;
    NodeAssert.ok(runtime);
    return { adapter, runtime };
  });
}

function codexErrorNotification(input: {
  readonly id: string;
  readonly message: string;
  readonly codexErrorInfo?: string;
}): ProviderEvent {
  return {
    id: asEventId(input.id),
    kind: "notification",
    provider: ProviderDriverKind.make("codex"),
    threadId: asThreadId("thread-1"),
    turnId: asTurnId("turn-limit"),
    createdAt: USAGE_LIMIT_NOW,
    method: "error",
    payload: {
      threadId: "thread-1",
      turnId: "turn-limit",
      willRetry: false,
      error: {
        message: input.message,
        ...(input.codexErrorInfo ? { codexErrorInfo: input.codexErrorInfo } : {}),
      },
    },
  };
}

function codexRateLimitsNotification(input: {
  readonly id: string;
  readonly rateLimitReachedType?: string;
  readonly primary?: { readonly usedPercent: number; readonly resetsInSeconds: number };
  readonly secondary?: { readonly usedPercent: number; readonly resetsInSeconds: number };
}): ProviderEvent {
  return {
    id: asEventId(input.id),
    kind: "notification",
    provider: ProviderDriverKind.make("codex"),
    threadId: asThreadId("thread-1"),
    turnId: asTurnId("turn-limit"),
    createdAt: USAGE_LIMIT_NOW,
    method: "account/rateLimits/updated",
    payload: {
      rateLimits: {
        limitId: "codex",
        ...(input.rateLimitReachedType ? { rateLimitReachedType: input.rateLimitReachedType } : {}),
        ...(input.primary
          ? {
              primary: {
                usedPercent: input.primary.usedPercent,
                resetsAt: USAGE_LIMIT_NOW_SECONDS + input.primary.resetsInSeconds,
                windowDurationMins: 300,
              },
            }
          : {}),
        ...(input.secondary
          ? {
              secondary: {
                usedPercent: input.secondary.usedPercent,
                resetsAt: USAGE_LIMIT_NOW_SECONDS + input.secondary.resetsInSeconds,
                windowDurationMins: 10_080,
              },
            }
          : {}),
      },
    },
  };
}

function codexUsageLimitTurnFailed(id: string, turnId = "turn-limit"): ProviderEvent {
  return {
    id: asEventId(id),
    kind: "notification",
    provider: ProviderDriverKind.make("codex"),
    threadId: asThreadId("thread-1"),
    turnId: asTurnId(turnId),
    createdAt: USAGE_LIMIT_NOW,
    method: "turn/completed",
    payload: {
      threadId: "thread-1",
      turn: {
        id: turnId,
        items: [],
        status: "failed",
        error: { message: CODEX_OUT_OF_CREDITS, codexErrorInfo: "usageLimitExceeded" },
      },
    },
  };
}

usageLimitLayer("CodexAdapterLive usage limits", (it) => {
  it.effect("names the exhausted window and the workspace's missing credits", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startUsageLimitRuntime();
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* runtime.emit(
        codexErrorNotification({
          id: "evt-limit-error",
          message: CODEX_OUT_OF_CREDITS,
          codexErrorInfo: "usageLimitExceeded",
        }),
      );
      yield* runtime.emit(
        codexRateLimitsNotification({
          id: "evt-limit-rate-limits",
          rateLimitReachedType: "workspace_owner_credits_depleted",
          primary: { usedPercent: 40, resetsInSeconds: 3_600 },
          secondary: { usedPercent: 100, resetsInSeconds: 5 * 86_400 + 5 * 3_600 },
        }),
      );
      yield* runtime.emit(codexUsageLimitTurnFailed("evt-limit-turn"));
      // A second turn stopping on the same limit says as much as the first.
      yield* runtime.emit(codexUsageLimitTurnFailed("evt-limit-turn-2", "turn-limit-2"));

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const expected =
        "Codex usage limit reached. The weekly limit resets in 5d 5h. The workspace has no credits to continue sooner: ask your workspace owner to add credits, or send the message again once the limit resets.";
      NodeAssert.deepStrictEqual(
        events.map((event) => event.type),
        [
          "account.rate-limits.updated",
          "runtime.error",
          "turn.completed",
          "runtime.error",
          "turn.completed",
        ],
      );
      for (const event of events) {
        if (event.type === "runtime.error") {
          NodeAssert.equal(event.payload.message, expected);
          NodeAssert.equal(event.payload.detail, CODEX_OUT_OF_CREDITS);
        }
        if (event.type === "turn.completed") {
          NodeAssert.equal(event.payload.errorMessage, expected);
        }
      }
    }),
  );

  it.effect("names the session window for a plan limit", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startUsageLimitRuntime();
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* runtime.emit(
        codexErrorNotification({
          id: "evt-plan-error",
          message: "You've hit your usage limit.",
          codexErrorInfo: "usageLimitExceeded",
        }),
      );
      yield* runtime.emit(
        codexRateLimitsNotification({
          id: "evt-plan-rate-limits",
          rateLimitReachedType: "rate_limit_reached",
          primary: { usedPercent: 100, resetsInSeconds: 3 * 3_600 + 20 * 60 },
        }),
      );
      yield* runtime.emit(codexUsageLimitTurnFailed("evt-plan-turn"));

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const completed = events.find((event) => event.type === "turn.completed");
      NodeAssert.equal(
        completed?.payload.errorMessage,
        "Codex usage limit reached. The session limit resets in 3h 20m. Send the message again once the limit resets.",
      );
    }),
  );

  it.effect("reads a rate-limit snapshot seen earlier in the session", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startUsageLimitRuntime();
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      // The window arrives long before the stop, and the update that reports the
      // limit as reached carries no windows of its own.
      yield* runtime.emit(
        codexRateLimitsNotification({
          id: "evt-early-rate-limits",
          primary: { usedPercent: 100, resetsInSeconds: 3 * 3_600 + 20 * 60 },
        }),
      );
      yield* runtime.emit(
        codexRateLimitsNotification({
          id: "evt-sparse-rate-limits",
          rateLimitReachedType: "rate_limit_reached",
        }),
      );
      yield* runtime.emit(codexUsageLimitTurnFailed("evt-early-turn"));

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const completed = events.find((event) => event.type === "turn.completed");
      NodeAssert.equal(
        completed?.payload.errorMessage,
        "Codex usage limit reached. The session limit resets in 3h 20m. Send the message again once the limit resets.",
      );
    }),
  );

  it.effect("falls back to the short message without a rate-limit snapshot", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startUsageLimitRuntime();
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* runtime.emit(
        codexErrorNotification({
          id: "evt-bare-error",
          message: CODEX_OUT_OF_CREDITS,
          codexErrorInfo: "usageLimitExceeded",
        }),
      );
      yield* runtime.emit(codexUsageLimitTurnFailed("evt-bare-turn"));

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const expected = "Codex usage limit reached. Send the message again once the limit resets.";
      NodeAssert.deepStrictEqual(
        events.map((event) => event.type),
        ["runtime.error", "turn.completed"],
      );
      const runtimeError = events.find((event) => event.type === "runtime.error");
      NodeAssert.equal(runtimeError?.payload.message, expected);
      const completed = events.find((event) => event.type === "turn.completed");
      NodeAssert.equal(completed?.payload.errorMessage, expected);
    }),
  );

  it.effect("still relays other provider errors as they arrive", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startUsageLimitRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit(
        codexErrorNotification({
          id: "evt-other-error",
          message: "Codex is temporarily unavailable.",
          codexErrorInfo: "internalServerError",
        }),
      );

      const first = yield* Fiber.join(firstEventFiber);
      NodeAssert.equal(first._tag, "Some");
      if (first._tag !== "Some" || first.value.type !== "runtime.error") return;
      NodeAssert.equal(first.value.payload.message, "Codex is temporarily unavailable.");
      NodeAssert.equal(first.value.payload.class, "provider_error");
    }),
  );
});

it.effect("managed runtime rotation restarts app-server and resumes the same native thread", () => {
  const runtimes: FakeCodexRuntime[] = [];
  let revision = "first";
  const layer = Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      return yield* makeCodexAdapter(decodeCodexSettings({}), {
        resolveRuntime: Effect.sync(() => ({
          config: decodeCodexSettings({
            binaryPath: "/t3/tools/codex/0.155.1/bin/codex",
            homePath: "/t3/caches/codex/home",
            launchArgs: "-c 'model_provider=managed'",
          }),
          environment: { ACCESS_TOKEN: `dummy-${revision}` },
          revision,
        })),
        makeRuntime: (options) => {
          const runtime = new FakeCodexRuntime(options);
          runtime.startImpl.mockImplementation(() =>
            Promise.resolve({
              provider: ProviderDriverKind.make("codex"),
              threadId: options.threadId,
              runtimeMode: options.runtimeMode,
              cwd: options.cwd,
              status: "ready" as const,
              sessionGeneration: "generation-current",
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              resumeCursor: { threadId: "native-managed-thread" },
            }),
          );
          runtimes.push(runtime);
          return Effect.succeed(runtime);
        },
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    const threadId = asThreadId("managed-token-rotation");
    yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "first" });
    NodeAssert.equal(runtimes.length, 1);
    revision = "rotated";
    yield* adapter.sendTurn({ threadId, input: "second" });
    NodeAssert.equal(runtimes.length, 2);
    NodeAssert.equal(runtimes[0]?.closeImpl.mock.calls.length, 1);
    NodeAssert.deepEqual(runtimes[1]?.options.resumeCursor, { threadId: "native-managed-thread" });
    NodeAssert.equal(runtimes[1]?.options.environment?.ACCESS_TOKEN, "dummy-rotated");
    NodeAssert.equal(runtimes[1]?.options.binaryPath, "/t3/tools/codex/0.155.1/bin/codex");
  }).pipe(Effect.provide(layer));
});

it.effect("managed turn failures preserve the sharing-limit code for client notices", () => {
  const factory = makeRuntimeFactory();
  const layer = Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      return yield* makeCodexAdapter(decodeCodexSettings({}), {
        makeRuntime: factory.factory,
        resolveRuntime: Effect.succeed({
          config: decodeCodexSettings({}),
          environment: {},
          revision: "managed",
        }),
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    yield* adapter.startSession({ threadId: asThreadId("thread-1"), runtimeMode: "full-access" });
    const eventsFiber = yield* adapter.streamEvents.pipe(
      Stream.take(2),
      Stream.runCollect,
      Effect.forkChild,
    );
    const notification = codexUsageLimitTurnFailed("managed-sharing-limit");
    yield* factory.lastRuntime!.emit({
      ...notification,
      payload: {
        threadId: "thread-1",
        turn: {
          id: "turn-limit",
          items: [],
          status: "failed",
          error: { message: "subscription_sharing_usage_limit_exceeded", codexErrorInfo: "other" },
        },
      },
    });
    const events = Array.from(yield* Fiber.join(eventsFiber));
    NodeAssert.equal(events[0]?.type, "runtime.error");
    if (events[0]?.type === "runtime.error") {
      NodeAssert.equal(events[0].payload.code, "subscription_sharing_usage_limit_exceeded");
      NodeAssert.match(events[0].payload.message, /ChatGPT usage limit/);
    }
    NodeAssert.equal(events[1]?.type, "turn.completed");
    if (events[1]?.type === "turn.completed") NodeAssert.equal(events[1].payload.state, "failed");
  }).pipe(Effect.provide(layer));
});
