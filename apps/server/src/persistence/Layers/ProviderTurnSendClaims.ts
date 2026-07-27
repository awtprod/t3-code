import { IsoDateTime, NonNegativeInt, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  AcquireProviderTurnSendClaimInput,
  CancelProviderTurnSendClaimsInput,
  MarkProviderTurnSendDeliveriesTeardownDispatchedInput,
  ProviderTurnSendClaimRepository,
  RecordProviderTurnSendDeliveryInput,
  RetireProviderTurnSendDeliveriesInput,
  type ProviderTurnSendClaimOutcome,
  type ProviderTurnSendClaimRepositoryShape,
  type ProviderTurnSendDeliveryState,
} from "../Services/ProviderTurnSendClaims.ts";

// The claim row's owner, read back after the conditional upsert. Absent only
// when a cancel barrier blocked the insert and no other request had claimed.
const ClaimOwnerRowSchema = Schema.Struct({
  requestSequence: NonNegativeInt,
});

const DeliveryRowSchema = Schema.Struct({
  deliveryId: NonNegativeInt,
  requestSequence: NonNegativeInt,
  turnId: TurnId,
  reconciledAt: Schema.NullOr(IsoDateTime),
  teardownDispatchedAt: Schema.NullOr(IsoDateTime),
});

const RetiredDeliveryRowSchema = Schema.Struct({
  deliveryId: NonNegativeInt,
});

const makeProviderTurnSendClaimRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Compare-and-set. The `WHERE NOT EXISTS` makes the cancel barrier part of the
  // same statement as the insert, so SQLite's write serialization — not our
  // instruction ordering — decides the race: an interrupt either commits before
  // this and writes nothing, or commits after and finds the turn already claimed.
  //
  // The `ON CONFLICT ... DO UPDATE ... WHERE` is LAST-wins by sequence, matching
  // the event-log supersession guard it backs: among several requests for one
  // message the NEWEST is the live one. First-wins would be the wrong ordering
  // and not merely a weaker one — it would hand the claim to the stale original
  // and permanently lock out the session-exit auto-resume that re-issues the
  // same message, which is the recovery this whole path exists to perform.
  //
  // Equal sequences do not update, so a replay of the winner re-reads its own
  // row and is still told it holds the claim.
  //
  const upsertClaimIfNotCanceled = SqlSchema.void({
    Request: AcquireProviderTurnSendClaimInput,
    execute: (request) =>
      sql`
        INSERT INTO provider_turn_send_claims (
          thread_id, message_id, request_sequence, claimed_at
        )
        SELECT ${request.threadId}, ${request.messageId}, ${request.requestSequence}, ${request.claimedAt}
        WHERE NOT EXISTS (
          SELECT 1 FROM provider_turn_send_barriers
          WHERE thread_id = ${request.threadId}
            AND canceled_through_sequence >= ${request.requestSequence}
        )
        ON CONFLICT (thread_id, message_id) DO UPDATE SET
          request_sequence = excluded.request_sequence,
          claimed_at = excluded.claimed_at
        WHERE excluded.request_sequence > provider_turn_send_claims.request_sequence
      `,
  });

  // Who owns the claim now. Read as a separate statement rather than via
  // RETURNING because the upsert is deliberately allowed to affect zero rows —
  // RETURNING would then yield nothing and could not distinguish "a newer
  // request holds it" from "a stop blocked it", which are different outcomes to
  // log and, for a replay of the winner itself, a different answer entirely.
  //
  // The barrier is re-tested HERE as well as in the insert, and that is not
  // redundant: the insert's test only covers a stop that lands BEFORE the claim
  // row exists. A stop that lands after it writes only to the barrier table —
  // nothing revokes the row — so a read that consulted the claim alone would
  // still name the canceled request as owner and let it send stopped work. This
  // is the interrupt-to-send half of the race; the insert closes the
  // send-to-interrupt half.
  const readClaimOwner = SqlSchema.findOneOption({
    Request: Schema.Struct({
      threadId: AcquireProviderTurnSendClaimInput.fields.threadId,
      messageId: AcquireProviderTurnSendClaimInput.fields.messageId,
    }),
    Result: ClaimOwnerRowSchema,
    execute: ({ threadId, messageId }) =>
      sql`
        SELECT claim.request_sequence AS "requestSequence"
        FROM provider_turn_send_claims AS claim
        WHERE claim.thread_id = ${threadId}
          AND claim.message_id = ${messageId}
          AND NOT EXISTS (
            SELECT 1 FROM provider_turn_send_barriers AS barrier
            WHERE barrier.thread_id = ${threadId}
              AND barrier.canceled_through_sequence >= claim.request_sequence
          )
      `,
  });

  // Is this request covered by a stop? Asked only when the request did NOT end
  // up owning the claim, to say WHY.
  //
  // The distinction cannot be recovered from `readClaimOwner` alone, because it
  // filters barrier-covered rows out of its own result: a caller that sees no
  // owner cannot tell "the user stopped me" from "nothing is claimed". Those two
  // demand opposite handling in the post-send fence — interrupt the running turn
  // versus leave it strictly alone — so the ambiguity is resolved here with a
  // second read rather than guessed at by the caller.
  const readCancelBarrierCovers = SqlSchema.findOneOption({
    Request: Schema.Struct({
      threadId: AcquireProviderTurnSendClaimInput.fields.threadId,
      requestSequence: AcquireProviderTurnSendClaimInput.fields.requestSequence,
    }),
    Result: Schema.Struct({ canceledThroughSequence: NonNegativeInt }),
    execute: ({ threadId, requestSequence }) =>
      sql`
        SELECT canceled_through_sequence AS "canceledThroughSequence"
        FROM provider_turn_send_barriers
        WHERE thread_id = ${threadId}
          AND canceled_through_sequence >= ${requestSequence}
      `,
  });

  // Monotonic raise. `MAX` in the DO UPDATE keeps an out-of-order interrupt from
  // lowering an existing barrier and thereby un-canceling work.
  const raiseCancelBarrier = SqlSchema.void({
    Request: CancelProviderTurnSendClaimsInput,
    execute: (request) =>
      sql`
        INSERT INTO provider_turn_send_barriers (
          thread_id, canceled_through_sequence, updated_at
        )
        VALUES (${request.threadId}, ${request.canceledThroughSequence}, ${request.updatedAt})
        ON CONFLICT (thread_id)
        DO UPDATE SET
          canceled_through_sequence = MAX(
            provider_turn_send_barriers.canceled_through_sequence,
            excluded.canceled_through_sequence
          ),
          updated_at = excluded.updated_at
      `,
  });

  const acquire: ProviderTurnSendClaimRepositoryShape["acquire"] = (input) =>
    upsertClaimIfNotCanceled(input).pipe(
      Effect.flatMap(() =>
        readClaimOwner({ threadId: input.threadId, messageId: input.messageId }),
      ),
      Effect.flatMap((owner) => {
        // The winner is whoever's sequence is on the row — including this
        // request on a replay of its own successful acquire, which must still
        // be allowed to send rather than be misread as superseded by itself.
        if (owner._tag === "Some" && owner.value.requestSequence === input.requestSequence) {
          return Effect.succeed<ProviderTurnSendClaimOutcome>({ _tag: "acquired" });
        }
        // Some OTHER sequence holds an uncanceled row. That alone settles it —
        // a barrier covering this request would also have to cover the holder
        // for the stop to apply to the work now in progress, and it does not,
        // since the holder survived the same filter. So this is supersession,
        // not cancellation, whatever the barrier says about us specifically.
        if (owner._tag === "Some") {
          return Effect.succeed<ProviderTurnSendClaimOutcome>({
            _tag: "superseded",
            heldBySequence: owner.value.requestSequence,
          });
        }
        // No uncanceled owner. Either a stop covers this request, or — the
        // unreachable case — nothing is claimed at all. Ask the barrier rather
        // than assume, because assuming "canceled" here would let a fence
        // interrupt a turn nobody stopped.
        return readCancelBarrierCovers({
          threadId: input.threadId,
          requestSequence: input.requestSequence,
        }).pipe(
          Effect.map(
            (barrier): ProviderTurnSendClaimOutcome =>
              barrier._tag === "Some" ? { _tag: "canceled" } : { _tag: "superseded" },
          ),
        );
      }),
      Effect.mapError(toPersistenceSqlError("ProviderTurnSendClaimRepository.acquire:query")),
    );

  const cancel: ProviderTurnSendClaimRepositoryShape["cancel"] = (input) =>
    raiseCancelBarrier(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProviderTurnSendClaimRepository.cancel:query")),
    );

  // Phase two of the claim protocol. Every successful request gets its own
  // durable row. The claim predicate admits the current holder and ex-holders
  // whose RPC crossed a later takeover, while an absent claim admits nothing.
  // Without that correlation an owner-less fallback could manufacture stale
  // evidence and interrupt an unrelated healthy turn.
  //
  // The per-turn unique key makes exact retries idempotent while preserving a
  // distinct turn returned by equal-sequence replay. delivery_id is SQLite's
  // insertion order and completes the total survivor order when sequences tie.
  const stampDeliveredTurn = SqlSchema.void({
    Request: RecordProviderTurnSendDeliveryInput,
    execute: (request) =>
      sql`
        INSERT INTO provider_turn_send_deliveries (
          thread_id, message_id, request_sequence, delivered_turn_id
        )
        SELECT
          ${request.threadId},
          ${request.messageId},
          ${request.requestSequence},
          ${request.turnId}
        WHERE EXISTS (
          SELECT 1
          FROM provider_turn_send_claims
          WHERE thread_id = ${request.threadId}
            AND message_id = ${request.messageId}
            AND request_sequence >= ${request.requestSequence}
        )
        ON CONFLICT (thread_id, message_id, request_sequence, delivered_turn_id)
        DO NOTHING
      `,
  });

  const readDeliveryRows = SqlSchema.findAll({
    Request: Schema.Struct({
      threadId: RecordProviderTurnSendDeliveryInput.fields.threadId,
      messageId: RecordProviderTurnSendDeliveryInput.fields.messageId,
    }),
    Result: DeliveryRowSchema,
    execute: ({ threadId, messageId }) =>
      sql`
        SELECT
          delivery_id AS "deliveryId",
          request_sequence AS "requestSequence",
          delivered_turn_id AS "turnId",
          reconciled_at AS "reconciledAt",
          teardown_dispatched_at AS "teardownDispatchedAt"
        FROM provider_turn_send_deliveries
        WHERE thread_id = ${threadId}
          AND message_id = ${messageId}
        ORDER BY request_sequence ASC, delivery_id ASC
      `,
  });

  // The write and read intentionally remain separate statements. SQLite
  // serializes the delivery inserts, so whichever completing sender writes
  // second necessarily reads the first sender's row as well as its own. A third
  // sender can land after that read, but its own later read then sees all three.
  // That "at least the later writer observes the pair/chain" property is the
  // reconciliation guarantee. The exact pair is searched across ALL rows, not
  // only live ones: a racing newer completion may retire this caller's row
  // between the insert and read, but cannot erase the evidence that this insert
  // was owned. Per-turn uniqueness removes the old equal-sequence
  // stamp/overwrite race.
  const recordDelivery: ProviderTurnSendClaimRepositoryShape["recordDelivery"] = (input) =>
    stampDeliveredTurn(input).pipe(
      Effect.flatMap(() =>
        readDeliveryRows({
          threadId: input.threadId,
          messageId: input.messageId,
        }),
      ),
      Effect.map((rows): ProviderTurnSendDeliveryState => {
        const recorded = rows.some(
          (row) => row.requestSequence === input.requestSequence && row.turnId === input.turnId,
        );
        if (!recorded) {
          return { _tag: "unowned" };
        }
        return {
          _tag: "recorded",
          deliveries: rows
            .filter((row) => row.reconciledAt === null)
            .map(({ deliveryId, requestSequence, turnId, teardownDispatchedAt }) => ({
              deliveryId,
              requestSequence,
              turnId,
              teardownDispatched: teardownDispatchedAt !== null,
            })),
        };
      }),
      Effect.mapError(
        toPersistenceSqlError("ProviderTurnSendClaimRepository.recordDelivery:query"),
      ),
    );

  // Guard retirement in SQL rather than trusting a reactor snapshot. Only the
  // concrete named rows can move, and only when each is strictly earlier than
  // the named survivor in (request_sequence, delivery_id) order. The update is
  // monotonic and RETURNING exposes exactly which rows this call newly retired.
  const retireDeliveryRows = SqlSchema.findAll({
    Request: RetireProviderTurnSendDeliveriesInput,
    Result: RetiredDeliveryRowSchema,
    execute: (request) =>
      request.deliveryIds.length === 0
        ? sql`
            SELECT delivery_id AS "deliveryId"
            FROM provider_turn_send_deliveries
            WHERE 0
          `
        : sql`
            UPDATE provider_turn_send_deliveries AS target
            SET reconciled_at = ${request.reconciledAt}
            WHERE target.thread_id = ${request.threadId}
              AND target.message_id = ${request.messageId}
              AND target.reconciled_at IS NULL
              AND target.delivery_id IN ${sql.in(request.deliveryIds)}
              AND EXISTS (
                SELECT 1
                FROM provider_turn_send_deliveries AS survivor
                WHERE survivor.thread_id = target.thread_id
                  AND survivor.message_id = target.message_id
                  AND survivor.delivery_id = ${request.survivorDeliveryId}
                  AND (
                    target.request_sequence < survivor.request_sequence
                    OR (
                      target.request_sequence = survivor.request_sequence
                      AND target.delivery_id < survivor.delivery_id
                    )
                  )
              )
            RETURNING delivery_id AS "deliveryId"
          `,
  });

  const retireDeliveries: ProviderTurnSendClaimRepositoryShape["retireDeliveries"] = (input) =>
    retireDeliveryRows(input).pipe(
      Effect.map((rows) => rows.map((row) => row.deliveryId)),
      Effect.mapError(
        toPersistenceSqlError("ProviderTurnSendClaimRepository.retireDeliveries:query"),
      ),
    );

  // A widened stop destroys the whole provider session, including the current
  // survivor that retirement must protect. Remember that coverage separately:
  // if redrive later appends a newer row, the old survivor can be retired
  // without sending an exact-turn interrupt to a session already torn down.
  const markTeardownDispatchedRows = SqlSchema.findAll({
    Request: MarkProviderTurnSendDeliveriesTeardownDispatchedInput,
    Result: RetiredDeliveryRowSchema,
    execute: (request) =>
      request.deliveryIds.length === 0
        ? sql`
            SELECT delivery_id AS "deliveryId"
            FROM provider_turn_send_deliveries
            WHERE 0
          `
        : sql`
            UPDATE provider_turn_send_deliveries
            SET teardown_dispatched_at = ${request.dispatchedAt}
            WHERE thread_id = ${request.threadId}
              AND message_id = ${request.messageId}
              AND reconciled_at IS NULL
              AND teardown_dispatched_at IS NULL
              AND delivery_id IN ${sql.in(request.deliveryIds)}
            RETURNING delivery_id AS "deliveryId"
          `,
  });

  const markTeardownDispatched: ProviderTurnSendClaimRepositoryShape["markTeardownDispatched"] = (
    input,
  ) =>
    markTeardownDispatchedRows(input).pipe(
      Effect.map((rows) => rows.map((row) => row.deliveryId)),
      Effect.mapError(
        toPersistenceSqlError("ProviderTurnSendClaimRepository.markTeardownDispatched:query"),
      ),
    );

  // Existence only, and deliberately barrier-blind: a stop raised after the
  // claim does not un-send the prompt, so filtering by the barrier here would
  // report a delivered message as never-attempted. See `hasEverClaimed` on the
  // service for why recovery needs this rather than the pending row.
  const readAnyClaimForMessage = SqlSchema.findOneOption({
    Request: Schema.Struct({
      threadId: AcquireProviderTurnSendClaimInput.fields.threadId,
      messageId: AcquireProviderTurnSendClaimInput.fields.messageId,
    }),
    Result: ClaimOwnerRowSchema,
    execute: ({ threadId, messageId }) =>
      sql`
        SELECT request_sequence AS "requestSequence"
        FROM provider_turn_send_claims
        WHERE thread_id = ${threadId}
          AND message_id = ${messageId}
      `,
  });

  const hasEverClaimed: ProviderTurnSendClaimRepositoryShape["hasEverClaimed"] = (input) =>
    readAnyClaimForMessage(input).pipe(
      Effect.map((row) => row._tag === "Some"),
      Effect.mapError(
        toPersistenceSqlError("ProviderTurnSendClaimRepository.hasEverClaimed:query"),
      ),
    );

  return {
    acquire,
    cancel,
    recordDelivery,
    retireDeliveries,
    markTeardownDispatched,
    hasEverClaimed,
  } satisfies ProviderTurnSendClaimRepositoryShape;
});

export const ProviderTurnSendClaimRepositoryLive = Layer.effect(
  ProviderTurnSendClaimRepository,
  makeProviderTurnSendClaimRepository,
);
