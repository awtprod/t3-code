import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface StalledTurnWatchdogShape {
  /**
   * Start the background stalled-turn watchdog within the provided scope.
   *
   * The watchdog periodically auto-fails turns whose provider stream has gone
   * silent — a running turn with no provider activity for the configured
   * threshold — so a wedged turn self-heals instead of spinning forever until a
   * human clicks interrupt.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class StalledTurnWatchdog extends Context.Service<
  StalledTurnWatchdog,
  StalledTurnWatchdogShape
>()("@awtprod/command-center/orchestration/Services/StalledTurnWatchdog") {}
