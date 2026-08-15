/**
 * OrchestrationEventStore - Event store interface for orchestration events.
 *
 * Owns durable append/replay access to the orchestration event stream. It does
 * not reduce events into read models or apply command validation rules.
 *
 * Uses Effect `Context.Service` for dependency injection and exposes typed
 * persistence/decode errors for event append and replay operations.
 *
 * @module OrchestrationEventStore
 */
import {
  MessageId,
  ModelSelection,
  NonNegativeInt,
  OrchestrationEvent,
  SourceProposedPlanReference,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

import type { OrchestrationEventStoreError } from "../Errors.ts";

export const ThreadTurnStartClaimInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  /**
   * Sequence of the turn-start-requested event being judged. Only events strictly
   * above it count, so a request never supersedes itself.
   */
  afterSequence: NonNegativeInt,
});
export type ThreadTurnStartClaimInput = typeof ThreadTurnStartClaimInput.Type;

export const ThreadTurnStartClaim = Schema.Struct({
  /**
   * True when a later `thread.turn-start-requested` for the SAME message exists
   * on this thread. The request being judged has been superseded by a re-issue
   * (e.g. a session-exit auto-resume) and must not drive the provider itself.
   */
  supersededBySameMessage: Schema.Boolean,
  /**
   * True when ANY `thread.turn-interrupt-requested` landed on this thread after
   * the request being judged. The user stopped the thread while this reactor
   * lagged, so the prompt must not be sent even though no pending row records it
   * anymore.
   *
   * Deliberately not narrowed to "the interrupt that belongs to this request":
   * the caller asks about a request it has not yet driven, and a stop issued
   * above an undriven request cancels it regardless of what else was queued in
   * between. Binding by ordering instead lets `start A → start B → interrupt`
   * send A after the user pressed stop.
   */
  interruptedAfter: Schema.Boolean,
});
export type ThreadTurnStartClaim = typeof ThreadTurnStartClaim.Type;

export const ThreadTurnStartsAboveCutoffInput = Schema.Struct({
  threadId: ThreadId,
  /**
   * The stop's cancellation cutoff. Turn-starts at or below it were canceled by
   * the stop and are deliberately excluded; only those the stop spared are
   * returned, matching the barrier's inclusive `>=` coverage test so this read
   * and the durable claim cannot disagree about which requests a stop covers.
   */
  canceledThroughSequence: NonNegativeInt,
  /**
   * The stop's own sequence. Bounds the scan from above so a turn-start the user
   * submitted AFTER the stop was accepted is not re-driven by it: that request
   * has not been processed yet and will run on its own.
   */
  stopSequence: NonNegativeInt,
});
export type ThreadTurnStartsAboveCutoffInput = typeof ThreadTurnStartsAboveCutoffInput.Type;

export const ThreadTurnStartAboveCutoff = Schema.Struct({
  sequence: NonNegativeInt,
  messageId: MessageId,
  /**
   * The request's OWN model selection, not the thread's and not a cached one.
   *
   * Carried because a re-drive that substitutes a thread-wide cached selection
   * silently reassigns the model: two spared requests submitted on different
   * models would both restart on whichever was cached last. Optional because a
   * request that named no model legitimately has none, and the resume path
   * falls back to the thread default for exactly that case.
   */
  modelSelection: Schema.optional(ModelSelection),
  /**
   * The request's originating proposed plan, when it had one.
   *
   * Dropping it is not cosmetic: a plan-implementation turn that is re-driven
   * without its plan reference can never mark that plan implemented, so the
   * plan stays open forever with the work already done. See
   * `ThreadTurnResumeCommand.sourceProposedPlan`.
   */
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
});
export type ThreadTurnStartAboveCutoff = typeof ThreadTurnStartAboveCutoff.Type;

/**
 * OrchestrationEventStoreShape - Service API for orchestration event persistence.
 */
export interface OrchestrationEventStoreShape {
  /**
   * Persist a new orchestration event.
   *
   * @param event - Event payload without sequence (assigned by storage).
   * @returns Effect containing the stored event with assigned sequence.
   *
   * Actor kind is inferred from command/metadata before persistence.
   */
  readonly append: (
    event: Omit<OrchestrationEvent, "sequence">,
  ) => Effect.Effect<OrchestrationEvent, OrchestrationEventStoreError>;

