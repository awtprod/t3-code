import type { HookCallbackMatcher, HookInput } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, type EfficiencySettings, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  MODEL_GUARDRAIL_HOOK_MATCHER,
  makeClaudeModelGuardrailHooks,
  mergeClaudeSdkHooks,
} from "../orchestration-v2/Adapters/ClaudeModelGuardrail.ts";
import { resolveClaudeModelCatalog } from "../provider/ClaudeModelCatalog.ts";
import { SIEVE_HOOK_MATCHER, makeClaudeToolResultSieveHooks } from "./ClaudeToolResultSieve.ts";
import type { JudgeAnswer, JudgeShape } from "./Judge.ts";

const threadId = ThreadId.make("thread:acme-sieve");
const context = { threadId, sessionModel: () => "claude-opus-5-5" };

const settingsWith = (mode: "off" | "shadow" | "active"): EfficiencySettings => ({
  ...DEFAULT_SERVER_SETTINGS.efficiency,
  sieve: { ...DEFAULT_SERVER_SETTINGS.efficiency.sieve, mode, minChars: 50 },
});

/** Hides blocks b002 and b003; everything else is needed and nothing is an error. */
const judge: JudgeShape = {
  enabled: true,
  ask: (request) =>
    Effect.sync(() => {
      const answers: Record<string, JudgeAnswer> = {};
      for (const key of Object.keys(request.questions)) {
        const noul = key === "is_error" ? 0 : key === "b002" || key === "b003" ? 0.02 : 0.9;
        answers[key] = { type: "noul", noul };
      }
      return {
        answers,
        model: "jev-latest",
        usage: { inputTokens: 1, outputTokens: 0 },
        latencyMs: 1,
      };
    }),
};

const content = Array.from(
  { length: 100 },
  (_, index) => `content line ${String(index + 1).padStart(3, "0")} xxxx`,
).join("\n");
const postToolUse = {
  hook_event_name: "PostToolUse",
  session_id: "session:acme",
  transcript_path: "/tmp/acme.jsonl",
  cwd: "/repo",
  tool_name: "Read",
  tool_use_id: "tool:acme",
  tool_input: { file_path: "/repo/src/parse.ts" },
  tool_response: {
    type: "text",
    file: { filePath: "/repo/src/parse.ts", content, numLines: 100, startLine: 1, totalLines: 100 },
  },
} as unknown as HookInput;

const guardrail = makeClaudeModelGuardrailHooks({
  sessionModel: context.sessionModel,
  catalog: resolveClaudeModelCatalog(undefined),
});

const hooksFor = (
  mode: "off" | "shadow" | "active",
  live?: { mode: "off" | "shadow" | "active" },
) =>
  makeClaudeToolResultSieveHooks({
    judge,
    currentSettings: () => settingsWith(live?.mode ?? mode),
    latestUserRequest: () => Effect.succeed("fix the bug in parse()"),
  })(context);

describe("Claude tool-result sieve hook registration", () => {
  it("registers nothing while the sieve is off, and the guardrail stays", () => {
    expect(hooksFor("off")).toBeUndefined();
    // The merge ClaudeAdapterV2 does for every opened query.
    const merged = mergeClaudeSdkHooks(guardrail, hooksFor("off"));
    expect(merged.PreToolUse?.map((matcher) => matcher.matcher)).toEqual([
      MODEL_GUARDRAIL_HOOK_MATCHER,
    ]);
    expect(merged.PostToolUse).toBeUndefined();
  });

  it("adds a Read|Grep PostToolUse matcher when on, after the guardrail", () => {
    for (const mode of ["shadow", "active"] as const) {
      const merged = mergeClaudeSdkHooks(guardrail, hooksFor(mode));
      expect(merged.PreToolUse?.map((matcher) => matcher.matcher)).toEqual([
        MODEL_GUARDRAIL_HOOK_MATCHER,
      ]);
      expect(merged.PostToolUse?.map((matcher) => matcher.matcher)).toEqual([SIEVE_HOOK_MATCHER]);
    }
  });
});

describe("Claude tool-result sieve pass", () => {
  const callbackOf = (matchers: ReadonlyArray<HookCallbackMatcher> | undefined) => {
    const callback = matchers?.[0]?.hooks[0];
    if (callback === undefined) throw new Error("expected a sieve hook");
    return callback;
  };
  const signal = new AbortController().signal;

  it("rewrites a large Read result in active mode", async () => {
    const callback = callbackOf(hooksFor("active")?.PostToolUse);
    const output = (await callback(postToolUse, "tool:acme", { signal })) as {
      readonly hookSpecificOutput?: {
        readonly hookEventName: string;
        readonly updatedToolOutput: { readonly file: { readonly content: string } };
      };
    };
    expect(output.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
    expect(output.hookSpecificOutput?.updatedToolOutput.file.content).toContain(
      "[sieve] Lines 26-75",
    );
  });

  it("leaves the result untouched in shadow mode and after a live switch to off", async () => {
    expect(
      await callbackOf(hooksFor("shadow")?.PostToolUse)(postToolUse, "tool:acme", { signal }),
    ).toEqual({});
    const live = { mode: "active" as "off" | "shadow" | "active" };
    const registered = hooksFor("active", live);
    live.mode = "off";
    expect(await callbackOf(registered?.PostToolUse)(postToolUse, "tool:acme", { signal })).toEqual(
      {},
    );
  });
});
