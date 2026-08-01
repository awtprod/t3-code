import {
  NonNegativeInt,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  TurnId,
  type UsageBreakdown,
  type UsageCostKind,
  type UsageQueryResult,
  type UsageSummary,
  type UsageTimeSeriesBucket,
  type UsageTokenTotals,
  type UsageTurnRow,
} from "@t3tools/contracts";
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
});
type UsageDbRow = typeof UsageDbRow.Type;

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
    }),
    Result: UsageDbRow,
    execute: (input) => sql`
      SELECT
        thread_id AS "threadId", turn_id AS "turnId", project_id AS "projectId",
        provider_instance_id AS "providerInstanceId", provider_driver AS "provider",
        model, workload, component_kind AS "componentKind", component_id AS "componentId",
        quality, uncached_input_tokens AS "uncachedInputTokens",
        cache_read_input_tokens AS "cacheReadInputTokens",
        cache_write_input_tokens AS "cacheWriteInputTokens", output_tokens AS "outputTokens",
        reasoning_output_tokens AS "reasoningOutputTokens", duration_ms AS "durationMs",
        tool_uses AS "toolUses", cost_micro_usd AS "costMicroUsd", cost_kind AS "costKind",
        cache_savings_micro_usd AS "cacheSavingsMicroUsd",
        rate_provenance AS "rateProvenance", completed_at AS "completedAt"
      FROM projection_turn_usage
      WHERE completed_at >= ${input.from} AND completed_at < ${input.to}
        AND (${input.projectId} IS NULL OR project_id = ${input.projectId})
        AND (${input.providerInstanceId} IS NULL OR provider_instance_id = ${input.providerInstanceId})
        AND (${input.model} IS NULL OR model = ${input.model})
        AND (${input.workload} IS NULL OR workload = ${input.workload})
        AND (${input.quality} IS NULL OR quality = ${input.quality})
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
        pricingProvenance: [
          ...rows.reduce((groups, row) => {
            const key = row.rateProvenance ?? "Price unavailable";
            groups.set(key, (groups.get(key) ?? 0) + 1);
            return groups;
          }, new Map<string, number>()),
        ]
          .map(([key, componentCount]) => ({ key, componentCount }))
          .toSorted((left, right) => right.componentCount - left.componentCount),
        turns: page,
        nextCursor: offset + limit < allTurns.length ? String(offset + limit) : null,
      } satisfies UsageQueryResult;
    },
    Effect.mapError(toPersistenceSqlError("query turn usage")),
  );

  return ProjectionTurnUsageRepository.of({ record, query });
});

export const ProjectionTurnUsageRepositoryLive = Layer.effect(ProjectionTurnUsageRepository, make);
