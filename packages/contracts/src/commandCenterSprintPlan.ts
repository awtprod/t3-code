import { SPRINT_PLAN_IMPORT_LIMITS } from "@command-center/core";
import * as Schema from "effect/Schema";

const textEncoder = new TextEncoder();

const boundedJson = (root: unknown): boolean => {
  let nodes = 0;
  const visit = (value: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > SPRINT_PLAN_IMPORT_LIMITS.nodes || depth > SPRINT_PLAN_IMPORT_LIMITS.depth) {
      return false;
    }
    if (typeof value === "string") return value.length <= SPRINT_PLAN_IMPORT_LIMITS.stringLength;
    if (value === null || typeof value === "boolean" || typeof value === "number") return true;
    if (Array.isArray(value)) return value.every((item) => visit(item, depth + 1));
    if (typeof value !== "object") return false;
    const entries = Object.entries(value);
    return (
      entries.length <= SPRINT_PLAN_IMPORT_LIMITS.objectKeys &&
      entries.every(
        ([key, child]) =>
          key.length <= SPRINT_PLAN_IMPORT_LIMITS.keyLength && visit(child, depth + 1),
      )
    );
  };
  return visit(root, 0);
};

const Identifier = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(256),
  Schema.makeFilter(
    (value) => value.trim() === value || "Identifier must not have surrounding whitespace.",
  ),
);
const BoundedString = Schema.String.check(
  Schema.isMaxLength(SPRINT_PLAN_IMPORT_LIMITS.stringLength),
);
const BoundedNonEmptyString = BoundedString.check(Schema.isNonEmpty());
const Reason = Schema.String.check(
  Schema.isMaxLength(4_096),
  Schema.makeFilter((value) => value.trim().length > 0 || "Reason must not be blank."),
);
const SafeNonNegativeInt = Schema.Int.check(
  Schema.makeFilter(
    (value) =>
      (Number.isSafeInteger(value) && value >= 0) || "Expected a non-negative safe integer.",
  ),
);
const PositiveSafeInt = Schema.Int.check(
  Schema.makeFilter(
    (value) => (Number.isSafeInteger(value) && value >= 1) || "Expected a positive safe integer.",
  ),
);
const IsoDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u),
  Schema.makeFilter((value) => {
    const time = Date.parse(`${value}T00:00:00.000Z`);
    return (
      (Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value) ||
      "Expected a real calendar date."
    );
  }),
);
const IsoTimestamp = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u),
  Schema.makeFilter(
    (value) => Number.isFinite(Date.parse(value)) || "Expected a valid UTC timestamp.",
  ),
);
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const SourceJson = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      textEncoder.encode(value).byteLength <= SPRINT_PLAN_IMPORT_LIMITS.bytes ||
      `Source JSON must be at most ${SPRINT_PLAN_IMPORT_LIMITS.bytes} bytes.`,
  ),
);
const BoundedJson = Schema.Json.check(
  Schema.makeFilter((value) => boundedJson(value) || "JSON value exceeds sprint-plan bounds."),
);
const JsonExtras = Schema.Record(
  Schema.String.check(Schema.isMaxLength(SPRINT_PLAN_IMPORT_LIMITS.keyLength)),
  Schema.Json,
);
const withJsonExtras = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(Schema.Struct(fields), [JsonExtras]);

export const CommandCenterSprintPlanScoreSource = withJsonExtras({
  id: BoundedNonEmptyString,
  label: BoundedNonEmptyString,
  start: BoundedString,
  now: BoundedString,
  target: BoundedString,
});
export type CommandCenterSprintPlanScoreSource = typeof CommandCenterSprintPlanScoreSource.Type;

export const CommandCenterSprintPlanTaskSource = withJsonExtras({
  id: BoundedNonEmptyString,
  text: BoundedNonEmptyString,
  owner: BoundedNonEmptyString,
  day: BoundedNonEmptyString,
  note: BoundedString,
  done: Schema.Boolean,
});
export type CommandCenterSprintPlanTaskSource = typeof CommandCenterSprintPlanTaskSource.Type;

