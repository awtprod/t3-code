import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
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

/** Bump for incompatible UsageSummary changes; skipped unknown array variants need no bump. */
export const USAGE_CONTRACT_VERSION = 6 as const;

export const USAGE_MERGE_COMPATIBLE_SINCE = 4 as const;

export const UsageProviderKind = Schema.Literals([
  "claude",
  "codex",
  "grok",
  "cursor",
  "opencode",
  "antigravity",
  "pi",
  "muse",
]);
export type UsageProviderKind = typeof UsageProviderKind.Type;

const USAGE_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const UsageDay = TrimmedNonEmptyString.check(Schema.isPattern(USAGE_DAY_PATTERN)).pipe(
  Schema.brand("UsageDay"),
);
export type UsageDay = typeof UsageDay.Type;

export const UsageResolution = Schema.Literals(["day", "hour"]);
export type UsageResolution = typeof UsageResolution.Type;

export const UsageCostSource = Schema.Literals(["providerReported", "modelPriced", "unpriced"]);
export type UsageCostSource = typeof UsageCostSource.Type;

/** Sum uncached input, cache reads, and cache writes for input totals; reasoning is already included in output. */
export const UsageTokenTotals = Schema.Struct({
  uncachedInputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
});
export type UsageTokenTotals = typeof UsageTokenTotals.Type;

export const UsageCategoryCost = Schema.Struct({
  input: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  output: Schema.Number,
});
export type UsageCategoryCost = typeof UsageCategoryCost.Type;

export const UsageBucket = Schema.Struct({
  day: UsageDay,
  hourStart: Schema.optional(TrimmedNonEmptyString),
  provider: UsageProviderKind,
  model: TrimmedNonEmptyString,
  sourcePath: Schema.optional(TrimmedNonEmptyString),
  totals: UsageTokenTotals,
  costUsd: Schema.Number,
  cacheSavingsUsd: Schema.Number,
  categoryCostUsd: Schema.optional(UsageCategoryCost),
  fastCostUsd: Schema.optional(Schema.Number),
  ultrafastCostUsd: Schema.optional(Schema.Number),
  speedPremiumUsd: Schema.optional(Schema.Number),
  costSource: UsageCostSource,
  records: NonNegativeInt,
  unpricedRecords: NonNegativeInt,
  sessions: NonNegativeInt,
});
export type UsageBucket = typeof UsageBucket.Type;

export const UsageSourceFingerprint = Schema.Struct({
  hostId: TrimmedNonEmptyString,
  provider: UsageProviderKind,
  resolvedHomePath: TrimmedNonEmptyString,
  /** Transcript directory device:inode distinguishes machines sharing a hostname and home path. */
  volumeId: Schema.String,
});
export type UsageSourceFingerprint = typeof UsageSourceFingerprint.Type;

export const UsageSourceStatus = Schema.Literals(["ok", "missing", "partial", "failed"]);
export type UsageSourceStatus = typeof UsageSourceStatus.Type;

export const UsageSource = Schema.Struct({
  fingerprint: UsageSourceFingerprint,
  status: UsageSourceStatus,
  scannedFiles: NonNegativeInt,
  skippedFiles: NonNegativeInt,
  malformedRecords: NonNegativeInt,
  /** Total this count; bucket counts double-count sessions spanning days or models. */
  distinctSessions: NonNegativeInt,
  message: Schema.NullOr(TrimmedNonEmptyString),
  action: Schema.optionalKey(Schema.Literal("enableCursorKeychain")),
  /** Cached response during refresh; repeat with awaitRefresh for fresh data. */
  refreshing: Schema.optionalKey(Schema.Literal(true)),
});
export type UsageSource = typeof UsageSource.Type;

export const UsagePricingStatus = Schema.Literals(["fresh", "cached", "unavailable"]);
export type UsagePricingStatus = typeof UsagePricingStatus.Type;

export const UsagePricing = Schema.Struct({
  status: UsagePricingStatus,
  source: TrimmedNonEmptyString,
  fetchedAt: Schema.NullOr(Schema.String),
  knownModels: NonNegativeInt,
});
export type UsagePricing = typeof UsagePricing.Type;

export const UsageSummaryInput = Schema.Struct({
  sinceDay: UsageDay,
  untilDay: UsageDay,
  /** IANA bucketing zone; offsets fail across DST boundaries. */
  timeZone: TrimmedNonEmptyString,
  resolution: Schema.optional(UsageResolution),
  sinceTime: Schema.optional(TrimmedNonEmptyString),
  untilTime: Schema.optional(TrimmedNonEmptyString),
  awaitRefresh: Schema.optional(Schema.Boolean),
});
export type UsageSummaryInput = typeof UsageSummaryInput.Type;

export const UsageSummary = Schema.Struct({
  contractVersion: Schema.Number,
  readAt: Schema.String,
  timeZone: TrimmedNonEmptyString,
  sinceDay: UsageDay,
  untilDay: UsageDay,
  buckets: ForwardCompatibleArray(UsageBucket),
  sources: ForwardCompatibleArray(UsageSource),
  pricing: UsagePricing,
  scanDurationMs: NonNegativeInt,
});
export type UsageSummary = typeof UsageSummary.Type;

export class UsageReadError extends Schema.TaggedError<UsageReadError>()("UsageReadError", {
  reason: Schema.Literals(["scanFailed", "invalidWindow"]),
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Usage read failed (${this.reason}): ${this.detail}`;
  }
}

// Command Center usage analytics (fork): orchestration-projection-backed `usage.query`
// contract, distinct from the transcript-scan summary above. The fork's `UsageSummary`/
// `UsageTokenTotals` are exported as `UsageQuerySummary`/`UsageQueryTokenTotals` to
// coexist with upstream's names.

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

export const UsageQueryTokenTotals = Schema.Struct({
  uncachedInputTokens: Schema.NullOr(NonNegativeInt),
  cacheReadInputTokens: Schema.NullOr(NonNegativeInt),
  cacheWriteInputTokens: Schema.NullOr(NonNegativeInt),
  outputTokens: Schema.NullOr(NonNegativeInt),
  reasoningOutputTokens: Schema.NullOr(NonNegativeInt),
  toolUses: Schema.NullOr(NonNegativeInt),
  durationMs: Schema.NullOr(NonNegativeInt),
});
export type UsageQueryTokenTotals = typeof UsageQueryTokenTotals.Type;

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

export const UsageQuerySummary = Schema.Struct({
  tokens: UsageQueryTokenTotals,
  cost: UsageCostSummary,
  componentCount: NonNegativeInt,
  turnCount: NonNegativeInt,
  completeComponentCount: NonNegativeInt,
  cacheUtilization: Schema.NullOr(Schema.Number),
});
export type UsageQuerySummary = typeof UsageQuerySummary.Type;

export const UsageBreakdown = Schema.Struct({
  key: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  summary: UsageQuerySummary,
});
export type UsageBreakdown = typeof UsageBreakdown.Type;

export const UsageTimeSeriesBucket = Schema.Struct({
  from: IsoDateTime,
  to: IsoDateTime,
  summary: UsageQuerySummary,
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
  summary: UsageQuerySummary,
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
  summary: UsageQuerySummary,
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

export class UsageQueryError extends Schema.TaggedError<UsageQueryError>()("UsageQueryError", {
  message: TrimmedNonEmptyString,
}) {}
