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
import { MessageId, NonNegativeInt, OrchestrationEvent, ThreadId } from "@t3tools/contracts";
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
>()("t3/persistence/Services/OrchestrationEventStore") {}
