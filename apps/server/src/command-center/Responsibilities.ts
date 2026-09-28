import {
  Automation,
  NonNegativeInt,
  TrimmedNonEmptyString,
  type Automation as AutomationType,
} from "@command-center/core";
import { nextAutomationScheduleOccurrences } from "@t3tools/shared/automationSchedule";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeCommandCenterAuditLog } from "./AuditLog.ts";
import { preparationResultFromOutput } from "./automation/PreparationResult.ts";

const BoundedId = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const BoundedActor = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const BoundedReason = TrimmedNonEmptyString.check(Schema.isMaxLength(500));
const BoundedLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }));

const ListInput = Schema.Struct({
  spaceId: Schema.optionalKey(BoundedId),
  limit: Schema.optionalKey(BoundedLimit),
});
const DetailInput = Schema.Struct({
  spaceId: BoundedId,
  automationId: BoundedId,
  historyLimit: Schema.optionalKey(BoundedLimit),
});
const PauseInput = Schema.Struct({
  spaceId: BoundedId,
  automationId: BoundedId,
  paused: Schema.Boolean,
  actor: BoundedActor,
  reason: Schema.optionalKey(BoundedReason),
  expectedVersion: NonNegativeInt,
});

export type ResponsibilityHealth =
  | "paused"
  | "blocked"
  | "temporarily-failing"
  | "healthy"
  | "unknown";

export interface ResponsibilityResultReference {
  readonly kind: "artifact";
  readonly artifactId: string;
  readonly runId: string;
  readonly executionId: string;
  readonly spaceId: string;
  readonly automationId: string;
}

export interface ResponsibilityIncident {
  readonly id: string;
  readonly state: "transient" | "blocked" | "resolved";
  readonly canonicalCode: string;
  readonly resource: string;
  readonly subject: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly occurrenceCount: number;
  readonly latestExecutionId: string | null;
  readonly retryAt: string | null;
  readonly recoveryInstruction: string;
  readonly displayError: string;
  readonly resolvedAt: string | null;
}

export interface ResponsibilityHistoryEntry {
  readonly executionId: string;
  readonly workIdentity: string;
  readonly state: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly error: string | null;
  readonly usefulResultRef: ResponsibilityResultReference | null;
  readonly preparationResult: import("@t3tools/contracts").CommandCenterPreparationResult | null;
}

export interface ResponsibilityStatus {
  readonly automationId: string;
  readonly spaceId: string;
  readonly name: string;
  readonly purpose: string;
  readonly owner: string;
  readonly enabled: boolean;
  readonly watchedSources: ReadonlyArray<string>;
  readonly authority: null;
  readonly limits: null;
  readonly authorityExplanation: string;
  readonly limitsExplanation: string;
  readonly paused: boolean;
  readonly pauseActor: string | null;
  readonly pauseReason: string | null;
  readonly pauseVersion: number;
  readonly health: ResponsibilityHealth;
  readonly lastAdmissionAttemptAt: string | null;
  readonly lastAdmissionStatus: "admitted" | "paused" | "blocked" | null;
  readonly lastCheckedAt: string | null;
  readonly lastCheckStatus: "ok" | "transient-error" | "blocked" | "paused" | null;
  readonly lastSuccessfulAt: string | null;
  readonly lastUsefulResultAt: string | null;
  readonly lastUsefulResultRef: ResponsibilityResultReference | null;
  readonly lastPreparationResult:
    | import("@t3tools/contracts").CommandCenterPreparationResult
    | null;
  readonly currentExecutionId: string | null;
  readonly nextScheduledAt: string | null;
  readonly incidentId: string | null;
  readonly incident: ResponsibilityIncident | null;
}

export interface ResponsibilityDetail extends ResponsibilityStatus {
  readonly history: ReadonlyArray<ResponsibilityHistoryEntry>;
}

