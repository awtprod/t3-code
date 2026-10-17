import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EfficiencyCandidateId,
  EventId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import type { OrchestratorV2DispatchResult } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { intakeClientCommand } from "../ws.ts";
import {
  ClientTurnRouter,
  ClientTurnRoutingReadsService,
  DELEGATION_BOUNDS,
  buildDelegationHandoffText,
  dispatchClientCommand,
  launchClientThread,
  layer as routerLayer,
  type RoutingThreadSnapshot,
} from "./ClientTurnRouting.ts";
import * as Judge from "./Judge.ts";
import { ThreadRoutingService, layer as threadRoutingLayer } from "./ThreadRouting.ts";

const claudeInstance = ProviderInstanceId.make("claudeAgent");
const codexInstance = ProviderInstanceId.make("codex");
const opus = { instanceId: claudeInstance, model: "claude-opus-5-5" };
const fable = { instanceId: claudeInstance, model: "claude-fable-5-1" };
const astra = { instanceId: codexInstance, model: "gpt-6-astra" };

const provider = (instanceId: ProviderInstanceId, driver: string, models: ReadonlyArray<string>) =>
  ({
    instanceId,
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-17T00:00:00.000Z",
    models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
  }) satisfies ServerProvider;

const providers = [
  provider(claudeInstance, "claudeAgent", ["claude-opus-5-5", "claude-fable-5-1"]),
  provider(codexInstance, "codex", ["gpt-6-astra"]),
];

/** Economy routes to Opus on Claude, quality to Astra on Codex (a driver change). */
const efficiencyOn = {
  efficiency: {
    enabled: true,
    candidates: [
      {
        candidateId: EfficiencyCandidateId.make("acme-economy-opus"),
        tier: "economy" as const,
        instanceId: claudeInstance,
        model: "claude-opus-5-5",
        enabled: true,
      },
      {
        candidateId: EfficiencyCandidateId.make("acme-quality-astra"),
        tier: "quality" as const,
        instanceId: codexInstance,
        model: "gpt-6-astra",
        enabled: true,
      },
    ],
  },
};

const now = DateTime.makeUnsafe("2026-10-17T00:00:00.000Z");

