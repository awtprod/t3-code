import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe } from "vite-plus/test";
import {
  DEFAULT_MODEL,
  ProviderDriverKind,
  type ProviderSession,
  ThreadId,
} from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";

import {
  buildCodexDeveloperInstructions,
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import {
  buildCommandCenterIsolationProbeScript,
  buildThreadStartParams,
  buildTurnStartParams,
  hasConfiguredMcpServer,
  isRecoverableThreadResumeError,
  makeCodexSessionRuntime,
  matchesCodexInterruptTarget,
  openCodexThread,
  verifyCommandCenterCodexIsolation,
} from "./CodexSessionRuntime.ts";

const makeFakeChildHandle = (input: {
  readonly pid: number;
  readonly exitCode: Effect.Effect<ChildProcessSpawner.ExitCode>;
  readonly stdin?: Sink.Sink<void, Uint8Array>;
  readonly stdout?: Stream.Stream<Uint8Array>;
}) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(input.pid),
    exitCode: input.exitCode,
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: input.stdin ?? Sink.drain,
    stdout: input.stdout ?? Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

describe("matchesCodexInterruptTarget", () => {
  const session: ProviderSession = {
    provider: ProviderDriverKind.make("codex"),
    status: "running",
    runtimeMode: "full-access",
    sessionGeneration: "generation-current",
    threadId: ThreadId.make("thread-interrupt-target"),
    resumeCursor: { threadId: "provider-thread-current" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("rejects a mismatched native cursor", () => {
    NodeAssert.equal(
      matchesCodexInterruptTarget(session, {
        sessionGeneration: "generation-current",
        resumeCursor: { threadId: "provider-thread-other" },
      }),
      false,
    );
  });

  it("accepts the same native cursor across runtime generations", () => {
    NodeAssert.equal(
      matchesCodexInterruptTarget(session, {
        sessionGeneration: "generation-historical",
        resumeCursor: { threadId: "provider-thread-current" },
      }),
      true,
    );
  });

  it("requires generation equality when the target has no cursor", () => {
    NodeAssert.equal(
      matchesCodexInterruptTarget(session, {
        sessionGeneration: "generation-current",
      }),
      true,
    );
    NodeAssert.equal(
      matchesCodexInterruptTarget(session, {
        sessionGeneration: "generation-other",
      }),
      false,
    );
  });
});

describe("CodexSessionRuntime terminal lifecycle", () => {
  it.effect(
    "emits exactly one terminal event when a process exit races a later graceful close",
    () =>
      Effect.gen(function* () {
        // The child process exits first (claiming the terminal `session/exited`),
        // then a graceful close() runs afterwards. Regression guard for the
        // double-terminal-emit race: without the atomic terminal claim, close()
        // would emit a second `session/closed` that — arriving after a
        // replacement turn started — marks the healthy resumed session stopped.
        const exitGate = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const spawner = ChildProcessSpawner.make(() =>
          Effect.succeed(makeFakeChildHandle({ pid: 4242, exitCode: Deferred.await(exitGate) })),
        );

        // Dedicated scope so close()'s Scope.close tears down the runtime's own
        // scope, not the ambient test scope.
        const runtimeScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(runtimeScope, Exit.void));
        const runtime = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make("thread-exit-race"),
          binaryPath: "/usr/bin/codex",
          cwd: "/tmp/exit-race",
          runtimeMode: "approval-required",
        }).pipe(
          Effect.provideService(Scope.Scope, runtimeScope),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );

        const methodsRef = yield* Ref.make<ReadonlyArray<string>>([]);
        const exitedSeen = yield* Deferred.make<void>();
        const collector = yield* Effect.forkScoped(
          Stream.runForEach(runtime.events, (event) =>
            event.kind === "session"
              ? Ref.update(methodsRef, (methods) => [...methods, event.method]).pipe(
                  Effect.andThen(
                    event.method === "session/exited"
                      ? Deferred.succeed(exitedSeen, undefined).pipe(Effect.asVoid)
                      : Effect.void,
                  ),
                )
              : Effect.void,
          ),
        );

        // Process exits cleanly -> settleProcessExit claims the terminal emit.
        yield* Deferred.succeed(exitGate, ChildProcessSpawner.ExitCode(0));
        yield* Deferred.await(exitedSeen);

        // Graceful close must NOT emit a second terminal event. It ends the
        // events queue with Queue.end (Cause.Done) after the exit already
        // claimed the terminal, so the collector drains any remaining buffered
        // events and then completes gracefully; Fiber.await returns the
        // successful Exit and methodsRef holds every recorded event.
        yield* runtime.close;
        yield* Fiber.await(collector);

        const methods = yield* Ref.get(methodsRef);
        const terminals = methods.filter(
          (method) => method === "session/exited" || method === "session/closed",
        );
        NodeAssert.deepEqual(terminals, ["session/exited"]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("releases terminal delivery when process-exit emission fails", () =>
    Effect.gen(function* () {
      const exitGate = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(makeFakeChildHandle({ pid: 4299, exitCode: Deferred.await(exitGate) })),
      );
      const crypto = yield* Crypto.Crypto;
      const uuidCalls = yield* Ref.make(0);
      const exitEmitAttempted = yield* Deferred.make<void>();
      const uuidError = PlatformError.systemError({
        _tag: "Unknown",
        module: "Crypto",
        method: "randomUUIDv4",
        description: "terminal event identifier unavailable",
      });
      const failingCrypto = {
        ...crypto,
        randomUUIDv4: Ref.getAndUpdate(uuidCalls, (calls) => calls + 1).pipe(
          Effect.flatMap((call) =>
            call === 1
              ? Deferred.succeed(exitEmitAttempted, undefined).pipe(
                  Effect.andThen(Effect.fail(uuidError)),
                )
              : crypto.randomUUIDv4,
          ),
        ),
      } satisfies typeof crypto;

      const runtimeScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(runtimeScope, Exit.void));
      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-exit-emit-failure"),
        binaryPath: "/usr/bin/codex",
        cwd: "/tmp/exit-emit-failure",
        runtimeMode: "approval-required",
      }).pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Crypto.Crypto, failingCrypto),
      );

      const methodsRef = yield* Ref.make<ReadonlyArray<string>>([]);
      const collector = yield* Effect.forkScoped(
        Stream.runForEach(runtime.events, (event) =>
          event.kind === "session"
            ? Ref.update(methodsRef, (methods) => [...methods, event.method])
            : Effect.void,
        ),
      );

      // The process-exit path reaches terminal emission, but UUID generation
      // fails before the event can be offered. close() must still be allowed to
      // deliver session/closed rather than trusting the failed claimant's flag.
      yield* Deferred.succeed(exitGate, ChildProcessSpawner.ExitCode(1));
      yield* Deferred.await(exitEmitAttempted);
      yield* runtime.close;
      yield* Fiber.await(collector);

      const methods = yield* Ref.get(methodsRef);
      const terminals = methods.filter(
        (method) => method === "session/exited" || method === "session/closed",
      );
      NodeAssert.deepEqual(terminals, ["session/closed"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("emits a single terminal event when only a graceful close occurs", () =>
    Effect.gen(function* () {
      // Control: with no process exit, close() is the sole terminal emitter and
      // must still produce exactly one `session/closed`.
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(makeFakeChildHandle({ pid: 4343, exitCode: Effect.never })),
      );
      const runtimeScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(runtimeScope, Exit.void));
      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-close-only"),
        binaryPath: "/usr/bin/codex",
        cwd: "/tmp/close-only",
        runtimeMode: "approval-required",
      }).pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const methodsRef = yield* Ref.make<ReadonlyArray<string>>([]);
      // The collector records session-lifecycle methods and self-terminates once
      // it consumes a terminal event (takeUntil is inclusive, so the terminal is
      // recorded before the stream ends).
      const isTerminal = (method: string) =>
        method === "session/closed" || method === "session/exited";
      const collector = yield* Effect.forkScoped(
        Stream.runForEach(
          runtime.events.pipe(
            Stream.takeUntil((event) => event.kind === "session" && isTerminal(event.method)),
          ),
          (event) =>
            event.kind === "session"
              ? Ref.update(methodsRef, (methods) => [...methods, event.method])
              : Effect.void,
        ),
      );

      // close() emits session/closed and then ends the events queue with
      // Queue.end (Cause.Done). Because end drains buffered items before
      // signalling Done — rather than discarding them like Queue.shutdown — the
      // collector deterministically receives the just-emitted terminal even
      // though it is joined only afterwards.
      yield* runtime.close;
      yield* Fiber.join(collector);

      const methods = yield* Ref.get(methodsRef);
      const terminals = methods.filter((method) => isTerminal(method));
      NodeAssert.deepEqual(terminals, ["session/closed"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

describe("CodexSessionRuntimeIdentifierGenerationError", () => {
  it("retains identifier purpose and the random source failure", () => {
    const cause = new Error("random source unavailable");
    const error = new CodexErrors.CodexAppServerIdentifierGenerationError({
      purpose: "provider-event",
      cause,
    });

    NodeAssert.equal(error.purpose, "provider-event");
    NodeAssert.strictEqual(error.cause, cause);
    NodeAssert.equal(
      error.message,
      "Failed to generate Codex App Server identifier for provider-event.",
    );
  });
});

function makeThreadOpenResponse(
  threadId: string,
  permissionProfile?: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    ...(permissionProfile
      ? { activePermissionProfile: { id: permissionProfile, extends: null } }
      : {}),
    thread: {
      cliVersion: "0.144.6",
      createdAt: 1_766_000_000,
      cwd: "/tmp/project",
      ephemeral: false,
      id: threadId,
      modelProvider: "openai",
      preview: "",
      sessionId: "session-1",
      source: "appServer",
      turns: [],
      status: { type: "idle" },
      updatedAt: 1_766_000_000,
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

describe("CodexSessionRuntime sendTurn target provenance", () => {
  it.effect("uses the runtime generation and exact turn/start provider thread", () =>
    Effect.gen(function* () {
      const providerThreadId = "provider-thread-from-thread-start";
      const canonicalThreadId = ThreadId.make("thread-runtime-target-provenance");
      const inbound = yield* Queue.unbounded<Uint8Array>();
      const turnStartThreadIds: Array<string> = [];
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const encodeJsonString = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);
      const decodeJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
      const respond = (id: string | number, result: unknown) =>
        Effect.gen(function* () {
          const encoded = yield* encodeJsonString({ id, result });
          yield* Queue.offer(inbound, encoder.encode(`${encoded}\n`));
        }).pipe(Effect.orDie);
      const wireHandle = makeFakeChildHandle({
        pid: 4444,
        exitCode: Effect.never,
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.gen(function* () {
            const message = (yield* decodeJsonString(decoder.decode(chunk))) as {
              readonly id?: string | number;
              readonly method?: string;
              readonly params?: Record<string, unknown>;
            };
            if (message.id === undefined) {
              return;
            }
            switch (message.method) {
              case "initialize":
                yield* respond(message.id, {
                  userAgent: "codex-runtime-target-test",
                  codexHome: "/tmp/codex-runtime-target-test",
                  platformFamily: "unix",
                  platformOs: "linux",
                });
                return;
              case "thread/start":
                yield* respond(message.id, makeThreadOpenResponse(providerThreadId));
                return;
              case "turn/start":
                turnStartThreadIds.push(String(message.params?.threadId));
                yield* respond(message.id, {
                  turn: {
                    id: "provider-turn-1",
                    items: [],
                    status: "inProgress",
                  },
                });
                return;
              default:
                throw new Error(`Unexpected Codex request: ${String(message.method)}`);
            }
          }).pipe(Effect.orDie),
        ),
        stdout: Stream.fromQueue(inbound),
      });
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(wireHandle));
      const runtimeScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(runtimeScope, Exit.void));
      const runtime = yield* makeCodexSessionRuntime({
        threadId: canonicalThreadId,
        binaryPath: "/usr/bin/codex",
        cwd: "/tmp/codex-runtime-target-test",
        runtimeMode: "full-access",
      }).pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const session = yield* runtime.start();
      const started = yield* runtime.sendTurn({ input: "prove target provenance" });

      NodeAssert.deepStrictEqual(turnStartThreadIds, [providerThreadId]);
      NodeAssert.equal(started.threadId, canonicalThreadId);
      NodeAssert.equal(started.turnId, "provider-turn-1");
      NodeAssert.deepStrictEqual(started.resumeCursor, { threadId: providerThreadId });
      NodeAssert.deepStrictEqual(started.target, {
        sessionGeneration: session.sessionGeneration,
        resumeCursor: { threadId: providerThreadId },
      });
      NodeAssert.equal(started.target?.sessionGeneration, session.sessionGeneration);
      NodeAssert.deepStrictEqual(started.target?.resumeCursor, started.resumeCursor);

      yield* runtime.close;
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("buildTurnStartParams", () => {
  it("keeps invalid turn values only in the schema cause", () => {
    const secret = "codex-turn-input-secret-sentinel";
    const error = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        attachments: [
          {
            type: "image",
            url: { secret } as unknown as string,
          },
        ],
      }).pipe(Effect.flip),
    );
    const { cause, ...directDiagnostics } = error;

    NodeAssert.equal(error.operation, "decode-request-payload");
    NodeAssert.equal(error.method, "turn/start");
    NodeAssert.ok((error.issueCount ?? 0) > 0);
    NodeAssert.ok(error.issueKinds?.includes("Pointer"));
    NodeAssert.ok((error.maximumPathDepth ?? 0) > 0);
    NodeAssert.ok(Schema.isSchemaError(cause));
    NodeAssert.doesNotMatch(error.message, new RegExp(secret));
    NodeAssert.doesNotMatch(JSON.stringify(directDiagnostics), new RegExp(secret));
  });

  it("includes plan collaboration mode when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
      input: [
        {
          type: "text",
          text: "Make a plan",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("plan", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("includes default collaboration mode and image attachments", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("default", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("reports the same fallback model and effort in settings and instructions", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Go",
        interactionMode: "default",
      }),
    );

    const settings = params.collaborationMode?.settings;
    NodeAssert.equal(settings?.model, DEFAULT_MODEL);
    NodeAssert.equal(settings?.reasoning_effort, "medium");
    NodeAssert.ok(settings?.developer_instructions?.includes(`as ${DEFAULT_MODEL} with medium`));
  });

  it("omits collaboration mode when interaction mode is absent", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "untrusted",
      sandboxPolicy: {
        type: "readOnly",
      },
      input: [
        {
          type: "text",
          text: "Review",
        },
      ],
    });
  });

  it.effect("selects a non-escalatable permission profile without a legacy sandbox policy", () =>
    Effect.gen(function* () {
      const permissionProfile = "command-center-isolated-write-v1";
      const thread = buildThreadStartParams({
        cwd: "/runtime/project",
        runtimeMode: "auto-accept-edits",
        model: undefined,
        serviceTier: undefined,
        permissionProfile,
      });
      const turn = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        permissionProfile,
      });

      NodeAssert.deepStrictEqual(thread, {
        cwd: "/runtime/project",
        approvalPolicy: "never",
        permissions: permissionProfile,
      });
      NodeAssert.equal("sandbox" in thread, false);
      NodeAssert.equal(turn.approvalPolicy, "never");
      NodeAssert.equal(turn.permissions, permissionProfile);
      NodeAssert.equal("sandboxPolicy" in turn, false);
    }),
  );
});

describe("buildCodexDeveloperInstructions", () => {
  it("appends runtime info after the mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });

    NodeAssert.ok(instructions.startsWith(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS));
    NodeAssert.match(instructions, /Command Center/);
    NodeAssert.match(instructions, /Codex harness/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with high reasoning effort/);
  });

  it("includes runtime info alongside plan mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("plan", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });

    NodeAssert.ok(instructions.startsWith(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS));
    NodeAssert.match(instructions, /as gpt-5\.3-codex with medium reasoning effort/);
  });

  it("varies with the model and effort of each turn", () => {
    const first = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });
    const second = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.4",
      reasoningEffort: "high",
    });

    NodeAssert.notEqual(first, second);
  });

  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("T3 browser developer instructions", () => {
  it("prefers the product-native preview tools in both collaboration modes", () => {
    for (const instructions of [
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
    ]) {
      NodeAssert.match(instructions, /t3-code/);
      NodeAssert.match(instructions, /preview_status/);
      NodeAssert.match(instructions, /preview_open/);
      NodeAssert.match(instructions, /Do not switch to global browser skills/);
    }
  });
});