export const CommandCenterSprintPlanWeekSource = withJsonExtras({
  id: BoundedNonEmptyString,
  num: SafeNonNegativeInt,
  start: IsoDate,
  end: IsoDate,
  range: BoundedNonEmptyString,
  tue: BoundedString,
  fri: BoundedString,
  tasks: Schema.Array(CommandCenterSprintPlanTaskSource).check(
    Schema.isMaxLength(SPRINT_PLAN_IMPORT_LIMITS.tasksPerWeek),
  ),
});
export type CommandCenterSprintPlanWeekSource = typeof CommandCenterSprintPlanWeekSource.Type;

export const CommandCenterSprintPlanSource = withJsonExtras({
  version: PositiveSafeInt,
  updated: IsoTimestamp,
  score: Schema.Array(CommandCenterSprintPlanScoreSource).check(
    Schema.isMaxLength(SPRINT_PLAN_IMPORT_LIMITS.scores),
  ),
  weeks: Schema.Array(CommandCenterSprintPlanWeekSource).check(
    Schema.isMaxLength(SPRINT_PLAN_IMPORT_LIMITS.weeks),
    Schema.makeFilter(
      (weeks) =>
        weeks.reduce((count, week) => count + week.tasks.length, 0) <=
          SPRINT_PLAN_IMPORT_LIMITS.tasks || "Sprint plan contains too many tasks.",
    ),
  ),
}).check(
  Schema.makeFilter((source) => boundedJson(source) || "Sprint plan metadata exceeds JSON bounds."),
);
export type CommandCenterSprintPlanSource = typeof CommandCenterSprintPlanSource.Type;

export const CommandCenterSprintPlanDateConflict = Schema.Struct({
  taskId: BoundedNonEmptyString,
  weekId: BoundedNonEmptyString,
  sourceDay: BoundedString,
  dayDate: Schema.optionalKey(IsoDate),
  textDateReference: BoundedString,
  textDate: Schema.optionalKey(IsoDate),
  reason: Schema.Literals(["different-dates", "weekday-mismatch"]),
});
export type CommandCenterSprintPlanDateConflict = typeof CommandCenterSprintPlanDateConflict.Type;

const NormalizedTask = Schema.Struct({
  id: BoundedNonEmptyString,
  text: BoundedNonEmptyString,
  owner: BoundedNonEmptyString,
  day: BoundedNonEmptyString,
  note: BoundedString,
  sourceChecked: Schema.Boolean,
  scheduledDate: Schema.optionalKey(IsoDate),
  dateConflict: Schema.optionalKey(CommandCenterSprintPlanDateConflict),
});
const NormalizedWeek = Schema.Struct({
  id: BoundedNonEmptyString,
  num: SafeNonNegativeInt,
  start: IsoDate,
  end: IsoDate,
  range: BoundedNonEmptyString,
  tue: BoundedString,
  fri: BoundedString,
  tasks: Schema.Array(NormalizedTask).check(
    Schema.isMaxLength(SPRINT_PLAN_IMPORT_LIMITS.tasksPerWeek),
  ),
});
export const CommandCenterNormalizedSprintPlan = Schema.Struct({
  sourceVersion: PositiveSafeInt,
  sourceUpdatedAt: IsoTimestamp,
  scores: Schema.Array(CommandCenterSprintPlanScoreSource).check(
    Schema.isMaxLength(SPRINT_PLAN_IMPORT_LIMITS.scores),
  ),
  weeks: Schema.Array(NormalizedWeek).check(
    Schema.isMaxLength(SPRINT_PLAN_IMPORT_LIMITS.weeks),
    Schema.makeFilter(
      (weeks) =>
        weeks.reduce((count, week) => count + week.tasks.length, 0) <=
          SPRINT_PLAN_IMPORT_LIMITS.tasks || "Normalized sprint plan contains too many tasks.",
    ),
  ),
  dateConflicts: Schema.Array(CommandCenterSprintPlanDateConflict).check(
    Schema.isMaxLength(SPRINT_PLAN_IMPORT_LIMITS.tasks),
  ),
}).check(
  Schema.makeFilter(
    (source) => boundedJson(source) || "Normalized sprint plan exceeds JSON bounds.",
  ),
);
export type CommandCenterNormalizedSprintPlan = typeof CommandCenterNormalizedSprintPlan.Type;

