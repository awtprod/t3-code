import {
  ProviderDriverKind,
  ProviderInstanceId,
  type TurnUsageRecord,
  type UsagePricingOverride,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { priceTurnUsage, resolveUsagePrice } from "./pricing.ts";

const KIMI = ProviderDriverKind.make("kimi");
const INSTANCE = ProviderInstanceId.make("kimi");
const completedAt = "2026-08-01T00:00:00.000Z";

function usage(overrides: Partial<TurnUsageRecord> = {}): TurnUsageRecord {
  return {
    component: { kind: "main", id: "main" },
    model: "kimi-code/k3",
    workload: "interactive",
    quality: "reported",
    completedAt,
    ...overrides,
  };
}

describe("usage pricing", () => {
  it("prices K3 cache reads, cache creation, uncached input, and output independently", () => {
    const rate = resolveUsagePrice({
      providerInstanceId: INSTANCE,
      driver: KIMI,
      model: "kimi-code/k3",
      completedAt,
      overrides: [],
    });
    const priced = priceTurnUsage(
      usage({
        uncachedInputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
        cacheWriteInputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
      rate,
    );
    expect(priced.costMicroUsd).toBe(21_300_000);
    expect(priced.cacheSavingsMicroUsd).toBe(2_700_000);
  });

  it("uses instance overrides before driver overrides and labels subscriptions as estimates", () => {
    const overrides: ReadonlyArray<UsagePricingOverride> = [
      {
        driver: KIMI,
        model: "kimi-code/k3",
        effectiveAt: "2026-07-01T00:00:00.000Z",
        uncachedInputMicroUsdPerMillion: 4_000_000,
        outputMicroUsdPerMillion: 20_000_000,
      },
      {
        providerInstanceId: INSTANCE,
        model: "kimi-code/k3",
        effectiveAt: "2026-07-15T00:00:00.000Z",
        uncachedInputMicroUsdPerMillion: 5_000_000,
        outputMicroUsdPerMillion: 25_000_000,
      },
    ];
    const rate = resolveUsagePrice({
      providerInstanceId: INSTANCE,
      driver: KIMI,
      model: "kimi-code/k3",
      completedAt,
      overrides,
    });
    expect(rate?.uncachedInputMicroUsdPerMillion).toBe(5_000_000);
    expect(
      priceTurnUsage(usage({ uncachedInputTokens: 1_000_000, billingMode: "subscription" }), rate)
        .costKind,
    ).toBe("api-equivalent-estimate");
    expect(
      priceTurnUsage(usage({ uncachedInputTokens: 1_000_000, billingMode: "api" }), rate).costKind,
    ).toBe("estimated");
  });

  it("never estimates unsupported models and prefers provider-reported cost", () => {
    expect(
      resolveUsagePrice({
        providerInstanceId: INSTANCE,
        driver: KIMI,
        model: "custom/model",
        completedAt,
        overrides: [],
      }),
    ).toBeUndefined();
    expect(priceTurnUsage(usage({ providerReportedCostUsd: 1.234567 }), undefined)).toMatchObject({
      costMicroUsd: 1_234_567,
      costKind: "reported",
    });
  });
});
