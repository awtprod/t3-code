const FIELD_LIMITS = [
  { minimum: 0, maximum: 59 },
  { minimum: 0, maximum: 23 },
  { minimum: 1, maximum: 31 },
  { minimum: 1, maximum: 12 },
  { minimum: 0, maximum: 7 },
] as const;

const WEEKDAY_NUMBERS: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

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

export interface ParsedAutomationCronExpression {
  readonly sources: readonly [string, string, string, string, string];
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

export function parseAutomationCronExpression(
  expression: string,
): ParsedAutomationCronExpression | undefined {
  const sources = expression.trim().split(/\s+/u);
  if (sources.length !== FIELD_LIMITS.length) return undefined;
  const parsed = sources.map((source, index) => {
    const limits = FIELD_LIMITS[index]!;
    return fieldValues(source!, limits.minimum, limits.maximum);
  });
  if (parsed.some((field) => field === undefined)) return undefined;
  return {
    sources: [sources[0]!, sources[1]!, sources[2]!, sources[3]!, sources[4]!],
    fields: [parsed[0]!, parsed[1]!, parsed[2]!, parsed[3]!, parsed[4]!],
    dayOfMonthWildcard: sources[2] === "*",
    dayOfWeekWildcard: sources[4] === "*",
  };
}

export function isValidAutomationTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
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
  const weekday = WEEKDAY_NUMBERS[value("weekday") ?? ""];
  const minute = Number(value("minute"));
  const hour = Number(value("hour"));
  const day = Number(value("day"));
  const month = Number(value("month"));
  return weekday === undefined || [minute, hour, day, month].some(Number.isNaN)
    ? undefined
    : { minute, hour, day, month, weekday };
}

export function automationScheduleMatches(
  expression: string,
  timezone: string,
  scheduledFor: Date | string,
): boolean {
  const cron = parseAutomationCronExpression(expression);
  // @effect-diagnostics-next-line globalDate:off -- public scheduling utility accepts native dates.
  const at = scheduledFor instanceof Date ? scheduledFor : new Date(scheduledFor);
  if (cron === undefined || Number.isNaN(at.getTime()) || !isValidAutomationTimeZone(timezone)) {
    return false;
  }
  const parts = zonedParts(at, timezone);
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

function formatTime(hour: number, minute: number): string {
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${minute.toString().padStart(2, "0")} ${suffix}`;
}

function exactSingleValue(source: string): number | undefined {
  return /^\d+$/u.test(source) ? Number(source) : undefined;
}

export function describeAutomationSchedule(expression: string): string {
  const parsed = parseAutomationCronExpression(expression);
  if (parsed === undefined) return "Invalid recurring schedule";
  const [minuteSource, hourSource, daySource, monthSource, weekdaySource] = parsed.sources;
  if (daySource !== "*" || monthSource !== "*") {
    const minute = exactSingleValue(minuteSource);
    const hour = exactSingleValue(hourSource);
    const day = exactSingleValue(daySource);
    if (
      minute !== undefined &&
      hour !== undefined &&
      day !== undefined &&
      monthSource === "*" &&
      weekdaySource === "*"
    ) {
      return `Monthly on day ${day} at ${formatTime(hour, minute)}`;
    }
    return "Custom recurring schedule";
  }
  if (minuteSource === "*" && hourSource === "*" && weekdaySource === "*") return "Every minute";
  const minuteStep = /^\*\/(\d+)$/u.exec(minuteSource)?.[1];
  if (minuteStep && hourSource === "*" && weekdaySource === "*") {
    return `Every ${minuteStep} minutes`;
  }
  const minute = exactSingleValue(minuteSource);
  if (minute === undefined) return "Custom recurring schedule";
  if (hourSource === "*" && weekdaySource === "*") {
    return minute === 0 ? "Every hour" : `Every hour at :${minute.toString().padStart(2, "0")}`;
  }
  const hourStep = /^\*\/(\d+)$/u.exec(hourSource)?.[1];
  if (hourStep && weekdaySource === "*")
    return `Every ${hourStep} hours at :${minute.toString().padStart(2, "0")}`;
  const hour = exactSingleValue(hourSource);
  if (hour === undefined) return "Custom recurring schedule";
  const time = formatTime(hour, minute);
  if (weekdaySource === "*") return `Every day at ${time}`;
  if (weekdaySource === "1-5") return `Weekdays at ${time}`;
  const weekdayValues = [...parsed.fields[4]]
    .map((value) => (value === 7 ? 0 : value))
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((left, right) => left - right);
  if (weekdayValues.length > 0) {
    return `Every ${weekdayValues.map((value) => WEEKDAY_LABELS[value]).join(", ")} at ${time}`;
  }
  return "Custom recurring schedule";
}

export function nextAutomationScheduleOccurrences(
  expression: string,
  timezone: string,
  options: { readonly from?: Date; readonly count?: number; readonly maxDays?: number } = {},
): ReadonlyArray<string> {
  if (
    parseAutomationCronExpression(expression) === undefined ||
    !isValidAutomationTimeZone(timezone)
  )
    return [];
  const count = Math.max(1, Math.min(10, options.count ?? 3));
  const maxMinutes = Math.max(1, Math.min(740, options.maxDays ?? 370)) * 24 * 60;
  // @effect-diagnostics-next-line globalDate:off -- scheduling preview starts at wall-clock now.
  const from = options.from ?? new Date();
  // @effect-diagnostics-next-line globalDate:off -- mutable cursor keeps the bounded scan inexpensive.
  const cursor = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  const matches: string[] = [];
  for (let offset = 0; offset < maxMinutes && matches.length < count; offset += 1) {
    if (automationScheduleMatches(expression, timezone, cursor)) matches.push(cursor.toISOString());
    cursor.setTime(cursor.getTime() + 60_000);
  }
  return matches;
}

export type AutomationSchedulePreset =
  | { readonly frequency: "minutes"; readonly interval: number }
  | { readonly frequency: "hours"; readonly interval: number; readonly minute: number }
  | { readonly frequency: "daily" | "weekdays"; readonly hour: number; readonly minute: number }
  | {
      readonly frequency: "weekly";
      readonly weekdays: ReadonlyArray<number>;
      readonly hour: number;
      readonly minute: number;
    }
  | {
      readonly frequency: "monthly";
      readonly dayOfMonth: number;
      readonly hour: number;
      readonly minute: number;
    };

function boundedInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

export function automationSchedulePresetExpression(preset: AutomationSchedulePreset): string {
  switch (preset.frequency) {
    case "minutes":
      return `*/${boundedInteger(preset.interval, 1, 59)} * * * *`;
    case "hours":
      return `${boundedInteger(preset.minute, 0, 59)} */${boundedInteger(preset.interval, 1, 23)} * * *`;
    case "daily":
      return `${boundedInteger(preset.minute, 0, 59)} ${boundedInteger(preset.hour, 0, 23)} * * *`;
    case "weekdays":
      return `${boundedInteger(preset.minute, 0, 59)} ${boundedInteger(preset.hour, 0, 23)} * * 1-5`;
    case "weekly": {
      const weekdays = [...new Set(preset.weekdays.map((value) => boundedInteger(value, 0, 6)))]
        .sort()
        .join(",");
      return `${boundedInteger(preset.minute, 0, 59)} ${boundedInteger(preset.hour, 0, 23)} * * ${weekdays || "1"}`;
    }
    case "monthly":
      return `${boundedInteger(preset.minute, 0, 59)} ${boundedInteger(preset.hour, 0, 23)} ${boundedInteger(preset.dayOfMonth, 1, 31)} * *`;
  }
}