export const CommandCenterSprintPlanActor = Schema.Struct({
  id: Identifier,
  kind: Schema.Literals(["user", "agent", "system"]),
});
export type CommandCenterSprintPlanActor = typeof CommandCenterSprintPlanActor.Type;

const SourceReference = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(256),
  Schema.makeFilter(
    (value) =>
      (value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)) ||
      "Source reference must be a safe bounded label.",
  ),
);
const OriginalFileName = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(256),
  Schema.makeFilter(
    (value) =>
      (value.trim() === value &&
        value !== "." &&
        value !== ".." &&
        !/[\\/\u0000-\u001f\u007f]/u.test(value)) ||
      "Original file name must be a safe base name.",
  ),
);
export const CommandCenterSprintPlanImportProvenance = Schema.Struct({
  sourceRef: SourceReference,
  originalFileName: Schema.optionalKey(OriginalFileName),
});
export type CommandCenterSprintPlanImportProvenance =
  typeof CommandCenterSprintPlanImportProvenance.Type;

const ManualMutationProvenance = Schema.Struct({
  kind: Schema.Literal("manual"),
  sourceRef: Schema.optionalKey(SourceReference),
  evidenceRef: Schema.optionalKey(SourceReference),
});
const StoredMutationProvenance = Schema.Struct({
  kind: Schema.Literals(["manual", "import", "approved-adjustment", "inbox-adjustment"]),
  sourceRef: Schema.optionalKey(SourceReference),
  evidenceRef: Schema.optionalKey(SourceReference),
});

export const CommandCenterSprintPlanImportConflict = Schema.Struct({
  taskId: BoundedNonEmptyString,
  field: Schema.Literals(["text", "note", "day", "owner", "done"]),
  baseline: Schema.Union([BoundedString, Schema.Boolean]),
  current: Schema.Union([BoundedString, Schema.Boolean]),
  incoming: Schema.optionalKey(Schema.Union([BoundedString, Schema.Boolean])),
  reason: Schema.Literals(["both-changed", "locally-edited-task-removed"]),
});
export type CommandCenterSprintPlanImportConflict =
  typeof CommandCenterSprintPlanImportConflict.Type;

export const CommandCenterSprintPlanPreviewImportInput = Schema.Struct({
  planId: Identifier,
  spaceId: Identifier,
  sourceJson: SourceJson,
});
export type CommandCenterSprintPlanPreviewImportInput =
  typeof CommandCenterSprintPlanPreviewImportInput.Type;

export const CommandCenterSprintPlanPreviewImportResult = Schema.Struct({
  planId: Identifier,
  sourceSha256: Sha256,
  sourceVersion: PositiveSafeInt,
  sourceUpdatedAt: IsoTimestamp,
  taskCount: SafeNonNegativeInt.check(Schema.isLessThanOrEqualTo(SPRINT_PLAN_IMPORT_LIMITS.tasks)),
  existingVersion: Schema.NullOr(SafeNonNegativeInt),
  unchangedSource: Schema.Boolean,
  conflicts: Schema.Array(CommandCenterSprintPlanImportConflict).check(
    Schema.isMaxLength(SPRINT_PLAN_IMPORT_LIMITS.tasks * 5),
  ),
  sourceDateConflicts: Schema.Array(CommandCenterSprintPlanDateConflict).check(
    Schema.isMaxLength(SPRINT_PLAN_IMPORT_LIMITS.tasks),
  ),
});
export type CommandCenterSprintPlanPreviewImportResult =
  typeof CommandCenterSprintPlanPreviewImportResult.Type;

export const CommandCenterSprintPlanApplyImportInput = Schema.Struct({
  planId: Identifier,
  spaceId: Identifier,
  sourceJson: SourceJson,
  provenance: CommandCenterSprintPlanImportProvenance,
  expectedVersion: SafeNonNegativeInt,
  mutationId: Identifier,
});
export type CommandCenterSprintPlanApplyImportInput =
  typeof CommandCenterSprintPlanApplyImportInput.Type;

export const CommandCenterSprintPlanListCursor = Schema.Struct({
  updatedAt: IsoTimestamp,
  planId: Identifier,
});
export type CommandCenterSprintPlanListCursor = typeof CommandCenterSprintPlanListCursor.Type;

