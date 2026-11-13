import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  type MessageId,
  ProjectId,
  ProviderInstanceId,
  type ScheduledTaskError,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const threadId = ThreadId.make("thread:outcome");
const taskId = ScheduledTaskId.make("task:outcome");

const makeLayer = (
  sent: Ref.Ref<ReadonlyArray<MessageId>>,
  events: Queue.Queue<unknown>,
  followedFrom: Ref.Ref<number | undefined>,
) =>
  ScheduledTaskService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          sendToThread: (input) =>
            Ref.update(sent, (ids) => [...ids, input.messageId]).pipe(Effect.as({} as never)),
          streamStoredEventsFrom: (input) =>
            Stream.unwrap(
              Ref.set(followedFrom, input?.afterSequence).pipe(
                Effect.as(Stream.fromQueue(events) as never),
              ),
            ),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        NodeCrypto.layer,
        Scheduler.layer,
      ),
    ),
  );

const withService = <A, E>(
  body: (input: {
    readonly service: ScheduledTaskService.ScheduledTaskService["Service"];
    readonly dispatch: () => Effect.Effect<MessageId, ScheduledTaskError>;
    readonly events: Queue.Queue<unknown>;
    readonly followedFrom: Ref.Ref<number | undefined>;
  }) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-02T09:00:00.000Z"));
    const sent = yield* Ref.make<ReadonlyArray<MessageId>>([]);
    const events = yield* Queue.unbounded<unknown>();
    const followedFrom = yield* Ref.make<number | undefined>(undefined);
    return yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* service.upsert({
        id: taskId,
        title: "Weekly report",
        prompt: "Write the weekly report",
        // Paused so the scheduler never fires it; runNow still dispatches.
        enabled: false,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        threadId,
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const dispatch = () =>
        Effect.gen(function* () {
          // Distinct start times give each dispatch its own message id.
          yield* TestClock.adjust("1 second");
          const result = yield* service.runNow({ id: taskId });
          assert.equal(result.task.lastRunStatus, "succeeded");
          assert.isNull(result.task.lastRunOutcome);
          const ids = yield* Ref.get(sent);
          return ids[ids.length - 1]!;
        });
      return yield* body({ service, dispatch, events, followedFrom });
    }).pipe(Effect.provide(makeLayer(sent, events, followedFrom)));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory));

const currentTask = (service: ScheduledTaskService.ScheduledTaskService["Service"]) =>
  service.list().pipe(Effect.map(({ tasks }) => tasks.find((task) => task.id === taskId)!));

const insertErrorItem = (runId: string, failure: object) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert({
      turn_item_id: `item:${runId}`,
      thread_id: threadId,
      run_id: runId,
      ordinal: 1,
      type: "error",
      status: "failed",
      updated_at: "2026-11-02T09:00:05.000Z",
      payload_json: JSON.stringify({ type: "error", failure }),
    })}`;
  });

const insertRun = (run: {
  readonly id: string;
  readonly threadId?: string;
  readonly ordinal: number;
  readonly status: string;
  readonly userMessageId: string;
  readonly restartContinuationOfRunId?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
      run_id: run.id,
      thread_id: run.threadId ?? threadId,
      ordinal: run.ordinal,
      provider: "codex",
      status: run.status,
      requested_at: "2026-11-02T09:00:01.000Z",
      completed_at: `2026-11-02T09:00:0${run.ordinal + 1}.000Z`,
      payload_json: JSON.stringify({
        userMessageId: run.userMessageId,
        startedAt: "2026-11-02T09:00:01.000Z",
        ...(run.restartContinuationOfRunId === undefined
          ? {}
          : { restartContinuationOfRunId: run.restartContinuationOfRunId }),
      }),
    })}`;
  });

const started = "2026-11-02T09:00:01.000Z";

