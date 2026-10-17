import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

// A client `orchestration.dispatchCommand` may choose its own thread id. A `cc:`
// id that never went through the Command Center bridge must still be refused
// at session open by the registry's admission gate, before the adapter runs.
const refusesClientChosenCommandCenterThread = (input: {
  readonly driver: string;
  readonly runtimeMode: "full-access" | "approval-required";
  readonly threadId: string;
  readonly expectOpened?: boolean;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("cc-admission");
      const driver = ProviderDriverKind.make(input.driver);
      const instanceId = ProviderInstanceId.make(input.driver);
      const opened: Array<string> = [];
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (session) =>
          Effect.sync(() => {
            opened.push(String(session.threadId));
          }).pipe(Effect.andThen(Effect.die("the admission gate must refuse before this"))),
      };
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make(input.threadId);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${input.threadId}`),
          threadId,
          projectId: ProjectId.make("project:cc-admission"),
          title: "Client-chosen Command Center id",
          modelSelection: { instanceId, model: "test-model" },
          runtimeMode: input.runtimeMode,
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`send:${input.threadId}`),
          threadId,
          messageId: MessageId.make(`message:${input.threadId}`),
          text: "Run unattended",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const projection = yield* orchestrator.getThreadProjection(threadId);
        // The control case proves the adapter is reachable on this path at all.
        assert.deepEqual(opened, input.expectOpened === true ? [input.threadId] : []);
        assert.notEqual(projection.runs.at(-1)?.status, "running");
        assert.lengthOf(projection.providerTurns, 0);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: `cc-admission-${input.driver}` },
            ProviderAdapterRegistry.layerSingle(adapter),
            { runEffectWorker: false },
          ),
        ),
      );
    }),
  );

it.effect("refuses a client-chosen cc: thread id on a non-Codex provider", () =>
  refusesClientChosenCommandCenterThread({
    driver: "claudeAgent",
    runtimeMode: "approval-required",
    threadId: "cc:interactive:acme-client",
  }),
);

it.effect("refuses a client-chosen cc: thread id on Codex in full-access mode", () =>
  refusesClientChosenCommandCenterThread({
    driver: "codex",
    runtimeMode: "full-access",
    threadId: "cc:automation:acme-client",
  }),
);

it.effect("still opens an ordinary client thread on the same path", () =>
  refusesClientChosenCommandCenterThread({
    driver: "codex",
    runtimeMode: "full-access",
    threadId: "thread:acme-client",
    expectOpened: true,
  }),
);

// Isolation is chosen at session open from the thread that opens the session.
// Codex can host many provider threads per session, so the Orchestrator would
// otherwise hand every thread of an instance one shared session: a cc: thread
// would then run in whatever launch opened it first (seen live: a Space agent
// thread opened the shared, unisolated session and a later cc: Run joined it).
const providerSessionOpenedFor = (threadId: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("cc-session");
      const instanceId = ProviderInstanceId.make("codex");
      const opened: Array<{ threadId: string; providerSessionId: string }> = [];
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (session) =>
          Effect.sync(() => {
            opened.push({
              threadId: String(session.threadId),
              providerSessionId: String(session.providerSessionId),
            });
          }).pipe(Effect.andThen(Effect.die("only the session id is under test"))),
      };
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const id = ThreadId.make(threadId);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${threadId}`),
          threadId: id,
          projectId: ProjectId.make("project:cc-session"),
          title: "Session ownership",
          modelSelection: { instanceId, model: "test-model" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`send:${threadId}`),
          threadId: id,
          messageId: MessageId.make(`message:${threadId}`),
          text: "Hello",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: `cc-session-${threadId.replaceAll(":", "-")}` },
            ProviderAdapterRegistry.layerSingle(adapter),
            { runEffectWorker: false },
          ),
        ),
      );
      return opened;
    }),
  );

it.effect("opens a dedicated provider session for a cc: thread, never the shared one", () =>
  Effect.gen(function* () {
    const ordinary = yield* providerSessionOpenedFor("thread:acme-ordinary");
    const commandCenter = yield* providerSessionOpenedFor("cc:interactive:acme-session");
    assert.isAbove(ordinary.length, 0);
    assert.isAbove(commandCenter.length, 0);
    assert.strictEqual(
      ordinary[0]?.providerSessionId,
      "provider-session:provider-instance:codex:shared",
    );
    for (const open of commandCenter) {
      assert.strictEqual(open.threadId, "cc:interactive:acme-session");
      assert.notInclude(open.providerSessionId, ":shared");
    }
  }),
);