export const CommandCenterSprintPlanListInput = Schema.Struct({
  spaceId: Identifier,
  cursor: Schema.optionalKey(CommandCenterSprintPlanListCursor),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type CommandCenterSprintPlanListInput = typeof CommandCenterSprintPlanListInput.Type;

export const CommandCenterSprintPlanGetInput = Schema.Struct({
  planId: Identifier,
  spaceId: Identifier,
});
export type CommandCenterSprintPlanGetInput = typeof CommandCenterSprintPlanGetInput.Type;

export const CommandCenterSprintPlanGetOriginalInput = Schema.Struct({
  planId: Identifier,
  spaceId: Identifier,
});
export type CommandCenterSprintPlanGetOriginalInput =
  typeof CommandCenterSprintPlanGetOriginalInput.Type;

const TaskStringPatchBase = {
  planId: Identifier,
  spaceId: Identifier,
  taskId: Identifier,
  before: BoundedString,
  after: BoundedString,
  expectedVersion: SafeNonNegativeInt,
  mutationId: Identifier,
  provenance: ManualMutationProvenance,
};
const RequiredReasonPatch = (field: "text" | "day" | "owner") =>
  Schema.Struct({
    ...TaskStringPatchBase,
    field: Schema.Literal(field),
    before: BoundedNonEmptyString,
    after: BoundedNonEmptyString,
    reason: Reason,
  });
export const CommandCenterSprintPlanPatchTaskInput = Schema.Union([
  RequiredReasonPatch("text"),
  RequiredReasonPatch("day"),
  RequiredReasonPatch("owner"),
  Schema.Struct({
    ...TaskStringPatchBase,
    field: Schema.Literal("note"),
    reason: Schema.optionalKey(Reason),
  }),
  Schema.Struct({
    planId: Identifier,
    spaceId: Identifier,
    taskId: Identifier,
    field: Schema.Literal("done"),
    before: Schema.Boolean,
    after: Schema.Boolean,
    reason: Schema.optionalKey(Reason),
    expectedVersion: SafeNonNegativeInt,
    mutationId: Identifier,
    provenance: ManualMutationProvenance,
  }),
]).check(
  Schema.makeFilter(
    (patch) => patch.before !== patch.after || "Task patch must change the field value.",
  ),
);
export type CommandCenterSprintPlanPatchTaskInput =
  typeof CommandCenterSprintPlanPatchTaskInput.Type;

export const CommandCenterSprintPlanResolveDateConflictInput = Schema.Struct({
  planId: Identifier,
  spaceId: Identifier,
  taskId: Identifier,
  resolvedDate: IsoDate,
  reason: Reason,
  expectedVersion: SafeNonNegativeInt,
  mutationId: Identifier,
  provenance: ManualMutationProvenance,
});
export type CommandCenterSprintPlanResolveDateConflictInput =
  typeof CommandCenterSprintPlanResolveDateConflictInput.Type;

export const CommandCenterSprintPlanListHistoryInput = Schema.Struct({
  planId: Identifier,
  spaceId: Identifier,
  beforeSequence: Schema.optionalKey(PositiveSafeInt),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type CommandCenterSprintPlanListHistoryInput =
  typeof CommandCenterSprintPlanListHistoryInput.Type;

export const CommandCenterSprintPlanDateResolution = Schema.Struct({
  taskId: Identifier,
  sourceConflict: CommandCenterSprintPlanDateConflict,
  resolvedDate: IsoDate,
  reason: Reason,
  actor: CommandCenterSprintPlanActor,
  provenance: StoredMutationProvenance,
  planVersion: PositiveSafeInt,
  updatedAt: IsoTimestamp,
});
export type CommandCenterSprintPlanDateResolution =
  typeof CommandCenterSprintPlanDateResolution.Type;

export const CommandCenterSprintPlanSummary = Schema.Struct({
  id: Identifier,
  spaceId: Identifier,
  version: PositiveSafeInt,
  sourceVersion: PositiveSafeInt,
  sourceUpdatedAt: IsoTimestamp,
  sourceSha256: Sha256,
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});
export type CommandCenterSprintPlanSummary = typeof CommandCenterSprintPlanSummary.Type;

export const CommandCenterSprintPlanListResult = Schema.Struct({
  plans: Schema.Array(CommandCenterSprintPlanSummary).check(Schema.isMaxLength(100)),
  nextCursor: Schema.optionalKey(CommandCenterSprintPlanListCursor),
});
export type CommandCenterSprintPlanListResult = typeof CommandCenterSprintPlanListResult.Type;

export const CommandCenterSprintPlanSnapshot = Schema.Struct({
  id: Identifier,
  spaceId: Identifier,
  version: PositiveSafeInt,
  sourceVersion: PositiveSafeInt,
  sourceUpdatedAt: IsoTimestamp,
  sourceSha256: Sha256,
  sourceJson: SourceJson,
  provenance: CommandCenterSprintPlanImportProvenance,
  baseline: CommandCenterSprintPlanSource,
  baselineNormalized: CommandCenterNormalizedSprintPlan,
  current: CommandCenterSprintPlanSource,
  dateResolutions: Schema.Array(CommandCenterSprintPlanDateResolution).check(
    Schema.isMaxLength(SPRINT_PLAN_IMPORT_LIMITS.tasks),
  ),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});
export type CommandCenterSprintPlanSnapshot = typeof CommandCenterSprintPlanSnapshot.Type;

export const CommandCenterSprintPlanOriginal = Schema.Struct({
  planId: Identifier,
  spaceId: Identifier,
  sourceVersion: PositiveSafeInt,
  sourceUpdatedAt: IsoTimestamp,
  sourceSha256: Sha256,
  sourceJson: SourceJson,
  provenance: CommandCenterSprintPlanImportProvenance,
  original: CommandCenterSprintPlanSource,
  originalNormalized: CommandCenterNormalizedSprintPlan,
  importedAt: IsoTimestamp,
});
export type CommandCenterSprintPlanOriginal = typeof CommandCenterSprintPlanOriginal.Type;

export const CommandCenterSprintPlanHistoryEntry = Schema.Struct({
  sequence: PositiveSafeInt,
  mutationId: Identifier,
  planId: Identifier,
  spaceId: Identifier,
  planVersion: PositiveSafeInt,
  operation: Schema.Literals(["import", "task-patch", "date-resolution"]),
  taskId: Schema.optionalKey(Identifier),
  field: Schema.optionalKey(
    Schema.Literals(["text", "note", "day", "owner", "done", "dateResolution"]),
  ),
  before: Schema.optionalKey(BoundedJson),
  after: Schema.optionalKey(BoundedJson),
  reason: Schema.optionalKey(Reason),
  actor: CommandCenterSprintPlanActor,
  provenance: StoredMutationProvenance,
  occurredAt: IsoTimestamp,
});
export type CommandCenterSprintPlanHistoryEntry = typeof CommandCenterSprintPlanHistoryEntry.Type;
export const CommandCenterSprintPlanListHistoryResult = Schema.Struct({
  entries: Schema.Array(CommandCenterSprintPlanHistoryEntry).check(Schema.isMaxLength(100)),
  nextBeforeSequence: Schema.optionalKey(PositiveSafeInt),
});
export type CommandCenterSprintPlanListHistoryResult =
  typeof CommandCenterSprintPlanListHistoryResult.Type;

export const CommandCenterSprintPlanApplyImportResult = CommandCenterSprintPlanSnapshot;
export type CommandCenterSprintPlanApplyImportResult =
  typeof CommandCenterSprintPlanApplyImportResult.Type;
export const CommandCenterSprintPlanGetResult = CommandCenterSprintPlanSnapshot;
export type CommandCenterSprintPlanGetResult = typeof CommandCenterSprintPlanGetResult.Type;
export const CommandCenterSprintPlanGetOriginalResult = CommandCenterSprintPlanOriginal;
export type CommandCenterSprintPlanGetOriginalResult =
  typeof CommandCenterSprintPlanGetOriginalResult.Type;
export const CommandCenterSprintPlanPatchTaskResult = CommandCenterSprintPlanSnapshot;
export type CommandCenterSprintPlanPatchTaskResult =
  typeof CommandCenterSprintPlanPatchTaskResult.Type;
export const CommandCenterSprintPlanResolveDateConflictResult = CommandCenterSprintPlanSnapshot;
export type CommandCenterSprintPlanResolveDateConflictResult =
  typeof CommandCenterSprintPlanResolveDateConflictResult.Type;
