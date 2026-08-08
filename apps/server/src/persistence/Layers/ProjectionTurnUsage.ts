import {
  NonNegativeInt,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  TurnId,
  type UsageBreakdown,
  type UsageCostKind,
  type InternalGenerationUsageBreakdown,
  type InternalGenerationUsageSummary,
  type UsageQueryResult,
  type UsageSummary,
  type UsageTimeSeriesBucket,
  type UsageTokenTotals,
  type UsageTurnRow,
  EfficiencyTier,
} from "@t3tools/contracts";
import { RouteSelectionSource } from "@command-center/core";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionTurnUsageRepository,
  type ProjectionTurnUsageRepositoryShape,
  type RecordTurnUsageInput,
} from "../Services/ProjectionTurnUsage.ts";
import { priceTurnUsage, resolveUsagePrice } from "../../usage/pricing.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

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
  operation: Schema.Literals(["title", "branch", "commit", "pull-request"]),
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
  key: keyof UsageTokenTotals,
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

function summarize(rows: ReadonlyArray<UsageDbRow>): UsageSummary {
  const tokens: UsageTokenTotals = {
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

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettingsService;

  const selectRows = SqlSchema.findAll({
    Request: Schema.Struct({
      from: Schema.String,
      to: Schema.String,
      projectId: Schema.NullOr(Schema.String),
      providerInstanceId: Schema.NullOr(Schema.String),
      model: Schema.NullOr(Schema.String),
      workload: Schema.NullOr(Schema.String),
      quality: Schema.NullOr(Schema.String),
      tier: Schema.NullOr(Schema.String),
    }),
    Result: UsageDbRow,
    execute: (input) => sql`
      SELECT
        u.thread_id AS "threadId", u.turn_id AS "turnId", u.project_id AS "projectId",
        u.provider_instance_id AS "providerInstanceId", u.provider_driver AS "provider",
        u.model, u.workload, u.component_kind AS "componentKind", u.component_id AS "componentId",
        u.quality, u.uncached_input_tokens AS "uncachedInputTokens",
        u.cache_read_input_tokens AS "cacheReadInputTokens",
        u.cache_write_input_tokens AS "cacheWriteInputTokens", u.output_tokens AS "outputTokens",
        u.reasoning_output_tokens AS "reasoningOutputTokens", u.duration_ms AS "durationMs",
        u.tool_uses AS "toolUses", u.cost_micro_usd AS "costMicroUsd", u.cost_kind AS "costKind",
        u.cache_savings_micro_usd AS "cacheSavingsMicroUsd",
        u.rate_provenance AS "rateProvenance", u.completed_at AS "completedAt",
        json_extract(t.efficiency_decision_json, '$.tier') AS "tier",
        json_extract(t.efficiency_decision_json, '$.source') AS "efficiencySource",
        json_extract(t.efficiency_decision_json, '$.matchedRuleId') AS "efficiencyRuleId",
        json_extract(t.efficiency_decision_json, '$.fallbackReason') AS "fallbackReason",
        json_extract(t.efficiency_decision_json, '$.experimentArm') AS "experimentArm"
      FROM projection_turn_usage u
      LEFT JOIN projection_turns t ON t.thread_id = u.thread_id AND t.turn_id = u.turn_id
      WHERE u.completed_at >= ${input.from} AND u.completed_at < ${input.to}
        AND (${input.projectId} IS NULL OR u.project_id = ${input.projectId})
        AND (${input.providerInstanceId} IS NULL OR u.provider_instance_id = ${input.providerInstanceId})
        AND (${input.model} IS NULL OR u.model = ${input.model})
        AND (${input.workload} IS NULL OR u.workload = ${input.workload})
        AND (${input.quality} IS NULL OR u.quality = ${input.quality})
        AND (${input.tier} IS NULL OR json_extract(t.efficiency_decision_json, '$.tier') = ${input.tier})
      ORDER BY u.completed_at DESC
    `,
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

  const record: ProjectionTurnUsageRepositoryShape["record"] = Effect.fn(
    "ProjectionTurnUsageRepository.record",
  )(
    function* (input: RecordTurnUsageInput) {
      const currentSettings = yield* settings.getSettings;
      const rate = resolveUsagePrice({
        providerInstanceId: input.providerInstanceId,
        driver: input.provider,
        model: input.usage.model,
        completedAt: input.usage.completedAt,
        overrides: currentSettings.usagePricingOverrides,
      });
      const priced = priceTurnUsage(input.usage, rate);
      yield* sql`
      INSERT INTO projection_turn_usage (
        thread_id, turn_id, project_id, provider_instance_id, provider_driver, model,
        workload, component_kind, component_id, component_name, quality,
        uncached_input_tokens, cache_read_input_tokens, cache_write_input_tokens,
        output_tokens, reasoning_output_tokens, context_used_tokens, context_limit_tokens,
        duration_ms, tool_uses, cost_micro_usd, cost_kind, cache_savings_micro_usd,
        rate_provenance, completed_at
      ) VALUES (
        ${input.threadId}, ${input.turnId}, ${input.projectId}, ${input.providerInstanceId},
        ${input.provider}, ${input.usage.model ?? null}, ${input.usage.workload},
        ${input.usage.component.kind}, ${input.usage.component.id},
        ${input.usage.component.name ?? null}, ${input.usage.quality},
        ${input.usage.uncachedInputTokens ?? null}, ${input.usage.cacheReadInputTokens ?? null},
        ${input.usage.cacheWriteInputTokens ?? null}, ${input.usage.outputTokens ?? null},
        ${input.usage.reasoningOutputTokens ?? null}, ${input.usage.contextUsedTokens ?? null},
        ${input.usage.contextLimitTokens ?? null}, ${input.usage.durationMs ?? null},
        ${input.usage.toolUses ?? null}, ${priced.costMicroUsd}, ${priced.costKind},
        ${priced.cacheSavingsMicroUsd}, ${priced.rateProvenance}, ${input.usage.completedAt}
      )
      ON CONFLICT (thread_id, turn_id, component_kind, component_id) DO UPDATE SET
        project_id = excluded.project_id,
        provider_instance_id = excluded.provider_instance_id,
        provider_driver = excluded.provider_driver,
        model = excluded.model,
        workload = excluded.workload,
        component_name = excluded.component_name,
        quality = excluded.quality,
        uncached_input_tokens = excluded.uncached_input_tokens,
        cache_read_input_tokens = excluded.cache_read_input_tokens,
        cache_write_input_tokens = excluded.cache_write_input_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_output_tokens = excluded.reasoning_output_tokens,
        context_used_tokens = excluded.context_used_tokens,
        context_limit_tokens = excluded.context_limit_tokens,
        duration_ms = excluded.duration_ms,
        tool_uses = excluded.tool_uses,
        cost_micro_usd = excluded.cost_micro_usd,
        cost_kind = excluded.cost_kind,
        cache_savings_micro_usd = excluded.cache_savings_micro_usd,
        rate_provenance = excluded.rate_provenance,
        completed_at = excluded.completed_at
    `;
    },
    Effect.mapError(toPersistenceSqlError("record turn usage")),
  );

  const query: ProjectionTurnUsageRepositoryShape["query"] = Effect.fn(
    "ProjectionTurnUsageRepository.query",
  )(
    function* (input) {
      const rows = yield* selectRows({
        from: input.from,
        to: input.to,
        projectId: input.projectId ?? null,
        providerInstanceId: input.providerInstanceId ?? null,
        model: input.model ?? null,
        workload: input.workload ?? null,
        quality: input.quality ?? null,
        tier: input.tier ?? null,
      });
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

  return ProjectionTurnUsageRepository.of({ record, query });
});

export const ProjectionTurnUsageRepositoryLive = Layer.effect(ProjectionTurnUsageRepository, make);
