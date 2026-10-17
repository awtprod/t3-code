import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { type OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import {
  planProgressFromSteps,
  readThreadPlanProgress,
  streamThreadPlanProgress,
} from "./ThreadPlanProgress.ts";

const testLayer = SqlitePersistenceMemory.pipe(Layer.provideMerge(NodeServices.layer));

const step = (text: string, status: "pending" | "running" | "completed") => ({
  id: text,
  text,
  status,
});

const insertRun = (sql: SqlClient.SqlClient, threadId: string, runId: string, ordinal: number) =>
  sql`
    INSERT INTO orchestration_v2_projection_runs (
      run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at,
      completed_at, payload_json
    ) VALUES (${runId}, ${threadId}, ${ordinal}, 'codex', NULL, 'running',
      '2026-06-20T00:00:00.000Z', NULL, '{}')
  `;

const upsertPlan = (
  sql: SqlClient.SqlClient,
  input: {
    readonly planId: string;
    readonly threadId: string;
    readonly runId: string;
    readonly kind?: "todo_list" | "proposed_plan";
    readonly status?: "draft" | "active" | "completed" | "superseded";
    readonly steps: ReadonlyArray<ReturnType<typeof step>>;
  },
) =>
  sql`
    INSERT INTO orchestration_v2_projection_plans (
      plan_id, thread_id, run_id, node_id, kind, status, payload_json
    ) VALUES (
      ${input.planId}, ${input.threadId}, ${input.runId}, 'node-1', ${input.kind ?? "todo_list"},
      ${input.status ?? "active"},
      ${JSON.stringify({
        id: input.planId,
        kind: input.kind ?? "todo_list",
        status: input.status ?? "active",
        steps: input.steps,
      })}
    )
    ON CONFLICT(plan_id) DO UPDATE SET
      status = excluded.status, payload_json = excluded.payload_json
  `;

const planUpdated = (threadId: string): OrchestrationV2DomainEvent =>
  ({
    type: "plan.updated",
    threadId: ThreadId.make(threadId),
  }) as unknown as OrchestrationV2DomainEvent;

it("names the running step, else the next pending one, else the last", () => {
  expect(
    planProgressFromSteps([
      step("Read the code", "completed"),
      step("Write the fix", "running"),
      step("Run the tests", "pending"),
    ]),
  ).toEqual({ step: "Write the fix", completedSteps: 1, totalSteps: 3 });
  expect(
    planProgressFromSteps([step("Read the code", "completed"), step("Write the fix", "pending")]),
  ).toEqual({ step: "Write the fix", completedSteps: 1, totalSteps: 2 });
  expect(
    planProgressFromSteps([step("Read the code", "completed"), step("Ship it", "completed")]),
  ).toEqual({ step: "Ship it", completedSteps: 2, totalSteps: 2 });
  expect(planProgressFromSteps([])).toBeUndefined();
});

it.effect("reads the active todo list of each thread's newest run", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* insertRun(sql, "thread-a", "run-a1", 1);
    yield* insertRun(sql, "thread-a", "run-a2", 2);
    yield* upsertPlan(sql, {
      planId: "plan-a1",
      threadId: "thread-a",
      runId: "run-a1",
      steps: [step("Old step", "running")],
    });
    yield* upsertPlan(sql, {
      planId: "plan-a2",
      threadId: "thread-a",
      runId: "run-a2",
      steps: [step("Plan", "completed"), step("Build", "running")],
    });
    // Proposed plans and finished lists are not progress.
    yield* insertRun(sql, "thread-b", "run-b1", 1);
    yield* upsertPlan(sql, {
      planId: "plan-b1",
      threadId: "thread-b",
      runId: "run-b1",
      kind: "proposed_plan",
      steps: [step("Proposal", "pending")],
    });
    yield* upsertPlan(sql, {
      planId: "plan-b2",
      threadId: "thread-b",
      runId: "run-b1",
      status: "completed",
      steps: [step("Done", "completed")],
    });

    const progress = yield* readThreadPlanProgress([
      ThreadId.make("thread-a"),
      ThreadId.make("thread-b"),
      ThreadId.make("thread-none"),
    ]);
    expect(Object.fromEntries(progress)).toEqual({
      "thread-a": { step: "Build", completedSteps: 1, totalSteps: 2 },
      "thread-b": null,
      "thread-none": null,
    });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("emits the current progress, then only changes of the followed threads", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* insertRun(sql, "thread-a", "run-a1", 1);
    yield* upsertPlan(sql, {
      planId: "plan-a1",
      threadId: "thread-a",
      runId: "run-a1",
      steps: [step("Plan", "running"), step("Build", "pending")],
    });
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const updates = yield* Queue.unbounded<unknown>();
    yield* Stream.runForEach(
      streamThreadPlanProgress({
        threadIds: [ThreadId.make("thread-a")],
        events: Stream.fromQueue(events),
      }),
      (update) => Queue.offer(updates, update),
    ).pipe(Effect.forkScoped);

    expect(yield* Queue.take(updates)).toEqual({
      threadId: "thread-a",
      progress: { step: "Plan", completedSteps: 0, totalSteps: 2 },
    });

    // An event that does not change the value, and one for an unfollowed thread, emit nothing.
    yield* Queue.offer(events, planUpdated("thread-a"));
    yield* Queue.offer(events, planUpdated("thread-other"));
    yield* upsertPlan(sql, {
      planId: "plan-a1",
      threadId: "thread-a",
      runId: "run-a1",
      steps: [step("Plan", "completed"), step("Build", "running")],
    });
    yield* Queue.offer(events, planUpdated("thread-a"));
    expect(yield* Queue.take(updates)).toEqual({
      threadId: "thread-a",
      progress: { step: "Build", completedSteps: 1, totalSteps: 2 },
    });

    yield* upsertPlan(sql, {
      planId: "plan-a1",
      threadId: "thread-a",
      runId: "run-a1",
      status: "completed",
      steps: [step("Plan", "completed"), step("Build", "completed")],
    });
    yield* Queue.offer(events, planUpdated("thread-a"));
    expect(yield* Queue.take(updates)).toEqual({ threadId: "thread-a", progress: null });
    expect(yield* Queue.size(updates)).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
