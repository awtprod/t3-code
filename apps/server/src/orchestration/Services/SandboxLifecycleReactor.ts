import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface SandboxLifecycleReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class SandboxLifecycleReactor extends Context.Reference<SandboxLifecycleReactorShape>(
  "@awtprod/command-center/orchestration/Services/SandboxLifecycleReactor",
  { defaultValue: () => ({ start: () => Effect.void, drain: Effect.void }) },
) {}
