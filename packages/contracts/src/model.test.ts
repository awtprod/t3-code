import { describe, expect, it } from "vite-plus/test";

import {
  CLAUDE_WORKER_FALLBACK_MODEL,
  isClaudeManagerModelSlug,
  rewriteManagerModelInCommand,
} from "./model.ts";

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

describe("rewriteManagerModelInCommand", () => {
  it("rewrites a headless `claude -p --model claude-fable*` dispatch", () => {
    expect(rewriteManagerModelInCommand("claude -p --model claude-fable-5-1 --max-turns 120")).toBe(
      "claude -p --model claude-opus-4-8 --max-turns 120",
    );
  });

  it("strips a context-window suffix on the fable model token", () => {
    expect(rewriteManagerModelInCommand("claude -p --model claude-fable-5-1[1m]")).toBe(
      "claude -p --model claude-opus-4-8",
    );
  });

  it("handles the `--model=` form and preserves quotes", () => {
    expect(rewriteManagerModelInCommand('claude --model="claude-fable-5" -p')).toBe(
      'claude --model="claude-opus-4-8" -p',
    );
  });

  it("is case-insensitive and rewrites every occurrence", () => {
    expect(
      rewriteManagerModelInCommand(
        "claude -p --model Claude-Fable-5-1; claude -p --model claude-fable-5",
      ),
    ).toBe("claude -p --model claude-opus-4-8; claude -p --model claude-opus-4-8");
  });

  it("leaves worker-model dispatches untouched (same reference)", () => {
    const cmd = "claude -p --model claude-opus-4-8 --max-turns 160";
    expect(rewriteManagerModelInCommand(cmd)).toBe(cmd);
  });

  it("does not touch commands that never invoke claude", () => {
    const cmd = "echo --model claude-fable-5-1";
    expect(rewriteManagerModelInCommand(cmd)).toBe(cmd);
  });

  it("leaves a claude command with no model flag untouched", () => {
    const cmd = "claude -p 'do the thing'";
    expect(rewriteManagerModelInCommand(cmd)).toBe(cmd);
  });
});
