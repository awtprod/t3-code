/**
 * Command Center usage analytics (`usage.query`) over orchestration v2.
 *
 * Every completed v2 provider turn with main-agent token usage is one
 * analytics row: tokens from the turn's `turnTokenUsage`, model and instance
 * from its run, project from its thread, duration from its timestamps, and
 * cost priced at read time with the same rates as the Usage page (the
 * `usagePriceOverrides` setting, then LiteLLM). The fork's
 * `projection_turn_usage` writer, its second pricing path and its table reads
 * are gone; the table stays on disk unread.
 *
 * Not available from v2 turn usage (reported as null or a fixed bucket): tool
 * use counts, provider-reported cost, per-subagent components, and the
 * efficiency tier / rule / source / fallback / experiment columns (efficiency
 * routing is not re-hooked into v2 yet).
 */
import {
  NonNegativeInt,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  TurnId,
  TurnTokenUsage,
  type UsageBreakdown,
  type UsageCostKind,
  type InternalGenerationUsageBreakdown,
  type InternalGenerationUsageSummary,
  type UsageQueryResult,
  type UsageQuerySummary,
  type UsageTimeSeriesBucket,
  type UsageQueryTokenTotals,
  type UsageTurnRow,
  EfficiencyTier,
} from "@t3tools/contracts";
import { RouteSelectionSource } from "@command-center/core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { isCommandCenterThreadId } from "../../provider/security/CommandCenterProviderIsolation.ts";
import { priceTurnUsage, type TurnUsageTokens } from "../../usage/turnUsagePricing.ts";
import { UsageService } from "../../usage/UsageService.ts";
import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionTurnUsageRepository,
  type ProjectionTurnUsageRepositoryShape,
} from "../Services/ProjectionTurnUsage.ts";

const NullableNonNegativeInt = Schema.NullOr(NonNegativeInt);

const UsageDbRow = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  projectId: Schema.NullOr(ProjectId),
  providerInstanceId: ProviderInstanceId,
  provider: ProviderDriverKind,
  model: Schema.NullOr(Schema.String),
  workload: Schema.Literals(["interactive", "automation"]),
  componentKind: Schema.Literals(["main", "subagent"]),
  componentId: Schema.String,
  quality: Schema.Literals(["reported", "derived", "partial"]),
  uncachedInputTokens: NullableNonNegativeInt,
  cacheReadInputTokens: NullableNonNegativeInt,
  cacheWriteInputTokens: NullableNonNegativeInt,
  outputTokens: NullableNonNegativeInt,
  reasoningOutputTokens: NullableNonNegativeInt,
  durationMs: NullableNonNegativeInt,
  toolUses: NullableNonNegativeInt,
  costMicroUsd: NullableNonNegativeInt,
  costKind: Schema.Literals(["reported", "estimated", "api-equivalent-estimate", "unavailable"]),
  cacheSavingsMicroUsd: NullableNonNegativeInt,
  rateProvenance: Schema.NullOr(Schema.String),
  completedAt: Schema.String,
  tier: Schema.NullOr(EfficiencyTier),
  efficiencySource: Schema.NullOr(RouteSelectionSource),
  efficiencyRuleId: Schema.NullOr(Schema.String),
  fallbackReason: Schema.NullOr(Schema.String),
  experimentArm: Schema.NullOr(Schema.Literals(["control", "challenger"])),
});
type UsageDbRow = typeof UsageDbRow.Type;

const InternalGenerationDbRow = Schema.Struct({
  // Text-generation operations plus dynamic `judge.<operation>` rows written by
  // the efficiency Judge. Kept as a free string so a new operation label never
  // fails the whole read at the boundary; the value is only used as a grouping
  // key, never as a discriminant.
  operation: Schema.String,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  durationMs: NonNegativeInt,
  inputTokens: NullableNonNegativeInt,
  outputTokens: NullableNonNegativeInt,
  costMicroUsd: NullableNonNegativeInt,
  status: Schema.Literals(["success", "error"]),
});
type InternalGenerationDbRow = typeof InternalGenerationDbRow.Type;

const optionalSum = (
  rows: ReadonlyArray<UsageDbRow>,
  key: keyof UsageQueryTokenTotals,
): number | null => {
  const values = rows.flatMap((row) => {
    const value = row[key as keyof UsageDbRow];
    return typeof value === "number" ? [value] : [];
  });
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
};

