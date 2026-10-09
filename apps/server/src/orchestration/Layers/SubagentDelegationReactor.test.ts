import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  SUBAGENT_REPORTED_ACTIVITY_KIND,
  SUBAGENT_STARTED_ACTIVITY_KIND,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandDispatcher } from "../CommandDispatcher.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { SubagentDelegationReactor } from "../Services/SubagentDelegationReactor.ts";
import { buildSubagentHandoffText, make, subagentReport } from "./SubagentDelegationReactor.ts";

const NOW = "2026-09-28T00:00:00.000Z";
const LATER = "2026-09-28T00:05:00.000Z";

const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
  turnId: string | null = null,
): OrchestrationThread["messages"][number] => ({
  id: MessageId.make(id),
  role,
  text,
  turnId: turnId === null ? null : TurnId.make(turnId),
  streaming: false,
  createdAt: NOW,
  updatedAt: NOW,
});

const thread = (input: Partial<OrchestrationThread>): OrchestrationThread => ({
  id: ThreadId.make("thread"),
  projectId: ProjectId.make("project"),
  title: "Review plan",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  pullRequests: [],
  session: null,
  ...input,
});

describe("buildSubagentHandoffText", () => {
  it("hands over the recent parent conversation and the task, not the task twice", () => {
    const text = buildSubagentHandoffText({
      parent: thread({
        messages: [
          message("m1", "user", "Review the plan"),
          message("m2", "assistant", "Two blockers: A and B"),
          message("m3", "user", "Now implement the fix"),
        ],
      }),
      delegatedMessageId: MessageId.make("m3"),
      task: "Now implement the fix",
    });
    expect(text).toContain('from the thread "Review plan" (on gpt-6-astra)');
    expect(text).toContain("--- assistant ---\nTwo blockers: A and B");
    expect(text.match(/Now implement the fix/g)).toHaveLength(1);
    expect(text.endsWith("Task:\nNow implement the fix")).toBe(true);
  });

  it("bounds the handed-over history", () => {
    const text = buildSubagentHandoffText({
      parent: thread({
        messages: Array.from({ length: 20 }, (_, index) =>
          message(`m${index}`, "user", `${index}:${"x".repeat(5_000)}`),
        ),
      }),
      delegatedMessageId: MessageId.make("task"),
      task: "go",
    });
    expect(text).not.toContain("--- user ---\n11:");
    expect(text).toContain("--- user ---\n12:");
    expect(text.length).toBeLessThan(8 * 1_600 + 1_000);
  });
});

describe("subagentReport", () => {
  it("waits while the delegated turn runs", () => {
    const child = thread({
      latestTurn: {
        turnId: TurnId.make("t1"),
        state: "running",
        requestedAt: LATER,
        startedAt: LATER,
        completedAt: null,
        assistantMessageId: null,
      },
    });
    expect(subagentReport(child, LATER)).toBeUndefined();
  });

  it("ignores a turn that finished before the delegation", () => {
    const child = thread({
      latestTurn: {
        turnId: TurnId.make("t0"),
        state: "completed",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
        assistantMessageId: null,
      },
    });
    expect(subagentReport(child, LATER)).toBeUndefined();
  });

  it("reports the last assistant reply of the delegated turn", () => {
    const child = thread({
      latestTurn: {
        turnId: TurnId.make("t1"),
        state: "completed",
        requestedAt: LATER,
        startedAt: LATER,
        completedAt: LATER,
        assistantMessageId: null,
      },
      messages: [
        message("a0", "assistant", "old turn", "t0"),
        message("a1", "assistant", "working on it", "t1"),
        message("a2", "assistant", "Done: fixed A and B", "t1"),
      ],
    });
    expect(subagentReport(child, LATER)).toEqual({
      turnId: "t1",
      state: "completed",
      text: "Done: fixed A and B",
    });
  });
});

const PARENT_ID = ThreadId.make("parent");
const CHILD_ID = ThreadId.make("child");
const opus = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };

const eventBase = (id: string, threadId: ThreadId) => ({
  sequence: 0,
  eventId: EventId.make(id),
  commandId: CommandId.make(`cmd-${id}`),
  aggregateKind: "thread" as const,
  aggregateId: threadId,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  occurredAt: NOW,
});

const subagentStarted: OrchestrationEvent = {
  ...eventBase("started", PARENT_ID),
  type: "thread.activity-appended",
  payload: {
    threadId: PARENT_ID,
    activity: {
      id: EventId.make("activity-started"),
      tone: "info",
      kind: SUBAGENT_STARTED_ACTIVITY_KIND,
      summary: "Routed to a claude-opus-5-5 subagent",
      payload: {
        childThreadId: CHILD_ID,
        reuseChild: false,
        messageId: "task",
        modelSelection: opus,
        efficiencyDecision: {
          tier: "quality",
          modelSelection: opus,
          source: "tier-policy",
          workload: "interactive",
          contextThresholdPercent: 90,
          toolWarningThreshold: 24,
        },
        interactionMode: "default",
      },
      turnId: null,
      createdAt: NOW,
    },
  },
};

