import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AutomationRuns, type AutomationRunsShape } from "../AutomationRuns.ts";
import { AUTOMATION_RECOVERY_HOLD_ENV, make } from "./RecoveryCoordinator.ts";
import {
  AutomationRuntime,
  type AutomationRuntimeShape,
  readAutomationRecoveryHold,
} from "./Runtime.ts";

// The deploy-time recovery hold is parsed fail-closed: only unset or a
// false-like value releases it, and no value can stop the server starting.
// Enforcement is per execution in AutomationRuns (AutomationLeaseFencing.test).

const withEnv = (env: Readonly<Record<string, string>>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env }));

for (const value of [undefined, "", "false", "False", "0", "no", "OFF", "n"]) {
  it.effect(`does not hold for ${JSON.stringify(value)}`, () =>
    Effect.gen(function* () {
      expect(yield* readAutomationRecoveryHold).toBe(false);
    }).pipe(
      Effect.provide(withEnv(value === undefined ? {} : { [AUTOMATION_RECOVERY_HOLD_ENV]: value })),
    ),
  );
}

for (const value of ["true", "1", "TRUE", "yes", "enabled", "hold-please"]) {
  it.effect(`holds for ${JSON.stringify(value)}`, () =>
    Effect.gen(function* () {
      expect(yield* readAutomationRecoveryHold).toBe(true);
    }).pipe(Effect.provide(withEnv({ [AUTOMATION_RECOVERY_HOLD_ENV]: value }))),
  );
}

it.effect("keeps ticking while held so work created after start still recovers", () => {
  const calls = { recoverDue: 0 };
  const layer = Layer.mergeAll(
    Layer.succeed(
      AutomationRuns,
      AutomationRuns.of({
        recoverDue: () =>
          Effect.sync(() => {
            calls.recoverDue += 1;
            return { scanned: 0, recovered: 0, remaining: 0, failures: [] };
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
    withEnv({ [AUTOMATION_RECOVERY_HOLD_ENV]: "true" }),
  );
  return Effect.gen(function* () {
    yield* (yield* make).tick();
    expect(calls.recoverDue).toBe(1);
  }).pipe(Effect.provide(layer));
});
