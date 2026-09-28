// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { parseSprintPlanSource } from "@command-center/core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { canonicalJson } from "./automation/Digest.ts";
import { makeSprintPlanService } from "./SprintPlan.ts";

const Id = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200));
const SourcePath = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512));
const Version = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const CandidateKind = Schema.Literals(["clip", "title", "thumbnail"]);
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const BLOCK_CAUSES = [
  "missing-recording",
  "source-unavailable",
  "stale-plan-version",
  "date-ambiguous",
] as const;
const BindingInput = Schema.Struct({
  spaceId: Id,
  planId: Id,
  taskId: Id,
  candidateKind: CandidateKind,
  expectedPlanVersion: Version,
  expectedBindingVersion: Version,
  performerId: Id,
  performerName: Id,
  recordingId: Id,
  recordingVersion: Id,
  rootId: Id,
  relativePath: SourcePath,
  sourceSha256: Digest,
});
const ScanInput = Schema.Struct({
  spaceId: Id,
  planId: Id,
  responsibilityId: Id,
  candidateKind: CandidateKind,
  taskIds: Schema.Array(Id).check(Schema.isNonEmpty(), Schema.isMaxLength(30)),
  today: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)),
  windowDays: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30 })),
});
export type CcnBindingInput = typeof BindingInput.Type;
export type CcnScanInput = typeof ScanInput.Type;

export interface CcnRecordingBinding extends Omit<
  CcnBindingInput,
  "expectedPlanVersion" | "expectedBindingVersion"
> {
  readonly id: string;
  readonly planVersion: number;
  readonly version: number;
}

export class CcnPreparationError extends Schema.TaggedErrorClass<CcnPreparationError>()(
  "CcnPreparationError",
  {
    reason: Schema.Literals(["validation", "not-found", "conflict", "persistence"]),
    message: Schema.String,
  },
) {}

const decodeBinding = Schema.decodeUnknownEffect(BindingInput);
const decodeScan = Schema.decodeUnknownEffect(ScanInput);
const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const bindingId = (
  input: Pick<CcnBindingInput, "spaceId" | "planId" | "taskId" | "candidateKind">,
) =>
  `ccn-binding:${hash(canonicalJson([input.spaceId, input.planId, input.taskId, input.candidateKind]))}`;
const blockedId = (input: { spaceId: string; planId: string; taskId: string; cause: string }) =>
  `ccn-blocked:${hash(canonicalJson([input.spaceId, input.planId, input.taskId, input.cause]))}`;
const validation = (message: string) => new CcnPreparationError({ reason: "validation", message });
const conflict = (message: string) => new CcnPreparationError({ reason: "conflict", message });

type BindingRow = CcnRecordingBinding;

