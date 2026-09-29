import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

export const SPRINT_PLAN_IMPORT_LIMITS = {
  bytes: 1_048_576,
  depth: 32,
  nodes: 20_000,
  objectKeys: 256,
  keyLength: 128,
  stringLength: 8_192,
  scores: 64,
  weeks: 64,
  tasksPerWeek: 512,
  tasks: 4_096,
} as const;

export type SprintPlanJson =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<SprintPlanJson>
  | { readonly [key: string]: SprintPlanJson };

export interface SprintPlanScoreSource {
  readonly id: string;
  readonly label: string;
  readonly start: string;
  readonly now: string;
  readonly target: string;
  readonly [key: string]: SprintPlanJson;
}

export interface SprintPlanTaskSource {
  readonly id: string;
  readonly text: string;
  readonly owner: string;
  readonly day: string;
  readonly note: string;
  readonly done: boolean;
  readonly [key: string]: SprintPlanJson;
}

export interface SprintPlanWeekSource {
  readonly id: string;
  readonly num: number;
  readonly start: string;
  readonly end: string;
  readonly range: string;
  readonly tue: string;
  readonly fri: string;
  readonly tasks: ReadonlyArray<SprintPlanTaskSource>;
  readonly [key: string]: SprintPlanJson;
}

export interface SprintPlanSource {
  readonly version: number;
  readonly updated: string;
  readonly score: ReadonlyArray<SprintPlanScoreSource>;
  readonly weeks: ReadonlyArray<SprintPlanWeekSource>;
  readonly [key: string]: SprintPlanJson;
}

export interface SprintPlanDateConflict {
  readonly taskId: string;
  readonly weekId: string;
  readonly sourceDay: string;
  readonly dayDate?: string | undefined;
  readonly textDateReference: string;
  readonly textDate?: string | undefined;
  readonly reason: "different-dates" | "weekday-mismatch";
}

export interface NormalizedSprintPlanTask {
  readonly id: string;
  readonly text: string;
  readonly owner: string;
  readonly day: string;
  readonly note: string;
  /** A source check is an imported assertion, not a verified outcome. */
  readonly sourceChecked: boolean;
  readonly scheduledDate?: string;
  readonly dateConflict?: SprintPlanDateConflict;
}

export interface NormalizedSprintPlanWeek {
  readonly id: string;
  readonly num: number;
  readonly start: string;
  readonly end: string;
  readonly range: string;
  readonly tue: string;
  readonly fri: string;
  readonly tasks: ReadonlyArray<NormalizedSprintPlanTask>;
}

export interface NormalizedSprintPlan {
  readonly sourceVersion: number;
  readonly sourceUpdatedAt: string;
  /** Score values remain strings so unknown and non-numeric targets stay lossless. */
  readonly scores: ReadonlyArray<SprintPlanScoreSource>;
  readonly weeks: ReadonlyArray<NormalizedSprintPlanWeek>;
  readonly dateConflicts: ReadonlyArray<SprintPlanDateConflict>;
}

export interface ParsedSprintPlanSource {
  /** Exact bytes supplied by a string import. */
  readonly sourceJson: string;
  readonly source: SprintPlanSource;
  readonly normalized: NormalizedSprintPlan;
  readonly byteLength: number;
  readonly taskCount: number;
}

export class SprintPlanValidationError extends Schema.TaggedErrorClass<SprintPlanValidationError>()(
  "SprintPlanValidationError",
  {
    message: Schema.String,
  },
) {}
const isSprintPlanValidationError = Schema.is(SprintPlanValidationError);

const BoundedString = Schema.String.check(
  Schema.isMaxLength(SPRINT_PLAN_IMPORT_LIMITS.stringLength),
);
const BoundedNonEmptyString = BoundedString.check(Schema.isNonEmpty());
const IsoDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u),
  Schema.isMaxLength(10),
);
const UpdatedTimestamp = BoundedNonEmptyString.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u),
);

const ScoreShape = Schema.Struct({
  id: BoundedNonEmptyString,
  label: BoundedNonEmptyString,
  start: BoundedString,
  now: BoundedString,
  target: BoundedString,
});

const TaskShape = Schema.Struct({
  id: BoundedNonEmptyString,
  text: BoundedNonEmptyString,
  owner: BoundedNonEmptyString,
  day: BoundedNonEmptyString,
  note: BoundedString,
  done: Schema.Boolean,
});

