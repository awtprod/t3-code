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
  ProjectId,
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
} from "../Services/OrchestrationEventStore.ts";

// Both counts are non-negative by construction (each CASE contributes 0 or 1)
// and `COALESCE`d, so an empty tail yields 0 rather than NULL. The aggregate
// always produces exactly one row, even when no events match.
const ThreadTurnStartClaimRowSchema = Schema.Struct({
  sameMessageRestartCount: NonNegativeInt,
  interruptCount: NonNegativeInt,
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
  } satisfies OrchestrationEventStoreShape;
});

export const OrchestrationEventStoreLive = Layer.effect(OrchestrationEventStore, makeEventStore);