function costKind(rows: ReadonlyArray<UsageDbRow>): UsageCostKind {
  const known = rows.filter((row) => row.costMicroUsd !== null);
  if (known.length === 0) return "unavailable";
  if (known.every((row) => row.costKind === "reported")) return "reported";
  if (known.some((row) => row.costKind === "api-equivalent-estimate")) {
    return "api-equivalent-estimate";
  }
  return "estimated";
}

function summarize(rows: ReadonlyArray<UsageDbRow>): UsageQuerySummary {
  const tokens: UsageQueryTokenTotals = {
    uncachedInputTokens: optionalSum(rows, "uncachedInputTokens"),
    cacheReadInputTokens: optionalSum(rows, "cacheReadInputTokens"),
    cacheWriteInputTokens: optionalSum(rows, "cacheWriteInputTokens"),
    outputTokens: optionalSum(rows, "outputTokens"),
    reasoningOutputTokens: optionalSum(rows, "reasoningOutputTokens"),
    toolUses: optionalSum(rows, "toolUses"),
    durationMs: optionalSum(rows, "durationMs"),
  };
  const inputValues = [
    tokens.uncachedInputTokens,
    tokens.cacheReadInputTokens,
    tokens.cacheWriteInputTokens,
  ];
  const knownInputs = inputValues.filter((value): value is number => value !== null);
  const inputTotal = knownInputs.reduce((sum, value) => sum + value, 0);
  const costs = rows.flatMap((row) => (row.costMicroUsd === null ? [] : [row.costMicroUsd]));
  const savings = rows.flatMap((row) =>
    row.cacheSavingsMicroUsd === null ? [] : [row.cacheSavingsMicroUsd],
  );
  return {
    tokens,
    cost: {
      microUsd: costs.length === 0 ? null : costs.reduce((sum, value) => sum + value, 0),
      kind: costKind(rows),
      cacheSavingsMicroUsd:
        savings.length === 0 ? null : savings.reduce((sum, value) => sum + value, 0),
    },
    componentCount: rows.length,
    turnCount: new Set(rows.map((row) => `${row.threadId}:${row.turnId}`)).size,
    completeComponentCount: rows.filter((row) => row.quality !== "partial").length,
    cacheUtilization:
      inputTotal === 0 || tokens.cacheReadInputTokens === null
        ? null
        : tokens.cacheReadInputTokens / inputTotal,
  };
}

function groupBreakdown(
  rows: ReadonlyArray<UsageDbRow>,
  keyOf: (row: UsageDbRow) => string,
): ReadonlyArray<UsageBreakdown> {
  const groups = new Map<string, Array<UsageDbRow>>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, label: key, summary: summarize(group) }))
    .toSorted((left, right) => right.summary.componentCount - left.summary.componentCount);
}

function summarizeInternalGeneration(
  rows: ReadonlyArray<InternalGenerationDbRow>,
): InternalGenerationUsageSummary {
  const sumKnown = (key: "inputTokens" | "outputTokens" | "costMicroUsd"): number | null => {
    const values = rows.flatMap((row) => (row[key] === null ? [] : [row[key]]));
    return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
  };
  return {
    invocationCount: rows.length,
    successCount: rows.filter((row) => row.status === "success").length,
    errorCount: rows.filter((row) => row.status === "error").length,
    durationMs: rows.reduce((sum, row) => sum + row.durationMs, 0),
    inputTokens: sumKnown("inputTokens"),
    outputTokens: sumKnown("outputTokens"),
    costMicroUsd: sumKnown("costMicroUsd"),
  };
}

function groupInternalGeneration(
  rows: ReadonlyArray<InternalGenerationDbRow>,
  keyOf: (row: InternalGenerationDbRow) => string,
): ReadonlyArray<InternalGenerationUsageBreakdown> {
  const groups = new Map<string, Array<InternalGenerationDbRow>>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, label: key, summary: summarizeInternalGeneration(group) }))
    .toSorted((left, right) => right.summary.invocationCount - left.summary.invocationCount);
}