const WeekShape = Schema.Struct({
  id: BoundedNonEmptyString,
  num: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  start: IsoDate,
  end: IsoDate,
  range: BoundedNonEmptyString,
  tue: BoundedString,
  fri: BoundedString,
  tasks: Schema.Array(TaskShape).check(Schema.isMaxLength(SPRINT_PLAN_IMPORT_LIMITS.tasksPerWeek)),
});

const SourceShape = Schema.Struct({
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  updated: UpdatedTimestamp,
  score: Schema.Array(ScoreShape).check(Schema.isMaxLength(SPRINT_PLAN_IMPORT_LIMITS.scores)),
  weeks: Schema.Array(WeekShape).check(Schema.isMaxLength(SPRINT_PLAN_IMPORT_LIMITS.weeks)),
});

const decodeSourceShape = Schema.decodeUnknownSync(SourceShape);
const textEncoder = new TextEncoder();

const fail = (message: string): never => {
  throw new SprintPlanValidationError({ message });
};

const assertBoundedJson: (root: unknown) => asserts root is SprintPlanJson = (root) => {
  let nodes = 0;
  const ancestors = new WeakSet<object>();

  const visit = (value: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > SPRINT_PLAN_IMPORT_LIMITS.nodes) fail("Sprint plan JSON has too many values.");
    if (depth > SPRINT_PLAN_IMPORT_LIMITS.depth) fail("Sprint plan JSON is nested too deeply.");
    if (value === null || Predicate.isBoolean(value) || Predicate.isString(value)) {
      if (Predicate.isString(value) && value.length > SPRINT_PLAN_IMPORT_LIMITS.stringLength) {
        fail("Sprint plan JSON contains an oversized string.");
      }
      return;
    }
    if (Predicate.isNumber(value)) {
      if (!Number.isFinite(value)) fail("Sprint plan JSON contains a non-finite number.");
      return;
    }
    if (!Predicate.isObjectOrArray(value)) {
      fail("Sprint plan input must contain JSON values only.");
    }
    const objectValue = value as object;
    if (ancestors.has(objectValue)) fail("Sprint plan input contains a cycle.");
    ancestors.add(objectValue);
    if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1);
    } else {
      const record = value as Record<string, unknown>;
      const prototype = Object.getPrototypeOf(record);
      if (prototype !== Object.prototype && prototype !== null) {
        fail("Sprint plan input must contain plain JSON objects only.");
      }
      const keys = Object.keys(record);
      if (keys.length > SPRINT_PLAN_IMPORT_LIMITS.objectKeys) {
        fail("Sprint plan JSON object has too many fields.");
      }
      for (const key of keys) {
        if (key.length > SPRINT_PLAN_IMPORT_LIMITS.keyLength) {
          fail("Sprint plan JSON contains an oversized field name.");
        }
        visit(record[key], depth + 1);
      }
    }
    ancestors.delete(objectValue);
  };

  visit(root, 0);
};

const parseIsoDate = (value: string): number => {
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(time) ||
    DateTime.formatIso(DateTime.makeUnsafe(time)).slice(0, 10) !== value
  ) {
    fail(`Invalid calendar date '${value}'.`);
  }
  return time;
};

const monthNumbers: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const weekdayNumbers: Readonly<Record<string, number>> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const isoFromParts = (year: number, month: number, day: number): string | undefined => {
  const value = `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}`;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) &&
    DateTime.formatIso(DateTime.makeUnsafe(time)).slice(0, 10) === value
    ? value
    : undefined;
};

const validateRange = (week: SprintPlanWeekSource): void => {
  const match = /^([A-Za-z]{3,9})\s+(\d{1,2})\s+[–-]\s+([A-Za-z]{3,9})\s+(\d{1,2})$/u.exec(
    week.range,
  );
  if (match === null) return fail(`Week '${week.id}' has a malformed date range.`);
  const startMonth = monthNumbers[match[1]!.toLowerCase()];
  const endMonth = monthNumbers[match[3]!.toLowerCase()];
  const expectedStartMonth = Number(week.start.slice(5, 7));
  const expectedEndMonth = Number(week.end.slice(5, 7));
  if (
    startMonth !== expectedStartMonth ||
    Number(match[2]) !== Number(week.start.slice(8, 10)) ||
    endMonth !== expectedEndMonth ||
    Number(match[4]) !== Number(week.end.slice(8, 10))
  ) {
    fail(`Week '${week.id}' range does not match its start and end dates.`);
  }
};

