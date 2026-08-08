import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { TurnUsageQuality, TurnUsageWorkload } from "./providerRuntime.ts";
import { EfficiencyTier } from "./efficiency.ts";
import { RouteSelectionSource } from "@command-center/core";

export const UsageBucketSize = Schema.Literals(["hour", "day", "week", "month"]);
export type UsageBucketSize = typeof UsageBucketSize.Type;

export const UsageQueryInput = Schema.Struct({
  from: IsoDateTime,
  to: IsoDateTime,
  bucket: UsageBucketSize,
  projectId: Schema.optional(ProjectId),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  model: Schema.optional(TrimmedNonEmptyString),
  workload: Schema.optional(TurnUsageWorkload),
  quality: Schema.optional(TurnUsageQuality),
  tier: Schema.optional(EfficiencyTier),
  cursor: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(PositiveInt),
});
export type UsageQueryInput = typeof UsageQueryInput.Type;

export const UsageTokenTotals = Schema.Struct({
  uncachedInputTokens: Schema.NullOr(NonNegativeInt),
  cacheReadInputTokens: Schema.NullOr(NonNegativeInt),
  cacheWriteInputTokens: Schema.NullOr(NonNegativeInt),
  outputTokens: Schema.NullOr(NonNegativeInt),
  reasoningOutputTokens: Schema.NullOr(NonNegativeInt),
  toolUses: Schema.NullOr(NonNegativeInt),
  durationMs: Schema.NullOr(NonNegativeInt),
});
export type UsageTokenTotals = typeof UsageTokenTotals.Type;

export const UsageCostKind = Schema.Literals([
  "reported",
  "estimated",
  "api-equivalent-estimate",
  "unavailable",
]);
export type UsageCostKind = typeof UsageCostKind.Type;

export const UsageCostSummary = Schema.Struct({
  microUsd: Schema.NullOr(NonNegativeInt),
  kind: UsageCostKind,
  cacheSavingsMicroUsd: Schema.NullOr(NonNegativeInt),
});
export type UsageCostSummary = typeof UsageCostSummary.Type;

export const UsageSummary = Schema.Struct({
  tokens: UsageTokenTotals,
  cost: UsageCostSummary,
  componentCount: NonNegativeInt,
  turnCount: NonNegativeInt,
  completeComponentCount: NonNegativeInt,
  cacheUtilization: Schema.NullOr(Schema.Number),
});
export type UsageSummary = typeof UsageSummary.Type;

export const UsageBreakdown = Schema.Struct({
  key: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  summary: UsageSummary,
});
export type UsageBreakdown = typeof UsageBreakdown.Type;

export const UsageTimeSeriesBucket = Schema.Struct({
  from: IsoDateTime,
  to: IsoDateTime,
  summary: UsageSummary,
});
export type UsageTimeSeriesBucket = typeof UsageTimeSeriesBucket.Type;

export const UsageTurnRow = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  projectId: Schema.NullOr(ProjectId),
  providerInstanceId: ProviderInstanceId,
  provider: ProviderDriverKind,
  model: Schema.NullOr(TrimmedNonEmptyString),
  workload: TurnUsageWorkload,
  tier: Schema.NullOr(EfficiencyTier),
  efficiencySource: Schema.NullOr(RouteSelectionSource),
  efficiencyRuleId: Schema.NullOr(TrimmedNonEmptyString),
  fallbackReason: Schema.NullOr(TrimmedNonEmptyString),
  experimentArm: Schema.NullOr(Schema.Literals(["control", "challenger"])),
  completedAt: IsoDateTime,
  summary: UsageSummary,
});
export type UsageTurnRow = typeof UsageTurnRow.Type;

export const UsagePricingProvenance = Schema.Struct({
  key: TrimmedNonEmptyString,
  componentCount: NonNegativeInt,
});
export type UsagePricingProvenance = typeof UsagePricingProvenance.Type;

export const InternalGenerationUsageSummary = Schema.Struct({
  invocationCount: NonNegativeInt,
  successCount: NonNegativeInt,
  errorCount: NonNegativeInt,
  durationMs: NonNegativeInt,
  inputTokens: Schema.NullOr(NonNegativeInt),
  outputTokens: Schema.NullOr(NonNegativeInt),
  costMicroUsd: Schema.NullOr(NonNegativeInt),
});
export type InternalGenerationUsageSummary = typeof InternalGenerationUsageSummary.Type;

export const InternalGenerationUsageBreakdown = Schema.Struct({
  key: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  summary: InternalGenerationUsageSummary,
});
export type InternalGenerationUsageBreakdown = typeof InternalGenerationUsageBreakdown.Type;

export const InternalGenerationUsageResult = Schema.Struct({
  summary: InternalGenerationUsageSummary,
  byOperation: Schema.Array(InternalGenerationUsageBreakdown),
  byProvider: Schema.Array(InternalGenerationUsageBreakdown),
  byModel: Schema.Array(InternalGenerationUsageBreakdown),
});
export type InternalGenerationUsageResult = typeof InternalGenerationUsageResult.Type;

export const UsageQueryResult = Schema.Struct({
  summary: UsageSummary,
  timeSeries: Schema.Array(UsageTimeSeriesBucket),
  byProvider: Schema.Array(UsageBreakdown),
  byModel: Schema.Array(UsageBreakdown),
  byProject: Schema.Array(UsageBreakdown),
  byWorkload: Schema.Array(UsageBreakdown),
  byComponent: Schema.Array(UsageBreakdown),
  byTier: Schema.Array(UsageBreakdown),
  byRule: Schema.Array(UsageBreakdown),
  byEfficiencySource: Schema.Array(UsageBreakdown),
  byFallback: Schema.Array(UsageBreakdown),
  byExperimentArm: Schema.Array(UsageBreakdown),
  pricingProvenance: Schema.Array(UsagePricingProvenance),
  internalGeneration: InternalGenerationUsageResult,
  turns: Schema.Array(UsageTurnRow),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
});
export type UsageQueryResult = typeof UsageQueryResult.Type;

export const UsagePricingOverride = Schema.Struct({
  providerInstanceId: Schema.optional(ProviderInstanceId),
  driver: Schema.optional(ProviderDriverKind),
  model: TrimmedNonEmptyString,
  effectiveAt: IsoDateTime,
  uncachedInputMicroUsdPerMillion: NonNegativeInt,
  cacheReadInputMicroUsdPerMillion: Schema.optional(NonNegativeInt),
  cacheWriteInputMicroUsdPerMillion: Schema.optional(NonNegativeInt),
  outputMicroUsdPerMillion: NonNegativeInt,
});
export type UsagePricingOverride = typeof UsagePricingOverride.Type;

export class UsageQueryError extends Schema.TaggedErrorClass<UsageQueryError>()("UsageQueryError", {
  message: TrimmedNonEmptyString,
}) {}