  /**
   * Replay events after the provided sequence.
   *
   * @param sequenceExclusive - Sequence cursor (exclusive).
   * @param limit - Maximum number of events to emit.
   * @returns Stream containing ordered events.
   *
   * Reads in fixed-size pages and normalizes non-integer/negative limits.
   */
  readonly readFromSequence: (
    sequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;

  /**
   * Read all events from the beginning of the stream.
   *
   * @returns Stream containing all stored events.
   */
  readonly readAll: () => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;

  /**
   * Reports whether a turn-start for `messageId` was re-requested on this thread
   * after `afterSequence`, and whether an interrupt landed after it.
   *
   * This exists because the provider-command reactor's supersession guard cannot
   * rely on the pending turn-start projection rows alone. Those rows are
   * consumed: `turn.started` deletes the placeholder it adopts, so once a turn
   * begins there is no row left to judge a late duplicate of that same request
   * against, and the reactor would drive the provider a second time. The event
   * log is never consumed: it is append-only, so a re-request for the same
   * message is permanently observable at its own sequence regardless of what
   * happened afterwards.
   *
   * Scoped to the thread stream and to sequences above the request being
   * judged, so the cost is bounded by that thread's recent tail rather than the
   * whole log, and so a request never supersedes itself.
   */
  readonly getThreadTurnStartClaim: (
    input: ThreadTurnStartClaimInput,
  ) => Effect.Effect<ThreadTurnStartClaim, OrchestrationEventStoreError>;

  /**
   * Lists the turn-starts on this thread that a stop's narrowed cutoff spared —
   * those strictly above `canceledThroughSequence` and below `stopSequence`.
   *
   * Exists because a session stop is broader than its own cutoff. The cutoff
   * governs which QUEUED requests the barrier refuses, but the stop still tears
   * the whole provider session down, and a request the cutoff spared may already
   * have reached that session. Sparing it at the barrier and then killing the
   * session it is running in loses the same instruction the narrowing existed to
   * protect — only later, and only when the scheduler happens to let the send win
   * the race. The reactor uses this to re-drive those requests after the
   * teardown, so the outcome no longer depends on which fiber ran first.
   *
   * Two further exclusions, both of which turn a re-drive into a wrong answer
   * rather than a missing one, so they belong in the query and not in the
   * caller:
   *
   * - A request a LATER cancellation covers. This stop is not necessarily the
   *   newest event on the thread — an escalation is dispatched only after its
   *   interrupt's retries ran out, so a stop the user pressed in that window
   *   sits between the two. Judging candidates only against this stop's own
   *   cutoff would re-append a request the user already canceled, above the
   *   barrier that canceled it, restarting a session they shut down.
   * - A request whose turn already ran to a terminal state. A spared request
   *   that was sent, started, and completed before the teardown arrived does
   *   not need recovering; re-driving it runs the same prompt twice.
   *
   * Oldest first, so re-driving preserves the order the user sent them in.
   *
   * Reads the append-only log rather than the pending-start projection, because
   * the projection is consumed: a `turn.started` or a fold deletes the
   * placeholder, and those are exactly the cases where the request DID reach the
   * session and therefore most needs re-driving. Scoped to one thread's stream
   * between two sequences, so it reads that thread's recent tail.
   */
  readonly listThreadTurnStartsAboveCutoff: (
    input: ThreadTurnStartsAboveCutoffInput,
  ) => Effect.Effect<ReadonlyArray<ThreadTurnStartAboveCutoff>, OrchestrationEventStoreError>;
}

/**
 * OrchestrationEventStore - Service tag for orchestration event persistence.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const events = yield* OrchestrationEventStore
 *   return yield* Stream.runCollect(events.readAll())
 * })
 * ```
 */
export class OrchestrationEventStore extends Context.Service<
  OrchestrationEventStore,
  OrchestrationEventStoreShape
>()("@awtprod/command-center/persistence/Services/OrchestrationEventStore") {}
