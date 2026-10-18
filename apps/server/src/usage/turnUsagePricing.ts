import type { UsageCostKind } from "@t3tools/contracts";

import type { UsageRateTables } from "./UsageService.ts";
import { cacheSavingsUsd, priceUsage, type PricedRecord } from "./usagePricing.ts";

/** One orchestration v2 provider turn's main-agent tokens, null when unreported. */
export interface TurnUsageTokens {
  readonly uncachedInputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningOutputTokens: number | null;
}

export interface PricedTurnUsage {
  readonly costMicroUsd: number | null;
  readonly costKind: UsageCostKind;
  readonly cacheSavingsMicroUsd: number | null;
  /** Which price source applied, shown as the analytics "price provenance". */
  readonly rateProvenance: string | null;
}

const UNPRICED: PricedTurnUsage = {
  costMicroUsd: null,
  costKind: "unavailable",
  cacheSavingsMicroUsd: null,
  rateProvenance: null,
};

const toMicroUsd = (usd: number) => Math.max(0, Math.round(usd * 1_000_000));

/**
 * Prices a turn exactly like the Usage page prices transcript records: an
 * exact `usagePriceOverrides` entry first, then the LiteLLM table, after
 * `usageModelAliases` maps the model. There is one price mechanism; nothing
 * here keeps built-in rates of its own.
 */
export function priceTurnUsage(
  tables: UsageRateTables,
  model: string | null,
  tokens: TurnUsageTokens,
): PricedTurnUsage {
  if (model === null) return UNPRICED;
  const counts = [
    tokens.uncachedInputTokens,
    tokens.cacheReadInputTokens,
    tokens.cacheWriteInputTokens,
    tokens.outputTokens,
  ];
  if (counts.every((count) => count === null)) return UNPRICED;
  const target = tables.aliases.get(model) ?? model;
  const record: PricedRecord = {
    model: target,
    totals: {
      uncachedInputTokens: tokens.uncachedInputTokens ?? 0,
      cachedInputTokens: tokens.cacheReadInputTokens ?? 0,
      cacheCreationTokens: tokens.cacheWriteInputTokens ?? 0,
      outputTokens: tokens.outputTokens ?? 0,
      reasoningTokens: tokens.reasoningOutputTokens ?? 0,
    },
    speed: "standard",
    reportedCostUsd: null,
  };
  const priced = priceUsage(tables.rates, record, tables.overrides);
  if (priced.costSource === "unpriced") return UNPRICED;
  return {
    costMicroUsd: toMicroUsd(priced.costUsd),
    costKind: "estimated",
    cacheSavingsMicroUsd: toMicroUsd(cacheSavingsUsd(tables.rates, record, tables.overrides)),
    rateProvenance: tables.overrides.has(target.trim()) ? "usagePriceOverrides" : "LiteLLM",
  };
}