const appThread = (
  id: ThreadId,
  over: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread => ({
  id,
  projectId: ProjectId.make("project:acme"),
  title: "Acme thread",
  providerInstanceId: claudeInstance,
  modelSelection: fable,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  ...over,
});

const completedRun = (threadId: ThreadId, ordinal: number): OrchestrationV2Run => ({
  id: RunId.make(`run:${threadId}:${ordinal}`),
  threadId,
  ordinal,
  providerInstanceId: claudeInstance,
  modelSelection: fable,
  providerThreadId: null,
  userMessageId: MessageId.make(`message:${threadId}:${ordinal}`),
  rootNodeId: null,
  activeAttemptId: null,
  status: "completed",
  requestedAt: now,
  startedAt: now,
  completedAt: now,
  checkpointId: null,
  contextHandoffId: null,
});

const parentId = ThreadId.make("thread:acme-parent");
/** A parent bound to Claude with one finished run, so it can be forked. */
const boundParent: RoutingThreadSnapshot = {
  thread: appThread(parentId, {
    activeProviderThreadId:
      "provider-thread:acme" as OrchestrationV2AppThread["activeProviderThreadId"],
  }),
  runs: [completedRun(parentId, 1)],
};

const messageDispatch = (
  over: Partial<Extract<OrchestrationV2Command, { type: "message.dispatch" }>> = {},
): Extract<OrchestrationV2Command, { type: "message.dispatch" }> => ({
  type: "message.dispatch",
  commandId: CommandId.make("command:acme-turn"),
  createdBy: "user",
  creationSource: "web",
  threadId: parentId,
  messageId: MessageId.make("message:acme-turn"),
  text: "review the acme change",
  attachments: [],
  modelSelection: fable,
  dispatchMode: { type: "start_immediately" },
  ...over,
});

/** What intake would store: one run per dispatched message. */
const storedResult = (
  command: OrchestrationV2Command,
  runId = RunId.make(`run:for:${command.commandId}`),
): OrchestratorV2DispatchResult => ({
  sequence: 7,
  storedEvents:
    command.type === "message.dispatch"
      ? [
          {
            sequence: 7,
            event: {
              id: EventId.make(`event:${runId}`),
              type: "run.updated",
              threadId: command.threadId,
              runId,
              occurredAt: now,
              payload: {
                ...completedRun(command.threadId, 9),
                id: runId,
                userMessageId: command.messageId,
                status: "starting",
              },
            },
          } as unknown as OrchestrationV2StoredEvent,
        ]
      : [],
});

const makeLayer = (input: {
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly threads: ReadonlyMap<ThreadId, RoutingThreadSnapshot>;
  readonly conversation?: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly text: string;
  }>;
}) => {
  const sql = Layer.effectDiscard(runMigrations()).pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  );
  const routing = threadRoutingLayer.pipe(Layer.provideMerge(sql));
  return routerLayer.pipe(
    Layer.provideMerge(routing),
    Layer.provide(
      Layer.succeed(
        ClientTurnRoutingReadsService,
        ClientTurnRoutingReadsService.of({
          thread: (threadId) => Effect.succeed(input.threads.get(threadId)),
          messageText: () => Effect.succeed(undefined),
          recentConversation: () => Effect.succeed(input.conversation ?? []),
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(ProviderRegistry, {
        getProviders: Effect.succeed(providers),
      } as unknown as ProviderRegistry["Service"]),
    ),
    Layer.provide(Judge.layerTest),
    Layer.provide(ServerSettings.layerTest(input.settings ?? {})),
    Layer.provide(NodeServices.layer),
  );
};

/** Runs `dispatchClientCommand` with an intake stub that records what reached it. */
const dispatchThroughRouter = (command: OrchestrationV2Command) =>
  Effect.gen(function* () {
    const router = yield* ClientTurnRouter;
    const reached: Array<OrchestrationV2Command> = [];
    const result = yield* dispatchClientCommand(router, command, (dispatched) =>
      Effect.sync(() => {
        reached.push(dispatched);
        return storedResult(dispatched);
      }),
    );
    return { reached, result };
  });

const setRouting = (
  threadId: ThreadId,
  routingMode: "manual" | "auto",
  efficiencyTier: "economy" | "balanced" | "quality" | null,
  retryOfTurnId?: TurnId,
) =>
  Effect.flatMap(ThreadRoutingService, (routing) =>
    routing.set({
      threadId,
      routingMode,
      efficiencyTier,
      ...(retryOfTurnId === undefined ? {} : { retryOfTurnId }),
    }),
  );

const threads = (...snapshots: ReadonlyArray<RoutingThreadSnapshot>) =>
  new Map(snapshots.map((snapshot) => [snapshot.thread.id, snapshot] as const));

describe("efficiency off (the default) or manual: a pure pass-through", () => {
  it.effect("hands intake the very same command object and records nothing when off", () =>
    Effect.gen(function* () {
      yield* setRouting(parentId, "auto", "quality");
      const command = messageDispatch();
      const { reached } = yield* dispatchThroughRouter(command);
      assert.strictEqual(reached.length, 1);
      assert.strictEqual(reached[0], command);
      const state = yield* Effect.flatMap(ThreadRoutingService, (routing) => routing.get(parentId));
      assert.isNull(state.latestDecision);
      assert.deepStrictEqual(state.delegations, []);
    }).pipe(Effect.provide(makeLayer({ threads: threads(boundParent) }))),
  );

  it.effect("passes launches through unchanged when off", () =>
    Effect.gen(function* () {
      const router = yield* ClientTurnRouter;
      yield* setRouting(parentId, "auto", "economy");
      const input = {
        commandId: CommandId.make("command:acme-launch"),
        threadId: parentId,
        projectId: ProjectId.make("project:acme"),
        title: "Acme",
        modelSelection: fable,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        workspaceStrategy: { type: "root" as const },
        initialMessage: {
          messageId: MessageId.make("message:acme-launch"),
          text: "hi",
          attachments: [],
        },
        createdBy: "user" as const,
        creationSource: "web" as const,
      };
      let reached: unknown;
      yield* launchClientThread(router, input, (launched) =>
        Effect.sync(() => {
          reached = launched;
          return { threadId: parentId, projection: { runs: [] } as never, resumed: false };
        }),
      );
      assert.strictEqual(reached, input);
    }).pipe(Effect.provide(makeLayer({ threads: threads() }))),
  );

  it.effect("honours an explicit pick: a manual thread runs the picked model, no decision", () =>
    Effect.gen(function* () {
      // PR #150: the composer flips the thread to manual when the user picks a model.
      yield* setRouting(parentId, "manual", "quality");
      const command = messageDispatch({ modelSelection: fable });
      const { reached } = yield* dispatchThroughRouter(command);
      assert.strictEqual(reached.length, 1);
      assert.strictEqual(reached[0], command);
      const state = yield* Effect.flatMap(ThreadRoutingService, (routing) => routing.get(parentId));
      assert.isNull(state.latestDecision);
      assert.deepStrictEqual(state.delegations, []);
    }).pipe(Effect.provide(makeLayer({ settings: efficiencyOn, threads: threads(boundParent) }))),
  );
});

describe("auto routing on V2 client turns", () => {
  it.effect(
    "a WebSocket-submitted turn on an auto thread is routed and its decision recorded",
    () =>
      Effect.gen(function* () {
        yield* setRouting(parentId, "auto", "economy");
        const router = yield* ClientTurnRouter;
        const reached: Array<OrchestrationV2Command> = [];
        const intake = ThreadManagement.ThreadManagementService.of({
          dispatch: (command: OrchestrationV2Command) =>
            Effect.sync(() => {
              reached.push(command);
              return storedResult(command, RunId.make("run:acme-ws"));
            }),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]);
        // The exact handler body ws.ts runs for `orchestration.dispatchCommand`.
        yield* intakeClientCommand(router, messageDispatch()).pipe(
          Effect.provideService(ThreadManagement.ThreadManagementService, intake),
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "s4-routing-ws-" }).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        );
        assert.strictEqual(reached.length, 1);
        const dispatched = reached[0] as Extract<
          OrchestrationV2Command,
          { type: "message.dispatch" }
        >;
        assert.deepStrictEqual(dispatched.modelSelection, opus);
        const state = yield* Effect.flatMap(ThreadRoutingService, (routing) =>
          routing.get(parentId),
        );
        assert.strictEqual(state.latestDecision?.runId, RunId.make("run:acme-ws"));
        assert.strictEqual(state.latestDecision?.decision.tier, "economy");
        assert.strictEqual(state.latestDecision?.decision.source, "tier-policy");
        assert.deepStrictEqual(state.latestDecision?.decision.modelSelection, opus);
      }).pipe(Effect.provide(makeLayer({ settings: efficiencyOn, threads: threads(boundParent) }))),
  );

  it.effect("leaves steering into an active run unrouted", () =>
    Effect.gen(function* () {
      yield* setRouting(parentId, "auto", "economy");
      const command = messageDispatch();
      const router = yield* ClientTurnRouter;
      const plan = yield* router.planDispatch(command);
      assert.deepStrictEqual(plan, { type: "unrouted", reason: "active-run" });
      const steer = messageDispatch({
        dispatchMode: { type: "steer_active", targetRunId: RunId.make("run:x") },
      });
      assert.deepStrictEqual(yield* router.planDispatch(steer), {
        type: "unrouted",
        reason: "steer-or-deferred",
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          settings: efficiencyOn,
          threads: threads({
            ...boundParent,
            runs: [{ ...completedRun(parentId, 2), status: "running" }],
          }),
        }),
      ),
    ),
  );

  it.effect("consumes a retry-one-tier-higher marker once", () =>
    Effect.gen(function* () {
      yield* setRouting(parentId, "auto", "economy", TurnId.make("run:acme-parent:1"));
      yield* dispatchThroughRouter(messageDispatch());
      const routing = yield* ThreadRoutingService;
      const state = yield* routing.get(parentId);
      assert.strictEqual(state.latestDecision?.decision.retryOfTurnId, "run:acme-parent:1");
      assert.isNull(state.pendingRetryOfTurnId);
    }).pipe(Effect.provide(makeLayer({ settings: efficiencyOn, threads: threads(boundParent) }))),
  );
});

