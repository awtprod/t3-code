import {
  SPRINT_PLAN_IMPORT_LIMITS,
  type NormalizedSprintPlan,
  type SprintPlanDateConflict,
  type SprintPlanJson,
  type SprintPlanSource,
  type SprintPlanTaskSource,
  parseSprintPlanSource,
} from "@command-center/core";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeCommandCenterAuditLog } from "./AuditLog.ts";

const TASK_FIELDS = ["text", "note", "day", "owner", "done"] as const;
export type SprintPlanTaskField = (typeof TASK_FIELDS)[number];

export interface SprintPlanActor {
  readonly id: string;
  readonly kind: "user" | "agent" | "system";
}

export interface SprintPlanMutationProvenance {
  readonly kind: "manual" | "import" | "approved-adjustment" | "inbox-adjustment";
  readonly sourceRef?: string | undefined;
  readonly evidenceRef?: string | undefined;
}

export interface SprintPlanImportProvenance {
  readonly sourceRef: string;
  readonly originalFileName?: string | undefined;
}

export interface SprintPlanImportConflict {
  readonly taskId: string;
  readonly field: SprintPlanTaskField;
  readonly baseline: string | boolean;
  readonly current: string | boolean;
  readonly incoming?: string | boolean;
  readonly reason: "both-changed" | "locally-edited-task-removed";
}

export interface SprintPlanConflictDecision {
  readonly taskId: string;
  readonly field: SprintPlanTaskField;
  readonly decision: "keep-current" | "use-incoming";
}

export interface SprintPlanImportPreview {
  readonly planId: string;
  readonly sourceSha256: string;
  readonly sourceVersion: number;
  readonly sourceUpdatedAt: string;
  readonly taskCount: number;
  readonly existingVersion: number | null;
  readonly unchangedSource: boolean;
  readonly conflicts: ReadonlyArray<SprintPlanImportConflict>;
  readonly sourceDateConflicts: ReadonlyArray<SprintPlanDateConflict>;
}

export interface SprintPlanDateResolution {
  readonly taskId: string;
  readonly sourceConflict: SprintPlanDateConflict;
  readonly resolvedDate: string;
  readonly reason: string;
  readonly actor: SprintPlanActor;
  readonly provenance: SprintPlanMutationProvenance;
  readonly planVersion: number;
  readonly updatedAt: string;
}

export interface SprintPlanSnapshot {
  readonly id: string;
  readonly spaceId: string;
  readonly version: number;
  readonly sourceVersion: number;
  readonly sourceUpdatedAt: string;
  readonly sourceSha256: string;
  readonly sourceJson: string;
  readonly provenance: SprintPlanImportProvenance;
  readonly baseline: SprintPlanSource;
  readonly baselineNormalized: NormalizedSprintPlan;
  readonly current: SprintPlanSource;
  readonly dateResolutions: ReadonlyArray<SprintPlanDateResolution>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SprintPlanOriginal {
  readonly planId: string;
  readonly spaceId: string;
  readonly sourceVersion: number;
  readonly sourceUpdatedAt: string;
  readonly sourceSha256: string;
  readonly sourceJson: string;
  readonly provenance: SprintPlanImportProvenance;
  readonly original: SprintPlanSource;
  readonly originalNormalized: NormalizedSprintPlan;
  readonly importedAt: string;
}

export interface SprintPlanHistoryEntry {
  readonly sequence: number;
  readonly mutationId: string;
  readonly planId: string;
  readonly spaceId: string;
  readonly planVersion: number;
  readonly operation: "import" | "task-patch" | "date-resolution";
  readonly taskId?: string;
  readonly field?: SprintPlanTaskField | "dateResolution";
  readonly before?: SprintPlanJson;
  readonly after?: SprintPlanJson;
  readonly reason?: string;
  readonly actor: SprintPlanActor;
  readonly provenance: SprintPlanMutationProvenance;
  readonly occurredAt: string;
}

export interface SprintPlanHistoryPage {
  readonly entries: ReadonlyArray<SprintPlanHistoryEntry>;
  readonly nextBeforeSequence?: number;
}

export interface SprintPlanSummary {
  readonly id: string;
  readonly spaceId: string;
  readonly version: number;
  readonly sourceVersion: number;
  readonly sourceUpdatedAt: string;
  readonly sourceSha256: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SprintPlanListPage {
  readonly plans: ReadonlyArray<SprintPlanSummary>;
  readonly nextCursor?: {
    readonly updatedAt: string;
    readonly planId: string;
  };
}

export interface SprintPlanApplyImportInput {
  readonly planId: string;
  readonly spaceId: string;
  readonly sourceJson: string;
  readonly provenance: SprintPlanImportProvenance;
  readonly expectedVersion: number;
  readonly mutationId: string;
  readonly conflictDecisions?: ReadonlyArray<SprintPlanConflictDecision>;
}

export interface SprintPlanTaskPatchInput {
  readonly planId: string;
  readonly spaceId: string;
  readonly taskId: string;
  readonly field: SprintPlanTaskField;
  readonly before: string | boolean;
  readonly after: string | boolean;
  readonly reason?: string;
  readonly expectedVersion: number;
  readonly mutationId: string;
  readonly provenance: SprintPlanMutationProvenance;
}

export interface SprintPlanDateResolutionInput {
  readonly planId: string;
  readonly spaceId: string;
  readonly taskId: string;
  readonly resolvedDate: string;
  readonly reason: string;
  readonly expectedVersion: number;
  readonly mutationId: string;
  readonly provenance: SprintPlanMutationProvenance;
}

export class SprintPlanServiceError extends Schema.TaggedErrorClass<SprintPlanServiceError>()(
  "SprintPlanServiceError",
  {
    reason: Schema.Literals(["validation", "not-found", "conflict", "persistence"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface SprintPlanServiceShape {
  readonly list: (input: {
    readonly spaceId: string;
    readonly cursor?: {
      readonly updatedAt: string;
      readonly planId: string;
    };
    readonly limit?: number;
  }) => Effect.Effect<SprintPlanListPage, SprintPlanServiceError>;
  readonly previewImport: (input: {
    readonly planId: string;
    readonly spaceId: string;
    readonly sourceJson: string;
  }) => Effect.Effect<SprintPlanImportPreview, SprintPlanServiceError>;
  readonly applyImport: (
    input: SprintPlanApplyImportInput,
    actor: SprintPlanActor,
  ) => Effect.Effect<SprintPlanSnapshot, SprintPlanServiceError>;
  readonly get: (input: {
    readonly planId: string;
    readonly spaceId: string;
  }) => Effect.Effect<SprintPlanSnapshot, SprintPlanServiceError>;
  readonly getOriginal: (input: {
    readonly planId: string;
    readonly spaceId: string;
  }) => Effect.Effect<SprintPlanOriginal, SprintPlanServiceError>;
  readonly patchTask: (
    input: SprintPlanTaskPatchInput,
    actor: SprintPlanActor,
  ) => Effect.Effect<SprintPlanSnapshot, SprintPlanServiceError>;
  readonly resolveDateConflict: (
    input: SprintPlanDateResolutionInput,
    actor: SprintPlanActor,
  ) => Effect.Effect<SprintPlanSnapshot, SprintPlanServiceError>;
  readonly listHistory: (input: {
    readonly planId: string;
    readonly spaceId: string;
    readonly beforeSequence?: number;
    readonly limit?: number;
  }) => Effect.Effect<SprintPlanHistoryPage, SprintPlanServiceError>;
}

export class SprintPlanService extends Context.Service<SprintPlanService, SprintPlanServiceShape>()(
  "@awtprod/command-center/command-center/SprintPlan",
) {}

interface PlanRow {
  readonly id: string;
  readonly spaceId: string;
  readonly version: number;
  readonly sourceVersion: number;
  readonly currentImportId: string;
  readonly currentJson: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface PlanSummaryRow {
  readonly id: string;
  readonly spaceId: string;
  readonly version: number;
  readonly sourceVersion: number;
  readonly sourceUpdatedAt: string;
  readonly sourceSha256: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ImportRow {
  readonly id: string;
  readonly planId: string;
  readonly mutationId: string;
  readonly sourceSha256: string;
  readonly sourceVersion: number;
  readonly sourceUpdatedAt: string;
  readonly sourceJson: string;
  readonly provenanceJson: string;
  readonly appliedPlanVersion: number;
  readonly importedAt: string;
}

interface HistoryRow {
  readonly sequence: number;
  readonly mutationId: string;
  readonly planId: string;
  readonly spaceId: string;
  readonly planVersion: number;
  readonly operation: "import" | "task-patch" | "date-resolution";
  readonly taskId: string | null;
  readonly field: SprintPlanTaskField | "dateResolution" | null;
  readonly beforeJson: string | null;
  readonly afterJson: string | null;
  readonly reason: string | null;
  readonly actorJson: string;
  readonly provenanceJson: string;
  readonly requestDigest: string;
  readonly occurredAt: string;
}

interface DateResolutionRow {
  readonly taskId: string;
  readonly sourceConflictJson: string;
  readonly resolvedDate: string;
  readonly reason: string;
  readonly actorJson: string;
  readonly provenanceJson: string;
  readonly planVersion: number;
  readonly updatedAt: string;
}

interface MutationReceiptRow {
  readonly planId: string;
  readonly spaceId: string;
  readonly planVersion: number;
  readonly requestDigest: string;
}

const Identifier = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256));
const Reason = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096));
const IsoDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u));
const IsoTimestamp = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u),
  Schema.makeFilter(
    (value) => Number.isFinite(Date.parse(value)) || "Expected a valid UTC timestamp.",
  ),
);
const Actor = Schema.Struct({ id: Identifier, kind: Schema.Literals(["user", "agent", "system"]) });
const MutationProvenance = Schema.Struct({
  kind: Schema.Literals(["manual", "import", "approved-adjustment", "inbox-adjustment"]),
  sourceRef: Schema.optional(Identifier),
  evidenceRef: Schema.optional(Identifier),
});
const ImportProvenance = Schema.Struct({
  sourceRef: Identifier,
  originalFileName: Schema.optional(Identifier),
});
const ConflictDecisions = Schema.Array(
  Schema.Struct({
    taskId: Identifier,
    field: Schema.Literals(["text", "note", "day", "owner", "done"]),
    decision: Schema.Literals(["keep-current", "use-incoming"]),
  }),
).check(Schema.isMaxLength(SPRINT_PLAN_IMPORT_LIMITS.tasks * 5));
const DateConflict = Schema.Struct({
  taskId: Identifier,
  weekId: Identifier,
  sourceDay: Schema.String.check(Schema.isMaxLength(SPRINT_PLAN_IMPORT_LIMITS.stringLength)),
  dayDate: Schema.optional(IsoDate),
  textDateReference: Schema.String.check(
    Schema.isMaxLength(SPRINT_PLAN_IMPORT_LIMITS.stringLength),
  ),
  textDate: Schema.optional(IsoDate),
  reason: Schema.Literals(["different-dates", "weekday-mismatch"]),
});