function bucketStart(value: string, bucket: "hour" | "day" | "week" | "month"): DateTime.Utc {
  if (bucket === "hour") return DateTime.makeUnsafe(`${value.slice(0, 13)}:00:00.000Z`);
  if (bucket === "day") return DateTime.makeUnsafe(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (bucket === "month") return DateTime.makeUnsafe(`${value.slice(0, 7)}-01T00:00:00.000Z`);
  const dayMs = 86_400_000;
  const epochDay = Math.floor(DateTime.toEpochMillis(DateTime.makeUnsafe(value)) / dayMs);
  const mondayEpochDay = Math.floor((epochDay + 3) / 7) * 7 - 3;
  return DateTime.makeUnsafe(mondayEpochDay * dayMs);
}

function nextBucket(date: DateTime.Utc, bucket: "hour" | "day" | "week" | "month"): DateTime.Utc {
  if (bucket === "hour") return DateTime.add(date, { hours: 1 });
  if (bucket === "day") return DateTime.add(date, { days: 1 });
  if (bucket === "week") return DateTime.add(date, { weeks: 1 });
  return DateTime.add(date, { months: 1 });
}

function timeSeries(
  rows: ReadonlyArray<UsageDbRow>,
  bucket: "hour" | "day" | "week" | "month",
): ReadonlyArray<UsageTimeSeriesBucket> {
  const groups = new Map<string, Array<UsageDbRow>>();
  for (const row of rows) {
    const from = DateTime.formatIso(bucketStart(row.completedAt, bucket));
    const group = groups.get(from) ?? [];
    group.push(row);
    groups.set(from, group);
  }
  return [...groups.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([from, group]) => ({
      from,
      to: DateTime.formatIso(nextBucket(DateTime.makeUnsafe(from), bucket)),
      summary: summarize(group),
    }));
}

function turnRows(rows: ReadonlyArray<UsageDbRow>): ReadonlyArray<UsageTurnRow> {
  const groups = new Map<string, Array<UsageDbRow>>();
  for (const row of rows) {
    const key = `${row.threadId}:${row.turnId}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const row = group[0]!;
      return {
        threadId: row.threadId,
        turnId: row.turnId,
        projectId: row.projectId,
        providerInstanceId: row.providerInstanceId,
        provider: row.provider,
        model: row.model,
        workload: row.workload,
        tier: row.tier,
        efficiencySource: row.efficiencySource,
        efficiencyRuleId: row.efficiencyRuleId,
        fallbackReason: row.fallbackReason,
        experimentArm: row.experimentArm,
        completedAt: group
          .map((entry) => entry.completedAt)
          .toSorted((left, right) => right.localeCompare(left))[0]!,
        summary: summarize(group),
      };
    })
    .toSorted((left, right) => right.completedAt.localeCompare(left.completedAt));
}

const ProviderTurnUsageDbRow = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  projectId: Schema.NullOr(ProjectId),
  providerInstanceId: ProviderInstanceId,
  provider: ProviderDriverKind,
  model: Schema.NullOr(Schema.String),
  turnTokenUsage: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.String,
});
type ProviderTurnUsageDbRow = typeof ProviderTurnUsageDbRow.Type;

const decodeTurnTokenUsage = Schema.decodeUnknownOption(Schema.fromJsonString(TurnTokenUsage));

function nonNegative(value: number): number {
  return Math.max(0, value);
}

/** v2 counts input including cache reads and writes; analytics splits it. */
export function turnUsageTokens(usage: TurnTokenUsage): TurnUsageTokens {
  const cacheRead = usage.cachedInputTokens ?? null;
  const cacheWrite = usage.cacheCreationTokens ?? null;
  return {
    uncachedInputTokens:
      usage.inputTokens === undefined
        ? null
        : nonNegative(usage.inputTokens - (cacheRead ?? 0) - (cacheWrite ?? 0)),
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: usage.outputTokens ?? null,
    reasoningOutputTokens: usage.reasoningTokens ?? null,
  };
}

function durationMs(row: ProviderTurnUsageDbRow): number | null {
  if (row.startedAt === null) return null;
  const started = DateTime.make(row.startedAt);
  const completed = DateTime.make(row.completedAt);
  if (Option.isNone(started) || Option.isNone(completed)) return null;
  return nonNegative(
    DateTime.toEpochMillis(completed.value) - DateTime.toEpochMillis(started.value),
  );
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const usageService = yield* UsageService;

  // One row per settled main-agent provider turn of a run. Subagent provider
  // threads have no run attempt and are counted inside their parent turn's
  // provider-reported totals where the provider includes them.
  const selectProviderTurns = SqlSchema.findAll({
    Request: Schema.Struct({
      from: Schema.String,
      to: Schema.String,
      projectId: Schema.NullOr(Schema.String),
      providerInstanceId: Schema.NullOr(Schema.String),
      model: Schema.NullOr(Schema.String),
    }),
    Result: ProviderTurnUsageDbRow,
    execute: (input) => sql`
      SELECT
        pt.thread_id AS "threadId",
        pt.provider_turn_id AS "turnId",
        th.project_id AS "projectId",
        COALESCE(r.provider_instance_id, r.provider) AS "providerInstanceId",
        COALESCE(ptr.driver, json_extract(ptr.payload_json, '$.driver'), r.provider) AS "provider",
        json_extract(r.payload_json, '$.modelSelection.model') AS "model",
        json_extract(pt.payload_json, '$.turnTokenUsage') AS "turnTokenUsage",
        pt.started_at AS "startedAt",
        pt.completed_at AS "completedAt"
      FROM orchestration_v2_projection_provider_turns pt
      JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id = pt.run_attempt_id
      JOIN orchestration_v2_projection_runs r ON r.run_id = a.run_id
      LEFT JOIN orchestration_v2_projection_threads th ON th.thread_id = pt.thread_id
      LEFT JOIN orchestration_v2_projection_provider_threads ptr
        ON ptr.provider_thread_id = pt.provider_thread_id
      WHERE pt.completed_at IS NOT NULL
        AND pt.status IN ('completed', 'interrupted', 'failed', 'cancelled')
        AND julianday(pt.completed_at) >= julianday(${input.from})
        AND julianday(pt.completed_at) < julianday(${input.to})
        AND (${input.projectId} IS NULL OR th.project_id = ${input.projectId})
        AND (${input.providerInstanceId} IS NULL
          OR COALESCE(r.provider_instance_id, r.provider) = ${input.providerInstanceId})
        AND (${input.model} IS NULL
          OR json_extract(r.payload_json, '$.modelSelection.model') = ${input.model})
      ORDER BY pt.completed_at DESC
    `,
  });

  const usageRows = Effect.fn("ProjectionTurnUsageRepository.usageRows")(function* (
    input: Parameters<ProjectionTurnUsageRepositoryShape["query"]>[0],
  ) {
    // Efficiency routing is not re-hooked into v2 yet, so no turn carries a
    // tier: a tier filter matches nothing rather than everything.
    if (input.tier !== undefined) return [] as ReadonlyArray<UsageDbRow>;
    const turns = yield* selectProviderTurns({
      from: input.from,
      to: input.to,
      projectId: input.projectId ?? null,
      providerInstanceId: input.providerInstanceId ?? null,
      model: input.model ?? null,
    });
    const tables = yield* usageService.readRateTables;
    return turns.flatMap((turn): ReadonlyArray<UsageDbRow> => {
      const usage =
        turn.turnTokenUsage === null ? Option.none() : decodeTurnTokenUsage(turn.turnTokenUsage);
      // A turn without any usage report is not analytics data.
      if (Option.isNone(usage)) return [];
      const workload = isCommandCenterThreadId(turn.threadId) ? "automation" : "interactive";
      const quality = usage.value.usageStatus === "complete" ? "reported" : "partial";
      if (input.workload !== undefined && input.workload !== workload) return [];
      if (input.quality !== undefined && input.quality !== quality) return [];
      const tokens =
        usage.value.usageStatus === "unavailable"
          ? {
              uncachedInputTokens: null,
              cacheReadInputTokens: null,
              cacheWriteInputTokens: null,
              outputTokens: null,
              reasoningOutputTokens: null,
            }
          : turnUsageTokens(usage.value);
      const priced = priceTurnUsage(tables, turn.model, tokens);
      return [
        {
          threadId: turn.threadId,
          turnId: turn.turnId,
          projectId: turn.projectId,
          providerInstanceId: turn.providerInstanceId,
          provider: turn.provider,
          model: turn.model,
          workload,
          componentKind: "main",
          componentId: "main",
          quality,
          ...tokens,
          durationMs: durationMs(turn),
          toolUses: null,
          costMicroUsd: priced.costMicroUsd,
          costKind: priced.costKind,
          cacheSavingsMicroUsd: priced.cacheSavingsMicroUsd,
          rateProvenance: priced.rateProvenance,
          completedAt: turn.completedAt,
          tier: null,
          efficiencySource: null,
          efficiencyRuleId: null,
          fallbackReason: null,
          experimentArm: null,
        },
      ];
    });
  });

  const selectInternalGenerationRows = SqlSchema.findAll({
    Request: Schema.Struct({
      from: Schema.String,
      to: Schema.String,
      providerInstanceId: Schema.NullOr(Schema.String),
      model: Schema.NullOr(Schema.String),
    }),
    Result: InternalGenerationDbRow,
    execute: (input) => sql`
      SELECT operation, provider_instance_id AS "providerInstanceId", model,
        duration_ms AS "durationMs", input_tokens AS "inputTokens",
        output_tokens AS "outputTokens", cost_micro_usd AS "costMicroUsd", status
      FROM internal_generation_usage
      WHERE completed_at >= ${input.from} AND completed_at < ${input.to}
        AND (${input.providerInstanceId} IS NULL OR provider_instance_id = ${input.providerInstanceId})
        AND (${input.model} IS NULL OR model = ${input.model})
      ORDER BY completed_at DESC
    `,
  });

  const query: ProjectionTurnUsageRepositoryShape["query"] = Effect.fn(
    "ProjectionTurnUsageRepository.query",
  )(
    function* (input) {
      const rows = yield* usageRows(input);
      const internalGenerationRows = yield* selectInternalGenerationRows({
        from: input.from,
        to: input.to,
        providerInstanceId: input.providerInstanceId ?? null,
        model: input.model ?? null,
      });
      const allTurns = turnRows(rows);
      const offset = Math.max(0, Number.parseInt(input.cursor ?? "0", 10) || 0);
      const limit = Math.min(200, input.limit ?? 50);
      const page = allTurns.slice(offset, offset + limit);
      return {
        summary: summarize(rows),
        timeSeries: timeSeries(rows, input.bucket),
        byProvider: groupBreakdown(rows, (row) => row.providerInstanceId),
        byModel: groupBreakdown(rows, (row) => row.model ?? "Unknown model"),
        byProject: groupBreakdown(rows, (row) => row.projectId ?? "Unknown project"),
        byWorkload: groupBreakdown(rows, (row) => row.workload),
        byComponent: groupBreakdown(rows, (row) => row.componentKind),
        byTier: groupBreakdown(rows, (row) => row.tier ?? "Manual / unrouted"),
        byRule: groupBreakdown(rows, (row) => row.efficiencyRuleId ?? "No matching rule"),
        byEfficiencySource: groupBreakdown(
          rows,
          (row) => row.efficiencySource ?? "Manual / unrouted",
        ),
        byFallback: groupBreakdown(rows, (row) => row.fallbackReason ?? "No fallback"),
        byExperimentArm: groupBreakdown(rows, (row) => row.experimentArm ?? "Not enrolled"),
        pricingProvenance: [
          ...rows.reduce((groups, row) => {
            const key = row.rateProvenance ?? "Price unavailable";
            groups.set(key, (groups.get(key) ?? 0) + 1);
            return groups;
          }, new Map<string, number>()),
        ]
          .map(([key, componentCount]) => ({ key, componentCount }))
          .toSorted((left, right) => right.componentCount - left.componentCount),
        internalGeneration: {
          summary: summarizeInternalGeneration(internalGenerationRows),
          byOperation: groupInternalGeneration(internalGenerationRows, (row) => row.operation),
          byProvider: groupInternalGeneration(
            internalGenerationRows,
            (row) => row.providerInstanceId,
          ),
          byModel: groupInternalGeneration(internalGenerationRows, (row) => row.model),
        },
        turns: page,
        nextCursor: offset + limit < allTurns.length ? String(offset + limit) : null,
      } satisfies UsageQueryResult;
    },
    Effect.mapError(toPersistenceSqlError("query turn usage")),
  );

  return ProjectionTurnUsageRepository.of({ query });
});

export const ProjectionTurnUsageRepositoryLive = Layer.effect(ProjectionTurnUsageRepository, make);
