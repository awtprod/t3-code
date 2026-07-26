import { NonNegativeInt, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  AcquireProviderTurnSendClaimInput,
  CancelProviderTurnSendClaimsInput,
  ProviderTurnSendClaimRepository,
  RecordProviderTurnSendDeliveryInput,
  type ProviderTurnSendClaimOutcome,
  type ProviderTurnSendClaimRepositoryShape,
  type ProviderTurnSendDeliveryState,
} from "../Services/ProviderTurnSendClaims.ts";

// The claim row's owner, read back after the conditional upsert. Absent only
// when a cancel barrier blocked the insert and no other request had claimed.
const ClaimOwnerRowSchema = Schema.Struct({
  requestSequence: NonNegativeInt,
});

const ClaimDeliveryRowSchema = Schema.Struct({
  requestSequence: NonNegativeInt,
  deliveredTurnId: Schema.NullOr(TurnId),
  supersededDeliveredTurnId: Schema.NullOr(TurnId),
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
  // A higher sequence also advances the DELIVERY state. Ownership alone must
  // never kill the old sender: the new RPC may fail after stealing the row. If
  // the old holder already stamped a successful delivery, moving that concrete
  // id into `superseded_delivered_turn_id` lets the new holder reconcile it
  // only after the new holder stamps its own successful, distinct replacement.
  // If the old RPC has not returned yet, `delivered_turn_id` is null and the
  // late old sender will populate the superseded slot itself. Existing
  // superseded evidence is preserved when there is no current delivery, so a
  // chain of ownership changes does not erase the only known successful old
  // send merely because an intermediate owner failed.
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
          claimed_at = excluded.claimed_at,
          delivered_turn_id = NULL,
          superseded_delivered_turn_id = CASE
            WHEN provider_turn_send_claims.delivered_turn_id IS NOT NULL
              THEN provider_turn_send_claims.delivered_turn_id
            ELSE provider_turn_send_claims.superseded_delivered_turn_id
          END
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

  // Phase two of the claim protocol. A successful CURRENT holder stamps the
  // current-delivery slot; a successful EX-holder whose RPC crossed a takeover
  // stamps the superseded slot. The `request_sequence >=` predicate is a safety
  // fence against impossible/corrupt backwards ownership: without it, a
  // delivery for a sequence that never owned this row could be recorded as
  // stale evidence and later used to interrupt an unrelated healthy turn.
  //
  // This write and the read below intentionally remain separate statements.
  // SQLite serializes all claim writes. For two completing sends, whichever
  // stamp runs second necessarily follows the first stamp; its subsequent read
  // sees both ids. Wrapping each pair in a transaction is unnecessary for that
  // invariant and would lengthen the write lock around an ordinary read.
  const stampDeliveredTurn = SqlSchema.void({
    Request: RecordProviderTurnSendDeliveryInput,
    execute: (request) =>
      sql`
        UPDATE provider_turn_send_claims
        SET
          delivered_turn_id = CASE
            WHEN request_sequence = ${request.requestSequence}
              THEN ${request.turnId}
            ELSE delivered_turn_id
          END,
          superseded_delivered_turn_id = CASE
            WHEN request_sequence > ${request.requestSequence}
              THEN ${request.turnId}
            ELSE superseded_delivered_turn_id
          END
        WHERE thread_id = ${request.threadId}
          AND message_id = ${request.messageId}
          AND request_sequence >= ${request.requestSequence}
      `,
  });

  const readDeliveryState = SqlSchema.findOneOption({
    Request: Schema.Struct({
      threadId: RecordProviderTurnSendDeliveryInput.fields.threadId,
      messageId: RecordProviderTurnSendDeliveryInput.fields.messageId,
      requestSequence: RecordProviderTurnSendDeliveryInput.fields.requestSequence,
    }),
    Result: ClaimDeliveryRowSchema,
    execute: ({ threadId, messageId, requestSequence }) =>
      sql`
        SELECT
          request_sequence AS "requestSequence",
          delivered_turn_id AS "deliveredTurnId",
          superseded_delivered_turn_id AS "supersededDeliveredTurnId"
        FROM provider_turn_send_claims
        WHERE thread_id = ${threadId}
          AND message_id = ${messageId}
          AND request_sequence >= ${requestSequence}
      `,
  });

  const recordDelivery: ProviderTurnSendClaimRepositoryShape["recordDelivery"] = (input) =>
    stampDeliveredTurn(input).pipe(
      Effect.flatMap(() =>
        readDeliveryState({
          threadId: input.threadId,
          messageId: input.messageId,
          requestSequence: input.requestSequence,
        }),
      ),
      Effect.map(
        (row): ProviderTurnSendDeliveryState =>
          row._tag === "Some"
            ? {
                _tag: "recorded",
                heldBySequence: row.value.requestSequence,
                deliveredTurnId: row.value.deliveredTurnId,
                supersededDeliveredTurnId: row.value.supersededDeliveredTurnId,
              }
            : { _tag: "unowned" },
      ),
      Effect.mapError(
        toPersistenceSqlError("ProviderTurnSendClaimRepository.recordDelivery:query"),
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
    hasEverClaimed,
  } satisfies ProviderTurnSendClaimRepositoryShape;
});

export const ProviderTurnSendClaimRepositoryLive = Layer.effect(
  ProviderTurnSendClaimRepository,
  makeProviderTurnSendClaimRepository,
);