interface DateReference {
  readonly label: string;
  readonly date?: string | undefined;
  readonly weekday?: number | undefined;
}

const dateWithinWeek = (
  week: SprintPlanWeekSource,
  month: number,
  day: number,
): string | undefined => {
  const startYear = Number(week.start.slice(0, 4));
  const candidates = [startYear - 1, startYear, startYear + 1]
    .map((year) => isoFromParts(year, month, day))
    .filter((candidate): candidate is string => candidate !== undefined);
  return (
    candidates.find((candidate) => candidate >= week.start && candidate <= week.end) ??
    candidates[1] ??
    candidates[0]
  );
};

const dateReferenceFromDay = (
  day: string,
  week: SprintPlanWeekSource,
): DateReference | undefined => {
  const match =
    /\b(Sun(?:day)?|Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:r(?:sday)?)?|Fri(?:day)?|Sat(?:urday)?)\s+(\d{1,2})\/(\d{1,2})\b/iu.exec(
      day,
    );
  if (match === null) return undefined;
  const weekday = weekdayNumbers[match[1]!.toLowerCase()];
  const month = Number(match[2]);
  const date = Number(match[3]);
  return { label: match[0], date: dateWithinWeek(week, month, date), weekday };
};

const thanksgivingDate = (year: number): string => {
  const firstWeekDay = DateTime.toPartsUtc(
    DateTime.makeUnsafe(`${year}-11-01T00:00:00.000Z`),
  ).weekDay;
  const firstThursday = 1 + ((4 - firstWeekDay + 7) % 7);
  return isoFromParts(year, 11, firstThursday + 21)!;
};

const dateReferenceFromText = (
  text: string,
  week: SprintPlanWeekSource,
): DateReference | undefined => {
  const numeric =
    /\b(Sun(?:day)?|Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:r(?:sday)?)?|Fri(?:day)?|Sat(?:urday)?)\s+(\d{1,2})\/(\d{1,2})\b/iu.exec(
      text,
    );
  const year = Number(week.start.slice(0, 4));
  if (numeric !== null) {
    return {
      label: numeric[0],
      date: dateWithinWeek(week, Number(numeric[2]), Number(numeric[3])),
      weekday: weekdayNumbers[numeric[1]!.toLowerCase()],
    };
  }
  const explicit =
    /\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\b/iu.exec(
      text,
    );
  if (explicit !== null) {
    return {
      label: explicit[0],
      date: dateWithinWeek(week, monthNumbers[explicit[3]!.toLowerCase()]!, Number(explicit[2])),
      weekday: weekdayNumbers[explicit[1]!.toLowerCase()],
    };
  }
  const thanksgiving = /\bThanksgiving Day\b/iu.exec(text);
  return thanksgiving === null
    ? undefined
    : { label: thanksgiving[0], date: thanksgivingDate(year), weekday: 4 };
};

const detectDateConflict = (
  task: SprintPlanTaskSource,
  week: SprintPlanWeekSource,
): { readonly scheduledDate?: string; readonly conflict?: SprintPlanDateConflict } => {
  const dayReference = dateReferenceFromDay(task.day, week);
  if (dayReference === undefined || dayReference.date === undefined) return {};
  const actualDay = DateTime.toPartsUtc(
    DateTime.makeUnsafe(`${dayReference.date}T00:00:00.000Z`),
  ).weekDay;
  if (dayReference.weekday !== undefined && actualDay !== dayReference.weekday) {
    return {
      conflict: {
        taskId: task.id,
        weekId: week.id,
        sourceDay: task.day,
        dayDate: dayReference.date,
        textDateReference: dayReference.label,
        reason: "weekday-mismatch",
      },
    };
  }
  const textReference = dateReferenceFromText(task.text, week);
  if (
    textReference !== undefined &&
    (textReference.date !== dayReference.date ||
      (textReference.weekday !== undefined && textReference.weekday !== actualDay))
  ) {
    return {
      conflict: {
        taskId: task.id,
        weekId: week.id,
        sourceDay: task.day,
        dayDate: dayReference.date,
        textDateReference: textReference.label,
        ...(textReference.date === undefined ? {} : { textDate: textReference.date }),
        reason: "different-dates",
      },
    };
  }
  return { scheduledDate: dayReference.date };
};

