/**
 * OrchestrationReactor - Composite orchestration reactor service interface.
 *
 * Coordinates startup of orchestration runtime reactors that translate domain
 * events into downstream side effects.
 *
 * @module OrchestrationReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * OrchestrationReactorShape - Service API for orchestration reactor lifecycle.
 */
export interface OrchestrationReactorShape {
  /**
   * Start orchestration-side reactors for provider/runtime/checkpoint flows.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /** Drain orchestration workers while their subscriptions are still live. */
  readonly drain: Effect.Effect<void>;

  /** Settle projected active turns that have no matching live provider turn. */
  readonly reconcileOrphanedTurns: Effect.Effect<void>;
}

/**
 * OrchestrationReactor - Service tag for orchestration reactor coordination.
 */
export class OrchestrationReactor extends Context.Service<
  OrchestrationReactor,
  OrchestrationReactorShape
>()("@awtprod/command-center/orchestration/Services/OrchestrationReactor") {}