const decodeActor = Schema.decodeUnknownEffect(Actor);
const decodeMutationProvenance = Schema.decodeUnknownEffect(MutationProvenance);
const decodeImportProvenance = Schema.decodeUnknownEffect(ImportProvenance);
const decodeConflictDecisions = Schema.decodeUnknownEffect(ConflictDecisions);
const decodeDateConflict = Schema.decodeUnknownEffect(DateConflict);
const decodeIdentifier = Schema.decodeUnknownEffect(Identifier);
const decodeReason = Schema.decodeUnknownEffect(Reason);
const decodeIsoDate = Schema.decodeUnknownEffect(IsoDate);
const decodeIsoTimestamp = Schema.decodeUnknownEffect(IsoTimestamp);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));
const isServiceError = Schema.is(SprintPlanServiceError);
const textEncoder = new TextEncoder();

const validationError = (message: string, cause?: unknown) =>
  new SprintPlanServiceError({
    reason: "validation",
    message,
    ...(cause === undefined ? {} : { cause }),
  });
const conflictError = (message: string) =>
  new SprintPlanServiceError({ reason: "conflict", message });
const notFoundError = (message: string) =>
  new SprintPlanServiceError({ reason: "not-found", message });
const persistenceError = (cause: unknown) =>
  isServiceError(cause)
    ? cause
    : new SprintPlanServiceError({
        reason: "persistence",
        message: "The sprint plan operation could not be persisted.",
        cause,
      });

const stringify = (value: unknown): string => JSON.stringify(value);
const equal = (left: unknown, right: unknown): boolean => stringify(left) === stringify(right);

const taskIndex = (source: SprintPlanSource): Map<string, SprintPlanTaskSource> =>
  new Map(source.weeks.flatMap((week) => week.tasks.map((task) => [task.id, task] as const)));

const mutableClone = (source: SprintPlanSource): SprintPlanSource =>
  JSON.parse(JSON.stringify(source)) as SprintPlanSource;

const fieldValue = (task: SprintPlanTaskSource, field: SprintPlanTaskField): string | boolean =>
  task[field];

const setFieldValue = (
  task: SprintPlanTaskSource,
  field: SprintPlanTaskField,
  value: string | boolean,
): void => {
  (task as unknown as Record<SprintPlanTaskField, string | boolean>)[field] = value;
};

const localChanges = (
  baseline: SprintPlanSource,
  current: SprintPlanSource,
): ReadonlyArray<{
  readonly taskId: string;
  readonly field: SprintPlanTaskField;
  readonly baseline: string | boolean;
  readonly current: string | boolean;
}> => {
  const currentTasks = taskIndex(current);
  return baseline.weeks.flatMap((week) =>
    week.tasks.flatMap((baselineTask) => {
      const currentTask = currentTasks.get(baselineTask.id);
      if (currentTask === undefined) return [];
      return TASK_FIELDS.flatMap((field) => {
        const before = fieldValue(baselineTask, field);
        const after = fieldValue(currentTask, field);
        return equal(before, after)
          ? []
          : [{ taskId: baselineTask.id, field, baseline: before, current: after }];
      });
    }),
  );
};

