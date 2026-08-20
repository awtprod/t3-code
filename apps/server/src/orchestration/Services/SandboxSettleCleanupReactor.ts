/**
 * SandboxSettleCleanupReactor - Reclaims a thread's sandbox once it settles.
 *
 * Settling a thread means the user is done with it. Without this reactor the
 * container, network, and volumes stay up until the hourly idle sweep or an
 * explicit Stop, which on a host where every thread gets its own container is
 * the difference between "done" and "reclaimed".
 *
 * @module SandboxSettleCleanupReactor
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * SandboxSettleCleanupReactorShape - Service API for settle-time sandbox cleanup.
 */
export interface SandboxSettleCleanupReactorShape {
  /**
   * Start reacting to thread.settled orchestration domain events.
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
 * SandboxSettleCleanupReactor - Service tag for settle-time sandbox cleanup.
 *
 * A reference with an inert default, matching `SandboxLifecycleReactor`: settle
 * cleanup is optional housekeeping, so a composition that never provides it --
 * the integration harness, reactor wiring tests -- simply does not reclaim
 * sandboxes rather than failing to build.
 */
export class SandboxSettleCleanupReactor extends Context.Reference<SandboxSettleCleanupReactorShape>(
  "@awtprod/command-center/orchestration/Services/SandboxSettleCleanupReactor",
  { defaultValue: () => ({ start: () => Effect.void, drain: Effect.void }) },
) {}
