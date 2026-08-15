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
import { IsoDateTime, MessageId, NonNegativeInt, ThreadId, TurnId } from "@t3tools/contracts";
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

export const RecordProviderTurnSendDeliveryInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  requestSequence: NonNegativeInt,
  /**
   * The concrete provider turn returned by a successful send. This is delivery
   * evidence, not merely ownership evidence: callers must never invoke this
   * method for a failed or indeterminate send.
   */
  turnId: TurnId,
});
export type RecordProviderTurnSendDeliveryInput = typeof RecordProviderTurnSendDeliveryInput.Type;

export const RetireProviderTurnSendDeliveriesInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  /**
   * Concrete rows whose external reconciliation action succeeded. Naming rows
   * rather than deriving them again prevents a later completion from widening
   * this write to evidence the caller never acted on.
   */
  deliveryIds: Schema.Array(NonNegativeInt),
  /**
   * The row that was the newest live delivery when reconciliation began.
   * SQL requires every target to be strictly earlier in the total order, so a
   * stale caller can never retire its named survivor.
   */
  survivorDeliveryId: NonNegativeInt,
  reconciledAt: IsoDateTime,
});
export type RetireProviderTurnSendDeliveriesInput =
  typeof RetireProviderTurnSendDeliveriesInput.Type;

export const MarkProviderTurnSendDeliveriesTeardownDispatchedInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  /**
   * Concrete deliveries known to be covered by one successfully dispatched
   * widened session stop. This includes the current survivor: it remains live,
   * but a later redrive can retire it without interrupting the torn-down
   * session once a newer survivor exists.
   */
  deliveryIds: Schema.Array(NonNegativeInt),
  dispatchedAt: IsoDateTime,
});
export type MarkProviderTurnSendDeliveriesTeardownDispatchedInput =
  typeof MarkProviderTurnSendDeliveriesTeardownDispatchedInput.Type;

/**
 * Why a request may not send, or that it may.
 *
 * The two refusals are deliberately NOT collapsed into one `false`. A
 * `canceled` result means the user stopped work that is now running and it must
 * be interrupted. A `superseded` result normally makes the pre-send path stand
 * down; after a send, a concrete higher `heldBySequence` instead proves this
 * sender lost ownership while its RPC was in flight, so its own returned turn
 * is the stale duplicate that must be interrupted.
 */
export type ProviderTurnSendClaimOutcome =
  /** This request holds the claim and is the one that may drive the provider. */
  | { readonly _tag: "acquired" }
  /** A stop at or above this request's sequence covers it. */
  | { readonly _tag: "canceled" }
  /**
   * Someone other than this request owns the claim.
   *
   * `heldBySequence` is absent in the one case where no row names an owner at
   * all. That should be unreachable — an uncanceled insert either installs this
   * request or loses to a higher one — but it is bucketed here rather than with
   * `canceled` on purpose: without a concrete owner, the post-send fence does
   * nothing, so an unexplained state never manufactures an interrupt of a turn
   * that is running correctly.
   */
  | { readonly _tag: "superseded"; readonly heldBySequence?: number };

export interface ProviderTurnSendDelivery {
  /**
   * SQLite integer insertion order. Together with requestSequence this defines
   * a total order even when equal-sequence replay returns distinct turns.
   */
  readonly deliveryId: number;
  readonly requestSequence: number;
  readonly turnId: TurnId;
  /**
   * A widened session-stop command was durably dispatched while this delivery
   * was live. The row is not retired until a newer survivor exists, but no
   * exact-turn interrupt is needed then because teardown covered it.
   */
  readonly teardownDispatched: boolean;
}

/**
 * All durable delivery evidence after one successful sender stamps its result.
 *
 * Unreconciled rows are ordered by (requestSequence, deliveryId) so every caller
 * derives the same survivor: the final successfully DELIVERED concrete turn,
 * regardless of which request currently owns the claim. Evidence is per
 * (request, concrete turn) pair and is never overwritten by a later request or
 * an equal-sequence replay, so an A/B/C chain cannot lose A when B returns.
 *
 * `unowned` is the safe result when no claim row can correlate the delivery.
 * Like the owner-less `superseded` acquire fallback, it carries no invented
 * owner or turn and therefore cannot manufacture an interrupt.
 */
export type ProviderTurnSendDeliveryState =
  | {
      readonly _tag: "recorded";
      readonly deliveries: ReadonlyArray<ProviderTurnSendDelivery>;
    }
  | { readonly _tag: "unowned" };

/**
 * ProviderTurnSendClaimRepositoryShape - Service API for durable send claims.
 */
