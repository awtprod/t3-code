import {
  type CommandCenterEventEnvelope,
  type OrchestrationEvent,
  ThreadId,
} from "@t3tools/contracts";
import { RepositoryBinding } from "@command-center/core";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CommandCenterEventStream } from "../../command-center/EventStream.ts";
import {
  isSpaceAgentThreadId,
  resolveSpaceIdsForProject,
  SpaceActivity,
} from "../../command-center/SpaceActivity.ts";
import { RepositoryIdentityResolver } from "../../project/RepositoryIdentityResolver.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  SpaceActivityReactor,
  type SpaceActivityReactorShape,
} from "../Services/SpaceActivityReactor.ts";

type ThreadTerminalEvent = Extract<
  OrchestrationEvent,
  { type: "thread.session-set" | "thread.settled" }
>;
type RunStateChangedEvent = Extract<CommandCenterEventEnvelope, { _tag: "RunStateChanged" }>;
type WorkItem =
  | { readonly kind: "thread"; readonly event: ThreadTerminalEvent }
  | { readonly kind: "run"; readonly event: RunStateChangedEvent };

/**
 * Orchestration events replayed at startup after the newest recorded thread
 * row. Events missed while the server was down are recovered only within this
 * window; older gaps stay missing (the feed is best effort, not a backfill).
 */
const CATCH_UP_EVENT_LIMIT = 5_000;
/** A settle or bare session error this close to a turn-end row adds nothing. */
const LOW_SIGNAL_WINDOW_MINUTES = 2;
const RUN_POLL_INTERVAL_MS = 5_000;
const RUN_STREAM_RETRY = Schedule.spaced("1 minute");
/** Longest assistant message prefix read from the projection. */
const MESSAGE_READ_CHARS = 20_000;

const RUN_STATUS: Readonly<Record<string, string>> = {
  succeeded: "completed",
  failed: "failed",
  canceled: "canceled",
};
const TURN_STATUS = {
  completed: "completed",
  interrupted: "interrupted",
  error: "failed",
} as const;
const TURN_SEVERITY = { completed: 0, interrupted: 1, error: 2 } as const;

const decodeRepositories = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(RepositoryBinding)),
);
const decodeRunInput = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ text: Schema.optional(Schema.String) })),
);

export interface ThreadOutcome {
  readonly status: string;
  readonly turnId?: string;
  /** Settles and session errors without a turn often echo a turn-end row. */
  readonly lowSignal: boolean;
}

/**
 * The terminal outcome an event represents, or undefined. A turn ends on a
 * `thread.session-set` that carries a terminal turn transition; a session that
 * errors without one still failed; `thread.settled` closes the thread.
 */
export const terminalThreadOutcome = (event: OrchestrationEvent): ThreadOutcome | undefined => {
  if (event.type === "thread.settled") return { status: "settled", lowSignal: true };
  if (event.type !== "thread.session-set") return undefined;
  const transitions =
    event.payload.terminalTurnTransitions ??
    (event.payload.terminalTurnTransition === undefined
      ? []
      : [event.payload.terminalTurnTransition]);
  const worst = transitions.reduce<(typeof transitions)[number] | undefined>(
    (current, next) =>
      current === undefined || TURN_SEVERITY[next.state] > TURN_SEVERITY[current.state]
        ? next
        : current,
    undefined,
  );
  if (worst !== undefined) {
    return { status: TURN_STATUS[worst.state], turnId: worst.turnId, lowSignal: false };
  }
  if (event.payload.session.status === "error") {
    const turnId = event.payload.session.activeTurnId;
    return { status: "failed", ...(turnId === null ? {} : { turnId }), lowSignal: true };
  }
  return undefined;
};

