import { AutomationId, SpaceId, type Automation } from "@command-center/core";
import {
  COMMAND_CENTER_WEBHOOK_MAX_DELIVERY_ID_CHARS,
  COMMAND_CENTER_WEBHOOK_MAX_PAYLOAD_BYTES,
  normalizeCommandCenterWebhookRoute,
  type CommandCenterAutomationExecution,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as AutomationRuns from "../AutomationRuns.ts";
import * as CommandCenterService from "../Service.ts";

const FIELD_LIMITS = [
  { minimum: 0, maximum: 59 },
  { minimum: 0, maximum: 23 },
  { minimum: 1, maximum: 31 },
  { minimum: 1, maximum: 12 },
  { minimum: 0, maximum: 7 },
] as const;
const WEEKDAYS: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};
const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

export class AutomationTriggerError extends Schema.TaggedErrorClass<AutomationTriggerError>()(
  "AutomationTriggerError",
  {
    reason: Schema.Literals([
      "not-found",
      "trigger-mismatch",
      "invalid-schedule",
      "invalid-webhook",
      "ambiguous-webhook",
      "start-failed",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

function triggerError(reason: AutomationTriggerError["reason"], message: string, cause?: unknown) {
  return new AutomationTriggerError({
    reason,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function parseInteger(value: string, minimum: number, maximum: number): number | undefined {
  if (!/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

function fieldValues(
  source: string,
  minimum: number,
  maximum: number,
): ReadonlySet<number> | undefined {
  const values = new Set<number>();
  for (const rawPart of source.split(",")) {
    const [rangeSource, stepSource, ...extra] = rawPart.split("/");
    if (rangeSource === undefined || extra.length > 0) return undefined;
    const step = stepSource === undefined ? 1 : parseInteger(stepSource, 1, maximum - minimum + 1);
    if (step === undefined) return undefined;
    let start: number;
    let end: number;
    if (rangeSource === "*") {
      start = minimum;
      end = maximum;
    } else if (rangeSource.includes("-")) {
      const [left, right, ...rangeExtra] = rangeSource.split("-");
      if (left === undefined || right === undefined || rangeExtra.length > 0) return undefined;
      const parsedLeft = parseInteger(left, minimum, maximum);
      const parsedRight = parseInteger(right, minimum, maximum);
      if (parsedLeft === undefined || parsedRight === undefined || parsedLeft > parsedRight) {
        return undefined;
      }
      start = parsedLeft;
      end = parsedRight;
    } else {
      const parsed = parseInteger(rangeSource, minimum, maximum);
      if (parsed === undefined || stepSource !== undefined) return undefined;
      start = parsed;
      end = parsed;
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values.size === 0 ? undefined : values;
}

export interface ParsedCronExpression {
  readonly fields: readonly [
    ReadonlySet<number>,
    ReadonlySet<number>,
    ReadonlySet<number>,
    ReadonlySet<number>,
    ReadonlySet<number>,
  ];
  readonly dayOfMonthWildcard: boolean;
  readonly dayOfWeekWildcard: boolean;
}

export function parseCronExpression(expression: string): ParsedCronExpression | undefined {
  const sources = expression.trim().split(/\s+/u);
  if (sources.length !== FIELD_LIMITS.length) return undefined;
  const parsed = sources.map((source, index) => {
    const limits = FIELD_LIMITS[index]!;
    return fieldValues(source!, limits.minimum, limits.maximum);
  });
  if (parsed.some((field) => field === undefined)) return undefined;
  return {
    fields: [parsed[0]!, parsed[1]!, parsed[2]!, parsed[3]!, parsed[4]!],
    dayOfMonthWildcard: sources[2] === "*",
    dayOfWeekWildcard: sources[4] === "*",
  };
}

function zonedParts(at: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    minute: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const weekday = WEEKDAYS[value("weekday") ?? ""];
  const minute = Number(value("minute"));
  const hour = Number(value("hour"));
  const day = Number(value("day"));
  const month = Number(value("month"));
  return weekday === undefined || [minute, hour, day, month].some(Number.isNaN)
    ? undefined
    : { minute, hour, day, month, weekday };
}

export function scheduleMatches(
  expression: string,
  timezone: string,
  scheduledFor: string,
): boolean {
  const cron = parseCronExpression(expression);
  const parsed = DateTime.make(scheduledFor);
  if (cron === undefined || Option.isNone(parsed)) return false;
  let parts: ReturnType<typeof zonedParts>;
  try {
    parts = zonedParts(DateTime.toDate(parsed.value), timezone);
  } catch {
    return false;
  }
  if (parts === undefined) return false;
  const [minutes, hours, days, months, weekdays] = cron.fields;
  const dayOfMonthMatches = days.has(parts.day);
  const dayOfWeekMatches = weekdays.has(parts.weekday) || (parts.weekday === 0 && weekdays.has(7));
  const dayMatches =
    cron.dayOfMonthWildcard && cron.dayOfWeekWildcard
      ? true
      : cron.dayOfMonthWildcard
        ? dayOfWeekMatches
        : cron.dayOfWeekWildcard
          ? dayOfMonthMatches
          : dayOfMonthMatches || dayOfWeekMatches;
  return (
    minutes.has(parts.minute) && hours.has(parts.hour) && months.has(parts.month) && dayMatches
  );
}

export function normalizeWebhookRoute(route: string): string | undefined {
  return normalizeCommandCenterWebhookRoute(route);
}

export interface AutomationTriggerCoordinatorShape {
  readonly admitSchedule: (input: {
    readonly automationId: AutomationId;
    readonly spaceId: SpaceId;
    readonly scheduledFor: string;
    readonly input?: Readonly<Record<string, Schema.Json>>;
  }) => Effect.Effect<CommandCenterAutomationExecution, AutomationTriggerError>;
  readonly admitWebhook: (input: {
    /** Server-derived identity of the authenticated admission channel. */
    readonly admissionSource: string;
    readonly spaceId: SpaceId;
    readonly route: string;
    readonly deliveryId: string;
    readonly payload?: Schema.Json;
  }) => Effect.Effect<CommandCenterAutomationExecution, AutomationTriggerError>;
}

export function webhookIdempotencyKey(input: {
  readonly admissionSource: string;
  readonly spaceId: SpaceId;
  readonly route: string;
  readonly deliveryId: string;
}): string {
  const digest = NodeCrypto.createHash("sha256")
    .update("command-center-webhook-idempotency-v1\n", "utf8")
    .update(input.admissionSource, "utf8")
    .update("\n", "utf8")
    .update(input.spaceId, "utf8")
    .update("\n", "utf8")
    .update(input.route, "utf8")
    .update("\n", "utf8")
    .update(input.deliveryId, "utf8")
    .digest("hex");
  return `webhook:v1:${digest}`;
}

export class AutomationTriggerCoordinator extends Context.Service<
  AutomationTriggerCoordinator,
  AutomationTriggerCoordinatorShape
>()(
  "@awtprod/command-center/command-center/automation/TriggerCoordinator/AutomationTriggerCoordinator",
) {}

export const make = Effect.gen(function* () {
  const commandCenter = yield* CommandCenterService.CommandCenterService;
  const runs = yield* AutomationRuns.AutomationRuns;

  const enabledAutomations = (spaceId: SpaceId) =>
    commandCenter.queryAutomations({ spaceId, enabled: true }).pipe(
      Effect.map(({ automations }) => automations),
      Effect.mapError((cause) => triggerError("start-failed", cause.message, cause)),
    );

  const start = Effect.fn("AutomationTriggerCoordinator.start")(function* (
    automation: Automation,
    idempotencyKey: string,
    input: JsonObject,
  ) {
    if (automation.configCommit === undefined) {
      return yield* triggerError(
        "start-failed",
        `Automation '${automation.id}' has no committed revision.`,
      );
    }
    return yield* runs
      .start({
        automationId: automation.id,
        spaceId: automation.spaceId,
        idempotencyKey,
        expectedConfigCommitSha: automation.configCommit,
        expectedDefinitionDigest: automation.definitionDigest,
        input,
      })
      .pipe(Effect.mapError((cause) => triggerError("start-failed", cause.message, cause)));
  });

  const admitSchedule = Effect.fn("AutomationTriggerCoordinator.admitSchedule")(function* (
    input: Parameters<AutomationTriggerCoordinatorShape["admitSchedule"]>[0],
  ) {
    const automations = yield* enabledAutomations(input.spaceId);
    const automation = automations.find((candidate) => candidate.id === input.automationId);
    if (automation === undefined) {
      return yield* triggerError("not-found", "The enabled scheduled automation was not found.");
    }
    if (automation.trigger.type !== "schedule") {
      return yield* triggerError(
        "trigger-mismatch",
        `Automation '${automation.id}' does not use a schedule trigger.`,
      );
    }
    const at = DateTime.make(input.scheduledFor);
    if (
      Option.isNone(at) ||
      !scheduleMatches(
        automation.trigger.expression,
        automation.trigger.timezone,
        input.scheduledFor,
      )
    ) {
      return yield* triggerError(
        "invalid-schedule",
        `The requested occurrence does not match automation '${automation.id}'.`,
      );
    }
    const occurrence = DateTime.formatIso(
      DateTime.makeUnsafe(Math.floor(DateTime.toEpochMillis(at.value) / 60_000) * 60_000),
    );
    return yield* start(automation, `schedule:${automation.id}:${occurrence}`, {
      ...input.input,
      trigger: { type: "schedule", scheduledFor: occurrence },
    });
  });

  const admitWebhook = Effect.fn("AutomationTriggerCoordinator.admitWebhook")(function* (
    input: Parameters<AutomationTriggerCoordinatorShape["admitWebhook"]>[0],
  ) {
    const route = normalizeWebhookRoute(input.route);
    const deliveryId = input.deliveryId.trim();
    const admissionSource = input.admissionSource.trim();
    const payloadBytes = Buffer.byteLength(encodeJson(input.payload ?? null), "utf8");
    if (
      route === undefined ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(admissionSource) ||
      deliveryId.length === 0 ||
      deliveryId.length > COMMAND_CENTER_WEBHOOK_MAX_DELIVERY_ID_CHARS ||
      !/^[\x21-\x7e]+$/u.test(deliveryId) ||
      payloadBytes > COMMAND_CENTER_WEBHOOK_MAX_PAYLOAD_BYTES
    ) {
      return yield* triggerError("invalid-webhook", "The webhook admission request is invalid.");
    }
    const automations = yield* enabledAutomations(input.spaceId);
    const matches = automations.filter(
      (automation) =>
        automation.trigger.type === "webhook" &&
        normalizeWebhookRoute(automation.trigger.route) === route,
    );
    if (matches.length === 0) {
      return yield* triggerError("not-found", "No enabled automation accepts this webhook route.");
    }
    if (matches.length !== 1) {
      return yield* triggerError(
        "ambiguous-webhook",
        "More than one enabled automation accepts this webhook route.",
      );
    }
    const automation = matches[0]!;
    return yield* start(
      automation,
      webhookIdempotencyKey({
        admissionSource,
        spaceId: input.spaceId,
        route,
        deliveryId,
      }),
      {
        trigger: { type: "webhook", route, deliveryId },
        payload: input.payload ?? null,
      },
    );
  });

  return AutomationTriggerCoordinator.of({ admitSchedule, admitWebhook });
});

export const layer = Layer.effect(AutomationTriggerCoordinator, make);

type JsonObject = Readonly<Record<string, Schema.Json>>;