describe("hasConfiguredMcpServer", () => {
  it("detects inline Codex MCP configuration arguments", () => {
    NodeAssert.equal(hasConfiguredMcpServer(undefined), false);
    NodeAssert.equal(hasConfiguredMcpServer(["--model", "gpt-5.4"]), false);
    NodeAssert.equal(
      hasConfiguredMcpServer(["-c", 'mcp_servers.t3-code.url="http://127.0.0.1/mcp"']),
      true,
    );
  });
});

describe("verifyCommandCenterCodexIsolation", () => {
  it.effect("executes a fail-closed app-server probe before a Command Center turn", () =>
    Effect.gen(function* () {
      const calls: Array<{
        method: string;
        payload: CodexRpc.ClientRequestParamsByMethod["command/exec"];
      }> = [];
      yield* verifyCommandCenterCodexIsolation({
        client: {
          request: (method, payload) => {
            calls.push({ method, payload });
            return Effect.succeed({
              exitCode: 0,
              stdout: "command-center-isolation-ok\n",
              stderr: "",
            });
          },
        },
        cwd: "/runtime/worktree",
        permissionProfile: "command-center-isolated-write-v1",
      });

      NodeAssert.equal(calls.length, 1);
      NodeAssert.equal(calls[0]?.method, "command/exec");
      NodeAssert.equal(calls[0]?.payload.cwd, "/runtime/worktree");
      const command = calls[0]?.payload.command;
      NodeAssert.deepStrictEqual(command?.slice(0, 2), ["/usr/bin/bash", "-c"]);
      const script = command?.[2] ?? "";
      NodeAssert.match(script, /\/proc\/\[0-9\]\*\/environ/u);
      NodeAssert.match(script, /T3_MCP_BEARER_TOKEN/u);
      NodeAssert.match(script, /test ! -r "\$HOME\/auth\.json"/u);
      NodeAssert.match(script, /test ! -r "\/proc\/1\/root\$HOME\/auth\.json"/u);
      NodeAssert.match(script, /: > "\$probe_path"/u);
      NodeAssert.match(script, /git status --porcelain=v1/u);
    }),
  );

  it.effect("rejects a failed or forged app-server probe result", () =>
    Effect.gen(function* () {
      const error = yield* verifyCommandCenterCodexIsolation({
        client: {
          request: () =>
            Effect.succeed({
              exitCode: 70,
              stdout: "",
              stderr: "",
            }),
        },
        cwd: "/runtime/worktree",
        permissionProfile: "command-center-isolated-read-v1",
      }).pipe(Effect.flip);

      NodeAssert.equal(error._tag, "CodexSessionRuntimeIsolationProbeError");
      NodeAssert.equal(error.exitCode, 70);
      NodeAssert.match(error.message, /live filesystem, process, or environment isolation/u);
      NodeAssert.doesNotMatch(error.message, /T3_MCP_BEARER_TOKEN/u);
    }),
  );

  it.effect("accepts only an actual sandbox-denied write for the read profile", () =>
    verifyCommandCenterCodexIsolation({
      client: {
        request: () =>
          Effect.succeed({
            exitCode: 73,
            stdout: "command-center-isolation-read-denial-ready\n",
            stderr: "",
          }),
      },
      cwd: "/runtime/worktree",
      permissionProfile: "command-center-isolated-read-v1",
    }),
  );

  it.effect("rejects the read profile when its workspace write succeeds", () =>
    Effect.gen(function* () {
      const error = yield* verifyCommandCenterCodexIsolation({
        client: {
          request: () =>
            Effect.succeed({
              exitCode: 74,
              stdout: "",
              stderr: "",
            }),
        },
        cwd: "/runtime/worktree",
        permissionProfile: "command-center-isolated-read-v1",
      }).pipe(Effect.flip);

      NodeAssert.equal(error._tag, "CodexSessionRuntimeIsolationProbeError");
      NodeAssert.equal(error.exitCode, 74);
    }),
  );

  it("makes the read probe's final operation an actual write that must be denied", () => {
    const script = buildCommandCenterIsolationProbeScript(false);
    NodeAssert.match(script, /command-center-isolation-read-denial-ready/u);
    NodeAssert.match(script, /: > "\$probe_path"/u);
    NodeAssert.ok(
      script.indexOf("git status --porcelain=v1") < script.indexOf(': > "$probe_path"'),
    );
    NodeAssert.ok(
      script.indexOf(': > "$probe_path"') <
        script.indexOf("command-center-isolation-read-denial-ready"),
    );
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches missing thread errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});

describe("openCodexThread", () => {
  it.effect("falls back to thread/start when resume fails recoverably", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
      const started = makeThreadOpenResponse("fresh-thread");
      const client = {
        request: (method: "thread/start" | "thread/resume", payload: unknown) => {
          calls.push({ method, payload });
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "thread not found",
              }),
            );
          }
          return Effect.succeed(started);
        },
      };

      const opened = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      });

      NodeAssert.equal(opened.thread.id, "fresh-thread");
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["thread/resume", "thread/start"],
      );
    }),
  );

  it.effect("propagates non-recoverable resume failures", () =>
    Effect.gen(function* () {
      const client = {
        request: (method: "thread/start" | "thread/resume", _payload: unknown) => {
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "timed out waiting for server",
              }),
            );
          }
          return Effect.succeed(makeThreadOpenResponse("fresh-thread"));
        },
      };

      const error = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      }).pipe(Effect.flip);

      NodeAssert.ok(isCodexAppServerRequestError(error));
      NodeAssert.equal(error.errorMessage, "timed out waiting for server");
    }),
  );

  it.effect("sends the permission profile on both resume and fallback start", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
      const client = {
        request: (method: "thread/start" | "thread/resume", payload: unknown) => {
          calls.push({ method, payload });
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "thread not found",
              }),
            );
          }
          return Effect.succeed(
            makeThreadOpenResponse("fresh-thread", "command-center-isolated-read-v1"),
          );
        },
      };

      yield* openCodexThread({
        client,
        threadId: ThreadId.make("cc:thread-1"),
        runtimeMode: "approval-required",
        cwd: "/runtime/project",
        requestedModel: undefined,
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
        permissionProfile: "command-center-isolated-read-v1",
      });

      for (const call of calls) {
        const payload = call.payload as Record<string, unknown>;
        NodeAssert.equal(payload.permissions, "command-center-isolated-read-v1");
        NodeAssert.equal("sandbox" in payload, false);
        NodeAssert.equal("sandboxPolicy" in payload, false);
      }
    }),
  );

  it.effect(
    "admits the thread when Codex enforces isolation but omits the active-profile echo (Codex 0.144.x)",
    () =>
      // Codex 0.144.x does not populate `activePermissionProfile` on thread/start
      // even when the requested profile is active. Isolation is proven empirically
      // by verifyCommandCenterCodexIsolation() (a live command/exec probe) before a
      // thread is ever opened, so a null/absent echo must NOT block the session.
      Effect.gen(function* () {
        const opened = yield* openCodexThread({
          client: {
            request: () => Effect.succeed(makeThreadOpenResponse("fresh-thread")),
          },
          threadId: ThreadId.make("cc:thread-1"),
          runtimeMode: "approval-required",
          cwd: "/runtime/project",
          requestedModel: undefined,
          serviceTier: undefined,
          resumeThreadId: undefined,
          permissionProfile: "command-center-isolated-read-v1",
        });

        NodeAssert.equal(opened.thread.id, "fresh-thread");
      }),
  );

  it.effect("fails closed when Codex activates a different permission profile than requested", () =>
    Effect.gen(function* () {
      const error = yield* openCodexThread({
        client: {
          request: () =>
            Effect.succeed(
              makeThreadOpenResponse("fresh-thread", "command-center-isolated-write-v1"),
            ),
        },
        threadId: ThreadId.make("cc:thread-1"),
        runtimeMode: "approval-required",
        cwd: "/runtime/project",
        requestedModel: undefined,
        serviceTier: undefined,
        resumeThreadId: undefined,
        permissionProfile: "command-center-isolated-read-v1",
      }).pipe(Effect.flip);

      NodeAssert.equal(error._tag, "CodexSessionRuntimePermissionProfileMismatchError");
      NodeAssert.match(error.message, /instead of required profile/u);
    }),
  );
});