export const makeCcnPreparation = Effect.fn("CcnPreparation.make")(function* (dependencies: {
  readonly sourceReady: (
    binding: CcnRecordingBinding,
  ) => Effect.Effect<boolean, CcnPreparationError>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const plans = yield* makeSprintPlanService();

  const getBinding = Effect.fn("CcnPreparation.getBinding")(function* (input: {
    readonly spaceId: string;
    readonly planId: string;
    readonly taskId: string;
    readonly candidateKind: CcnBindingInput["candidateKind"];
  }) {
    const rows = yield* sql<BindingRow>`
      SELECT id, space_id AS "spaceId", plan_id AS "planId", task_id AS "taskId",
        candidate_kind AS "candidateKind", plan_version AS "planVersion", version,
        performer_id AS "performerId", performer_name AS "performerName",
        recording_id AS "recordingId", recording_version AS "recordingVersion",
        root_id AS "rootId", relative_path AS "relativePath", source_sha256 AS "sourceSha256"
      FROM command_center_ccn_recording_bindings
      WHERE space_id = ${input.spaceId} AND plan_id = ${input.planId}
        AND task_id = ${input.taskId} AND candidate_kind = ${input.candidateKind}
      LIMIT 1`;
    return rows[0] ?? null;
  });

  const putBinding = Effect.fn("CcnPreparation.putBinding")(function* (raw: unknown) {
    const input = yield* decodeBinding(raw).pipe(
      Effect.mapError(() => validation("Invalid CCN recording binding.")),
    );
    if (
      input.relativePath.startsWith("/") ||
      input.relativePath
        .split("/")
        .some((part) => part === ".." || part === "." || part === "" || part.includes("\\"))
    ) {
      return yield* validation("Recording path must be relative to an approved root.");
    }
    const id = bindingId(input);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const plan = yield* plans
          .get({ planId: input.planId, spaceId: input.spaceId })
          .pipe(
            Effect.mapError(
              (cause) => new CcnPreparationError({ reason: cause.reason, message: cause.message }),
            ),
          );
        if (plan.version !== input.expectedPlanVersion)
          return yield* conflict("Sprint Plan version changed.");
        const task = plan.current.weeks
          .flatMap((week) => week.tasks)
          .find((candidate) => candidate.id === input.taskId);
        if (task === undefined)
          return yield* validation("The selected task is not in this Sprint Plan.");
        const current = yield* getBinding(input);
        if ((current?.version ?? 0) !== input.expectedBindingVersion)
          return yield* conflict("Recording binding version changed.");
        const now = DateTime.formatIso(yield* DateTime.now);
        if (current === null) {
          yield* sql`
          INSERT INTO command_center_ccn_recording_bindings (
            id, space_id, plan_id, task_id, candidate_kind, plan_version, version,
            performer_id, performer_name, recording_id, recording_version,
            root_id, relative_path, source_sha256, created_at, updated_at
          ) VALUES (
            ${id}, ${input.spaceId}, ${input.planId}, ${input.taskId}, ${input.candidateKind},
            ${plan.version}, 1, ${input.performerId}, ${input.performerName},
            ${input.recordingId}, ${input.recordingVersion}, ${input.rootId},
            ${input.relativePath}, ${input.sourceSha256}, ${now}, ${now}
          )
        `;
        } else {
          yield* sql`
          UPDATE command_center_ccn_recording_bindings
          SET plan_version = ${plan.version}, version = version + 1,
            performer_id = ${input.performerId}, performer_name = ${input.performerName},
            recording_id = ${input.recordingId}, recording_version = ${input.recordingVersion},
            root_id = ${input.rootId}, relative_path = ${input.relativePath},
            source_sha256 = ${input.sourceSha256}, updated_at = ${now}
          WHERE id = ${id} AND version = ${input.expectedBindingVersion}
        `;
        }
        return (yield* getBinding(input))!;
      }),
    );
  });

  const recordBlocked = Effect.fn("CcnPreparation.recordBlocked")(function* (input: {
    spaceId: string;
    planId: string;
    taskId: string;
    responsibilityId: string;
    cause: string;
    dueAt: string;
  }) {
    const id = blockedId(input);
    const now = DateTime.formatIso(yield* DateTime.now);
    const staleIds = BLOCK_CAUSES.filter((cause) => cause !== input.cause).map((cause) =>
      blockedId({ ...input, cause }),
    );
    yield* sql`
      UPDATE command_center_items SET status = 'canceled', updated_at = ${now}
      WHERE space_id = ${input.spaceId} AND status = 'waiting'
        AND id IN (${staleIds[0]}, ${staleIds[1]}, ${staleIds[2]})
    `;
    yield* sql`
      INSERT INTO command_center_items (
        id, space_id, kind, status, title, body, priority, due_at,
        source_json, links_json, metadata_json, created_at, updated_at
      ) VALUES (
        ${id}, ${input.spaceId}, 'alert', 'waiting',
        'CCN preparation needs a recording',
        ${`Sprint Plan task ${input.taskId} needs an explicit recording mapping (${input.cause}). Select the performer and an approved source before clip preparation resumes.`},
        'high', ${input.dueAt},
        ${canonicalJson({ kind: "automation", sourceRef: `ccn-preparation:${input.responsibilityId}`, capturedAt: now })},
        '[]', ${canonicalJson({ planId: input.planId, taskId: input.taskId, cause: input.cause })},
        ${now}, ${now}
      ) ON CONFLICT(id) DO UPDATE SET
        status = 'waiting', due_at = excluded.due_at,
        body = excluded.body, metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `;
    return id;
  });

  const scan = Effect.fn("CcnPreparation.scan")(function* (raw: unknown) {
    const input = yield* decodeScan(raw).pipe(
      Effect.mapError(() => validation("Invalid CCN preparation scan.")),
    );
    const parsedToday = DateTime.make(`${input.today}T00:00:00.000Z`);
    if (
      new Set(input.taskIds).size !== input.taskIds.length ||
      Option.isNone(parsedToday) ||
      DateTime.formatIsoDateUtc(parsedToday.value) !== input.today
    ) {
      return yield* validation("CCN scan has repeated task IDs or an invalid date.");
    }
    const plan = yield* plans
      .get({ planId: input.planId, spaceId: input.spaceId })
      .pipe(
        Effect.mapError(
          (cause) => new CcnPreparationError({ reason: cause.reason, message: cause.message }),
        ),
      );
    const normalized = (yield* parseSprintPlanSource(plan.current).pipe(
      Effect.mapError((cause) => validation(cause.message)),
    )).normalized;
    const tasks = new Map(
      normalized.weeks.flatMap((week) => week.tasks.map((task) => [task.id, task] as const)),
    );
    const current = new Map(
      plan.current.weeks.flatMap((week) => week.tasks.map((task) => [task.id, task] as const)),
    );
    const resolution = new Map(
      plan.dateResolutions.map((entry) => [entry.taskId, entry.resolvedDate] as const),
    );
    const cutoffIso = DateTime.formatIsoDateUtc(
      DateTime.add(parsedToday.value, { days: input.windowDays }),
    );
    const candidates: Array<{
      taskId: string;
      workIdentity: string;
      binding: CcnRecordingBinding;
      dueAt: string;
    }> = [];
    const blocked: Array<{ taskId: string; itemId: string; cause: string }> = [];
    for (const taskId of input.taskIds) {
      const task = tasks.get(taskId);
      const sourceTask = current.get(taskId);
      if (task === undefined || sourceTask === undefined)
        return yield* validation(`Task '${taskId}' is not in the selected Sprint Plan.`);
      if (sourceTask.done) continue;
      const date = resolution.get(taskId) ?? task.scheduledDate;
      if (date === undefined) {
        const cause = "date-ambiguous";
        blocked.push({
          taskId,
          cause,
          itemId: yield* recordBlocked({ ...input, taskId, cause, dueAt: input.today }),
        });
        continue;
      }
      if (date < input.today || date > cutoffIso) continue;
      const binding = yield* getBinding({ ...input, taskId });
      const cause =
        binding === null
          ? "missing-recording"
          : binding.planVersion !== plan.version
            ? "stale-plan-version"
            : (yield* dependencies.sourceReady(binding))
              ? null
              : "source-unavailable";
      if (cause !== null) {
        blocked.push({
          taskId,
          cause,
          itemId: yield* recordBlocked({ ...input, taskId, cause, dueAt: date }),
        });
        continue;
      }
      if (binding === null)
        return yield* conflict("Recording binding vanished during preparation.");
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE command_center_items SET status = 'canceled', updated_at = ${now}
        WHERE space_id = ${input.spaceId} AND id IN (
          ${blockedId({ ...input, taskId, cause: "missing-recording" })},
          ${blockedId({ ...input, taskId, cause: "source-unavailable" })},
          ${blockedId({ ...input, taskId, cause: "stale-plan-version" })},
          ${blockedId({ ...input, taskId, cause: "date-ambiguous" })}
        ) AND status = 'waiting'
      `;
      candidates.push({
        taskId,
        binding,
        dueAt: date,
        workIdentity: `ccn-preparation:v1:${hash(
          canonicalJson([
            input.spaceId,
            input.planId,
            input.responsibilityId,
            taskId,
            plan.version,
            binding.version,
            binding.recordingVersion,
            input.candidateKind,
          ]),
        )}`,
      });
    }
    return { planVersion: plan.version, candidates, blocked };
  });

  return { getBinding, putBinding, scan };
});
