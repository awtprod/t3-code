/**
 * Writes the per-Space activity feed (`SpaceActivity`) from orchestration V2.
 *
 * - A thread row per finished V2 run (`run.updated` reaching a terminal
 *   status) and per settle (`thread.settled`, low signal), for every active
 *   Space whose repository binding matches the thread's project.
 * - A Run row per Command Center Run state change, from the durable Command
 *   Center event log (`RunStateChanged`).
 *
 * Space agent threads are skipped, and a Run's own thread is logged once, as
 * the Run. V2 events are read from the stored event log after the newest
 * recorded thread row (bounded), so a short outage is caught up on restart.
 *
 * @module SpaceActivityReactor
 */
import {
  type CommandCenterEventEnvelope,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  ThreadId,
} from "@t3tools/contracts";
import { RepositoryBinding } from "@command-center/core";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { forkParked } from "../serverActivation.ts";
import { CommandCenterEventStream } from "./EventStream.ts";
import { OrchestrationBridge } from "./OrchestrationBridge.ts";
import { resolveSpaceIdsForProject, SpaceActivity } from "./SpaceActivity.ts";
import { isSpaceAgentThreadId } from "./SpaceAgentIds.ts";
import { latestAssistantText } from "./V2Transcript.ts";

type RunStateChangedEvent = Extract<CommandCenterEventEnvelope, { _tag: "RunStateChanged" }>;
type WorkItem =
  | { readonly kind: "thread"; readonly event: OrchestrationV2StoredEvent }
  | { readonly kind: "run"; readonly event: RunStateChangedEvent };

/**
 * V2 events replayed at startup after the newest recorded thread row. Gaps
 * older than this window stay missing (the feed is best effort, not a backfill).
 */
export const CATCH_UP_EVENT_LIMIT = 5_000;
/** A settle this close to a turn-end row adds nothing. */
const LOW_SIGNAL_WINDOW_MINUTES = 2;
const RUN_POLL_INTERVAL_MS = 5_000;
const STREAM_RETRY = Schedule.spaced("1 minute");

const RUN_STATUS: Readonly<Record<string, string>> = {
  succeeded: "completed",
  failed: "failed",
  canceled: "canceled",
};

const TERMINAL_RUN_STATUS: Partial<Record<OrchestrationV2Run["status"], string>> = {
  completed: "completed",
  interrupted: "interrupted",
  cancelled: "interrupted",
  failed: "failed",
  rolled_back: "failed",
};

const decodeRepositories = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(RepositoryBinding)),
);
const decodeRunInput = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ text: Schema.optional(Schema.String) })),
);

export interface ThreadOutcome {
  readonly status: string;
  readonly runId?: string;
  /** When the outcome happened; a V2 run's completion time, so repeats match. */
  readonly occurredAt: string;
  /** A settle often echoes a turn-end row; it is skipped when one is recent. */
  readonly lowSignal: boolean;
}

/** The terminal outcome a stored V2 event represents, or undefined. */
export const terminalThreadOutcome = (
  stored: Pick<OrchestrationV2StoredEvent, "event">,
): ThreadOutcome | undefined => {
  const event = stored.event;
  if (event.type === "thread.settled") {
    return {
      status: "settled",
      occurredAt: DateTime.formatIso(event.occurredAt),
      lowSignal: true,
    };
  }
  if (event.type !== "run.updated") return undefined;
  const status = TERMINAL_RUN_STATUS[event.payload.status];
  if (status === undefined) return undefined;
  return {
    status,
    runId: event.payload.id,
    occurredAt: DateTime.formatIso(event.payload.completedAt ?? event.occurredAt),
    lowSignal: false,
  };
};

/**
 * Where the V2 catch-up starts. Rows recorded before the V2 cutover carry V1
 * event sequences, which can exceed the V2 log's head; such a cursor (or none)
 * starts at the head. Otherwise replay at most `CATCH_UP_EVENT_LIMIT` events.
 */
