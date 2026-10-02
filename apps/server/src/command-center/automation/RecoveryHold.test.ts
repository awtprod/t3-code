import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AutomationRuns, type AutomationRunsShape } from "../AutomationRuns.ts";
import { AUTOMATION_RECOVERY_HOLD_ENV, make } from "./RecoveryCoordinator.ts";
import { AutomationRuntime, type AutomationRuntimeShape } from "./Runtime.ts";

// The deploy-time recovery hold: with the operator flag set, recovery ticks
// resume nothing; without it they run as before.

const harness = (env: Readonly<Record<string, string>>) => {
  const calls = { recoverDue: 0 };
  const layer = Layer.mergeAll(
    Layer.succeed(
      AutomationRuns,
      AutomationRuns.of({
        recoverDue: () =>
          Effect.sync(() => {
            calls.recoverDue += 1;
            return { scanned: 1, recovered: 1, remaining: 0, failures: [] };
          }),
      } as unknown as AutomationRunsShape),
    ),
    Layer.succeed(
      AutomationRuntime,
      AutomationRuntime.of({
        reconcileActiveSlots: () => Effect.succeed({ released: 0 }),
      } as unknown as AutomationRuntimeShape),
    ),
    NodeServices.layer,
    ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
  );
  return { calls, layer };
};

{
  const { calls, layer } = harness({ [AUTOMATION_RECOVERY_HOLD_ENV]: "true" });
  it.effect("resumes nothing while the operator hold is set", () =>
    Effect.gen(function* () {
      const coordinator = yield* make;
      expect(yield* coordinator.tick()).toEqual({
        scanned: 0,
        recovered: 0,
        remaining: 0,
        failures: [],
      });
      expect(calls.recoverDue).toBe(0);
    }).pipe(Effect.provide(layer)),
  );
}

{
  const { calls, layer } = harness({});
  it.effect("recovers normally when the hold is not set", () =>
    Effect.gen(function* () {
      const coordinator = yield* make;
      expect((yield* coordinator.tick()).recovered).toBe(1);
      expect(calls.recoverDue).toBe(1);
    }).pipe(Effect.provide(layer)),
  );
}

{
  const { calls, layer } = harness({ [AUTOMATION_RECOVERY_HOLD_ENV]: "false" });
  it.effect("recovers normally when the hold is explicitly off", () =>
    Effect.gen(function* () {
      const coordinator = yield* make;
      yield* coordinator.tick();
      expect(calls.recoverDue).toBe(1);
    }).pipe(Effect.provide(layer)),
  );
}
