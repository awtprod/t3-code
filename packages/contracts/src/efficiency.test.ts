import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { EfficiencyDecision, EfficiencySettings } from "./efficiency.ts";
import { ServerSettings } from "./settings.ts";

const decodeEfficiency = Schema.decodeUnknownSync(EfficiencySettings);
const decodeDecision = Schema.decodeUnknownSync(EfficiencyDecision);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);

describe("EfficiencySettings judge/tierJudgment/sieve defaults", () => {
  it("applies the judge defaults when the key is absent", () => {
    const { judge } = decodeEfficiency({});
    expect(judge).toEqual({
      transport: "off",
      model: "jev-latest",
      apiKeyEnv: "TYPESAFE_API_KEY",
      timeoutMs: 15000,
      maxStateChars: 120000,
    });
  });

  it("applies the tier-judgment defaults when the key is absent", () => {
    expect(decodeEfficiency({}).tierJudgment).toEqual({ enabled: false, minConfidence: 0.6 });
  });

  it("applies the sieve defaults when the key is absent", () => {
    expect(decodeEfficiency({}).sieve).toEqual({
      mode: "off",
      tools: ["Read", "Grep"],
      minChars: 1500,
      blockLines: 25,
      maxBlocks: 200,
      dropBelow: 0.1,
      keepAbove: 0.5,
      minPruneRatio: 0.2,
    });
  });

  it("rejects a sieve where dropBelow is not below keepAbove", () => {
    expect(() => decodeEfficiency({ sieve: { dropBelow: 0.6, keepAbove: 0.5 } })).toThrow();
    expect(() => decodeEfficiency({ sieve: { dropBelow: 0.5, keepAbove: 0.5 } })).toThrow();
    expect(decodeEfficiency({ sieve: { dropBelow: 0.2, keepAbove: 0.9 } }).sieve.keepAbove).toBe(
      0.9,
    );
  });

  it("keeps existing efficiency JSON unchanged while adding the new defaults", () => {
    const legacy = {
      enabled: true,
      defaultTier: "balanced" as const,
      rules: [],
      candidates: [],
      contextThresholds: { economy: 50, balanced: 70, quality: 95 },
      toolWarnings: { economy: 5, balanced: 10, quality: 20 },
      experiments: [],
    };
    const decoded = decodeEfficiency(legacy);
    // Pre-existing fields are preserved verbatim.
    expect(decoded.enabled).toBe(true);
    expect(decoded.defaultTier).toBe("balanced");
    expect(decoded.contextThresholds).toEqual({ economy: 50, balanced: 70, quality: 95 });
    // New sub-settings default to the disabled/off shape.
    expect(decoded.judge.transport).toBe("off");
    expect(decoded.tierJudgment.enabled).toBe(false);
    expect(decoded.sieve.mode).toBe("off");
  });

  it("only narrows the judge/tier defaults for values explicitly provided", () => {
    const decoded = decodeEfficiency({
      judge: { transport: "openai-compatible", model: "glm-5.3-flash" },
      tierJudgment: { enabled: true },
    });
    expect(decoded.judge.transport).toBe("openai-compatible");
    expect(decoded.judge.model).toBe("glm-5.3-flash");
    // Untouched judge fields still fall back to their defaults.
    expect(decoded.judge.apiKeyEnv).toBe("TYPESAFE_API_KEY");
    expect(decoded.tierJudgment.enabled).toBe(true);
    expect(decoded.tierJudgment.minConfidence).toBe(0.6);
  });
});

describe("EfficiencyDecision judgment field", () => {
  const base = {
    tier: "balanced" as const,
    modelSelection: { instanceId: "codex", model: "gpt-5.6-terra" },
    source: "tier-policy" as const,
    workload: "interactive" as const,
    contextThresholdPercent: 80,
    toolWarningThreshold: 12,
  };

  it("decodes without a judgment (additive/optional)", () => {
    expect(decodeDecision(base).judgment).toBeUndefined();
  });

  it("round-trips a recorded judgment", () => {
    const decoded = decodeDecision({
      ...base,
      judgment: {
        score: 1.4,
        confidence: 0.72,
        tier: "balanced",
        applied: true,
        model: "glm-5.3-flash",
      },
    });
    expect(decoded.judgment?.applied).toBe(true);
    expect(decoded.judgment?.score).toBe(1.4);
  });
});

describe("ServerSettings efficiency round-trip", () => {
  it("decodes settings JSON without the new efficiency keys unchanged", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.efficiency.judge.transport).toBe("off");
    expect(decoded.efficiency.tierJudgment.enabled).toBe(false);
    expect(decoded.efficiency.sieve.mode).toBe("off");
  });
});