export const catchUpStartSequence = (input: {
  readonly recordedCursor: number | undefined;
  readonly headSequence: number;
}): number =>
  input.recordedCursor === undefined || input.recordedCursor > input.headSequence
    ? input.headSequence
    : Math.max(input.recordedCursor, input.headSequence - CATCH_UP_EVENT_LIMIT);

export interface SpaceActivityReactorShape {
  /** Forks the V2 and Run followers; they run until the caller's scope closes. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Resolves once every enqueued item is processed (tests). */
  readonly drain: Effect.Effect<void>;
}

export class SpaceActivityReactor extends Context.Service<
  SpaceActivityReactor,
  SpaceActivityReactorShape
>()("@awtprod/command-center/command-center/SpaceActivityReactor") {}

const make = Effect.gen(function* () {
  const orchestration = yield* OrchestrationBridge;
  const eventStream = yield* CommandCenterEventStream;
  const activity = yield* SpaceActivity;
  const identities = yield* RepositoryIdentityResolver;
  const sql = yield* SqlClient.SqlClient;

  const activeSpaces = sql<{ readonly id: string; readonly repositoriesJson: string }>`
    SELECT id, repositories_json AS "repositoriesJson"
    FROM command_center_spaces
    WHERE lifecycle = 'active'
  `.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        id: row.id,
        lifecycle: "active" as const,
        repositories: Option.getOrElse(decodeRepositories(row.repositoriesJson), () => []),
      })),
    ),
  );

  const runIdForThread = (threadId: string) =>
    sql<{ readonly id: string }>`
      SELECT id FROM command_center_runs WHERE thread_id = ${threadId} LIMIT 1
    `.pipe(Effect.map((rows) => rows[0]?.id));

  const assistantText = (threadId: string, runId: string | undefined) =>
    latestAssistantText({ threadId, runId }).pipe(Effect.provideService(SqlClient.SqlClient, sql));

  const processThread = Effect.fn("SpaceActivityReactor.processThread")(function* (
    stored: OrchestrationV2StoredEvent,
  ) {
    const threadId = stored.event.threadId;
    const outcome = terminalThreadOutcome(stored);
    if (outcome === undefined || isSpaceAgentThreadId(threadId)) return;
    // A Run's thread is logged once, as the Run.
    if ((yield* runIdForThread(threadId)) !== undefined) return;
    if (outcome.lowSignal) {
      const occurredAt = DateTime.make(outcome.occurredAt);
      if (Option.isSome(occurredAt)) {
        const since = DateTime.subtract(occurredAt.value, { minutes: LOW_SIGNAL_WINDOW_MINUTES });
        if (yield* activity.hasRecentTurnRow(threadId, DateTime.formatIso(since))) return;
      }
    } else if (yield* activity.hasRowAt("thread", threadId, outcome.occurredAt)) {
      return;
    }
    const thread = Option.getOrUndefined(yield* orchestration.getThreadShellById(threadId));
    if (thread === undefined) return;
    const project = Option.getOrUndefined(
      yield* orchestration.getProjectShellById(thread.projectId),
    );
    if (project === undefined) return;
    const spaceIds = resolveSpaceIdsForProject(
      { id: project.id, remoteKeys: yield* identities.resolveRemoteKeys(project.workspaceRoot) },
      yield* activeSpaces,
    );
    if (spaceIds.length === 0) return;
    const text = yield* assistantText(threadId, outcome.runId);
    yield* Effect.forEach(spaceIds, (spaceId) =>
      activity.record({
        spaceId,
        occurredAt: outcome.occurredAt,
        sourceKind: "thread",
        sourceId: threadId,
        projectId: thread.projectId,
        title: thread.title,
        status: outcome.status,
        text,
        eventSequence: stored.sequence,
      }),
    );
  });

  const processRun = Effect.fn("SpaceActivityReactor.processRun")(function* (
    event: RunStateChangedEvent,
  ) {
    const status = RUN_STATUS[event.payload.status];
    if (status === undefined || event.spaceId === null || event.runId === null) return;
    const run = (yield* sql<{
      readonly threadId: string | null;
      readonly projectId: string | null;
      readonly kind: string;
      readonly inputJson: string;
      readonly error: string | null;
    }>`
      SELECT thread_id AS "threadId", project_id AS "projectId", kind,
        input_json AS "inputJson", error
      FROM command_center_runs
      WHERE id = ${event.runId}
    `)[0];
    const threadId = event.payload.threadId ?? run?.threadId ?? null;
    if (threadId !== null && isSpaceAgentThreadId(threadId)) return;
    const thread =
      threadId === null
        ? undefined
        : Option.getOrUndefined(yield* orchestration.getThreadShellById(ThreadId.make(threadId)));
    const commandText = Option.getOrUndefined(decodeRunInput(run?.inputJson ?? ""))
      ?.text?.trim()
      .split("\n", 1)[0];
    const text = threadId === null ? null : yield* assistantText(threadId, undefined);
    yield* activity.record({
      spaceId: event.spaceId,
      occurredAt: event.occurredAt,
      sourceKind: "run",
      sourceId: event.runId,
      projectId: event.payload.projectId ?? run?.projectId ?? null,
      title: thread?.title ?? (commandText || `${run?.kind ?? "agent"} Run`),
      status,
      text: text ?? event.payload.error ?? run?.error ?? null,
      eventSequence: event.sequence,
    });
  });

  const processItem = (item: WorkItem) =>
    (item.kind === "thread" ? processThread(item.event) : processRun(item.event)).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("space activity reactor failed to process event", {
              kind: item.kind,
              sequence: item.event.sequence,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const retryLogged = <E, R>(label: string, effect: Effect.Effect<void, E, R>) =>
    effect.pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning(`space activity ${label} failed; retrying`, {
              cause: Cause.pretty(cause),
            }),
      ),
      Effect.retry(STREAM_RETRY),
      Effect.ignore,
    );

  const start: SpaceActivityReactorShape["start"] = Effect.fn("SpaceActivityReactor.start")(
    function* () {
      const worker = yield* makeDrainableWorker(processItem);
      drainRef.current = worker.drain;

      /** Follows terminal V2 run updates and settles, resuming after the newest thread row. */
      const followThreads = Effect.gen(function* () {
        const afterSequence = catchUpStartSequence({
          recordedCursor: yield* activity.latestEventSequence("thread"),
          headSequence: yield* orchestration.latestEventSequence,
        });
        const enqueue = (stored: OrchestrationV2StoredEvent) =>
          terminalThreadOutcome(stored) === undefined
            ? Effect.void
            : worker.enqueue({ kind: "thread", event: stored });
        // Replayed duplicates are dropped by the table's unique key and the
        // run's completion-time check.
        yield* Effect.all(
          [
            Stream.runForEach(
              orchestration.streamStoredEventsFrom({ afterSequence, eventType: "run.updated" }),
              enqueue,
            ),
            Stream.runForEach(
              orchestration.streamStoredEventsFrom({ afterSequence, eventType: "thread.settled" }),
              enqueue,
            ),
          ],
          { concurrency: "unbounded", discard: true },
        );
      });

      /** Follows Run state changes from the durable Command Center event log. */
      const followRuns = Effect.gen(function* () {
        const recorded = yield* activity.latestEventSequence("run");
        const afterSequence =
          recorded ??
          (yield* sql<{ readonly sequence: number }>`
            SELECT COALESCE(MAX(sequence), 0) AS sequence FROM command_center_audit_events
          `)[0]?.sequence ??
          0;
        yield* Stream.runForEach(
          eventStream.changes({ afterSequence, pollIntervalMs: RUN_POLL_INTERVAL_MS }),
          (event) =>
            event._tag === "RunStateChanged" ? worker.enqueue({ kind: "run", event }) : Effect.void,
        );
      });

      yield* forkParked(retryLogged("thread stream", followThreads));
      yield* forkParked(retryLogged("Run stream", followRuns));
    },
  );

  const drainRef: { current: Effect.Effect<void> } = { current: Effect.void };
  return SpaceActivityReactor.of({
    start,
    drain: Effect.suspend(() => drainRef.current),
  });
});

export const layer = Layer.effect(SpaceActivityReactor, make);
