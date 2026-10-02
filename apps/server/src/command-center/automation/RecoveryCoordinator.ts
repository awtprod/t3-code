import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";

import * as AutomationRuns from "../AutomationRuns.ts";
import * as AutomationRuntime from "./Runtime.ts";

const DEFAULT_POLL_INTERVAL = Duration.seconds(5);
const DEFAULT_BATCH_LIMIT = 50;

/**
 * Operator hold: when true, recovery ticks resume nothing. Set it for a deploy
 * while stranded executions are inventoried and decided (see
 * docs/operations/automation-recovery-hold.md); unset it to resume recovery.
 */
export const AUTOMATION_RECOVERY_HOLD_ENV = "COMMAND_CENTER_AUTOMATION_RECOVERY_HOLD";
const emptyReport = { scanned: 0, recovered: 0, remaining: 0, failures: [] };

export interface AutomationRecoveryCoordinatorShape {
  readonly tick: () => Effect.Effect<AutomationRuns.AutomationRecoveryReport, never>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class AutomationRecoveryCoordinator extends Context.Service<
  AutomationRecoveryCoordinator,
  AutomationRecoveryCoordinatorShape
>()(
  "@awtprod/command-center/command-center/automation/RecoveryCoordinator/AutomationRecoveryCoordinator",
) {}

export const make = Effect.gen(function* () {
  const runs = yield* AutomationRuns.AutomationRuns;
  const runtime = yield* AutomationRuntime.AutomationRuntime;
  const crypto = yield* Crypto.Crypto;
  const workerId = `recovery:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`;
  const tickLock = yield* Semaphore.make(1);
  const held = yield* Config.boolean(AUTOMATION_RECOVERY_HOLD_ENV).pipe(Config.withDefault(false));

  const tick: AutomationRecoveryCoordinatorShape["tick"] = () =>
    held
      ? Effect.succeed(emptyReport)
      : tickLock.withPermits(1)(
          runs.recoverDue({ owner: workerId, limit: DEFAULT_BATCH_LIMIT }).pipe(
            Effect.tap(() => runtime.reconcileActiveSlots({ limit: DEFAULT_BATCH_LIMIT })),
            Effect.tap((report) =>
              report.scanned > 0 || report.failures.length > 0
                ? Effect.logInfo("command-center.automation.recovery-tick", {
                    scanned: report.scanned,
                    recovered: report.recovered,
                    remaining: report.remaining,
                    failures: report.failures.length,
                  })
                : Effect.void,
            ),
            Effect.catch((cause) =>
              Effect.logWarning("command-center.automation.recovery-tick-failed", { cause }).pipe(
                Effect.as(emptyReport),
              ),
            ),
          ),
        );

  const start: AutomationRecoveryCoordinatorShape["start"] = () =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(tick().pipe(Effect.repeat(Schedule.spaced(DEFAULT_POLL_INTERVAL))));
      yield* Effect.logInfo("command-center.automation.recovery-coordinator-started", {
        pollIntervalMs: Duration.toMillis(DEFAULT_POLL_INTERVAL),
        batchLimit: DEFAULT_BATCH_LIMIT,
        held,
      });
      if (held) {
        yield* Effect.logWarning("command-center.automation.recovery-held", {
          message: `${AUTOMATION_RECOVERY_HOLD_ENV} is set; no automation execution will be resumed until it is unset.`,
        });
      }
    });

  return AutomationRecoveryCoordinator.of({ tick, start });
});

export const layer = Layer.effect(AutomationRecoveryCoordinator, make);
