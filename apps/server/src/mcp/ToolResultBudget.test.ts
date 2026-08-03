import { expect, it } from "@effect/vitest";

import {
  MODEL_RESULT_LIMITS,
  capFirst,
  capNewest,
  capOpaqueResult,
  capText,
} from "./ToolResultBudget.ts";

it("caps text with deterministic continuation metadata", () => {
  expect(capText("abcdef", 4)).toEqual({
    value: "abcd",
    truncated: true,
    omittedCount: 2,
    continuation:
      "Result truncated for model context. Narrow the query or request a smaller page to continue.",
  });
  expect(capText("abcd", 4)).toEqual({ value: "abcd", truncated: false, omittedCount: 0 });
});

it("keeps the requested edge of bounded collections", () => {
  expect(capFirst([1, 2, 3], 2)).toMatchObject({ value: [1, 2], omittedCount: 1 });
  expect(capNewest([1, 2, 3], 2)).toMatchObject({ value: [2, 3], omittedCount: 1 });
});

it("caps SQL-shaped row arrays before enforcing the serialized character budget", () => {
  const result = capOpaqueResult(
    { rows: Array.from({ length: MODEL_RESULT_LIMITS.supabaseRows + 5 }, (_, id) => ({ id })) },
    { maxChars: MODEL_RESULT_LIMITS.supabaseChars, maxRows: MODEL_RESULT_LIMITS.supabaseRows },
  );
  expect(result.truncated).toBe(true);
  expect(result.omittedCount).toBe(5);
  expect((result.value as { rows: ReadonlyArray<unknown> }).rows).toHaveLength(200);
});

it("returns a valid bounded envelope for opaque oversized results", () => {
  const result = capOpaqueResult({ types: "x".repeat(40_000) }, { maxChars: 32_000 });
  expect(result.truncated).toBe(true);
  expect(typeof result.value).toBe("string");
  expect((result.value as string).length).toBe(32_000);
  expect(result.omittedCount).toBeGreaterThan(0);
  expect(result.continuation).toContain("smaller page");
});