const childSettled = (id: string): OrchestrationEvent => ({
  ...eventBase(id, CHILD_ID),
  type: "thread.session-set",
  payload: {
    threadId: CHILD_ID,
    session: {
      threadId: CHILD_ID,
      status: "ready",
      providerName: "claudeAgent",
      providerInstanceId: opus.instanceId,
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: LATER,
    },
  },
});

const parentThread = thread({
  id: PARENT_ID,
  messages: [message("task", "user", "Implement the fix")],
});
// The child's delegated turn finished after the delegation was recorded (the
// reactor stamps `since` from the test clock, which starts at the epoch).
const childThread = thread({
  id: CHILD_ID,
  modelSelection: opus,
  latestTurn: {
    turnId: TurnId.make("t1"),
    state: "completed",
    requestedAt: LATER,
    startedAt: LATER,
    completedAt: LATER,
    assistantMessageId: null,
  },
  messages: [message("reply", "assistant", "Done: fixed it", "t1")],
});

/**
 * Runs the real reactor against in-memory services. Parent activity appends
 * of a subagent report fail while `failuresLeft` is positive, and every
 * attempt is counted, so a test can script a transient or lasting outage.
 */
const makeHarness = Effect.gen(function* () {
  const events = yield* Queue.unbounded<OrchestrationEvent>();
  const state = { failuresLeft: 0, reportAttempts: 0 };
  const reports: Array<Extract<OrchestrationCommand, { type: "thread.activity.append" }>> = [];
  const layer = Layer.effect(SubagentDelegationReactor, make).pipe(
    Layer.provide(NodeServices.layer),
    Layer.provide(
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) =>
          Effect.suspend(() => {
            if (
              command.type !== "thread.activity.append" ||
              command.activity.kind !== SUBAGENT_REPORTED_ACTIVITY_KIND
            ) {
              return Effect.succeed({ sequence: 0 });
            }
            state.reportAttempts += 1;
            if (state.failuresLeft > 0) {
              state.failuresLeft -= 1;
              return Effect.fail(
                new PersistenceSqlError({ operation: "append", detail: "database is locked" }),
              );
            }
            reports.push(command);
            return Effect.succeed({ sequence: reports.length });
          }),
        streamDomainEvents: Stream.fromQueue(events),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadDetailById: (threadId) =>
          Effect.succeed(
            threadId === PARENT_ID
              ? Option.some(parentThread)
              : threadId === CHILD_ID
                ? Option.some(childThread)
                : Option.none(),
          ),
        getThreadShellById: () => Effect.succeed(Option.none()),
      }),
    ),
    Layer.provide(
      Layer.mock(OrchestrationCommandDispatcher)({
        dispatchNormalized: () => Effect.succeed({ sequence: 0 }),
      }),
    ),
  );
  return { events, state, reports, layer };
});

type Harness = Effect.Success<typeof makeHarness>;

/** Offers `event`, then drains the reactor while stepping the test clock past
 * every report retry backoff. */
const deliver = (harness: Harness, event: OrchestrationEvent) =>
  Effect.gen(function* () {
    const reactor = yield* SubagentDelegationReactor;
    yield* Queue.offer(harness.events, event);
    const drained = yield* Effect.forkChild(reactor.drain);
    for (let step = 0; step < 10; step += 1) {
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
    }
    yield* Fiber.join(drained);
  });

it.layer(NodeServices.layer)("subagent report delivery", (it) => {
  it.effect("retries a transient failure posting the report and posts it once", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reactor = yield* SubagentDelegationReactor;
          yield* reactor.start();
          yield* deliver(harness, subagentStarted);
          harness.state.failuresLeft = 2;
          yield* deliver(harness, childSettled("settled-1"));
          // A later child event must not post the same report again.
          yield* deliver(harness, childSettled("settled-2"));
        }).pipe(Effect.provide(harness.layer)),
      );
      expect(harness.state.reportAttempts).toBe(3);
      expect(harness.reports).toHaveLength(1);
      expect(harness.reports[0]?.threadId).toBe(PARENT_ID);
      expect(harness.reports[0]?.activity.payload).toMatchObject({
        childThreadId: CHILD_ID,
        detail: "Done: fixed it",
      });
    }),
  );

  it.effect("keeps the report pending when every attempt fails, so a later event posts it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reactor = yield* SubagentDelegationReactor;
          yield* reactor.start();
          yield* deliver(harness, subagentStarted);
          harness.state.failuresLeft = Number.POSITIVE_INFINITY;
          yield* deliver(harness, childSettled("settled-1"));
          // Bounded: the first attempt plus three retries, then it gives up.
          expect(harness.state.reportAttempts).toBe(4);
          expect(harness.reports).toHaveLength(0);

          harness.state.failuresLeft = 0;
          yield* deliver(harness, childSettled("settled-2"));
        }).pipe(Effect.provide(harness.layer)),
      );
      expect(harness.state.reportAttempts).toBe(5);
      expect(harness.reports).toHaveLength(1);
      expect(harness.reports[0]?.activity.payload).toMatchObject({ detail: "Done: fixed it" });
    }),
  );
});
