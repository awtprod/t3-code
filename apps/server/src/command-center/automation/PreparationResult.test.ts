import { expect, it } from "@effect/vitest";

import { preparationResultFromOutput } from "./PreparationResult.ts";

const result = {
  kind: "preparation-result",
  source: { id: "source-a", version: "v2", observedAt: "2026-09-28T12:00:00.000Z" },
  counts: { selected: 1, created: 1, reconciled: 0, skipped: 0, failed: 0 },
  subjects: [{ id: "subject-a", evidence: ["evidence-a"], artifactIds: ["artifact-a"] }],
};

it("accepts one bounded preparation result from a completed node output", () => {
  expect(preparationResultFromOutput(JSON.stringify({ research: result }))).toEqual(result);
  expect(
    preparationResultFromOutput(JSON.stringify({ research: { ...result, privateField: "omit" } })),
  ).toEqual(result);
});

it("does not report malformed, ambiguous, or oversized adapter output as useful work", () => {
  expect(preparationResultFromOutput("{")).toBeNull();
  expect(
    preparationResultFromOutput(
      JSON.stringify({ research: { ...result, counts: { ...result.counts, created: -1 } } }),
    ),
  ).toBeNull();
  expect(
    preparationResultFromOutput(
      JSON.stringify({
        research: { ...result, source: { ...result.source, observedAt: "not-a-date" } },
      }),
    ),
  ).toBeNull();
  expect(preparationResultFromOutput(JSON.stringify({ a: result, b: result }))).toBeNull();
  expect(
    preparationResultFromOutput(JSON.stringify({ research: result, padding: "x".repeat(70_000) })),
  ).toBeNull();
});
