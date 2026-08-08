import type {
  ProviderDriverKind,
  ProviderInstanceId,
  TurnUsageRecord,
  UsageCostKind,
  UsagePricingOverride,
} from "@t3tools/contracts";

export interface UsagePriceRate {
  readonly effectiveAt: string;
  readonly uncachedInputMicroUsdPerMillion: number;
  readonly cacheReadInputMicroUsdPerMillion?: number;
  readonly cacheWriteInputMicroUsdPerMillion?: number;
  readonly outputMicroUsdPerMillion: number;
  readonly provenance: string;
}

const KIMI = "kimi";

export const BUILT_IN_USAGE_PRICING: ReadonlyArray<
  UsagePriceRate & { readonly driver: string; readonly model: string }
> = [
  {
    driver: KIMI,
    model: "kimi-code/k3",
    effectiveAt: "2026-07-01T00:00:00.000Z",
    uncachedInputMicroUsdPerMillion: 3_000_000,
    cacheReadInputMicroUsdPerMillion: 300_000,
    cacheWriteInputMicroUsdPerMillion: 3_000_000,
    outputMicroUsdPerMillion: 15_000_000,
    provenance: "Kimi API pricing (2026-07)",
  },
];

function latestEffective<T extends { readonly effectiveAt: string }>(
  values: ReadonlyArray<T>,
  at: string,
): T | undefined {
  return values
    .filter((value) => value.effectiveAt <= at)
    .toSorted((left, right) => right.effectiveAt.localeCompare(left.effectiveAt))[0];
}

export function resolveUsagePrice(input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly model: string | undefined;
  readonly completedAt: string;
  readonly overrides: ReadonlyArray<UsagePricingOverride>;
}): UsagePriceRate | undefined {
  if (!input.model) return undefined;
  const instanceOverride = latestEffective(
    input.overrides.filter(
      (rate) => rate.providerInstanceId === input.providerInstanceId && rate.model === input.model,
    ),
    input.completedAt,
  );
  const driverOverride = latestEffective(
    input.overrides.filter(
      (rate) =>
        rate.providerInstanceId === undefined &&
        rate.driver === input.driver &&
        rate.model === input.model,
    ),
    input.completedAt,
  );
  const selected =
    instanceOverride ??
    driverOverride ??
    latestEffective(
      BUILT_IN_USAGE_PRICING.filter(
        (rate) => rate.driver === input.driver && rate.model === input.model,
      ),
      input.completedAt,
    );
  if (!selected) return undefined;
  return {
    effectiveAt: selected.effectiveAt,
    uncachedInputMicroUsdPerMillion: selected.uncachedInputMicroUsdPerMillion,
    ...(selected.cacheReadInputMicroUsdPerMillion === undefined
      ? {}
      : { cacheReadInputMicroUsdPerMillion: selected.cacheReadInputMicroUsdPerMillion }),
    ...(selected.cacheWriteInputMicroUsdPerMillion === undefined
      ? {}
      : { cacheWriteInputMicroUsdPerMillion: selected.cacheWriteInputMicroUsdPerMillion }),
    outputMicroUsdPerMillion: selected.outputMicroUsdPerMillion,
    provenance:
      selected === instanceOverride
        ? "instance override"
        : selected === driverOverride
          ? "driver override"
          : "provenance" in selected
            ? selected.provenance
            : "built-in",
  };
}

const charge = (tokens: number | undefined, rate: number | undefined): number | undefined =>
  tokens === undefined || rate === undefined ? undefined : Math.round((tokens * rate) / 1_000_000);

export function priceTurnUsage(
  usage: TurnUsageRecord,
  rate: UsagePriceRate | undefined,
): {
  readonly costMicroUsd: number | null;
  readonly costKind: UsageCostKind;
  readonly cacheSavingsMicroUsd: number | null;
  readonly rateProvenance: string | null;
} {
  if (usage.providerReportedCostUsd !== undefined) {
    return {
      costMicroUsd: Math.max(0, Math.round(usage.providerReportedCostUsd * 1_000_000)),
      costKind: "reported",
      cacheSavingsMicroUsd: null,
      rateProvenance: "provider reported",
    };
  }
  if (!rate) {
    return {
      costMicroUsd: null,
      costKind: "unavailable",
      cacheSavingsMicroUsd: null,
      rateProvenance: null,
    };
  }
  const components = [
    charge(usage.uncachedInputTokens, rate.uncachedInputMicroUsdPerMillion),
    charge(usage.cacheReadInputTokens, rate.cacheReadInputMicroUsdPerMillion),
    charge(
      usage.cacheWriteInputTokens,
      rate.cacheWriteInputMicroUsdPerMillion ?? rate.uncachedInputMicroUsdPerMillion,
    ),
    charge(usage.outputTokens, rate.outputMicroUsdPerMillion),
  ];
  const known = components.filter((value): value is number => value !== undefined);
  const savings =
    usage.cacheReadInputTokens !== undefined && rate.cacheReadInputMicroUsdPerMillion !== undefined
      ? Math.max(
          0,
          Math.round(
            (usage.cacheReadInputTokens *
              (rate.uncachedInputMicroUsdPerMillion - rate.cacheReadInputMicroUsdPerMillion)) /
              1_000_000,
          ),
        )
      : null;
  return {
    costMicroUsd: known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0),
    costKind: usage.billingMode === "api" ? "estimated" : "api-equivalent-estimate",
    cacheSavingsMicroUsd: savings,
    rateProvenance: rate.provenance,
  };
}