const isThreadTerminalEvent = (event: OrchestrationEvent): event is ThreadTerminalEvent =>
  terminalThreadOutcome(event) !== undefined;

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
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

  /** The newest finished assistant message of a turn (or of the thread). */
  const latestAssistantText = (threadId: string, turnId: string | undefined) =>
    sql<{ readonly text: string }>`
      SELECT substr(text, 1, ${MESSAGE_READ_CHARS}) AS text
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
        AND role = 'assistant'
        AND is_streaming = 0
        AND (${turnId ?? null} IS NULL OR turn_id = ${turnId ?? null})
      ORDER BY created_at DESC, message_id DESC
      LIMIT 1
    `.pipe(Effect.map((rows) => rows[0]?.text ?? null));

  const processThread = Effect.fn("SpaceActivityReactor.processThread")(function* (
    event: ThreadTerminalEvent,
  ) {
    const threadId = event.payload.threadId;
    const outcome = terminalThreadOutcome(event);
    if (outcome === undefined || isSpaceAgentThreadId(threadId)) return;
    // A Run's thread is logged once, as the Run.
    if ((yield* runIdForThread(threadId)) !== undefined) return;
    const occurredAt = DateTime.make(event.occurredAt);
    if (outcome.lowSignal && Option.isSome(occurredAt)) {
      const since = DateTime.subtract(occurredAt.value, { minutes: LOW_SIGNAL_WINDOW_MINUTES });
      if (yield* activity.hasRecentTurnRow(threadId, DateTime.formatIso(since))) return;
    }
    const thread = Option.getOrUndefined(yield* snapshots.getThreadShellById(threadId));
    if (thread === undefined) return;
    const project = Option.getOrUndefined(yield* snapshots.getProjectShellById(thread.projectId));
    if (project === undefined) return;
    const spaceIds = resolveSpaceIdsForProject(
      { id: project.id, remoteKeys: yield* identities.resolveRemoteKeys(project.workspaceRoot) },
      yield* activeSpaces,
    );
    if (spaceIds.length === 0) return;
    const text = yield* latestAssistantText(threadId, outcome.turnId);
    yield* Effect.forEach(spaceIds, (spaceId) =>
      activity.record({
        spaceId,
        occurredAt: event.occurredAt,
        sourceKind: "thread",
        sourceId: threadId,
        projectId: thread.projectId,
        title: thread.title,
        status: outcome.status,
        text,
        eventSequence: event.sequence,
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
        : Option.getOrUndefined(yield* snapshots.getThreadShellById(ThreadId.make(threadId)));
    const commandText = Option.getOrUndefined(decodeRunInput(run?.inputJson ?? ""))
      ?.text?.trim()
      .split("\n", 1)[0];
    const text = threadId === null ? null : yield* latestAssistantText(threadId, undefined);
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

  const worker = yield* makeDrainableWorker(processItem);
  const enqueueThreadEvent = (event: OrchestrationEvent) =>
    isThreadTerminalEvent(event) ? worker.enqueue({ kind: "thread", event }) : Effect.void;

  /** Replays orchestration events after the newest thread row (bounded). */
  const catchUpThreads = Effect.gen(function* () {
    const cursor = yield* activity.latestEventSequence("thread");
    if (cursor === undefined) return;
    yield* Stream.runForEach(engine.readEvents(cursor, CATCH_UP_EVENT_LIMIT), enqueueThreadEvent);
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("space activity catch-up failed", { cause: Cause.pretty(cause) }),
    ),
  );

  /**
   * Follows Run state changes from the durable Command Center event log,
   * resuming after the newest Run row (or the log head on first start).
   */
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
  }).pipe(
    Effect.tapCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logWarning("space activity Run stream failed; retrying", {
            cause: Cause.pretty(cause),
          }),
    ),
    Effect.retry(RUN_STREAM_RETRY),
  );

  const start: SpaceActivityReactorShape["start"] = Effect.fn("start")(function* () {
    // The hot subscription and the bounded catch-up run together; replayed
    // duplicates are dropped by the table's unique key.
    yield* forkParked(
      Effect.all(
        [Stream.runForEach(engine.streamDomainEvents, enqueueThreadEvent), catchUpThreads],
        {
          concurrency: "unbounded",
          discard: true,
        },
      ),
    );
    yield* forkParked(followRuns.pipe(Effect.ignore));
  });

  return { start, drain: worker.drain } satisfies SpaceActivityReactorShape;
});

export const SpaceActivityReactorLive = Layer.effect(SpaceActivityReactor, make);
