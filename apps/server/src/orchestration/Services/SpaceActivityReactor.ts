/**
 * SpaceActivityReactor - Records finished thread turns and Runs in the
 * per-Space activity feed (`command_center_space_activity`).
 *
 * @module SpaceActivityReactor
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface SpaceActivityReactorShape {
  /**
   * Start recording activity. Must run in a scope so the worker and stream
   * fibers are finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /** Resolves when the processing queue is empty and idle (tests). */
  readonly drain: Effect.Effect<void>;
}

/**
 * A reference with an inert default, like `SubagentDelegationReactor`, so a
 * composition that never provides it (integration harnesses) still builds.
 */
export class SpaceActivityReactor extends Context.Reference<SpaceActivityReactorShape>(
  "@awtprod/command-center/orchestration/Services/SpaceActivityReactor",
  { defaultValue: () => ({ start: () => Effect.void, drain: Effect.void }) },
) {}