const mergeImport = (
  baseline: SprintPlanSource,
  current: SprintPlanSource,
  incoming: SprintPlanSource,
): {
  readonly current: SprintPlanSource;
  readonly conflicts: ReadonlyArray<SprintPlanImportConflict>;
} => {
  const incomingTasks = taskIndex(incoming);
  const merged = mutableClone(incoming);
  const mergedTasks = taskIndex(merged);
  const conflicts: Array<SprintPlanImportConflict> = [];
  for (const change of localChanges(baseline, current)) {
    const incomingTask = incomingTasks.get(change.taskId);
    const mergedTask = mergedTasks.get(change.taskId);
    if (incomingTask === undefined || mergedTask === undefined) {
      conflicts.push({ ...change, reason: "locally-edited-task-removed" });
      continue;
    }
    const incomingValue = fieldValue(incomingTask, change.field);
    if (!equal(incomingValue, change.baseline) && !equal(incomingValue, change.current)) {
      conflicts.push({ ...change, incoming: incomingValue, reason: "both-changed" });
      continue;
    }
    setFieldValue(mergedTask, change.field, change.current);
  }
  return { current: merged, conflicts };
};

const validateCalendarDate = (value: string): boolean => {
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
};

const validateFieldPatch = Effect.fn("SprintPlan.validateFieldPatch")(
  function* (input: SprintPlanTaskPatchInput) {
    yield* decodeIdentifier(input.planId);
    yield* decodeIdentifier(input.spaceId);
    yield* decodeIdentifier(input.taskId);
    yield* decodeIdentifier(input.mutationId);
    yield* decodeMutationProvenance(input.provenance);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      return yield* validationError("Expected plan version must be a non-negative integer.");
    }
    if (!TASK_FIELDS.includes(input.field))
      return yield* validationError("Unsupported task field.");
    if (input.field === "done") {
      if (typeof input.before !== "boolean" || typeof input.after !== "boolean") {
        return yield* validationError(
          "Completion patches require boolean before and after values.",
        );
      }
    } else {
      if (typeof input.before !== "string" || typeof input.after !== "string") {
        return yield* validationError(`Task field '${input.field}' requires string values.`);
      }
      if (
        input.before.length > SPRINT_PLAN_IMPORT_LIMITS.stringLength ||
        input.after.length > SPRINT_PLAN_IMPORT_LIMITS.stringLength
      ) {
        return yield* validationError("Task patch value is too long.");
      }
      if (input.field !== "note" && input.after.length === 0) {
        return yield* validationError(`Task field '${input.field}' cannot be empty.`);
      }
      if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
        return yield* validationError(`A reason is required to edit task field '${input.field}'.`);
      }
      yield* decodeReason(input.reason.trim());
    }
    if (typeof input.reason === "string" && input.reason.trim().length > 0) {
      yield* decodeReason(input.reason.trim());
    } else if (input.reason !== undefined) {
      return yield* validationError("Task patch reason must be a string.");
    }
    if (equal(input.before, input.after))
      return yield* validationError("Task patch makes no change.");
  },
  Effect.mapError((cause) =>
    isServiceError(cause) ? cause : validationError("Invalid task patch.", cause),
  ),
);