export interface ProviderTurnSendClaimRepositoryShape {
  /**
   * Attempt to claim the right to send this message to the provider.
   *
   * Returns `acquired` only for the request holding the claim. Both the
   * "superseded by a newer request for this message" and the "canceled by a
   * stop at or above this request" tests are evaluated against the same write,
   * so there is no window between deciding and claiming.
   *
   * LAST-wins by `requestSequence`, matching the event-log supersession guard
   * this backs: a session-exit auto-resume re-issues the same message at a
   * higher sequence and must be able to take the claim from the original it is
   * recovering. Only the reverse — a stale request taking it from a newer one —
   * is refused.
   *
   * Idempotent for the SAME request: a replay re-reads its own winning row and
   * is still told `acquired`, so a retried send is not mistaken for a
   * superseded one.
   */
  readonly acquire: (
    input: AcquireProviderTurnSendClaimInput,
  ) => Effect.Effect<ProviderTurnSendClaimOutcome, ProjectionRepositoryError>;

  /**
   * Raise this thread's cancel barrier to `canceledThroughSequence`.
   *
   * Monotonic: a lower sequence never lowers an existing barrier, so interrupts
   * processed out of order cannot un-cancel earlier work.
   */
  readonly cancel: (
    input: CancelProviderTurnSendClaimsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Idempotently stamp one successful (request sequence, concrete turn) pair
   * and return all LIVE delivery evidence for its message in ascending
   * (requestSequence, deliveryId) order.
   *
   * The write is allowed only while a claim row can correlate this request to
   * the message. Successful ex-holders remain eligible after takeover, but an
   * owner-less fallback cannot manufacture evidence. A pair that was inserted
   * is always reported as `recorded`, even if a racing reconciliation retires
   * it before this method's read; another equal-sequence turn can neither
   * overwrite nor remove it.
   */
  readonly recordDelivery: (
    input: RecordProviderTurnSendDeliveryInput,
  ) => Effect.Effect<ProviderTurnSendDeliveryState, ProjectionRepositoryError>;

  /**
   * Durably retire concrete stale rows after their external reconciliation
   * action succeeds.
   *
   * Monotonic and idempotent. SQL updates only unreconciled named rows that are
   * strictly earlier than the named survivor in the total
   * (requestSequence, deliveryId) order. The survivor itself and any row newer
   * than it are therefore protected even if a stale reactor pass supplies them.
   *
   * Returns the delivery ids newly retired by this call. An empty result means
   * every eligible target was already retired or failed the survivor guard.
   */
  readonly retireDeliveries: (
    input: RetireProviderTurnSendDeliveriesInput,
  ) => Effect.Effect<ReadonlyArray<number>, ProjectionRepositoryError>;

  /**
   * Monotonically mark concrete live deliveries as covered by a successfully
   * dispatched widened session stop.
   *
   * This is distinct from retirement so the current survivor stays protected.
   * If redrive later inserts a newer survivor, reconciliation can retire the
   * covered predecessor without re-interrupting its already-torn-down turn.
   */
  readonly markTeardownDispatched: (
    input: MarkProviderTurnSendDeliveriesTeardownDispatchedInput,
  ) => Effect.Effect<ReadonlyArray<number>, ProjectionRepositoryError>;

  /**
   * Has any request for this message ever been cleared to reach the provider?
   *
   * This is the only durable record of an ATTEMPTED send. The reactor acquires
   * the claim in the statement immediately upstream of
   * `providerService.sendTurn`, with nothing between them, so a missing row
   * proves the adapter was never called for this message — and a present row
   * means it may have been: the prompt could be in flight, delivered, or already
   * executing tools, and a crash before `sendTurn` returns leaves all three
   * indistinguishable.
   *
   * That asymmetry is the point. Recovery needs positive evidence that nothing
   * was sent before it re-issues a message, and the absence of a projection row
   * cannot supply it. A steer that was DELIVERED and folded loses its pending
   * row, but a steer delivered without folding — the adapter began the work and
   * the provider died before `sendTurn` returned, so no `turn.started` and no
   * fold were ever projected — KEEPS its pending row while having reached the
   * provider. The placeholder cannot tell those apart; the claim can.
   *
   * Deliberately NOT filtered by the cancel barrier, unlike the reads inside
   * `acquire`. A barrier that rose after the claim does not un-send the prompt,
   * and the question here is only ever "could the provider have received this?".
   */
  readonly hasEverClaimed: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
}

/**
 * ProviderTurnSendClaimRepository - Service tag for durable send claims.
 */
export class ProviderTurnSendClaimRepository extends Context.Service<
  ProviderTurnSendClaimRepository,
  ProviderTurnSendClaimRepositoryShape
>()(
  "@awtprod/command-center/persistence/Services/ProviderTurnSendClaims/ProviderTurnSendClaimRepository",
) {}
