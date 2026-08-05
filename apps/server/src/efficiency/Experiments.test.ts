import { describe, expect, it } from "@effect/vitest";

import { assignExperiment, evaluateExperiment } from "./Experiments.ts";

describe("efficiency experiments", () => {
  it("assigns deterministically with a balanced 10k-thread distribution", () => {
    const experiment = {
      id: "economy-balanced",
      enabled: true,
      controlTier: "balanced",
      challengerTier: "economy",
    } as const;
    const arms = Array.from(
      { length: 10_000 },
      (_, index) =>
        assignExperiment({ experiment, threadId: `thread-${index}`, eligible: true })?.arm,
    );
    expect(arms.filter((arm) => arm === "control").length).toBeGreaterThanOrEqual(4_900);
    expect(arms.filter((arm) => arm === "control").length).toBeLessThanOrEqual(5_100);
    expect(assignExperiment({ experiment, threadId: "thread-7", eligible: true })).toEqual(
      assignExperiment({ experiment, threadId: "thread-7", eligible: true }),
    );
  });

  it("auto-pauses at ten outcomes per arm and a ten-point regression", () => {
    const outcomes = [
      ...Array.from({ length: 10 }, () => ({ arm: "control" as const, tokens: 100, bad: false })),
      ...Array.from({ length: 9 }, (_, index) => ({
        arm: "challenger" as const,
        tokens: 80,
        bad: index === 0,
      })),
    ];
    expect(evaluateExperiment(outcomes).autoPause).toBe(false);
    expect(
      evaluateExperiment([...outcomes, { arm: "challenger", tokens: 80, bad: false }]).autoPause,
    ).toBe(true);
  });

  it("refuses 14.9 percent and accepts 15 percent token improvement", () => {
    const control = Array.from({ length: 30 }, () => ({
      arm: "control" as const,
      tokens: 1_000,
      bad: false,
    }));
    const challenger = (tokens: number) =>
      Array.from({ length: 30 }, () => ({
        arm: "challenger" as const,
        tokens,
        bad: false,
      }));
    expect(evaluateExperiment([...control, ...challenger(851)]).recommendCheaperArm).toBeNull();
    expect(evaluateExperiment([...control, ...challenger(850)]).recommendCheaperArm).toBe(
      "challenger",
    );
  });
});