export class ResponsibilityError extends Schema.TaggedErrorClass<ResponsibilityError>()(
  "ResponsibilityError",
  {
    code: Schema.Literals([
      "validation",
      "not-found",
      "conflict",
      "config-unavailable",
      "persistence",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
const isResponsibilityError = Schema.is(ResponsibilityError);

export interface ResponsibilityConfigIdentity {
  readonly automationId: string;
  readonly spaceId: string;
  readonly configCommitSha: string;
  readonly definitionDigest: string;
  readonly enabled: boolean;
}

export interface ResponsibilityDependencies {
  /**
   * Integration seam for the parent service: synchronize private config, then
   * return the exact committed Automation identity in the requested Space.
   */
  readonly validateAutomation: (input: {
    readonly automationId: string;
    readonly spaceId: string;
  }) => Effect.Effect<ResponsibilityConfigIdentity, ResponsibilityError>;
  readonly listConfiguredAutomations: () => Effect.Effect<
    ReadonlyArray<ResponsibilityConfigIdentity>,
    ResponsibilityError
  >;
  readonly now: Effect.Effect<string>;
}

export interface ResponsibilitiesShape {
  readonly list: (
    input: unknown,
  ) => Effect.Effect<ReadonlyArray<ResponsibilityStatus>, ResponsibilityError>;
  readonly get: (input: unknown) => Effect.Effect<ResponsibilityDetail, ResponsibilityError>;
  readonly setPause: (input: unknown) => Effect.Effect<ResponsibilityStatus, ResponsibilityError>;
}

export class Responsibilities extends Context.Service<Responsibilities, ResponsibilitiesShape>()(
  "@awtprod/command-center/command-center/Responsibilities",
) {}

interface ResponsibilityRow {
  readonly automationId: string;
  readonly spaceId: string;
  readonly name: string;
  readonly owner: string;
  readonly enabled: number;
  readonly commitSha: string;
  readonly definitionDigest: string;
  readonly definitionJson: string;
  readonly paused: number | null;
  readonly pauseActor: string | null;
  readonly pauseReason: string | null;
  readonly pauseVersion: number | null;
  readonly lastAdmissionAttemptAt: string | null;
  readonly lastAdmissionStatus: "admitted" | "paused" | "blocked" | null;
  readonly lastCheckedAt: string | null;
  readonly lastCheckStatus: "ok" | "transient-error" | "blocked" | "paused" | null;
  readonly lastSuccessfulAt: string | null;
  readonly currentExecutionId: string | null;
  readonly incidentId: string | null;
  readonly incidentState: "transient" | "blocked" | "resolved" | null;
  readonly canonicalCode: string | null;
  readonly incidentResource: string | null;
  readonly incidentSubject: string | null;
  readonly firstSeenAt: string | null;
  readonly lastSeenAt: string | null;
  readonly occurrenceCount: number | null;
  readonly latestExecutionId: string | null;
  readonly retryAt: string | null;
  readonly recoveryInstruction: string | null;
  readonly displayError: string | null;
  readonly resolvedAt: string | null;
  readonly artifactId: string | null;
  readonly artifactRunId: string | null;
  readonly artifactExecutionId: string | null;
  readonly artifactCreatedAt: string | null;
  readonly lastOutputJson: string | null;
}

interface HistoryRow {
  readonly executionId: string;
  readonly workIdentity: string | null;
  readonly state: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly error: string | null;
  readonly artifactId: string | null;
  readonly artifactRunId: string | null;
  readonly artifactCreatedAt: string | null;
  readonly outputJson: string | null;
}

const decodeAutomation = Schema.decodeUnknownEffect(Automation);
const decodeListInput = Schema.decodeUnknownEffect(ListInput);
const decodeDetailInput = Schema.decodeUnknownEffect(DetailInput);
const decodePauseInput = Schema.decodeUnknownEffect(PauseInput);
const decodeStoredJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const validationError = (cause: unknown) =>
  new ResponsibilityError({
    code: "validation",
    message: "The Responsibility request is invalid.",
    cause,
  });
const persistenceError = (message: string, cause: unknown) =>
  new ResponsibilityError({ code: "persistence", message, cause });

function boundedDisplayError(value: string | null): string | null {
  if (value === null) return null;
  const withoutControls = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || (codePoint >= 127 && codePoint <= 159) ? " " : character;
  }).join("");
  return withoutControls.replace(/\s+/gu, " ").trim().slice(0, 500);
}

function watchedSources(automation: AutomationType): ReadonlyArray<string> {
  switch (automation.trigger.type) {
    case "manual":
      return [];
    case "schedule":
      return [`schedule:${automation.trigger.expression}@${automation.trigger.timezone}`];
    case "webhook":
      return [`webhook:${automation.trigger.route}`];
  }
}

function resultReference(
  row: Pick<
    ResponsibilityRow,
    "artifactId" | "artifactRunId" | "artifactExecutionId" | "spaceId" | "automationId"
  >,
): ResponsibilityResultReference | null {
  return row.artifactId === null || row.artifactRunId === null || row.artifactExecutionId === null
    ? null
    : {
        kind: "artifact",
        artifactId: row.artifactId,
        runId: row.artifactRunId,
        executionId: row.artifactExecutionId,
        spaceId: row.spaceId,
        automationId: row.automationId,
      };
}

export const make = Effect.fn("Responsibilities.make")(function* (
  dependencies: ResponsibilityDependencies,
) {
  const sql = yield* SqlClient.SqlClient;
  const audit = yield* makeCommandCenterAuditLog;

  const readRows = Effect.fn("Responsibilities.readRows")(function* (input: {
    readonly spaceId?: string;
    readonly automationId?: string;
    readonly limit: number;
  }) {
    return yield* sql<ResponsibilityRow>`
      SELECT automation.id AS "automationId", automation.space_id AS "spaceId",
        automation.name, space.owner_id AS owner, automation.enabled,
        automation.commit_sha AS "commitSha", automation.definition_digest AS "definitionDigest",
        automation.definition_json AS "definitionJson",
        control.paused, control.actor AS "pauseActor", control.reason AS "pauseReason",
        control.revision AS "pauseVersion",
        status.last_admission_attempt_at AS "lastAdmissionAttemptAt",
        status.last_admission_status AS "lastAdmissionStatus",
        status.last_checked_at AS "lastCheckedAt",
        status.last_check_status AS "lastCheckStatus",
        status.last_successful_at AS "lastSuccessfulAt",
        slot.execution_id AS "currentExecutionId",
        incident.id AS "incidentId", incident.state AS "incidentState",
        incident.canonical_code AS "canonicalCode", incident.resource AS "incidentResource",
        incident.subject AS "incidentSubject", incident.first_seen_at AS "firstSeenAt",
        incident.last_seen_at AS "lastSeenAt", incident.occurrence_count AS "occurrenceCount",
        incident.latest_execution_id AS "latestExecutionId", incident.retry_at AS "retryAt",
        incident.recovery_instruction AS "recoveryInstruction",
        incident.display_error AS "displayError", incident.resolved_at AS "resolvedAt",
        useful.id AS "artifactId", useful.run_id AS "artifactRunId",
        useful.execution_id AS "artifactExecutionId", useful.created_at AS "artifactCreatedAt",
        CASE WHEN length(last_execution.output_json) <= 65536
          THEN last_execution.output_json ELSE NULL END AS "lastOutputJson"
      FROM command_center_automations automation
      JOIN command_center_spaces space ON space.id = automation.space_id
        AND space.lifecycle = 'active'
      LEFT JOIN command_center_responsibility_controls control
        ON control.space_id = automation.space_id AND control.automation_id = automation.id
      LEFT JOIN command_center_responsibility_status status
        ON status.space_id = automation.space_id AND status.automation_id = automation.id
      LEFT JOIN command_center_responsibility_active_slots slot
        ON slot.space_id = automation.space_id AND slot.automation_id = automation.id
      LEFT JOIN command_center_responsibility_incidents incident
        ON incident.id = (
          SELECT candidate.id
          FROM command_center_responsibility_incidents candidate
          WHERE candidate.space_id = automation.space_id
            AND candidate.automation_id = automation.id
            AND candidate.state != 'resolved'
          ORDER BY CASE candidate.state WHEN 'blocked' THEN 0 ELSE 1 END,
            candidate.last_seen_at DESC
          LIMIT 1
        )
      LEFT JOIN (
        SELECT artifact.id, artifact.run_id, artifact.created_at,
          execution.id AS execution_id, execution.automation_id
        FROM command_center_artifacts artifact
        JOIN command_center_runs run ON run.id = artifact.run_id
        JOIN command_center_automation_executions execution
          ON execution.id = run.id OR execution.id = run.parent_run_id
        WHERE artifact.kind IN ('report', 'export')
          AND run.state = 'succeeded' AND execution.state = 'succeeded'
      ) useful ON useful.id = (
        SELECT artifact.id
        FROM command_center_artifacts artifact
        JOIN command_center_runs run ON run.id = artifact.run_id
        JOIN command_center_automation_executions execution
          ON execution.id = run.id OR execution.id = run.parent_run_id
        WHERE execution.space_id = automation.space_id
          AND execution.automation_id = automation.id
          AND artifact.kind IN ('report', 'export')
          AND run.state = 'succeeded' AND execution.state = 'succeeded'
        ORDER BY artifact.created_at DESC, artifact.id DESC
        LIMIT 1
      )
      LEFT JOIN command_center_automation_executions last_execution
        ON last_execution.id = (
          SELECT candidate.id FROM command_center_automation_executions candidate
          WHERE candidate.space_id = automation.space_id
            AND candidate.automation_id = automation.id AND candidate.state = 'succeeded'
          ORDER BY candidate.finished_at DESC, candidate.id DESC LIMIT 1
        )
      WHERE (${input.spaceId ?? null} IS NULL OR automation.space_id = ${input.spaceId ?? null})
        AND (${input.automationId ?? null} IS NULL OR automation.id = ${input.automationId ?? null})
      ORDER BY automation.name, automation.id
      LIMIT ${input.limit}
    `;
  });

  const statusFromRow = Effect.fn("Responsibilities.statusFromRow")(function* (
    row: ResponsibilityRow,
  ) {
    const parsed = yield* decodeStoredJson(row.definitionJson).pipe(
      Effect.mapError((cause) =>
        persistenceError("The committed Automation definition is invalid.", cause),
      ),
    );
    const automation = yield* decodeAutomation(parsed).pipe(
      Effect.mapError((cause) =>
        persistenceError("The committed Automation definition is invalid.", cause),
      ),
    );
    const paused = row.paused === 1;
    const incident =
      row.incidentId === null ||
      row.incidentState === null ||
      row.canonicalCode === null ||
      row.incidentResource === null ||
      row.incidentSubject === null ||
      row.firstSeenAt === null ||
      row.lastSeenAt === null ||
      row.occurrenceCount === null ||
      row.recoveryInstruction === null ||
      row.displayError === null
        ? null
        : ({
            id: row.incidentId,
            state: row.incidentState,
            canonicalCode: row.canonicalCode,
            resource: row.incidentResource,
            subject: row.incidentSubject,
            firstSeenAt: row.firstSeenAt,
            lastSeenAt: row.lastSeenAt,
            occurrenceCount: row.occurrenceCount,
            latestExecutionId: row.latestExecutionId,
            retryAt: row.retryAt,
            recoveryInstruction: row.recoveryInstruction,
            displayError: boundedDisplayError(row.displayError) ?? "Automation execution failed.",
            resolvedAt: row.resolvedAt,
          } satisfies ResponsibilityIncident);
    const health: ResponsibilityHealth = paused
      ? "paused"
      : incident?.state === "blocked"
        ? "blocked"
        : incident?.state === "transient"
          ? "temporarily-failing"
          : row.lastCheckStatus === "ok"
            ? "healthy"
            : "unknown";
    const now = yield* dependencies.now;
    const nextScheduledAt =
      automation.trigger.type === "schedule" && row.enabled === 1 && !paused
        ? (nextAutomationScheduleOccurrences(
            automation.trigger.expression,
            automation.trigger.timezone,
            { from: DateTime.toDate(DateTime.makeUnsafe(now)), count: 1 },
          )[0] ?? null)
        : null;
    return {
      automationId: row.automationId,
      spaceId: row.spaceId,
      name: row.name,
      purpose: row.name,
      owner: row.owner,
      enabled: row.enabled === 1,
      watchedSources: watchedSources(automation),
      authority: null,
      limits: null,
      authorityExplanation: "No separate authority is configured for this Automation.",
      limitsExplanation: "No per-Automation limits are configured.",
      paused,
      pauseActor: row.pauseActor,
      pauseReason: row.pauseReason,
      pauseVersion: row.pauseVersion ?? 0,
      health,
      lastAdmissionAttemptAt: row.lastAdmissionAttemptAt,
      lastAdmissionStatus: row.lastAdmissionStatus,
      lastCheckedAt: row.lastCheckedAt,
      lastCheckStatus: row.lastCheckStatus,
      lastSuccessfulAt: row.lastSuccessfulAt,
      lastUsefulResultAt: row.artifactCreatedAt,
      lastUsefulResultRef: resultReference(row),
      lastPreparationResult: preparationResultFromOutput(row.lastOutputJson),
      currentExecutionId: row.currentExecutionId,
      nextScheduledAt,
      incidentId: incident?.id ?? null,
      incident,
    } satisfies ResponsibilityStatus;
  });

  const list = Effect.fn("Responsibilities.list")(
    function* (rawInput: unknown) {
      const input = yield* decodeListInput(rawInput).pipe(Effect.mapError(validationError));
      const configured = yield* dependencies.listConfiguredAutomations();
      const rows = yield* readRows({
        ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
        limit: input.limit ?? 50,
      });
      return yield* Effect.forEach(
        rows.filter((row) =>
          configured.some(
            (identity) =>
              identity.spaceId === row.spaceId &&
              identity.automationId === row.automationId &&
              identity.configCommitSha === row.commitSha &&
              identity.definitionDigest === row.definitionDigest,
          ),
        ),
        statusFromRow,
      );
    },
    Effect.mapError((cause) =>
      isResponsibilityError(cause)
        ? cause
        : persistenceError("Could not list Responsibilities.", cause),
    ),
  );

  const history = Effect.fn("Responsibilities.history")(function* (input: {
    readonly spaceId: string;
    readonly automationId: string;
    readonly limit: number;
  }) {
    const rows = yield* sql<HistoryRow>`
      SELECT execution.id AS "executionId", execution.work_identity AS "workIdentity",
        execution.state, execution.created_at AS "startedAt", execution.finished_at AS "finishedAt",
        execution.error, useful.id AS "artifactId", useful.run_id AS "artifactRunId",
        useful.created_at AS "artifactCreatedAt",
        CASE WHEN length(execution.output_json) <= 65536
          THEN execution.output_json ELSE NULL END AS "outputJson"
      FROM command_center_automation_executions execution
      LEFT JOIN command_center_artifacts useful ON useful.id = (
        SELECT artifact.id
        FROM command_center_artifacts artifact
        JOIN command_center_runs run ON run.id = artifact.run_id
        WHERE run.id = execution.id OR run.parent_run_id = execution.id
        ORDER BY artifact.created_at DESC, artifact.id DESC
        LIMIT 1
      )
      WHERE execution.space_id = ${input.spaceId}
        AND execution.automation_id = ${input.automationId}
      ORDER BY execution.created_at DESC, execution.id DESC
      LIMIT ${input.limit}
    `;
    return rows.map((row) => ({
      executionId: row.executionId,
      workIdentity: row.workIdentity ?? `responsibility:v1:${input.spaceId}:${input.automationId}`,
      state: row.state,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      error: boundedDisplayError(row.error),
      usefulResultRef:
        row.artifactId === null || row.artifactRunId === null
          ? null
          : {
              kind: "artifact" as const,
              artifactId: row.artifactId,
              runId: row.artifactRunId,
              executionId: row.executionId,
              spaceId: input.spaceId,
              automationId: input.automationId,
            },
      preparationResult:
        row.state === "succeeded" ? preparationResultFromOutput(row.outputJson) : null,
    }));
  });

  const get = Effect.fn("Responsibilities.get")(
    function* (rawInput: unknown) {
      const input = yield* decodeDetailInput(rawInput).pipe(Effect.mapError(validationError));
      const rows = yield* readRows({
        spaceId: input.spaceId,
        automationId: input.automationId,
        limit: 1,
      });
      const row = rows[0];
      if (row === undefined) {
        return yield* new ResponsibilityError({
          code: "not-found",
          message: "The Responsibility was not found in the requested Space.",
        });
      }
      const identity = yield* dependencies.validateAutomation({
        spaceId: input.spaceId,
        automationId: input.automationId,
      });
      if (
        identity.configCommitSha !== row.commitSha ||
        identity.definitionDigest !== row.definitionDigest
      ) {
        return yield* new ResponsibilityError({
          code: "config-unavailable",
          message: "The Responsibility's committed Automation is no longer current.",
        });
      }
      return {
        ...(yield* statusFromRow(row)),
        history: yield* history({
          spaceId: input.spaceId,
          automationId: input.automationId,
          limit: input.historyLimit ?? 25,
        }),
      } satisfies ResponsibilityDetail;
    },
    Effect.mapError((cause) =>
      isResponsibilityError(cause)
        ? cause
        : persistenceError("Could not read the Responsibility.", cause),
    ),
  );

  const setPause = Effect.fn("Responsibilities.setPause")(
    function* (rawInput: unknown) {
      const input = yield* decodePauseInput(rawInput).pipe(Effect.mapError(validationError));
      const identity = yield* dependencies.validateAutomation({
        spaceId: input.spaceId,
        automationId: input.automationId,
      });
      if (identity.spaceId !== input.spaceId || identity.automationId !== input.automationId) {
        return yield* new ResponsibilityError({
          code: "not-found",
          message: "The Responsibility was not found in the requested Space.",
        });
      }
      const changedAt = yield* dependencies.now;
      const changed = yield* sql.withTransaction(
        Effect.gen(function* () {
          const automations = yield* sql<{
            readonly commitSha: string;
            readonly definitionDigest: string;
          }>`
          SELECT commit_sha AS "commitSha", definition_digest AS "definitionDigest"
          FROM command_center_automations
          WHERE id = ${input.automationId} AND space_id = ${input.spaceId}
          LIMIT 1
        `;
          const automation = automations[0];
          if (
            automation === undefined ||
            automation.commitSha !== identity.configCommitSha ||
            automation.definitionDigest !== identity.definitionDigest
          ) {
            return yield* new ResponsibilityError({
              code: "conflict",
              message: "The committed Automation changed while its control was being updated.",
            });
          }
          const controls = yield* sql<{
            readonly paused: number;
            readonly actor: string;
            readonly reason: string | null;
            readonly revision: number;
          }>`
          SELECT paused, actor, reason, revision
          FROM command_center_responsibility_controls
          WHERE space_id = ${input.spaceId} AND automation_id = ${input.automationId}
          LIMIT 1
        `;
          const current = controls[0];
          const currentVersion = current?.revision ?? 0;
          if (currentVersion !== input.expectedVersion) {
            return yield* new ResponsibilityError({
              code: "conflict",
              message: "The Responsibility control changed; reload it before trying again.",
            });
          }
          if (
            current !== undefined &&
            current.paused === (input.paused ? 1 : 0) &&
            current.actor === input.actor &&
            current.reason === (input.reason ?? null)
          ) {
            return { revision: current.revision, duplicate: true } as const;
          }
          const revision = currentVersion + 1;
          yield* sql`
          INSERT INTO command_center_responsibility_controls (
            space_id, automation_id, paused, actor, reason, revision, changed_at
          ) VALUES (
            ${input.spaceId}, ${input.automationId}, ${input.paused ? 1 : 0},
            ${input.actor}, ${input.reason ?? null}, ${revision}, ${changedAt}
          )
          ON CONFLICT(space_id, automation_id) DO UPDATE SET
            paused = excluded.paused, actor = excluded.actor, reason = excluded.reason,
            revision = excluded.revision, changed_at = excluded.changed_at
        `;
          return { revision, duplicate: false } as const;
        }),
      );

      if (!changed.duplicate) {
        yield* audit.append({
          eventId: `responsibility-control:${input.spaceId}:${input.automationId}:${changed.revision}`,
          actorKind: "user",
          action: input.paused ? "cc.responsibilities.paused" : "cc.responsibilities.resumed",
          spaceId: input.spaceId,
          payload: {
            automationId: input.automationId,
            actor: input.actor,
            reason: input.reason ?? null,
            revision: changed.revision,
            enabled: identity.enabled,
            configCommitSha: identity.configCommitSha,
            definitionDigest: identity.definitionDigest,
          },
          occurredAt: changedAt,
        });
      }
      return yield* get({
        spaceId: input.spaceId,
        automationId: input.automationId,
        historyLimit: 25,
      });
    },
    Effect.mapError((cause) =>
      isResponsibilityError(cause)
        ? cause
        : persistenceError("Could not update the Responsibility control.", cause),
    ),
  );

  return Responsibilities.of({ list, get, setPause });
});

export const layer = (dependencies: ResponsibilityDependencies) =>
  Layer.effect(Responsibilities, make(dependencies));
