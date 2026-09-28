import { CommandId, IsoDateTime, NonNegativeInt } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  CompleteProviderRestartRecoveryInput,
  ProviderRestartRecoveryRepository,
  ReserveProviderRestartRecoveryInput,
  type ProviderRestartRecoveryRepositoryShape,
  type ProviderRestartRecoveryReservationOutcome,
} from "../Services/ProviderRestartRecovery.ts";

const MAX_RESTART_RECOVERIES_PER_MESSAGE = 2;

const ReservationRow = Schema.Struct({
  attempt: NonNegativeInt,
  commandId: CommandId,
  reservedAt: IsoDateTime,
});

const makeProviderRestartRecoveryRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertReservation = SqlSchema.void({
    Request: Schema.Struct({
      ...ReserveProviderRestartRecoveryInput.fields,
      commandId: CommandId,
    }),
    execute: (request) => sql`
      INSERT INTO provider_restart_recoveries (
        thread_id,
        message_id,
        original_request_sequence,
        root_request_sequence,
        attempt,
        command_id,
        reserved_at
      )
      SELECT
        ${request.threadId},
        ${request.messageId},
        ${request.originalRequestSequence},
        COALESCE(MIN(history.root_request_sequence), ${request.originalRequestSequence}),
        COALESCE(MAX(history.attempt), 0) + 1,
        ${request.commandId},
        ${request.reservedAt}
      FROM provider_restart_recoveries AS history
      WHERE history.thread_id = ${request.threadId}
        AND history.message_id = ${request.messageId}
      HAVING COALESCE(MAX(history.attempt), 0) < ${MAX_RESTART_RECOVERIES_PER_MESSAGE}
        AND NOT EXISTS (
          SELECT 1
          FROM command_center_runs AS run
          WHERE run.thread_id = ${request.threadId}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM provider_restart_recoveries AS existing
          WHERE existing.thread_id = ${request.threadId}
            AND existing.message_id = ${request.messageId}
            AND existing.original_request_sequence = ${request.originalRequestSequence}
        )
        AND EXISTS (
          SELECT 1
          FROM projection_turns AS pending
          JOIN projection_threads AS thread
            ON thread.thread_id = pending.thread_id
          JOIN projection_thread_messages AS message
            ON message.thread_id = pending.thread_id
           AND message.message_id = pending.pending_message_id
           AND message.role = 'user'
          WHERE pending.thread_id = ${request.threadId}
            AND pending.pending_message_id = ${request.messageId}
            AND pending.request_sequence = ${request.originalRequestSequence}
            AND pending.turn_id IS NULL
            AND pending.state = 'pending'
            AND pending.checkpoint_turn_count IS NULL
            AND pending.pending_interrupt_requested = 0
            AND thread.deleted_at IS NULL
            AND thread.archived_at IS NULL
            AND thread.pending_approval_count = 0
            AND thread.pending_user_input_count = 0
        )
        AND NOT EXISTS (
          SELECT 1
          FROM provider_turn_send_claims AS claim
          WHERE claim.thread_id = ${request.threadId}
            AND claim.message_id = ${request.messageId}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM provider_turn_send_barriers AS barrier
          WHERE barrier.thread_id = ${request.threadId}
            AND barrier.canceled_through_sequence >= COALESCE(
              (
                SELECT MIN(roots.root_request_sequence)
                FROM provider_restart_recoveries AS roots
                WHERE roots.thread_id = ${request.threadId}
                  AND roots.message_id = ${request.messageId}
              ),
              ${request.originalRequestSequence}
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM projection_turns AS newer
          WHERE newer.thread_id = ${request.threadId}
            AND newer.pending_message_id = ${request.messageId}
            AND newer.turn_id IS NULL
            AND newer.state = 'pending'
            AND newer.checkpoint_turn_count IS NULL
            AND newer.request_sequence > ${request.originalRequestSequence}
        )
      ON CONFLICT DO NOTHING
    `,
  });

  // An accepted receipt makes a reserved command safe to replay even if a stop
  // or replacement arrived afterwards: the engine returns the original result
  // without appending another event. Without a receipt, every eligibility gate
  // is re-read so a reservation never becomes a cancellation bypass.
  const readUsableReservation = SqlSchema.findOneOption({
    Request: ReserveProviderRestartRecoveryInput,
    Result: ReservationRow,
    execute: (request) => sql`
      SELECT
        recovery.attempt,
        recovery.command_id AS "commandId",
        recovery.reserved_at AS "reservedAt"
      FROM provider_restart_recoveries AS recovery
      LEFT JOIN orchestration_command_receipts AS receipt
        ON receipt.command_id = recovery.command_id
      WHERE recovery.thread_id = ${request.threadId}
        AND recovery.message_id = ${request.messageId}
        AND recovery.original_request_sequence = ${request.originalRequestSequence}
        AND NOT EXISTS (
          SELECT 1
          FROM command_center_runs AS run
          WHERE run.thread_id = recovery.thread_id
        )
        AND (
          receipt.status = 'accepted'
          OR (
            receipt.command_id IS NULL
            AND EXISTS (
              SELECT 1
              FROM projection_turns AS pending
              JOIN projection_threads AS thread
                ON thread.thread_id = pending.thread_id
              JOIN projection_thread_messages AS message
                ON message.thread_id = pending.thread_id
               AND message.message_id = pending.pending_message_id
               AND message.role = 'user'
              WHERE pending.thread_id = recovery.thread_id
                AND pending.pending_message_id = recovery.message_id
                AND pending.request_sequence = recovery.original_request_sequence
                AND pending.turn_id IS NULL
                AND pending.state = 'pending'
                AND pending.checkpoint_turn_count IS NULL
                AND pending.pending_interrupt_requested = 0
                AND thread.deleted_at IS NULL
                AND thread.archived_at IS NULL
                AND thread.pending_approval_count = 0
                AND thread.pending_user_input_count = 0
            )
            AND NOT EXISTS (
              SELECT 1
              FROM provider_turn_send_claims AS claim
              WHERE claim.thread_id = recovery.thread_id
                AND claim.message_id = recovery.message_id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM provider_turn_send_barriers AS barrier
              WHERE barrier.thread_id = recovery.thread_id
                AND barrier.canceled_through_sequence >= recovery.root_request_sequence
            )
            AND NOT EXISTS (
              SELECT 1
              FROM projection_turns AS newer
              WHERE newer.thread_id = recovery.thread_id
                AND newer.pending_message_id = recovery.message_id
                AND newer.turn_id IS NULL
                AND newer.state = 'pending'
                AND newer.checkpoint_turn_count IS NULL
                AND newer.request_sequence > recovery.original_request_sequence
            )
          )
        )
    `,
  });

  const completeReservation = SqlSchema.void({
    Request: CompleteProviderRestartRecoveryInput,
    execute: (request) => sql`
      UPDATE provider_restart_recoveries
      SET
        replacement_request_sequence = COALESCE(
          replacement_request_sequence,
          ${request.replacementRequestSequence}
        ),
        dispatched_at = COALESCE(dispatched_at, ${request.dispatchedAt})
      WHERE thread_id = ${request.threadId}
        AND message_id = ${request.messageId}
        AND original_request_sequence = ${request.originalRequestSequence}
    `,
  });

  const reserve: ProviderRestartRecoveryRepositoryShape["reserve"] = (input) => {
    const commandId = CommandId.make(
      `server:restart-recovery:${input.threadId}:${input.messageId}:${input.originalRequestSequence}`,
    );
    return insertReservation({ ...input, commandId }).pipe(
      Effect.flatMap(() => readUsableReservation(input)),
      Effect.map(
        (reservation): ProviderRestartRecoveryReservationOutcome =>
          reservation._tag === "Some"
            ? { _tag: "reserved", reservation: reservation.value }
            : { _tag: "ineligible" },
      ),
      Effect.mapError(toPersistenceSqlError("ProviderRestartRecoveryRepository.reserve:query")),
    );
  };

  const complete: ProviderRestartRecoveryRepositoryShape["complete"] = (input) =>
    completeReservation(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProviderRestartRecoveryRepository.complete:query")),
    );

  return { reserve, complete } satisfies ProviderRestartRecoveryRepositoryShape;
});

export const ProviderRestartRecoveryRepositoryLive = Layer.effect(
  ProviderRestartRecoveryRepository,
  makeProviderRestartRecoveryRepository,
);
