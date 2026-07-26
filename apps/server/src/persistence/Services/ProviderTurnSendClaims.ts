/**
 * ProviderTurnSendClaimRepository - Durable send-claim for provider turn starts.
 *
 * Owns the compare-and-set that decides, atomically, whether a given turn-start
 * request may reach the provider adapter. Exists because the reactor's
 * supersession check and its `sendTurn` call are two operations: an interrupt
 * committed between them is invisible to a decision that already passed, so the
 * reactor would send stopped work — or, for an auto-resume re-issue, drive the
 * same prompt twice.
 *
 * @module ProviderTurnSendClaimRepository
 */
import { IsoDateTime, MessageId, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const AcquireProviderTurnSendClaimInput = Schema.Struct({
  threadId: ThreadId,
  /**
   * The claim is keyed by MESSAGE, not by request. An original turn-start and a
   * session-exit auto-resume of the same message are two requests for one piece
   * of work, and only one of them may drive the provider at a time.
   */
  messageId: MessageId,
  /**
   * Sequence of the turn-start-requested event asking to send. Orders the
   * contenders for one message — the highest sequence holds the claim — so a
   * loser can distinguish "a newer request superseded me" from "the user
   * canceled me". Also compared against the thread's cancel barrier so an
   * interrupt appended after this request is honored even if it lands during
   * the acquire itself.
   */
  requestSequence: NonNegativeInt,
  claimedAt: IsoDateTime,
});
export type AcquireProviderTurnSendClaimInput = typeof AcquireProviderTurnSendClaimInput.Type;

export const CancelProviderTurnSendClaimsInput = Schema.Struct({
  threadId: ThreadId,
  /**
   * Sequence of the interrupt. Every turn-start request at or below it is
   * canceled; later requests are unaffected, so a stop never suppresses a
   * message the user sent afterwards.
   */
  canceledThroughSequence: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type CancelProviderTurnSendClaimsInput = typeof CancelProviderTurnSendClaimsInput.Type;

/**
 * ProviderTurnSendClaimRepositoryShape - Service API for durable send claims.
 */
export interface ProviderTurnSendClaimRepositoryShape {
  /**
   * Attempt to claim the right to send this message to the provider.
   *
   * Returns `true` only for the request holding the claim. Both the
   * "superseded by a newer request for this message" and the "canceled by a
   * stop at or above this request" tests are evaluated inside the write, so
   * there is no window between deciding and claiming.
   *
   * LAST-wins by `requestSequence`, matching the event-log supersession guard
   * this backs: a session-exit auto-resume re-issues the same message at a
   * higher sequence and must be able to take the claim from the original it is
   * recovering. Only the reverse — a stale request taking it from a newer one —
   * is refused.
   *
   * Idempotent for the SAME request: a replay re-reads its own winning row and
   * still gets `true`, so a retried send is not mistaken for a superseded one.
   */
  readonly acquire: (
    input: AcquireProviderTurnSendClaimInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;

  /**
   * Raise this thread's cancel barrier to `canceledThroughSequence`.
   *
   * Monotonic: a lower sequence never lowers an existing barrier, so interrupts
   * processed out of order cannot un-cancel earlier work.
   */
  readonly cancel: (
    input: CancelProviderTurnSendClaimsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProviderTurnSendClaimRepository - Service tag for durable send claims.
 */
export class ProviderTurnSendClaimRepository extends Context.Service<
  ProviderTurnSendClaimRepository,
  ProviderTurnSendClaimRepositoryShape
>()("t3/persistence/Services/ProviderTurnSendClaims/ProviderTurnSendClaimRepository") {}
