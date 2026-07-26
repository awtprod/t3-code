import {
  CommandId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationActorKind,
  OrchestrationAggregateKind,
  OrchestrationEvent,
  OrchestrationEventMetadata,
  OrchestrationEventType,
  MessageId,
  ModelSelection,
  ProjectId,
  SourceProposedPlanReference,
  ThreadId,
} from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type OrchestrationEventStoreError,
} from "../Errors.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
  ThreadTurnStartClaimInput,
  ThreadTurnStartsAboveCutoffInput,
} from "../Services/OrchestrationEventStore.ts";

// Both counts are non-negative by construction (each CASE contributes 0 or 1)
// and `COALESCE`d, so an empty tail yields 0 rather than NULL. The aggregate
// always produces exactly one row, even when no events match.
const ThreadTurnStartClaimRowSchema = Schema.Struct({
  sameMessageRestartCount: NonNegativeInt,
  interruptCount: NonNegativeInt,
});

// Every field but `sequence` comes out of the payload JSON rather than a column,
// because the event table is generic over payloads. The query's WHERE clause
// restricts rows to `thread.turn-start-requested`, whose payload always carries a
// `messageId`, so that extraction cannot be null for any row this schema decodes.
//
// `modelSelection` and `sourceProposedPlan` are genuinely optional on that
// payload, and `json_extract` yields SQL NULL for an absent path and the object's
// JSON TEXT for a present one — hence `NullOr(fromJsonString(...))` rather than a
// plain decode. They are nulled back to `undefined` at the boundary so callers see
// the same optionality the event payload has.
const ThreadTurnStartAboveCutoffRowSchema = Schema.Struct({
  sequence: NonNegativeInt,
  messageId: MessageId,
  modelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
  sourceProposedPlan: Schema.NullOr(Schema.fromJsonString(SourceProposedPlanReference)),
});

const decodeEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const EventMetadataFromJsonString = Schema.fromJsonString(OrchestrationEventMetadata);

const AppendEventRequestSchema = Schema.Struct({
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  streamId: Schema.Union([ProjectId, ThreadId]),
  type: OrchestrationEventType,
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  actorKind: OrchestrationActorKind,
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  payloadJson: UnknownFromJsonString,
  metadataJson: EventMetadataFromJsonString,
});

const OrchestrationEventPersistedRowSchema = Schema.Struct({
  sequence: NonNegativeInt,
  eventId: EventId,
  type: OrchestrationEventType,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  payload: UnknownFromJsonString,
  metadata: EventMetadataFromJsonString,
});

const ReadFromSequenceRequestSchema = Schema.Struct({
  sequenceExclusive: NonNegativeInt,
  limit: Schema.Number,
});
const DEFAULT_READ_FROM_SEQUENCE_LIMIT = 1_000;
const READ_PAGE_SIZE = 500;