const normalize = (source: SprintPlanSource): NormalizedSprintPlan => {
  const dateConflicts: Array<SprintPlanDateConflict> = [];
  const weeks = source.weeks.map((week) => ({
    id: week.id,
    num: week.num,
    start: week.start,
    end: week.end,
    range: week.range,
    tue: week.tue,
    fri: week.fri,
    tasks: week.tasks.map((task) => {
      const date = detectDateConflict(task, week);
      if (date.conflict !== undefined) dateConflicts.push(date.conflict);
      return {
        id: task.id,
        text: task.text,
        owner: task.owner,
        day: task.day,
        note: task.note,
        sourceChecked: task.done,
        ...(date.scheduledDate === undefined ? {} : { scheduledDate: date.scheduledDate }),
        ...(date.conflict === undefined ? {} : { dateConflict: date.conflict }),
      };
    }),
  }));
  return {
    sourceVersion: source.version,
    sourceUpdatedAt: source.updated,
    scores: source.score,
    weeks,
    dateConflicts,
  };
};

const deepFreeze = <Value extends SprintPlanJson>(value: Value): Value => {
  if (Predicate.isObjectOrArray(value) && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child as SprintPlanJson);
    Object.freeze(value);
  }
  return value;
};

const parse = (input: string | unknown): ParsedSprintPlanSource => {
  let sourceJson: string;
  let value: unknown;
  if (Predicate.isString(input)) {
    sourceJson = input;
    if (textEncoder.encode(sourceJson).byteLength > SPRINT_PLAN_IMPORT_LIMITS.bytes) {
      fail("Sprint plan source exceeds the byte limit.");
    }
    try {
      value = JSON.parse(sourceJson) as unknown;
    } catch (cause) {
      fail(`Sprint plan source is not valid JSON: ${String(cause)}`);
    }
  } else {
    value = input;
    assertBoundedJson(value);
    sourceJson = JSON.stringify(value);
    if (textEncoder.encode(sourceJson).byteLength > SPRINT_PLAN_IMPORT_LIMITS.bytes) {
      fail("Sprint plan source exceeds the byte limit.");
    }
  }

  assertBoundedJson(value);
  try {
    decodeSourceShape(value);
  } catch (cause) {
    fail(`Sprint plan source has an invalid shape: ${String(cause)}`);
  }

  const source = value as SprintPlanSource;
  const updatedTime = Date.parse(source.updated);
  if (
    !Number.isFinite(updatedTime) ||
    DateTime.formatIso(DateTime.makeUnsafe(updatedTime)).slice(0, 10) !==
      source.updated.slice(0, 10)
  ) {
    fail(`Invalid source update timestamp '${source.updated}'.`);
  }
  const weekIds = new Set<string>();
  const taskIds = new Set<string>();
  let taskCount = 0;
  for (const week of source.weeks) {
    if (weekIds.has(week.id)) fail(`Duplicate sprint plan week ID '${week.id}'.`);
    weekIds.add(week.id);
    const start = parseIsoDate(week.start);
    const end = parseIsoDate(week.end);
    if (end < start) fail(`Week '${week.id}' ends before it starts.`);
    validateRange(week);
    taskCount += week.tasks.length;
    if (taskCount > SPRINT_PLAN_IMPORT_LIMITS.tasks) {
      fail("Sprint plan source has too many tasks.");
    }
    for (const task of week.tasks) {
      if (taskIds.has(task.id)) fail(`Duplicate sprint plan task ID '${task.id}'.`);
      taskIds.add(task.id);
    }
  }

  const frozen = deepFreeze(source);
  return {
    sourceJson,
    source: frozen,
    normalized: normalize(frozen),
    byteLength: textEncoder.encode(sourceJson).byteLength,
    taskCount,
  };
};

export const parseSprintPlanSource = (input: string | unknown) =>
  Effect.try({
    try: () => parse(input),
    catch: (cause) =>
      isSprintPlanValidationError(cause)
        ? cause
        : new SprintPlanValidationError({ message: String(cause) }),
  });
