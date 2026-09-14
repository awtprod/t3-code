import { describe, expect, it } from "vite-plus/test";

import { CLAUDE_WORKER_FALLBACK_MODEL, isClaudeManagerModelSlug } from "./model.ts";

describe("isClaudeManagerModelSlug", () => {
  it("treats the Fable family (canonical slugs) as manager-tier", () => {
    expect(isClaudeManagerModelSlug("claude-fable-5-1")).toBe(true);
    expect(isClaudeManagerModelSlug("claude-fable-5")).toBe(true);
    // Future Fable versions are covered by the prefix match.
    expect(isClaudeManagerModelSlug("claude-fable-6")).toBe(true);
  });

  it("is case-insensitive and tolerant of surrounding whitespace", () => {
    expect(isClaudeManagerModelSlug("  Claude-Fable-5-1  ")).toBe(true);
  });

  it("treats worker models as non-manager", () => {
    expect(isClaudeManagerModelSlug("claude-opus-4-8")).toBe(false);
    expect(isClaudeManagerModelSlug("claude-opus-5")).toBe(false);
    expect(isClaudeManagerModelSlug("claude-sonnet-5")).toBe(false);
    expect(isClaudeManagerModelSlug("claude-haiku-4-5")).toBe(false);
  });

  it("expects canonical slugs, not bare aliases", () => {
    // Callers resolve aliases via resolveClaudeModelSlug first; the bare alias
    // does not carry the canonical `claude-fable` prefix.
    expect(isClaudeManagerModelSlug("fable")).toBe(false);
  });

  it("is safe on empty / nullish input", () => {
    expect(isClaudeManagerModelSlug(undefined)).toBe(false);
    expect(isClaudeManagerModelSlug(null)).toBe(false);
    expect(isClaudeManagerModelSlug("")).toBe(false);
  });
});

describe("CLAUDE_WORKER_FALLBACK_MODEL", () => {
  it("is the designated worker model and is not itself manager-tier", () => {
    expect(CLAUDE_WORKER_FALLBACK_MODEL).toBe("claude-opus-4-8");
    expect(isClaudeManagerModelSlug(CLAUDE_WORKER_FALLBACK_MODEL)).toBe(false);
  });
});