describe("delegation trigger (thread.fork + message.dispatch into a child)", () => {
  it.effect("forks a child for a cross-driver route and runs the turn there", () =>
    Effect.gen(function* () {
      yield* setRouting(parentId, "auto", "quality");
      const { reached } = yield* dispatchThroughRouter(messageDispatch());
      assert.strictEqual(reached.length, 2);
      const fork = reached[0] as Extract<OrchestrationV2Command, { type: "thread.fork" }>;
      const child = reached[1] as Extract<OrchestrationV2Command, { type: "message.dispatch" }>;
      assert.strictEqual(fork.type, "thread.fork");
      assert.strictEqual(fork.sourceThreadId, parentId);
      assert.deepStrictEqual(fork.sourcePoint, { type: "latest_stable" });
      assert.strictEqual(child.type, "message.dispatch");
      assert.strictEqual(child.threadId, fork.targetThreadId);
      assert.deepStrictEqual(child.modelSelection, astra);
      // A fresh fork carries the conversation natively; the task goes as typed.
      assert.strictEqual(child.text, "review the acme change");
      const routing = yield* ThreadRoutingService;
      const parentState = yield* routing.get(parentId);
      assert.strictEqual(parentState.delegations.length, 1);
      assert.strictEqual(parentState.delegations[0]?.childThreadId, fork.targetThreadId);
      assert.isFalse(parentState.delegations[0]?.reusedChild);
      const childState = yield* routing.get(fork.targetThreadId);
      // Tier carry-over: the child is pinned manual at the routed tier and its run
      // carries the parent's decision.
      assert.strictEqual(childState.routingMode, "manual");
      assert.strictEqual(childState.efficiencyTier, "quality");
      assert.strictEqual(childState.latestDecision?.decision.tier, "quality");
      assert.strictEqual(childState.delegatedFrom?.parentThreadId, parentId);
    }).pipe(Effect.provide(makeLayer({ settings: efficiencyOn, threads: threads(boundParent) }))),
  );

  it.effect("reuses an idle child on the same selection with a bounded handoff", () =>
    Effect.gen(function* () {
      const childId = ThreadId.make("thread:acme-child");
      const routing = yield* ThreadRoutingService;
      yield* routing.recordDelegation({
        parentThreadId: parentId,
        childThreadId: childId,
        messageId: MessageId.make("message:earlier"),
        modelSelection: astra,
        reusedChild: false,
        // The test clock starts at the epoch, so the new row ties and sorts by rowid.
        createdAt: "1970-01-01T00:00:00.000Z",
      });
      yield* setRouting(parentId, "auto", "quality");
      const { reached } = yield* dispatchThroughRouter(messageDispatch());
      assert.strictEqual(reached.length, 1);
      const child = reached[0] as Extract<OrchestrationV2Command, { type: "message.dispatch" }>;
      assert.strictEqual(child.threadId, childId);
      assert.include(child.text, "[Routed turn]");
      assert.include(child.text, "Task:\nreview the acme change");
      // 10 parent messages offered, 8 handed off, each cut to 1500 chars.
      assert.strictEqual(child.text.match(/^--- (user|assistant) ---$/gmu)?.length, 8);
      assert.notInclude(child.text, "x".repeat(DELEGATION_BOUNDS.handoffMessageChars + 1));
      const state = yield* routing.get(parentId);
      assert.isTrue(state.delegations[0]?.reusedChild);
    }).pipe(
      Effect.provide(
        makeLayer({
          settings: efficiencyOn,
          threads: threads(boundParent, {
            thread: appThread(ThreadId.make("thread:acme-child"), { modelSelection: astra }),
            runs: [completedRun(ThreadId.make("thread:acme-child"), 1)],
          }),
          conversation: Array.from({ length: 10 }, (_, index) => ({
            role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
            text: `${index}:${"x".repeat(2_000)}`,
          })),
        }),
      ),
    ),
  );

  it.effect("never delegates from a routed child (no recursive forks)", () =>
    Effect.gen(function* () {
      const childId = ThreadId.make("thread:acme-child");
      const routing = yield* ThreadRoutingService;
      yield* routing.recordDelegation({
        parentThreadId: parentId,
        childThreadId: childId,
        messageId: MessageId.make("message:earlier"),
        modelSelection: opus,
        reusedChild: false,
        createdAt: "2026-10-17T00:00:00.000Z",
      });
      // Even if the user switches the child to auto at a cross-driver tier.
      yield* setRouting(childId, "auto", "quality");
      const { reached } = yield* dispatchThroughRouter(messageDispatch({ threadId: childId }));
      assert.strictEqual(reached.length, 1);
      const dispatched = reached[0] as Extract<
        OrchestrationV2Command,
        { type: "message.dispatch" }
      >;
      assert.strictEqual(dispatched.type, "message.dispatch");
      assert.strictEqual(dispatched.threadId, childId);
      assert.deepStrictEqual(dispatched.modelSelection, astra);
      assert.deepStrictEqual((yield* routing.get(childId)).delegations, []);
    }).pipe(
      Effect.provide(
        makeLayer({
          settings: efficiencyOn,
          threads: threads({
            thread: appThread(ThreadId.make("thread:acme-child"), {
              activeProviderThreadId:
                "provider-thread:child" as OrchestrationV2AppThread["activeProviderThreadId"],
            }),
            runs: [completedRun(ThreadId.make("thread:acme-child"), 1)],
          }),
        }),
      ),
    ),
  );

  it.effect("keeps plan acceptances on the parent", () =>
    Effect.gen(function* () {
      yield* setRouting(parentId, "auto", "quality");
      const { reached } = yield* dispatchThroughRouter(
        messageDispatch({
          sourcePlanRef: { threadId: parentId, planId: PlanId.make("plan:acme") },
        }),
      );
      assert.strictEqual(reached.length, 1);
      assert.strictEqual(reached[0]?.type, "message.dispatch");
      assert.strictEqual(
        (reached[0] as Extract<OrchestrationV2Command, { type: "message.dispatch" }>).threadId,
        parentId,
      );
    }).pipe(Effect.provide(makeLayer({ settings: efficiencyOn, threads: threads(boundParent) }))),
  );

  it.effect("never fires when efficiency is off", () =>
    Effect.gen(function* () {
      yield* setRouting(parentId, "auto", "quality");
      const command = messageDispatch();
      const { reached } = yield* dispatchThroughRouter(command);
      assert.deepStrictEqual(reached, [command]);
      assert.strictEqual(reached[0], command);
    }).pipe(Effect.provide(makeLayer({ threads: threads(boundParent) }))),
  );

  it.effect("never fires after an explicit pick (manual thread)", () =>
    Effect.gen(function* () {
      yield* setRouting(parentId, "manual", "quality");
      const command = messageDispatch({ modelSelection: astra });
      const { reached } = yield* dispatchThroughRouter(command);
      assert.deepStrictEqual(reached, [command]);
      assert.deepStrictEqual(
        (yield* Effect.flatMap(ThreadRoutingService, (routing) => routing.get(parentId)))
          .delegations,
        [],
      );
    }).pipe(Effect.provide(makeLayer({ settings: efficiencyOn, threads: threads(boundParent) }))),
  );

  it.effect("runs the turn unrouted on the parent when the fork fails", () =>
    Effect.gen(function* () {
      yield* setRouting(parentId, "auto", "quality");
      const router = yield* ClientTurnRouter;
      const command = messageDispatch();
      const reached: Array<OrchestrationV2Command> = [];
      yield* dispatchClientCommand(router, command, (dispatched) =>
        dispatched.type === "thread.fork"
          ? Effect.fail("fork refused" as const)
          : Effect.sync(() => {
              reached.push(dispatched);
              return storedResult(dispatched);
            }),
      );
      assert.deepStrictEqual(reached, [command]);
      assert.isTrue(
        Option.isNone(
          Option.fromNullishOr(
            (yield* Effect.flatMap(ThreadRoutingService, (routing) => routing.get(parentId)))
              .delegations[0],
          ),
        ),
      );
    }).pipe(Effect.provide(makeLayer({ settings: efficiencyOn, threads: threads(boundParent) }))),
  );
});

describe("buildDelegationHandoffText", () => {
  it("keeps the newest messages and the task", () => {
    const text = buildDelegationHandoffText({
      parentTitle: "Acme",
      parentModel: "claude-fable-5-1",
      conversation: [
        { role: "user", text: "first" },
        { role: "assistant", text: "  " },
        { role: "assistant", text: "second" },
      ],
      task: "do it",
    });
    assert.include(text, "--- user ---\nfirst");
    assert.include(text, "--- assistant ---\nsecond");
    assert.notInclude(text, "--- assistant ---\n  ");
    assert.isTrue(text.endsWith("Task:\ndo it"));
  });
});