it.effect.each([
  { status: "completed", outcome: "completed", error: null },
  { status: "failed", outcome: "failed", error: "usage_limit (api_error_429)" },
  { status: "interrupted", outcome: "interrupted", error: null },
  { status: "cancelled", outcome: "interrupted", error: null },
  { status: "rolled_back", outcome: "interrupted", error: null },
] as const)("records a $status run as $outcome", ({ status, outcome, error }) =>
  withService(({ service, dispatch }) =>
    Effect.gen(function* () {
      const messageId = yield* dispatch();
      yield* insertErrorItem("run:1", {
        class: "usage_limit",
        message: "Usage limit reached",
        code: "api_error_429",
        retryable: false,
      });
      const run = { id: "run:1", threadId, userMessageId: messageId, startedAt: started };
      yield* service.recordRunOutcome({ ...run, status: "running" });
      assert.isNull((yield* currentTask(service)).lastRunOutcome);

      yield* service.recordRunOutcome({ ...run, status });
      // A repeated or later terminal event keeps the first outcome.
      yield* service.recordRunOutcome({ ...run, status });
      yield* service.recordRunOutcome({ ...run, status: "rolled_back" });
      const task = yield* currentTask(service);
      assert.equal(task.lastRunStatus, "succeeded");
      assert.equal(task.lastRunOutcome, outcome);
      assert.equal(task.lastRunOutcomeError, error);
    }),
  ),
);

it.effect("only the latest dispatch sets the outcome, and a new dispatch clears it", () =>
  withService(({ service, dispatch }) =>
    Effect.gen(function* () {
      const first = yield* dispatch();
      yield* service.recordRunOutcome({
        id: "run:1",
        threadId,
        userMessageId: first,
        status: "completed",
      });
      assert.equal((yield* currentTask(service)).lastRunOutcome, "completed");

      const second = yield* dispatch();
      assert.notEqual(second, first);
      assert.isNull((yield* currentTask(service)).lastRunOutcome);

      // The first dispatch's run and an unrelated turn in the bound thread end late.
      yield* service.recordRunOutcome({
        id: "run:1",
        threadId,
        userMessageId: first,
        status: "failed",
      });
      yield* service.recordRunOutcome({
        id: "run:2",
        threadId,
        userMessageId: "message:typed-by-user",
        status: "completed",
      });
      assert.isNull((yield* currentTask(service)).lastRunOutcome);

      yield* service.recordRunOutcome({
        id: "run:3",
        threadId,
        userMessageId: second,
        status: "failed",
      });
      const task = yield* currentTask(service);
      assert.equal(task.lastRunOutcome, "failed");
      assert.equal(task.lastRunOutcomeError, "The run failed.");
    }),
  ),
);