export const makeSprintPlanService = Effect.fn("makeSprintPlanService")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const audit = yield* makeCommandCenterAuditLog;
  const mutationLock = yield* Semaphore.make(1);

  const digest = Effect.fn("SprintPlan.digest")(function* (value: string) {
    return Encoding.encodeHex(yield* crypto.digest("SHA-256", textEncoder.encode(value)));
  });

  const parseSource = (value: string) =>
    parseSprintPlanSource(value).pipe(
      Effect.mapError((cause) => validationError(cause.message, cause)),
    );

  const findPlan = Effect.fn("SprintPlan.findPlan")(function* (planId: string, spaceId: string) {
    const rows = yield* sql<PlanRow>`
      SELECT id, space_id AS "spaceId", version, source_version AS "sourceVersion",
        current_import_id AS "currentImportId", current_json AS "currentJson",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM command_center_sprint_plans
      WHERE id = ${planId}
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) return yield* notFoundError(`Sprint plan '${planId}' was not found.`);
    if (row.spaceId !== spaceId) {
      return yield* conflictError(`Sprint plan '${planId}' belongs to another Space.`);
    }
    return row;
  });

  const findImport = Effect.fn("SprintPlan.findImport")(function* (importId: string) {
    const rows = yield* sql<ImportRow>`
      SELECT id, plan_id AS "planId", mutation_id AS "mutationId",
        source_sha256 AS "sourceSha256", source_version AS "sourceVersion",
        source_updated_at AS "sourceUpdatedAt", source_json AS "sourceJson",
        provenance_json AS "provenanceJson", applied_plan_version AS "appliedPlanVersion",
        imported_at AS "importedAt"
      FROM command_center_sprint_plan_imports
      WHERE id = ${importId}
      LIMIT 1
    `;
    const row = rows[0];
    return row === undefined
      ? yield* new SprintPlanServiceError({
          reason: "persistence",
          message: `Sprint plan import '${importId}' is missing.`,
        })
      : row;
  });

  const hydrateImport = Effect.fn("SprintPlan.hydrateImport")(function* (imported: ImportRow) {
    const [parsed, provenance] = yield* Effect.all([
      parseSource(imported.sourceJson),
      decodeJson(imported.provenanceJson).pipe(
        Effect.flatMap(decodeImportProvenance),
        Effect.mapError(
          (cause) =>
            new SprintPlanServiceError({
              reason: "persistence",
              message: "Stored sprint plan provenance is invalid.",
              cause,
            }),
        ),
      ),
    ]);
    return { parsed, provenance };
  });

  const hydrate = Effect.fn("SprintPlan.hydrate")(function* (row: PlanRow) {
    const imported = yield* findImport(row.currentImportId);
    if (imported.planId !== row.id) {
      return yield* new SprintPlanServiceError({
        reason: "persistence",
        message: `Sprint plan '${row.id}' points to another plan's import.`,
      });
    }
    const [hydratedImport, current] = yield* Effect.all([
      hydrateImport(imported),
      parseSource(row.currentJson),
    ]);
    const resolutionRows = yield* sql<DateResolutionRow>`
      SELECT task_id AS "taskId", source_conflict_json AS "sourceConflictJson",
        resolved_date AS "resolvedDate", reason, actor_json AS "actorJson",
        provenance_json AS "provenanceJson", plan_version AS "planVersion",
        updated_at AS "updatedAt"
      FROM command_center_sprint_plan_date_resolutions
      WHERE plan_id = ${row.id}
      ORDER BY task_id
      LIMIT ${SPRINT_PLAN_IMPORT_LIMITS.tasks}
    `;
    const dateResolutions = yield* Effect.forEach(resolutionRows, (resolution) =>
      Effect.all([
        decodeJson(resolution.sourceConflictJson).pipe(Effect.flatMap(decodeDateConflict)),
        decodeIsoDate(resolution.resolvedDate).pipe(
          Effect.filterOrFail(
            validateCalendarDate,
            () =>
              new SprintPlanServiceError({
                reason: "persistence",
                message: "Stored sprint plan resolution date is invalid.",
              }),
          ),
        ),
        decodeJson(resolution.actorJson).pipe(Effect.flatMap(decodeActor)),
        decodeJson(resolution.provenanceJson).pipe(Effect.flatMap(decodeMutationProvenance)),
      ]).pipe(
        Effect.map(([sourceConflict, resolvedDate, actor, provenance]) => ({
          taskId: resolution.taskId,
          sourceConflict,
          resolvedDate,
          reason: resolution.reason,
          actor,
          provenance,
          planVersion: resolution.planVersion,
          updatedAt: resolution.updatedAt,
        })),
        Effect.mapError(
          (cause) =>
            new SprintPlanServiceError({
              reason: "persistence",
              message: "Stored sprint plan date resolution is invalid.",
              cause,
            }),
        ),
      ),
    );
    return {
      id: row.id,
      spaceId: row.spaceId,
      version: row.version,
      sourceVersion: imported.sourceVersion,
      sourceUpdatedAt: imported.sourceUpdatedAt,
      sourceSha256: imported.sourceSha256,
      sourceJson: imported.sourceJson,
      provenance: hydratedImport.provenance,
      baseline: hydratedImport.parsed.source,
      baselineNormalized: hydratedImport.parsed.normalized,
      current: current.source,
      dateResolutions,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } satisfies SprintPlanSnapshot;
  });

  const list = Effect.fn("SprintPlan.list")(function* (input: {
    readonly spaceId: string;
    readonly cursor?: {
      readonly updatedAt: string;
      readonly planId: string;
    };
    readonly limit?: number;
  }) {
    yield* decodeIdentifier(input.spaceId).pipe(
      Effect.mapError((cause) => validationError("Invalid sprint plan Space identifier.", cause)),
    );
    if (
      input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
    ) {
      return yield* validationError("List limit must be an integer between 1 and 100.");
    }
    if (input.cursor !== undefined) {
      yield* Effect.all([
        decodeIsoTimestamp(input.cursor.updatedAt),
        decodeIdentifier(input.cursor.planId),
      ]).pipe(
        Effect.mapError((cause) => validationError("Invalid sprint plan list cursor.", cause)),
      );
    }
    const limit = input.limit ?? 25;
    const rows =
      input.cursor === undefined
        ? yield* sql<PlanSummaryRow>`
            SELECT p.id, p.space_id AS "spaceId", p.version,
              p.source_version AS "sourceVersion", i.source_updated_at AS "sourceUpdatedAt",
              i.source_sha256 AS "sourceSha256", p.created_at AS "createdAt",
              p.updated_at AS "updatedAt"
            FROM command_center_sprint_plans p
            JOIN command_center_sprint_plan_imports i
              ON i.id = p.current_import_id AND i.plan_id = p.id
            WHERE p.space_id = ${input.spaceId}
            ORDER BY p.updated_at DESC, p.id DESC
            LIMIT ${limit + 1}
          `
        : yield* sql<PlanSummaryRow>`
            SELECT p.id, p.space_id AS "spaceId", p.version,
              p.source_version AS "sourceVersion", i.source_updated_at AS "sourceUpdatedAt",
              i.source_sha256 AS "sourceSha256", p.created_at AS "createdAt",
              p.updated_at AS "updatedAt"
            FROM command_center_sprint_plans p
            JOIN command_center_sprint_plan_imports i
              ON i.id = p.current_import_id AND i.plan_id = p.id
            WHERE p.space_id = ${input.spaceId}
              AND (
                p.updated_at < ${input.cursor.updatedAt}
                OR (p.updated_at = ${input.cursor.updatedAt} AND p.id < ${input.cursor.planId})
              )
            ORDER BY p.updated_at DESC, p.id DESC
            LIMIT ${limit + 1}
          `;
    const plans = rows.slice(0, limit);
    const last = plans[plans.length - 1];
    return {
      plans,
      ...(rows.length > limit && last !== undefined
        ? { nextCursor: { updatedAt: last.updatedAt, planId: last.id } }
        : {}),
    } satisfies SprintPlanListPage;
  }, Effect.mapError(persistenceError));

  const get = Effect.fn("SprintPlan.get")(function* (input: {
    readonly planId: string;
    readonly spaceId: string;
  }) {
    yield* decodeIdentifier(input.planId);
    yield* decodeIdentifier(input.spaceId);
    return yield* hydrate(yield* findPlan(input.planId, input.spaceId));
  }, Effect.mapError(persistenceError));

  const getOriginal = Effect.fn("SprintPlan.getOriginal")(function* (input: {
    readonly planId: string;
    readonly spaceId: string;
  }) {
    yield* decodeIdentifier(input.planId);
    yield* decodeIdentifier(input.spaceId);
    const plan = yield* findPlan(input.planId, input.spaceId);
    const rows = yield* sql<ImportRow>`
      SELECT id, plan_id AS "planId", mutation_id AS "mutationId",
        source_sha256 AS "sourceSha256", source_version AS "sourceVersion",
        source_updated_at AS "sourceUpdatedAt", source_json AS "sourceJson",
        provenance_json AS "provenanceJson", applied_plan_version AS "appliedPlanVersion",
        imported_at AS "importedAt"
      FROM command_center_sprint_plan_imports
      WHERE plan_id = ${plan.id}
      ORDER BY applied_plan_version ASC
      LIMIT 1
    `;
    const imported = rows[0];
    if (imported === undefined) {
      return yield* new SprintPlanServiceError({
        reason: "persistence",
        message: `Sprint plan '${plan.id}' has no original import.`,
      });
    }
    const hydrated = yield* hydrateImport(imported);
    return {
      planId: plan.id,
      spaceId: plan.spaceId,
      sourceVersion: imported.sourceVersion,
      sourceUpdatedAt: imported.sourceUpdatedAt,
      sourceSha256: imported.sourceSha256,
      sourceJson: imported.sourceJson,
      provenance: hydrated.provenance,
      original: hydrated.parsed.source,
      originalNormalized: hydrated.parsed.normalized,
      importedAt: imported.importedAt,
    } satisfies SprintPlanOriginal;
  }, Effect.mapError(persistenceError));

  const previewImport = Effect.fn("SprintPlan.previewImport")(function* (input: {
    readonly planId: string;
    readonly spaceId: string;
    readonly sourceJson: string;
  }) {
    yield* decodeIdentifier(input.planId);
    yield* decodeIdentifier(input.spaceId);
    if (typeof input.sourceJson !== "string") {
      return yield* validationError("Sprint plan source must be a JSON string.");
    }
    const incoming = yield* parseSource(input.sourceJson);
    const sourceSha256 = yield* digest(input.sourceJson);
    const rows = yield* sql<PlanRow>`
      SELECT id, space_id AS "spaceId", version, source_version AS "sourceVersion",
        current_import_id AS "currentImportId", current_json AS "currentJson",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM command_center_sprint_plans WHERE id = ${input.planId} LIMIT 1
    `;
    const existing = rows[0];
    if (existing === undefined) {
      const spaces = yield* sql<{ readonly id: string }>`
        SELECT id FROM command_center_spaces WHERE id = ${input.spaceId} LIMIT 1
      `;
      if (spaces[0] === undefined)
        return yield* notFoundError(`Space '${input.spaceId}' was not found.`);
      return {
        planId: input.planId,
        sourceSha256,
        sourceVersion: incoming.source.version,
        sourceUpdatedAt: incoming.source.updated,
        taskCount: incoming.taskCount,
        existingVersion: null,
        unchangedSource: false,
        conflicts: [],
        sourceDateConflicts: incoming.normalized.dateConflicts,
      } satisfies SprintPlanImportPreview;
    }
    if (existing.spaceId !== input.spaceId) {
      return yield* conflictError(`Sprint plan '${input.planId}' belongs to another Space.`);
    }
    const baselineImport = yield* findImport(existing.currentImportId);
    if (baselineImport.planId !== existing.id) {
      return yield* new SprintPlanServiceError({
        reason: "persistence",
        message: `Sprint plan '${existing.id}' points to another plan's import.`,
      });
    }
    const [baseline, current] = yield* Effect.all([
      parseSource(baselineImport.sourceJson),
      parseSource(existing.currentJson),
    ]);
    return {
      planId: input.planId,
      sourceSha256,
      sourceVersion: incoming.source.version,
      sourceUpdatedAt: incoming.source.updated,
      taskCount: incoming.taskCount,
      existingVersion: existing.version,
      unchangedSource: baselineImport.sourceSha256 === sourceSha256,
      conflicts: mergeImport(baseline.source, current.source, incoming.source).conflicts,
      sourceDateConflicts: incoming.normalized.dateConflicts,
    } satisfies SprintPlanImportPreview;
  }, Effect.mapError(persistenceError));

  const replayVersion = Effect.fn("SprintPlan.replayVersion")(function* (
    mutationId: string,
    requestDigest: string,
  ) {
    const rows = yield* sql<MutationReceiptRow>`
      SELECT plan_id AS "planId", space_id AS "spaceId", plan_version AS "planVersion",
        request_digest AS "requestDigest"
      FROM command_center_sprint_plan_mutation_receipts
      WHERE mutation_id = ${mutationId}
      LIMIT 1
    `;
    const replay = rows[0];
    if (replay !== undefined && replay.requestDigest !== requestDigest) {
      return yield* conflictError(`Mutation '${mutationId}' is already bound to another request.`);
    }
    return replay;
  });

  const recordMutation = (input: {
    readonly mutationId: string;
    readonly planId: string;
    readonly spaceId: string;
    readonly operation: "import" | "task-patch" | "date-resolution";
    readonly requestDigest: string;
    readonly planVersion: number;
    readonly occurredAt: string;
  }) => sql`
    INSERT INTO command_center_sprint_plan_mutation_receipts (
      mutation_id, plan_id, space_id, operation, request_digest, plan_version, occurred_at
    ) VALUES (
      ${input.mutationId}, ${input.planId}, ${input.spaceId}, ${input.operation},
      ${input.requestDigest}, ${input.planVersion}, ${input.occurredAt}
    )
  `;

  const applyImportUnlocked = Effect.fn("SprintPlan.applyImportUnlocked")(function* (
    input: SprintPlanApplyImportInput,
    actorInput: SprintPlanActor,
  ) {
    yield* decodeIdentifier(input.planId);
    yield* decodeIdentifier(input.spaceId);
    yield* decodeIdentifier(input.mutationId);
    if (typeof input.sourceJson !== "string") {
      return yield* validationError("Sprint plan source must be a JSON string.");
    }
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      return yield* validationError("Expected plan version must be a non-negative integer.");
    }
    const actor = yield* decodeActor(actorInput);
    const provenance = yield* decodeImportProvenance(input.provenance);
    const conflictDecisions = yield* decodeConflictDecisions(input.conflictDecisions ?? []).pipe(
      Effect.mapError((cause) =>
        validationError("Invalid bounded import conflict decisions.", cause),
      ),
    );
    const decisionKeys = new Set<string>();
    for (const choice of conflictDecisions) {
      const key = JSON.stringify([choice.taskId, choice.field]);
      if (decisionKeys.has(key)) {
        return yield* validationError(`Duplicate decision for ${choice.taskId}.${choice.field}.`);
      }
      decisionKeys.add(key);
    }
    const canonicalDecisions = [...conflictDecisions].sort((left, right) => {
      const leftKey = JSON.stringify([left.taskId, left.field]);
      const rightKey = JSON.stringify([right.taskId, right.field]);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    const incoming = yield* parseSource(input.sourceJson);
    const sourceSha256 = yield* digest(input.sourceJson);
    const requestDigest = yield* digest(
      stringify({
        operation: "import",
        planId: input.planId,
        spaceId: input.spaceId,
        sourceSha256,
        provenance,
        expectedVersion: input.expectedVersion,
        ...(canonicalDecisions.length === 0 ? {} : { conflictDecisions: canonicalDecisions }),
        actor,
      }),
    );
    const replay = yield* replayVersion(input.mutationId, requestDigest);
    if (replay !== undefined) {
      if (replay.planId !== input.planId || replay.spaceId !== input.spaceId) {
        return yield* conflictError(`Mutation '${input.mutationId}' belongs to another plan.`);
      }
      return yield* hydrate(yield* findPlan(input.planId, input.spaceId));
    }

    const rows = yield* sql<PlanRow>`
      SELECT id, space_id AS "spaceId", version, source_version AS "sourceVersion",
        current_import_id AS "currentImportId", current_json AS "currentJson",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM command_center_sprint_plans WHERE id = ${input.planId} LIMIT 1
    `;
    const existing = rows[0];
    if (existing === undefined) {
      if (canonicalDecisions.length > 0) {
        return yield* conflictError("A new plan has no import conflicts to resolve.");
      }
      if (input.expectedVersion !== 0) {
        return yield* conflictError(
          "Sprint plan version is stale; expected a new plan at version 0.",
        );
      }
      const spaces = yield* sql<{ readonly id: string }>`
        SELECT id FROM command_center_spaces WHERE id = ${input.spaceId} LIMIT 1
      `;
      if (spaces[0] === undefined)
        return yield* notFoundError(`Space '${input.spaceId}' was not found.`);
      const now = DateTime.formatIso(yield* DateTime.now);
      const importId = yield* crypto.randomUUIDv4;
      yield* sql`
        INSERT INTO command_center_sprint_plans (
          id, space_id, version, source_version, current_import_id, current_json,
          created_at, updated_at
        ) VALUES (
          ${input.planId}, ${input.spaceId}, 1, ${incoming.source.version}, ${importId},
          ${stringify(incoming.source)}, ${now}, ${now}
        )
      `;
      yield* sql`
        INSERT INTO command_center_sprint_plan_imports (
          id, plan_id, mutation_id, source_sha256, source_version, source_updated_at,
          source_json, provenance_json, applied_plan_version, imported_at
        ) VALUES (
          ${importId}, ${input.planId}, ${input.mutationId}, ${sourceSha256},
          ${incoming.source.version}, ${incoming.source.updated}, ${input.sourceJson},
          ${stringify(provenance)}, 1, ${now}
        )
      `;
      yield* sql`
        INSERT INTO command_center_sprint_plan_history (
          mutation_id, plan_id, space_id, plan_version, operation, before_json, after_json,
          actor_json, provenance_json, request_digest, occurred_at
        ) VALUES (
          ${input.mutationId}, ${input.planId}, ${input.spaceId}, 1, 'import', NULL,
          ${stringify({ sourceSha256, sourceVersion: incoming.source.version })},
          ${stringify(actor)}, ${stringify({ kind: "import", sourceRef: provenance.sourceRef })},
          ${requestDigest}, ${now}
        )
      `;
      yield* recordMutation({
        mutationId: input.mutationId,
        planId: input.planId,
        spaceId: input.spaceId,
        operation: "import",
        requestDigest,
        planVersion: 1,
        occurredAt: now,
      });
      yield* audit.append({
        eventId: `sprint-plan:${input.mutationId}`,
        actorKind: actor.kind,
        action: "cc.sprint-plan.import",
        spaceId: input.spaceId,
        payload: { planId: input.planId, planVersion: 1, sourceSha256 },
        occurredAt: now,
      });
      return yield* hydrate(yield* findPlan(input.planId, input.spaceId));
    }

    if (existing.spaceId !== input.spaceId) {
      return yield* conflictError(`Sprint plan '${input.planId}' belongs to another Space.`);
    }
    if (existing.version !== input.expectedVersion) {
      return yield* conflictError(
        `Sprint plan version is stale; expected ${input.expectedVersion}, current is ${existing.version}.`,
      );
    }
    const previousImport = yield* findImport(existing.currentImportId);
    if (previousImport.planId !== existing.id) {
      return yield* new SprintPlanServiceError({
        reason: "persistence",
        message: `Sprint plan '${existing.id}' points to another plan's import.`,
      });
    }
    if (previousImport.sourceSha256 === sourceSha256) {
      if (canonicalDecisions.length > 0) {
        return yield* conflictError("An unchanged source has no import conflicts to resolve.");
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* recordMutation({
        mutationId: input.mutationId,
        planId: input.planId,
        spaceId: input.spaceId,
        operation: "import",
        requestDigest,
        planVersion: existing.version,
        occurredAt: now,
      });
      return yield* hydrate(existing);
    }
    const [baseline, current] = yield* Effect.all([
      parseSource(previousImport.sourceJson),
      parseSource(existing.currentJson),
    ]);
    const merged = mergeImport(baseline.source, current.source, incoming.source);
    const conflictsByKey = new Map(
      merged.conflicts.map((conflict) => [
        JSON.stringify([conflict.taskId, conflict.field]),
        conflict,
      ]),
    );
    if (
      canonicalDecisions.length !== merged.conflicts.length ||
      canonicalDecisions.some(
        (choice) => !conflictsByKey.has(JSON.stringify([choice.taskId, choice.field])),
      )
    ) {
      return yield* conflictError(
        `Import has ${merged.conflicts.length} current conflict(s); provide one exact decision for each and no extras.`,
      );
    }
    const mergedTasks = taskIndex(merged.current);
    for (const choice of canonicalDecisions) {
      const conflict = conflictsByKey.get(JSON.stringify([choice.taskId, choice.field]))!;
      if (choice.decision === "keep-current") {
        const task = mergedTasks.get(choice.taskId);
        if (task === undefined) {
          return yield* conflictError(
            `Task '${choice.taskId}' was removed by the incoming source; keeping its local edit requires correcting the source.`,
          );
        }
        setFieldValue(task, choice.field, conflict.current);
      }
    }
    const decisionDigest = yield* digest(stringify(canonicalDecisions));
    const validatedMerged = yield* parseSprintPlanSource(merged.current).pipe(
      Effect.mapError((cause) => validationError(cause.message, cause)),
    );
    const now = DateTime.formatIso(yield* DateTime.now);
    const nextVersion = existing.version + 1;
    const importId = yield* crypto.randomUUIDv4;
    yield* sql`
      INSERT INTO command_center_sprint_plan_imports (
        id, plan_id, mutation_id, source_sha256, source_version, source_updated_at,
        source_json, provenance_json, applied_plan_version, imported_at
      ) VALUES (
        ${importId}, ${input.planId}, ${input.mutationId}, ${sourceSha256},
        ${incoming.source.version}, ${incoming.source.updated}, ${input.sourceJson},
        ${stringify(provenance)}, ${nextVersion}, ${now}
      )
    `;
    yield* sql`
      UPDATE command_center_sprint_plans
      SET version = ${nextVersion}, source_version = ${incoming.source.version},
        current_import_id = ${importId}, current_json = ${stringify(merged.current)}, updated_at = ${now}
      WHERE id = ${input.planId} AND space_id = ${input.spaceId} AND version = ${existing.version}
    `;
    yield* sql`
      INSERT INTO command_center_sprint_plan_history (
        mutation_id, plan_id, space_id, plan_version, operation, before_json, after_json,
        actor_json, provenance_json, request_digest, occurred_at
      ) VALUES (
        ${input.mutationId}, ${input.planId}, ${input.spaceId}, ${nextVersion}, 'import',
        ${stringify({ sourceSha256: previousImport.sourceSha256, sourceVersion: previousImport.sourceVersion })},
        ${stringify({ sourceSha256, sourceVersion: incoming.source.version, decisionCount: canonicalDecisions.length, decisionDigest, ...(canonicalDecisions.length <= 100 ? { decisions: canonicalDecisions } : {}) })},
        ${stringify(actor)}, ${stringify({ kind: "import", sourceRef: provenance.sourceRef })},
        ${requestDigest}, ${now}
      )
    `;
    yield* recordMutation({
      mutationId: input.mutationId,
      planId: input.planId,
      spaceId: input.spaceId,
      operation: "import",
      requestDigest,
      planVersion: nextVersion,
      occurredAt: now,
    });
    const activeConflicts = new Map(
      validatedMerged.normalized.dateConflicts.map((conflict) => [
        conflict.taskId,
        stringify(conflict),
      ]),
    );
    const storedResolutions = yield* sql<{
      readonly taskId: string;
      readonly sourceConflictJson: string;
    }>`
      SELECT task_id AS "taskId", source_conflict_json AS "sourceConflictJson"
      FROM command_center_sprint_plan_date_resolutions WHERE plan_id = ${input.planId}
      LIMIT ${SPRINT_PLAN_IMPORT_LIMITS.tasks}
    `;
    for (const resolution of storedResolutions) {
      if (activeConflicts.get(resolution.taskId) !== resolution.sourceConflictJson) {
        yield* sql`
          DELETE FROM command_center_sprint_plan_date_resolutions
          WHERE plan_id = ${input.planId} AND task_id = ${resolution.taskId}
        `;
      }
    }
    yield* audit.append({
      eventId: `sprint-plan:${input.mutationId}`,
      actorKind: actor.kind,
      action: "cc.sprint-plan.import",
      spaceId: input.spaceId,
      payload: {
        planId: input.planId,
        planVersion: nextVersion,
        sourceSha256,
        conflictDecisions: canonicalDecisions,
      },
      occurredAt: now,
    });
    return yield* hydrate(yield* findPlan(input.planId, input.spaceId));
  });

  const applyImport = (input: SprintPlanApplyImportInput, actor: SprintPlanActor) =>
    mutationLock
      .withPermits(1)(sql.withTransaction(applyImportUnlocked(input, actor)))
      .pipe(Effect.mapError(persistenceError));

  const patchTaskUnlocked = Effect.fn("SprintPlan.patchTaskUnlocked")(function* (
    input: SprintPlanTaskPatchInput,
    actorInput: SprintPlanActor,
  ) {
    yield* validateFieldPatch(input);
    const actor = yield* decodeActor(actorInput);
    const provenance = yield* decodeMutationProvenance(input.provenance);
    const requestDigest = yield* digest(stringify({ operation: "task-patch", ...input, actor }));
    const replay = yield* replayVersion(input.mutationId, requestDigest);
    if (replay !== undefined) {
      if (replay.planId !== input.planId || replay.spaceId !== input.spaceId) {
        return yield* conflictError(`Mutation '${input.mutationId}' belongs to another plan.`);
      }
      return yield* hydrate(yield* findPlan(input.planId, input.spaceId));
    }
    const plan = yield* findPlan(input.planId, input.spaceId);
    if (plan.version !== input.expectedVersion) {
      return yield* conflictError(
        `Sprint plan version is stale; expected ${input.expectedVersion}, current is ${plan.version}.`,
      );
    }
    const parsed = yield* parseSource(plan.currentJson);
    const current = mutableClone(parsed.source);
    const task = taskIndex(current).get(input.taskId);
    if (task === undefined) return yield* notFoundError(`Task '${input.taskId}' was not found.`);
    const storedBefore = fieldValue(task, input.field);
    if (!equal(storedBefore, input.before)) {
      return yield* conflictError(
        `Task '${input.taskId}.${input.field}' no longer matches before.`,
      );
    }
    setFieldValue(task, input.field, input.after);
    // Re-validate the complete bounded source after mutation and before persistence.
    const validatedCurrent = yield* parseSprintPlanSource(current).pipe(
      Effect.mapError((cause) => validationError(cause.message, cause)),
    );
    const now = DateTime.formatIso(yield* DateTime.now);
    const nextVersion = plan.version + 1;
    yield* sql`
      UPDATE command_center_sprint_plans
      SET current_json = ${stringify(current)}, version = ${nextVersion}, updated_at = ${now}
      WHERE id = ${input.planId} AND space_id = ${input.spaceId} AND version = ${plan.version}
    `;
    if (input.field === "day" || input.field === "text") {
      const currentConflict = validatedCurrent.normalized.dateConflicts.find(
        (candidate) => candidate.taskId === input.taskId,
      );
      yield* sql`
        DELETE FROM command_center_sprint_plan_date_resolutions
        WHERE plan_id = ${input.planId} AND task_id = ${input.taskId}
          AND source_conflict_json <> ${currentConflict === undefined ? "null" : stringify(currentConflict)}
      `;
    }
    yield* sql`
      INSERT INTO command_center_sprint_plan_history (
        mutation_id, plan_id, space_id, plan_version, operation, task_id, field,
        before_json, after_json, reason, actor_json, provenance_json, request_digest, occurred_at
      ) VALUES (
        ${input.mutationId}, ${input.planId}, ${input.spaceId}, ${nextVersion}, 'task-patch',
        ${input.taskId}, ${input.field}, ${stringify(input.before)}, ${stringify(input.after)},
        ${input.reason?.trim() ?? null}, ${stringify(actor)}, ${stringify(provenance)},
        ${requestDigest}, ${now}
      )
    `;
    yield* recordMutation({
      mutationId: input.mutationId,
      planId: input.planId,
      spaceId: input.spaceId,
      operation: "task-patch",
      requestDigest,
      planVersion: nextVersion,
      occurredAt: now,
    });
    yield* audit.append({
      eventId: `sprint-plan:${input.mutationId}`,
      actorKind: actor.kind,
      action: "cc.sprint-plan.task.patch",
      spaceId: input.spaceId,
      payload: {
        planId: input.planId,
        planVersion: nextVersion,
        taskId: input.taskId,
        field: input.field,
        before: input.before,
        after: input.after,
        ...(input.reason === undefined ? {} : { reason: input.reason.trim() }),
        provenance,
      },
      occurredAt: now,
    });
    return yield* hydrate(yield* findPlan(input.planId, input.spaceId));
  });

  const patchTask = (input: SprintPlanTaskPatchInput, actor: SprintPlanActor) =>
    mutationLock
      .withPermits(1)(sql.withTransaction(patchTaskUnlocked(input, actor)))
      .pipe(Effect.mapError(persistenceError));

  const resolveDateConflictUnlocked = Effect.fn("SprintPlan.resolveDateConflictUnlocked")(
    function* (input: SprintPlanDateResolutionInput, actorInput: SprintPlanActor) {
      yield* decodeIdentifier(input.planId);
      yield* decodeIdentifier(input.spaceId);
      yield* decodeIdentifier(input.taskId);
      yield* decodeIdentifier(input.mutationId);
      yield* decodeIsoDate(input.resolvedDate);
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
        return yield* validationError("Expected plan version must be a non-negative integer.");
      }
      if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
        return yield* validationError("A reason is required to resolve a source date conflict.");
      }
      yield* decodeReason(input.reason.trim());
      if (!validateCalendarDate(input.resolvedDate)) {
        return yield* validationError("Resolved task date is not a valid calendar date.");
      }
      const actor = yield* decodeActor(actorInput);
      const provenance = yield* decodeMutationProvenance(input.provenance);
      const requestDigest = yield* digest(
        stringify({ operation: "date-resolution", ...input, actor }),
      );
      const replay = yield* replayVersion(input.mutationId, requestDigest);
      if (replay !== undefined) {
        if (replay.planId !== input.planId || replay.spaceId !== input.spaceId) {
          return yield* conflictError(`Mutation '${input.mutationId}' belongs to another plan.`);
        }
        return yield* hydrate(yield* findPlan(input.planId, input.spaceId));
      }
      const plan = yield* findPlan(input.planId, input.spaceId);
      if (plan.version !== input.expectedVersion) {
        return yield* conflictError(
          `Sprint plan version is stale; expected ${input.expectedVersion}, current is ${plan.version}.`,
        );
      }
      const parsed = yield* parseSource(plan.currentJson);
      const conflict = parsed.normalized.dateConflicts.find(
        (candidate) => candidate.taskId === input.taskId,
      );
      if (conflict === undefined) {
        return yield* validationError(
          `Task '${input.taskId}' has no unresolved source date conflict.`,
        );
      }
      const previousRows = yield* sql<{ readonly resolvedDate: string }>`
        SELECT resolved_date AS "resolvedDate"
        FROM command_center_sprint_plan_date_resolutions
        WHERE plan_id = ${input.planId} AND task_id = ${input.taskId}
        LIMIT 1
      `;
      const now = DateTime.formatIso(yield* DateTime.now);
      const nextVersion = plan.version + 1;
      yield* sql`
        INSERT INTO command_center_sprint_plan_date_resolutions (
          plan_id, task_id, source_conflict_json, resolved_date, reason, actor_json,
          provenance_json, plan_version, updated_at
        ) VALUES (
          ${input.planId}, ${input.taskId}, ${stringify(conflict)}, ${input.resolvedDate},
          ${input.reason.trim()}, ${stringify(actor)}, ${stringify(provenance)}, ${nextVersion}, ${now}
        )
        ON CONFLICT(plan_id, task_id) DO UPDATE SET
          source_conflict_json = excluded.source_conflict_json,
          resolved_date = excluded.resolved_date,
          reason = excluded.reason,
          actor_json = excluded.actor_json,
          provenance_json = excluded.provenance_json,
          plan_version = excluded.plan_version,
          updated_at = excluded.updated_at
      `;
      yield* sql`
        UPDATE command_center_sprint_plans
        SET version = ${nextVersion}, updated_at = ${now}
        WHERE id = ${input.planId} AND space_id = ${input.spaceId} AND version = ${plan.version}
      `;
      yield* sql`
        INSERT INTO command_center_sprint_plan_history (
          mutation_id, plan_id, space_id, plan_version, operation, task_id, field,
          before_json, after_json, reason, actor_json, provenance_json, request_digest, occurred_at
        ) VALUES (
          ${input.mutationId}, ${input.planId}, ${input.spaceId}, ${nextVersion},
          'date-resolution', ${input.taskId}, 'dateResolution',
          ${previousRows[0] === undefined ? null : stringify(previousRows[0].resolvedDate)},
          ${stringify(input.resolvedDate)}, ${input.reason.trim()}, ${stringify(actor)},
          ${stringify(provenance)}, ${requestDigest}, ${now}
        )
      `;
      yield* recordMutation({
        mutationId: input.mutationId,
        planId: input.planId,
        spaceId: input.spaceId,
        operation: "date-resolution",
        requestDigest,
        planVersion: nextVersion,
        occurredAt: now,
      });
      yield* audit.append({
        eventId: `sprint-plan:${input.mutationId}`,
        actorKind: actor.kind,
        action: "cc.sprint-plan.date.resolve",
        spaceId: input.spaceId,
        payload: {
          planId: input.planId,
          planVersion: nextVersion,
          taskId: input.taskId,
          sourceConflict: conflict,
          resolvedDate: input.resolvedDate,
          reason: input.reason.trim(),
          provenance,
        },
        occurredAt: now,
      });
      return yield* hydrate(yield* findPlan(input.planId, input.spaceId));
    },
  );

  const resolveDateConflict = (input: SprintPlanDateResolutionInput, actor: SprintPlanActor) =>
    mutationLock
      .withPermits(1)(sql.withTransaction(resolveDateConflictUnlocked(input, actor)))
      .pipe(Effect.mapError(persistenceError));

  const listHistory = Effect.fn("SprintPlan.listHistory")(function* (input: {
    readonly planId: string;
    readonly spaceId: string;
    readonly beforeSequence?: number;
    readonly limit?: number;
  }) {
    yield* decodeIdentifier(input.planId);
    yield* decodeIdentifier(input.spaceId);
    yield* findPlan(input.planId, input.spaceId);
    if (
      input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
    ) {
      return yield* validationError("History limit must be an integer between 1 and 100.");
    }
    if (
      input.beforeSequence !== undefined &&
      (!Number.isSafeInteger(input.beforeSequence) || input.beforeSequence < 1)
    ) {
      return yield* validationError("History cursor must be a positive integer.");
    }
    const limit = input.limit ?? 25;
    const beforeSequence = input.beforeSequence ?? Number.MAX_SAFE_INTEGER;
    const rows = yield* sql<HistoryRow>`
      SELECT sequence, mutation_id AS "mutationId", plan_id AS "planId",
        space_id AS "spaceId", plan_version AS "planVersion", operation, task_id AS "taskId",
        field, before_json AS "beforeJson", after_json AS "afterJson", reason,
        actor_json AS "actorJson", provenance_json AS "provenanceJson",
        request_digest AS "requestDigest", occurred_at AS "occurredAt"
      FROM command_center_sprint_plan_history
      WHERE plan_id = ${input.planId} AND space_id = ${input.spaceId}
        AND sequence < ${beforeSequence}
      ORDER BY sequence DESC
      LIMIT ${limit + 1}
    `;
    const page = rows.slice(0, limit);
    const entries = yield* Effect.forEach(page, (row) =>
      Effect.all([
        row.beforeJson === null ? Effect.succeed(undefined) : decodeJson(row.beforeJson),
        row.afterJson === null ? Effect.succeed(undefined) : decodeJson(row.afterJson),
        decodeJson(row.actorJson).pipe(Effect.flatMap(decodeActor)),
        decodeJson(row.provenanceJson).pipe(Effect.flatMap(decodeMutationProvenance)),
      ]).pipe(
        Effect.map(([before, after, actor, provenance]) => ({
          sequence: row.sequence,
          mutationId: row.mutationId,
          planId: row.planId,
          spaceId: row.spaceId,
          planVersion: row.planVersion,
          operation: row.operation,
          ...(row.taskId === null ? {} : { taskId: row.taskId }),
          ...(row.field === null ? {} : { field: row.field }),
          ...(before === undefined ? {} : { before }),
          ...(after === undefined ? {} : { after }),
          ...(row.reason === null ? {} : { reason: row.reason }),
          actor,
          provenance,
          occurredAt: row.occurredAt,
        })),
      ),
    );
    return {
      entries,
      ...(rows.length <= limit || page.length === 0
        ? {}
        : { nextBeforeSequence: page[page.length - 1]!.sequence }),
    } satisfies SprintPlanHistoryPage;
  }, Effect.mapError(persistenceError));

  return SprintPlanService.of({
    list,
    previewImport,
    applyImport,
    get,
    getOriginal,
    patchTask,
    resolveDateConflict,
    listHistory,
  });
});

export const layer = Layer.effect(SprintPlanService, makeSprintPlanService());
