import type { AutomationId } from "@command-center/core";
import type { CommandCenterError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as CommandCenterService from "../Service.ts";
import * as TriggerCoordinator from "./TriggerCoordinator.ts";

const DEFAULT_POLL_INTERVAL = Duration.seconds(15);
const MAX_CATCH_UP_MINUTES = 60;
const MINUTE_MS = 60_000;

export class AutomationScheduleRunnerError extends Schema.TaggedErrorClass<AutomationScheduleRunnerError>()(
  "AutomationScheduleRunnerError",
  {
    reason: Schema.Literals(["invalid-occurrence", "persistence"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface AutomationScheduleFailure {
  readonly automationId: AutomationId;
  readonly message: string;
}

export interface AutomationScheduleTickReport {
  readonly scheduledFor: string;
  readonly scanned: number;
  readonly due: number;
  readonly admitted: number;
  readonly skippedDuplicate: boolean;
  readonly failures: ReadonlyArray<AutomationScheduleFailure>;
}

export interface AutomationScheduleRunnerShape {
  /**
   * Admit every committed, enabled schedule that is due in the supplied UTC
   * minute. The coordinator and durable runtime bind the resulting execution
   * to a minute-specific idempotency key.
   */
  readonly tick: (
    scheduledFor: string,
  ) => Effect.Effect<
    AutomationScheduleTickReport,
    AutomationScheduleRunnerError | CommandCenterError
  >;
  /** Start the internal polling loop in the caller's lifecycle scope. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class AutomationScheduleRunner extends Context.Service<
  AutomationScheduleRunner,
  AutomationScheduleRunnerShape
>()("t3/command-center/automation/ScheduleRunner/AutomationScheduleRunner") {}

function occurrenceMinute(source: string) {
  const parsed = DateTime.make(source);
  if (Option.isNone(parsed)) return undefined;
  return DateTime.formatIso(
    DateTime.makeUnsafe(Math.floor(DateTime.toEpochMillis(parsed.value) / 60_000) * 60_000),
  );
}

function occurrenceRange(lastChecked: string | undefined, current: string) {
  const currentMs = Date.parse(current);
  if (lastChecked === undefined) {
    return { occurrences: [current], truncatedBefore: undefined } as const;
  }
  const checkedMs = Date.parse(lastChecked);
  if (!Number.isFinite(checkedMs) || checkedMs >= currentMs) {
    return { occurrences: [], truncatedBefore: undefined } as const;
  }
  const requestedStart = checkedMs + MINUTE_MS;
  const boundedStart = Math.max(requestedStart, currentMs - (MAX_CATCH_UP_MINUTES - 1) * MINUTE_MS);
  const occurrences: string[] = [];
  for (let at = boundedStart; at <= currentMs; at += MINUTE_MS) {
    occurrences.push(DateTime.formatIso(DateTime.makeUnsafe(at)));
  }
  return {
    occurrences,
    truncatedBefore:
      boundedStart > requestedStart
        ? DateTime.formatIso(DateTime.makeUnsafe(boundedStart - MINUTE_MS))
        : undefined,
  } as const;
}

const persistenceError = (cause: unknown) =>
  new AutomationScheduleRunnerError({
    reason: "persistence",
    message: "The durable automation schedule cursor could not be updated.",
    cause,
  });

export const make = Effect.gen(function* () {
  const commandCenter = yield* CommandCenterService.CommandCenterService;
  const coordinator = yield* TriggerCoordinator.AutomationTriggerCoordinator;
  const sql = yield* SqlClient.SqlClient;
  const tickLock = yield* Semaphore.make(1);

  const tickUnlocked: AutomationScheduleRunnerShape["tick"] = Effect.fn(
    "AutomationScheduleRunner.tick",
  )(function* (scheduledFor) {
    const occurrence = occurrenceMinute(scheduledFor);
    if (occurrence === undefined) {
      return yield* new AutomationScheduleRunnerError({
        reason: "invalid-occurrence",
        message: "The schedule tick must contain a valid timestamp.",
      });
    }

    const { automations } = yield* commandCenter.queryAutomations({ enabled: true });
    // Filter defensively even though the service query is already constrained.
    // This keeps disabled or draft definitions inert if an alternate data source
    // ever returns a broader result.
    const candidates = automations.filter(
      (automation) =>
        automation.enabled &&
        automation.configCommit !== undefined &&
        automation.trigger.type === "schedule",
    );
    let due = 0;
    let admitted = 0;
    let evaluated = 0;
    const failures: AutomationScheduleFailure[] = [];

    for (const automation of candidates) {
      const cursorRows = yield* sql<{ readonly lastCheckedMinute: string }>`
          SELECT last_checked_minute AS "lastCheckedMinute"
          FROM command_center_automation_schedule_cursors
          WHERE automation_id = ${automation.id}
          LIMIT 1
        `.pipe(Effect.mapError(persistenceError));
      const range = occurrenceRange(cursorRows[0]?.lastCheckedMinute, occurrence);
      let lastCompleted = range.truncatedBefore;
      for (const scheduledFor of range.occurrences) {
        evaluated += 1;
        if (
          automation.trigger.type === "schedule" &&
          TriggerCoordinator.scheduleMatches(
            automation.trigger.expression,
            automation.trigger.timezone,
            scheduledFor,
          )
        ) {
          due += 1;
          const result = yield* coordinator
            .admitSchedule({
              automationId: automation.id,
              spaceId: automation.spaceId,
              scheduledFor,
            })
            .pipe(
              Effect.match({
                onFailure: (cause) => ({ ok: false as const, cause }),
                onSuccess: () => ({ ok: true as const }),
              }),
            );
          if (!result.ok) {
            failures.push({ automationId: automation.id, message: result.cause.message });
            break;
          }
          admitted += 1;
        }
        lastCompleted = scheduledFor;
      }
      if (lastCompleted !== undefined) {
        yield* sql`
            INSERT INTO command_center_automation_schedule_cursors (
              automation_id, last_checked_minute, updated_at
            ) VALUES (${automation.id}, ${lastCompleted}, ${occurrence})
            ON CONFLICT(automation_id) DO UPDATE SET
              last_checked_minute = excluded.last_checked_minute,
              updated_at = excluded.updated_at
            WHERE command_center_automation_schedule_cursors.last_checked_minute
              < excluded.last_checked_minute
          `.pipe(Effect.mapError(persistenceError));
      }
    }

    return {
      scheduledFor: occurrence,
      scanned: automations.length,
      due,
      admitted,
      skippedDuplicate: candidates.length > 0 && evaluated === 0,
      failures,
    };
  });

  const tick: AutomationScheduleRunnerShape["tick"] = (scheduledFor) =>
    tickLock.withPermits(1)(tickUnlocked(scheduledFor));

  const runCurrentMinute = Effect.gen(function* () {
    const report = yield* tick(DateTime.formatIso(yield* DateTime.now));
    if (report.due > 0 || report.failures.length > 0) {
      yield* Effect.logInfo("command-center.automation.schedule-tick", {
        scheduledFor: report.scheduledFor,
        due: report.due,
        admitted: report.admitted,
        failures: report.failures.length,
      });
    }
    for (const failure of report.failures) {
      yield* Effect.logWarning("command-center.automation.schedule-admission-failed", {
        scheduledFor: report.scheduledFor,
        automationId: failure.automationId,
        message: failure.message,
      });
    }
  });

  const start: AutomationScheduleRunnerShape["start"] = () =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        runCurrentMinute.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("command-center.automation.schedule-tick-failed", { cause }),
          ),
          Effect.repeat(Schedule.spaced(DEFAULT_POLL_INTERVAL)),
        ),
      );
      yield* Effect.logInfo("command-center.automation.schedule-runner-started", {
        pollIntervalMs: Duration.toMillis(DEFAULT_POLL_INTERVAL),
      });
    });

  return AutomationScheduleRunner.of({ tick, start });
});

export const layer = Layer.effect(AutomationScheduleRunner, make);
