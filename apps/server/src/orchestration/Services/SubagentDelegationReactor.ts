/**
 * SubagentDelegationReactor - Runs cross-provider routed turns in subagent
 * threads and reports their replies back to the parent thread.
 *
 * Auto routing can pick a model the thread's bound session cannot serve (a
 * different provider driver). The dispatcher turns such a turn into
 * `thread.turn.delegate`; this reactor starts the turn in a child thread on the
 * routed model and, when that turn settles, posts its final reply into the
 * parent as an activity.
 *
 * @module SubagentDelegationReactor
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * SubagentDelegationReactorShape - Service API for subagent delegation.
 */
export interface SubagentDelegationReactorShape {
  /**
   * Start reacting to subagent delegation and child session events.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * SubagentDelegationReactor - Service tag for subagent delegation.
 *
 * A reference with an inert default, like `SandboxSettleCleanupReactor`, so a
 * composition that never provides it (the integration harness, reactor wiring
 * tests) builds and simply leaves delegated turns unstarted.
 */
export class SubagentDelegationReactor extends Context.Reference<SubagentDelegationReactorShape>(
  "@awtprod/command-center/orchestration/Services/SubagentDelegationReactor",
  { defaultValue: () => ({ start: () => Effect.void, drain: Effect.void }) },
) {}