it.effect("catches up on a run that ended before it followed, then follows new runs", () =>
  withService(({ service, dispatch, events, followedFrom }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const messageId = yield* dispatch();
      yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
        run_id: "run:1",
        thread_id: threadId,
        ordinal: 1,
        provider: "codex",
        status: "failed",
        requested_at: "2026-11-02T09:00:01.000Z",
        completed_at: "2026-11-02T09:00:05.000Z",
        payload_json: JSON.stringify({ userMessageId: messageId }),
      })}`;
      yield* insertErrorItem("run:1", {
        class: "provider_error",
        message: "Model overloaded",
        code: null,
        retryable: true,
      });

      yield* sql`INSERT INTO orchestration_v2_events ${sql.insert({
        event_id: "event:1",
        thread_id: threadId,
        event_type: "run.updated",
        occurred_at: "2026-11-02T09:00:05.000Z",
        payload_json: "{}",
      })}`;
      // Waits on the change notification, so the outcome write must publish one.
      const awaitTask = (outcome: string) =>
        service.subscribeList().pipe(
          Stream.map(({ tasks }) => tasks.find((task) => task.id === taskId)),
          Stream.filter((task) => task?.lastRunOutcome === outcome),
          Stream.runHead,
          Effect.map((task) => (task._tag === "Some" ? task.value : undefined)),
        );

      yield* service.followRunOutcomes();
      const caughtUp = yield* awaitTask("failed");
      // Provider text can carry local paths, so only the structured class is kept.
      assert.equal(caughtUp?.lastRunOutcomeError, "provider_error");

      const next = yield* dispatch();
      yield* Queue.offer(events, {
        sequence: 2,
        event: {
          type: "run.updated",
          payload: { id: "run:2", threadId, userMessageId: next, status: "completed" },
        },
      });
      const followed = yield* awaitTask("completed");
      assert.isNull(followed?.lastRunOutcomeError);
      // The stream resumes after the head read before catch-up, so nothing in between is lost.
      assert.equal(yield* Ref.get(followedFrom), 1);
    }).pipe(Effect.scoped),
  ),
);

it.effect("a queued run cancelled before it started sets no outcome", () =>
  withService(({ service, dispatch }) =>
    Effect.gen(function* () {
      const messageId = yield* dispatch();
      // Promoting the queued message to a steer cancels its own run; the prompt runs elsewhere.
      yield* service.recordRunOutcome({
        id: "run:1",
        threadId,
        userMessageId: messageId,
        status: "cancelled",
        startedAt: null,
      });
      assert.isNull((yield* currentTask(service)).lastRunOutcome);
    }),
  ),
);

it.effect.each([
  { status: "completed", outcome: "completed", error: null, later: "failed" },
  { status: "failed", outcome: "failed", error: "The run failed.", later: "completed" },
] as const)("a restart continuation that ends $status replaces the interruption", (row) =>
  withService(({ service, dispatch }) =>
    Effect.gen(function* () {
      const messageId = yield* dispatch();
      yield* insertRun({ id: "run:1", ordinal: 1, status: "cancelled", userMessageId: messageId });
      yield* insertRun({
        id: "run:2",
        ordinal: 2,
        status: "cancelled",
        userMessageId: "message:restart-continuation:run:1",
        restartContinuationOfRunId: "run:1",
      });
      yield* service.recordRunOutcome({
        id: "run:1",
        threadId,
        userMessageId: messageId,
        status: "cancelled",
        startedAt: started,
      });
      assert.equal((yield* currentTask(service)).lastRunOutcome, "interrupted");

      // A second restart: the chain is run:3 -> run:2 -> run:1.
      const continuation = (id: string, status: string) => ({
        id,
        threadId,
        userMessageId: "message:restart-continuation:run:2",
        status,
        startedAt: started,
        restartContinuationOfRunId: "run:2",
      });
      yield* service.recordRunOutcome(continuation("run:3", row.status));
      let task = yield* currentTask(service);
      assert.equal(task.lastRunOutcome, row.outcome);
      assert.equal(task.lastRunOutcomeError, row.error);

      // A finished outcome is never overwritten.
      yield* service.recordRunOutcome(continuation("run:4", row.later));
      assert.equal((yield* currentTask(service)).lastRunOutcome, row.outcome);

      // A continuation of an older dispatch's run does not touch the newer dispatch.
      yield* dispatch();
      yield* service.recordRunOutcome(continuation("run:5", "completed"));
      task = yield* currentTask(service);
      assert.isNull(task.lastRunOutcome);
    }),
  ),
);

it.effect.each([
  { name: "a run in another thread", runThread: "thread:other", clearThread: false },
  { name: "a task without a stored thread", runThread: threadId, clearThread: true },
] as const)("catch-up ignores $name", ({ runThread, clearThread }) =>
  withService(({ service, dispatch, events }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const messageId = yield* dispatch();
      const [stored] = yield* sql<{ readonly last_run_thread_id: string | null }>`
        SELECT last_run_thread_id FROM scheduled_tasks WHERE task_id = ${taskId}`;
      assert.equal(stored?.last_run_thread_id, threadId);
      if (clearThread) {
        yield* sql`UPDATE scheduled_tasks SET last_run_thread_id = NULL WHERE task_id = ${taskId}`;
      }
      yield* insertRun({
        id: "run:1",
        threadId: runThread,
        ordinal: 1,
        status: "failed",
        userMessageId: messageId,
      });

      yield* service.followRunOutcomes();
      // Catch-up finishes before the stream is read and the first outcome wins, so "completed"
      // proves the catch-up did not record the failed run.
      yield* Queue.offer(events, {
        sequence: 1,
        event: {
          type: "run.updated",
          payload: { id: "run:2", threadId, userMessageId: messageId, status: "completed" },
        },
      });
      const task = yield* service.subscribeList().pipe(
        Stream.map(({ tasks }) => tasks.find((candidate) => candidate.id === taskId)),
        Stream.filter((candidate) => candidate?.lastRunOutcome != null),
        Stream.runHead,
      );
      assert.equal(task._tag === "Some" ? task.value?.lastRunOutcome : undefined, "completed");
    }).pipe(Effect.scoped),
  ),
);
