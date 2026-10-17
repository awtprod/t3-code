/**
 * The sidebar's working plan-step line: the current step of a thread's active
 * todo list and its completed count (n/m), read from the orchestration V2 plan
 * projection. Served to clients through `cc.threads.planProgress.subscribe`,
 * so the V2 thread shell stays upstream's.
 *
 * @module ThreadPlanProgress
 */
import {
  type CommandCenterThreadPlanProgress,
  type CommandCenterThreadPlanProgressUpdate,
  CommandCenterError,
  type OrchestrationV2DomainEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

const PlanSteps = Schema.Struct({
  steps: Schema.Array(
    Schema.Struct({
      text: Schema.String,
      status: Schema.Literals(["pending", "running", "completed"]),
    }),
  ),
});
const decodePlanSteps = Schema.decodeUnknownOption(Schema.fromJsonString(PlanSteps));

/** Longest step text sent to the sidebar. */
const STEP_TEXT_MAX_CHARS = 200;

/**
 * The step a working thread is on: the running one, else the first pending
 * one, else the last (every step done). Undefined for an empty list.
 */
export const planProgressFromSteps = (
  steps: ReadonlyArray<{ readonly text: string; readonly status: string }>,
): CommandCenterThreadPlanProgress | undefined => {
  if (steps.length === 0) return undefined;
  const current =
    steps.find((step) => step.status === "running") ??
    steps.find((step) => step.status === "pending") ??
    steps[steps.length - 1]!;
  return {
    step: current.text.slice(0, STEP_TEXT_MAX_CHARS),
    completedSteps: steps.filter((step) => step.status === "completed").length,
    totalSteps: steps.length,
  };
};

const sameProgress = (
  left: CommandCenterThreadPlanProgress | null,
  right: CommandCenterThreadPlanProgress | null,
): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.step === right.step &&
    left.completedSteps === right.completedSteps &&
    left.totalSteps === right.totalSteps);

/**
 * Plan progress for each thread: its active todo list on the newest run that
 * has one. Threads without an active todo list map to `null`.
 */
export const readThreadPlanProgress = (threadIds: ReadonlyArray<ThreadId>) =>
  Effect.gen(function* () {
    const result = new Map<ThreadId, CommandCenterThreadPlanProgress | null>(
      threadIds.map((threadId) => [threadId, null]),
    );
    if (threadIds.length === 0) return result;
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly threadId: string; readonly payloadJson: string }>`
      SELECT plan.thread_id AS "threadId", plan.payload_json AS "payloadJson"
      FROM orchestration_v2_projection_plans plan
      LEFT JOIN orchestration_v2_projection_runs run ON run.run_id = plan.run_id
      WHERE ${sql.in("plan.thread_id", threadIds)}
        AND plan.kind = 'todo_list'
        AND plan.status = 'active'
      ORDER BY plan.thread_id, COALESCE(run.ordinal, 0) DESC, plan.rowid DESC
    `;
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.threadId)) continue;
      seen.add(row.threadId);
      const steps = Option.getOrUndefined(decodePlanSteps(row.payloadJson))?.steps ?? [];
      result.set(row.threadId as ThreadId, planProgressFromSteps(steps) ?? null);
    }
    return result;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new CommandCenterError({
          reason: "persistence",
          message: "Thread plan progress could not be read.",
          cause,
        }),
    ),
  );

/**
 * The current progress of each requested thread, then an update whenever a
 * plan or run of one of them changes the value. Bounded by the input's
 * thread count; other threads' events are ignored.
 */
export const streamThreadPlanProgress = <E>(input: {
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly events: Stream.Stream<OrchestrationV2DomainEvent, E>;
}): Stream.Stream<CommandCenterThreadPlanProgressUpdate, CommandCenterError, SqlClient.SqlClient> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const tracked = new Set<string>(input.threadIds);
      const last = yield* readThreadPlanProgress([...tracked] as Array<ThreadId>);
      const initial = [...last].map(([threadId, progress]) => ({ threadId, progress }));
      const updates = input.events.pipe(
        Stream.filter(
          (event) =>
            (event.type === "plan.updated" || event.type === "run.updated") &&
            tracked.has(event.threadId),
        ),
        Stream.mapError(
          (cause) =>
            new CommandCenterError({
              reason: "persistence",
              message: "Thread events are unavailable.",
              cause,
            }),
        ),
        Stream.mapEffect((event) =>
          readThreadPlanProgress([event.threadId]).pipe(
            Effect.map((read) => {
              const progress = read.get(event.threadId) ?? null;
              if (sameProgress(last.get(event.threadId) ?? null, progress)) return [];
              last.set(event.threadId, progress);
              return [{ threadId: event.threadId, progress }];
            }),
          ),
        ),
        Stream.flatMap((items) => Stream.fromIterable(items)),
      );
      return Stream.concat(Stream.fromIterable(initial), updates);
    }),
  );
