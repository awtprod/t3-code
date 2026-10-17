import { expect, it } from "@effect/vitest";

import { priceTurnUsage } from "./turnUsagePricing.ts";
import { createOverrideRateTable, parseRateTable } from "./usagePricing.ts";

const tables = {
  rates: parseRateTable({
    "acme-litellm-model": { input_cost_per_token: 0.000_002, output_cost_per_token: 0.000_01 },
  }),
  overrides: createOverrideRateTable({
    "acme-override-model": { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 2 },
  }),
  aliases: new Map([["acme-preview", "acme-override-model"]]),
};
const tokens = {
  uncachedInputTokens: 1_000_000,
  cacheReadInputTokens: null,
  cacheWriteInputTokens: null,
  outputTokens: 1_000_000,
  reasoningOutputTokens: null,
};

it("prices a turn from the price overrides setting first", () => {
  expect(priceTurnUsage(tables, "acme-override-model", tokens)).toEqual({
    costMicroUsd: 3_000_000,
    costKind: "estimated",
    cacheSavingsMicroUsd: 0,
    rateProvenance: "usagePriceOverrides",
  });
});

it("falls back to LiteLLM and follows model aliases", () => {
  expect(priceTurnUsage(tables, "acme-litellm-model", tokens)).toMatchObject({
    costMicroUsd: 12_000_000,
    rateProvenance: "LiteLLM",
  });
  expect(priceTurnUsage(tables, "acme-preview", tokens).rateProvenance).toBe("usagePriceOverrides");
});

it("reports an unknown model or empty usage as unpriced, never $0", () => {
  const unpriced = {
    costMicroUsd: null,
    costKind: "unavailable",
    cacheSavingsMicroUsd: null,
    rateProvenance: null,
  };
  expect(priceTurnUsage(tables, "acme-unknown", tokens)).toEqual(unpriced);
  expect(priceTurnUsage(tables, null, tokens)).toEqual(unpriced);
  expect(
    priceTurnUsage(tables, "acme-override-model", {
      uncachedInputTokens: null,
      cacheReadInputTokens: null,
      cacheWriteInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
    }),
  ).toEqual(unpriced);
});
