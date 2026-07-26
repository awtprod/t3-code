import { NonNegativeInt } from "@t3tools/contracts";
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
  type ProviderTurnSendClaimRepositoryShape,
} from "../Services/ProviderTurnSendClaims.ts";

// The claim row's owner, read back after the conditional upsert. Absent only
// when a cancel barrier blocked the insert and no other request had claimed.
const ClaimOwnerRowSchema = Schema.Struct({
  requestSequence: NonNegativeInt,
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
      // The winner is whoever's sequence is on the row — including this request
      // on a replay of its own successful acquire, which must still be allowed
      // to send rather than be misread as superseded by itself.
      Effect.map((owner) =>
        owner._tag === "Some" ? owner.value.requestSequence === input.requestSequence : false,
      ),
      Effect.mapError(toPersistenceSqlError("ProviderTurnSendClaimRepository.acquire:query")),
    );

  const cancel: ProviderTurnSendClaimRepositoryShape["cancel"] = (input) =>
    raiseCancelBarrier(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProviderTurnSendClaimRepository.cancel:query")),
    );

  return {
    acquire,
    cancel,
  } satisfies ProviderTurnSendClaimRepositoryShape;
});

export const ProviderTurnSendClaimRepositoryLive = Layer.effect(
  ProviderTurnSendClaimRepository,
  makeProviderTurnSendClaimRepository,
);