function inferActorKind(
  event: Omit<OrchestrationEvent, "sequence">,
): Schema.Schema.Type<typeof OrchestrationActorKind> {
  if (event.commandId !== null && event.commandId.startsWith("provider:")) {
    return "provider";
  }
  if (event.commandId !== null && event.commandId.startsWith("server:")) {
    return "server";
  }
  if (
    event.metadata.providerTurnId !== undefined ||
    event.metadata.providerItemId !== undefined ||
    event.metadata.adapterKey !== undefined
  ) {
    return "provider";
  }
  if (event.commandId === null) {
    return "server";
  }
  return "client";
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): OrchestrationEventStoreError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeEventStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const appendEventRow = SqlSchema.findOne({
    Request: AppendEventRequestSchema,
    Result: OrchestrationEventPersistedRowSchema,
    execute: (request) =>
      sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${request.eventId},
          ${request.aggregateKind},
          ${request.streamId},
          COALESCE(
            (
              SELECT stream_version + 1
              FROM orchestration_events
              WHERE aggregate_kind = ${request.aggregateKind}
                AND stream_id = ${request.streamId}
              ORDER BY stream_version DESC
              LIMIT 1
            ),
            0
          ),
          ${request.type},
          ${request.occurredAt},
          ${request.commandId},
          ${request.causationEventId},
          ${request.correlationId},
          ${request.actorKind},
          ${request.payloadJson},
          ${request.metadataJson}
        )
        RETURNING
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_kind AS "aggregateKind",
          stream_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payload",
          metadata_json AS "metadata"
      `,
  });

  const readEventRowsFromSequence = SqlSchema.findAll({
    Request: ReadFromSequenceRequestSchema,
    Result: OrchestrationEventPersistedRowSchema,
    execute: (request) =>
      sql`
        SELECT
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_kind AS "aggregateKind",
          stream_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payload",
          metadata_json AS "metadata"
        FROM orchestration_events
        WHERE sequence > ${request.sequenceExclusive}
        ORDER BY sequence ASC
        LIMIT ${request.limit}
      `,
  });

  // Reads, from one thread's stream above a given sequence: how many later
  // turn-starts re-requested the same message, and how many stops landed.
  //
  // A stop is either kind of stop. `thread.session-stop-requested` ends the
  // whole session, which is strictly broader than interrupting one turn, so a
  // guard that counted only turn interrupts let an undriven turn-start slip past
  // a user who had shut the session down entirely — and `ProviderService.sendTurn`
  // resolves with `allowRecovery: true`, so that send does not merely fail
  // harmlessly, it revives the stopped session to deliver a prompt the user had
  // already abandoned.
  //
  // A stop counts against this request only if the stop's own CUTOFF reaches it.
  // For every stop the user pressed that cutoff is the stop's sequence, which is
  // above `afterSequence` by the WHERE clause below — so those all still count,
  // exactly as before. `thread.session-stop-requested` is the one event type
  // that can declare a narrower cutoff in its payload, and it does so in exactly
  // one situation: when the reactor escalated an interrupt whose delivery
  // failed. That escalation is dispatched only after the interrupt's retries ran
  // out, so it necessarily lands at a higher sequence than a message the user
  // typed during the retry delay — and counting it at its own sequence would
  // suppress that message, which the user submitted deliberately AFTER pressing
  // stop and which the original interrupt's cutoff was careful to let through.
  //
  // `>=` rather than `>` matches the durable barrier's own test
  // (`canceled_through_sequence >= request_sequence`), so the event-log fallback
  // and the claim table cannot disagree about which requests a stop covers.
  //
  // All of it comes from the append-only event log rather than the single-slot
  // pending projection row, which a turn-start for a different message evicts.
  // `stream_id` + `sequence` is indexed (`idx_orch_events_stream_sequence`), so
  // this reads only that thread's tail.
  const readThreadTurnStartClaimRow = SqlSchema.findOne({
    Request: ThreadTurnStartClaimInput,
    Result: ThreadTurnStartClaimRowSchema,
    execute: (request) =>
      sql`
        SELECT
          COALESCE(SUM(
            CASE
              WHEN event_type = 'thread.turn-start-requested'
                AND json_extract(payload_json, '$.messageId') = ${request.messageId}
              THEN 1 ELSE 0
            END
          ), 0) AS "sameMessageRestartCount",
          COALESCE(SUM(
            CASE
              WHEN event_type IN (
                'thread.turn-interrupt-requested',
                'thread.session-stop-requested'
              )
              AND COALESCE(
                json_extract(payload_json, '$.canceledThroughSequence'),
                sequence
              ) >= ${request.afterSequence}
              THEN 1 ELSE 0
            END
          ), 0) AS "interruptCount"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id = ${request.threadId}
          AND sequence > ${request.afterSequence}
      `,
  });

  // Selects the turn-starts a stop's narrowed cutoff deliberately spared AND that
  // still need re-driving.
  //
  // `sequence > canceledThroughSequence` is the exact complement of the barrier's
  // inclusive `canceled_through_sequence >= request_sequence` coverage test, so a
  // request is either refused by the barrier or listed here, never both and never
  // neither. `sequence < stopSequence` keeps the scan below the stop itself: a
  // turn-start appended after the stop was accepted has not been processed yet and
  // will drive itself, so re-driving it here would duplicate it.
  //
  // The two `NOT EXISTS` guards are what make the result a re-drive list rather
  // than merely a spared list. Both scan UPWARD without an upper bound, because
  // the events that invalidate a candidate arrive after it and, in the escalated
  // case, after the stop as well:
  //
  //  - Later cancellation. The escalated stop is dispatched only once its
  //    interrupt's retries are exhausted, so a stop the user pressed in that
  //    window sits between the interrupt and the escalation and carries a HIGHER
  //    cutoff. Reusing `getThreadTurnStartClaim`'s coverage expression
  //    (`COALESCE(payload cutoff, own sequence) >= candidate sequence`) keeps this
  //    read and the durable barrier deciding coverage the same way — so a request
  //    the user canceled is never re-appended above the barrier that canceled it.
  //    This stop cannot exclude its own candidates: its cutoff is below them by
  //    the outer bound, which is what "spared" means.
  //  - Already settled. A spared request that was adopted by a turn and whose
  //    session then went quiet (`activeTurnId` cleared) has run its course —
  //    completed or interrupted — and re-driving it repeats work the user already
  //    got. Adoption is the correlation point: a `thread.session-set` from
  //    `turn.started`, or a `thread.turn-start-folded` from a steer, names the
  //    request it answers via `turnRequestSequence`. A never-adopted request has
  //    no adoption sequence, `MIN(...)` yields NULL, the comparison is NULL rather
  //    than true, and it is correctly kept — which is the common case here, since
  //    a request the teardown destroyed is exactly one that never settled.
  //
  //    Settlement is recognized by an explicit correlation, not inferred from
  //    the session snapshot the write happens to carry. Only the writers that
  //    KNOW a turn ended stamp `settledTurnId` on their session-set — ingestion
  //    when a `turn.completed` arrives, the stall watchdog when it fails the
  //    turn it timed out — and this read counts a candidate settled only when
  //    some session-set names the very turn that adopted it. Everything else
  //    that clears `activeTurnId` is thereby excluded for free, and each of
  //    those exclusions is load-bearing:
  //      - the stop's own teardown clears it for every candidate at once;
  //        counting it would empty this list on every call and silently
  //        restore the very defect the read exists to fix;
  //      - a concurrent turn-start FAILURE for a different request writes
  //        `ready`/null; counting it would drop a genuinely spared prompt;
  //      - a session rebind writes a non-stopped status with no active turn
  //        while the spared turn it displaced never ran to its end;
  //      - a provider `session.exited` clears it because the turn DIED with
  //        the session — the exact case a re-drive exists for.
  //    An earlier version inferred settlement from `status <> 'stopped'` with
  //    `activeTurnId` null; the second and third writers above produce exactly
  //    that shape without settling anything, which is why the correlation is
  //    explicit now.
  //
  //    Excluding by sequence position instead is also wrong: a genuine
  //    `turn.completed` can be ingested after the stop event commits and before
  //    this read runs, and a sequence bound would ignore that settlement and
  //    re-drive work the user already received. The settled-turn match is
  //    position-independent, so it settles both orderings correctly. Matching
  //    is by the ADOPTED turn id (the adoption names it: `$.turnId` on a fold,
  //    `$.session.activeTurnId` on a turn.started session-set), which also
  //    settles a steer folded into a running turn when that turn completes.
  //
  // Same index as the claim read (`idx_orch_events_stream_sequence`); the outer
  // range is bounded on both sides and every sub-select is scoped to the same
  // thread's stream above one sequence, so this stays within one thread's tail.
  const readThreadTurnStartsAboveCutoffRows = SqlSchema.findAll({
    Request: ThreadTurnStartsAboveCutoffInput,
    Result: ThreadTurnStartAboveCutoffRowSchema,
    execute: (request) =>
      sql`
        SELECT
          turn_start.sequence AS "sequence",
          json_extract(turn_start.payload_json, '$.messageId') AS "messageId",
          json_extract(turn_start.payload_json, '$.modelSelection') AS "modelSelection",
          json_extract(turn_start.payload_json, '$.sourceProposedPlan') AS "sourceProposedPlan"
        FROM orchestration_events AS turn_start
        WHERE turn_start.aggregate_kind = 'thread'
          AND turn_start.stream_id = ${request.threadId}
          AND turn_start.event_type = 'thread.turn-start-requested'
          AND turn_start.sequence > ${request.canceledThroughSequence}
          AND turn_start.sequence < ${request.stopSequence}
          AND NOT EXISTS (
            SELECT 1
            FROM orchestration_events AS cancel_event
            WHERE cancel_event.aggregate_kind = 'thread'
              AND cancel_event.stream_id = turn_start.stream_id
              AND cancel_event.event_type IN (
                'thread.turn-interrupt-requested',
                'thread.session-stop-requested'
              )
              AND cancel_event.sequence > turn_start.sequence
              AND COALESCE(
                json_extract(cancel_event.payload_json, '$.canceledThroughSequence'),
                cancel_event.sequence
              ) >= turn_start.sequence
          )
          AND NOT EXISTS (
            SELECT 1
            FROM orchestration_events AS settle_event
            WHERE settle_event.aggregate_kind = 'thread'
              AND settle_event.stream_id = turn_start.stream_id
              AND settle_event.event_type = 'thread.session-set'
              AND settle_event.sequence > turn_start.sequence
              AND json_extract(settle_event.payload_json, '$.settledTurnId') IS NOT NULL
              AND json_extract(settle_event.payload_json, '$.settledTurnId') = (
                SELECT COALESCE(
                  json_extract(adopt_event.payload_json, '$.turnId'),
                  json_extract(adopt_event.payload_json, '$.session.activeTurnId')
                )
                FROM orchestration_events AS adopt_event
                WHERE adopt_event.aggregate_kind = 'thread'
                  AND adopt_event.stream_id = turn_start.stream_id
                  AND adopt_event.sequence > turn_start.sequence
                  AND adopt_event.event_type IN (
                    'thread.session-set',
                    'thread.turn-start-folded'
                  )
                  AND json_extract(
                    adopt_event.payload_json,
                    '$.turnRequestSequence'
                  ) = turn_start.sequence
                ORDER BY adopt_event.sequence ASC
                LIMIT 1
              )
          )
        ORDER BY turn_start.sequence ASC
      `,
  });

  const listThreadTurnStartsAboveCutoff: OrchestrationEventStoreShape["listThreadTurnStartsAboveCutoff"] =
    (input) =>
      readThreadTurnStartsAboveCutoffRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "OrchestrationEventStore.listThreadTurnStartsAboveCutoff:query",
            "OrchestrationEventStore.listThreadTurnStartsAboveCutoff:decodeRows",
          ),
        ),
        // SQL's absent-value is NULL and the event payload's is `undefined`. The
        // fields are dropped rather than passed through as `null` so a caller
        // spreading them into a command cannot turn "this request named no model"
        // into "this request explicitly selected null".
        Effect.map((rows) =>
          rows.map((row) => ({
            sequence: row.sequence,
            messageId: row.messageId,
            ...(row.modelSelection !== null ? { modelSelection: row.modelSelection } : {}),
            ...(row.sourceProposedPlan !== null
              ? { sourceProposedPlan: row.sourceProposedPlan }
              : {}),
          })),
        ),
      );

  const getThreadTurnStartClaim: OrchestrationEventStoreShape["getThreadTurnStartClaim"] = (
    input,
  ) =>
    readThreadTurnStartClaimRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "OrchestrationEventStore.getThreadTurnStartClaim:query",
          "OrchestrationEventStore.getThreadTurnStartClaim:decodeRow",
        ),
      ),
      Effect.map((row) => ({
        supersededBySameMessage: row.sameMessageRestartCount > 0,
        // ANY interrupt above this request's sequence suppresses it. There is no
        // attempt to bind the interrupt to the "most recent" turn-start, because
        // the caller's position already supplies the binding this needs: the
        // reactor asks about a request it has NOT yet sent. A stop the user
        // issued after that request was accepted, but before its prompt reached
        // the provider, cancels it — whatever else was queued in between.
        //
        // An earlier revision required no intervening turn-start (interrupt
        // strictly before the next start), reasoning that a later start "owns"
        // the interrupt. That is wrong for `start A → start B → interrupt`: A
        // reported `interruptedAfter: false` and could still be driven after the
        // user pressed stop. Ordering among queued starts does not decide whose
        // stop it is — an undriven prompt below a stop is stopped.
        //
        // This does not over-suppress the turn already in flight: that one was
        // sent before the interrupt was appended, so its claim was read (and
        // passed) at a lower sequence and it is settled by the interrupt path,
        // not by this guard.
        interruptedAfter: row.interruptCount > 0,
      })),
    );

  const append: OrchestrationEventStoreShape["append"] = (event) =>
    appendEventRow({
      eventId: event.eventId,
      aggregateKind: event.aggregateKind,
      streamId: event.aggregateId,
      type: event.type,
      causationEventId: event.causationEventId,
      correlationId: event.correlationId,
      actorKind: inferActorKind(event),
      occurredAt: event.occurredAt,
      commandId: event.commandId,
      payloadJson: event.payload,
      metadataJson: event.metadata,
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "OrchestrationEventStore.append:insert",
          "OrchestrationEventStore.append:decodeRow",
        ),
      ),
      Effect.flatMap((row) =>
        decodeEvent(row).pipe(
          Effect.mapError(toPersistenceDecodeError("OrchestrationEventStore.append:rowToEvent")),
        ),
      ),
    );

  const readFromSequence: OrchestrationEventStoreShape["readFromSequence"] = (
    sequenceExclusive,
    limit = DEFAULT_READ_FROM_SEQUENCE_LIMIT,
  ) => {
    const normalizedLimit = Math.max(0, Math.floor(limit));
    if (normalizedLimit === 0) {
      return Stream.empty;
    }
    const readPage = (
      cursor: number,
      remaining: number,
    ): Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError> =>
      Stream.fromEffect(
        readEventRowsFromSequence({
          sequenceExclusive: cursor,
          limit: Math.min(remaining, READ_PAGE_SIZE),
        }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "OrchestrationEventStore.readFromSequence:query",
              "OrchestrationEventStore.readFromSequence:decodeRows",
            ),
          ),
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              decodeEvent(row).pipe(
                Effect.mapError(
                  toPersistenceDecodeError("OrchestrationEventStore.readFromSequence:rowToEvent"),
                ),
              ),
            ),
          ),
        ),
      ).pipe(
        Stream.flatMap((events) => {
          if (events.length === 0) {
            return Stream.empty;
          }
          const nextRemaining = remaining - events.length;
          if (nextRemaining <= 0) {
            return Stream.fromIterable(events);
          }
          return Stream.concat(
            Stream.fromIterable(events),
            readPage(events[events.length - 1]!.sequence, nextRemaining),
          );
        }),
      );

    return readPage(sequenceExclusive, normalizedLimit);
  };

  return {
    append,
    readFromSequence,
    readAll: () => readFromSequence(0, Number.MAX_SAFE_INTEGER),
    getThreadTurnStartClaim,
    listThreadTurnStartsAboveCutoff,
  } satisfies OrchestrationEventStoreShape;
});

export const OrchestrationEventStoreLive = Layer.effect(OrchestrationEventStore, makeEventStore);
