import { describe, expect, it } from "vite-plus/test";

import {
  CLAUDE_WORKER_FALLBACK_MODEL,
  CODEX_WORKER_FALLBACK_MODEL,
  isClaudeManagerModelSlug,
  isCodexManagerModelSlug,
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
    expect(CLAUDE_WORKER_FALLBACK_MODEL).toBe("claude-opus-5-5");
    expect(isClaudeManagerModelSlug(CLAUDE_WORKER_FALLBACK_MODEL)).toBe(false);
  });
});

describe("isCodexManagerModelSlug", () => {
  it("treats the Astra family as manager-tier", () => {
    expect(isCodexManagerModelSlug("gpt-6-astra")).toBe(true);
    expect(isCodexManagerModelSlug(" GPT-7-Astra ")).toBe(true);
    expect(isCodexManagerModelSlug("gpt-6-astra-mini")).toBe(true);
  });

  it("treats worker models and look-alikes as non-manager", () => {
    expect(isCodexManagerModelSlug("gpt-6-sol")).toBe(false);
    expect(isCodexManagerModelSlug("gpt-6-terra")).toBe(false);
    expect(isCodexManagerModelSlug("gpt-6-castrato")).toBe(false);
    expect(isCodexManagerModelSlug(CODEX_WORKER_FALLBACK_MODEL)).toBe(false);
    expect(isCodexManagerModelSlug(undefined)).toBe(false);
    expect(isCodexManagerModelSlug("")).toBe(false);
  });
});

describe("rewriteManagerModelInCommand", () => {
  it("rewrites the bare `fable` alias but not look-alike tokens", () => {
    expect(rewriteManagerModelInCommand("claude -p --model fable 'go'")).toBe(
      "claude -p --model claude-opus-5-5 'go'",
    );
    const cmd = "claude -p --model fabled-thing";
    expect(rewriteManagerModelInCommand(cmd)).toBe(cmd);
  });

  it("rewrites a headless `codex exec` Astra dispatch in every flag form", () => {
    expect(rewriteManagerModelInCommand("codex exec -m gpt-6-astra 'review'")).toBe(
      "codex exec -m gpt-6-sol 'review'",
    );
    expect(rewriteManagerModelInCommand("codex exec --model=gpt-6-astra 'review'")).toBe(
      "codex exec --model=gpt-6-sol 'review'",
    );
    expect(rewriteManagerModelInCommand('codex exec -c model="gpt-6-astra" review')).toBe(
      'codex exec -c model="gpt-6-sol" review',
    );
  });

  it("leaves non-Astra codex dispatches and non-codex commands untouched", () => {
    const worker = "codex exec -m gpt-6-terra --max-turns 3";
    expect(rewriteManagerModelInCommand(worker)).toBe(worker);
    const mention = "echo -m gpt-6-astra";
    expect(rewriteManagerModelInCommand(mention)).toBe(mention);
  });

  it("rewrites a headless `claude -p --model claude-fable*` dispatch", () => {
    expect(rewriteManagerModelInCommand("claude -p --model claude-fable-5-1 --max-turns 120")).toBe(
      "claude -p --model claude-opus-5-5 --max-turns 120",
    );
  });

  it("strips a context-window suffix on the fable model token", () => {
    expect(rewriteManagerModelInCommand("claude -p --model claude-fable-5-1[1m]")).toBe(
      "claude -p --model claude-opus-5-5",
    );
  });

  it("handles the `--model=` form and preserves quotes", () => {
    expect(rewriteManagerModelInCommand('claude --model="claude-fable-5" -p')).toBe(
      'claude --model="claude-opus-5-5" -p',
    );
  });

  it("is case-insensitive and rewrites every occurrence", () => {
    expect(
      rewriteManagerModelInCommand(
        "claude -p --model Claude-Fable-5-1; claude -p --model claude-fable-5",
      ),
    ).toBe("claude -p --model claude-opus-5-5; claude -p --model claude-opus-5-5");
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
