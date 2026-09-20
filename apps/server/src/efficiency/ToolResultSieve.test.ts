import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  buildSieveQuestions,
  chunkIntoBlocks,
  DEFAULT_SIEVE_SETTINGS,
  decideSievePlan,
  normalizeToolResult,
  sieveToolResult,
  type JudgeAnswer,
  type JudgeLike,
  type JudgeResult,
  type SieveSettings,
  type ToolResultSieveInput,
} from "./ToolResultSieve.ts";

// ---------------------------------------------------------------------------
// Fakes / fixtures.
// ---------------------------------------------------------------------------

const task = { user_request: "fix the bug in parse()", assistant_intent: "read the file" };

function readResponse(content: string, startLine = 1): unknown {
  return {
    type: "text",
    file: {
      filePath: "/repo/src/parse.ts",
      content,
      numLines: content.split("\n").length,
      startLine,
      totalLines: content.split("\n").length,
    },
  };
}

/** 100 raw lines (no cat -n prefixes), ~20 chars each → well over minChars. */
function hundredLines(): string {
  const lines: Array<string> = [];
  for (let n = 1; n <= 100; n += 1) lines.push(`content line ${String(n).padStart(3, "0")} xxxx`);
  return lines.join("\n") + "\n";
}

interface FakeJudgeOptions {
  readonly enabled?: boolean;
  readonly fail?: boolean;
  readonly model?: string;
  readonly latencyMs?: number;
}

/** A judge that answers `noul` for each requested key from `byKey` (default 0.9). */
function fakeJudge(
  byKey: Readonly<Record<string, number>>,
  options: FakeJudgeOptions = {},
): JudgeLike {
  return {
    enabled: options.enabled ?? true,
    ask: (req) =>
      options.fail === true
        ? Effect.fail({ _tag: "JudgeError", reason: "boom" })
        : Effect.sync((): JudgeResult => {
            const answers: Record<string, JudgeAnswer> = {};
            for (const key of Object.keys(req.questions)) {
              // Default blocks to "needed" (0.9) and the error gate to "not an
              // error" (0) so tests only opt blocks into hiding explicitly.
              const fallback = key === "is_error" ? 0 : 0.9;
              answers[key] = { type: "noul", noul: byKey[key] ?? fallback };
            }
            return {
              answers,
              model: options.model ?? "glm-5.3-flash",
              usage: { inputTokens: 100, outputTokens: 0 },
              latencyMs: options.latencyMs ?? 12,
            };
          }),
  };
}

const activeSettings: SieveSettings = { ...DEFAULT_SIEVE_SETTINGS, mode: "active", minChars: 50 };

function readInput(content: string, startLine = 1): ToolResultSieveInput {
  return {
    toolName: "Read",
    toolInput: { file_path: "/repo/src/parse.ts" },
    toolResponse: readResponse(content, startLine),
    task,
  };
}

const run = <A>(effect: Effect.Effect<A>): Promise<A> => Effect.runPromise(effect);

// ---------------------------------------------------------------------------
// Pure: chunking.
// ---------------------------------------------------------------------------

describe("chunkIntoBlocks", () => {
  it("splits into blockLines-line blocks with b001… ids and file ranges", () => {
    const { blocks } = chunkIntoBlocks(hundredLines(), 25, 1);
    expect(blocks.map((b) => b.id)).toEqual(["b001", "b002", "b003", "b004"]);
    expect(blocks[0]!.fileStart).toBe(1);
    expect(blocks[0]!.fileEnd).toBe(25);
    expect(blocks[1]!.fileStart).toBe(26);
    expect(blocks[3]!.fileEnd).toBe(100);
  });

  it("honours a startLine base offset for Read continuity", () => {
    const { blocks } = chunkIntoBlocks("a\nb\nc\nd\n", 2, 41);
    expect(blocks[0]!.fileStart).toBe(41);
    expect(blocks[0]!.fileEnd).toBe(42);
    expect(blocks[1]!.fileStart).toBe(43);
  });

  it("parses cat -n-style line-number prefixes when present", () => {
    const text = "    41\talpha\n    42\tbravo\n    43\tcharlie\n";
    const { blocks } = chunkIntoBlocks(text, 2, 1);
    expect(blocks[0]!.fileStart).toBe(41);
    expect(blocks[0]!.fileEnd).toBe(42);
    expect(blocks[1]!.fileStart).toBe(43);
  });

  it("returns no blocks for empty text", () => {
    expect(chunkIntoBlocks("", 25, 1).blocks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pure: state / question construction.
// ---------------------------------------------------------------------------

describe("buildSieveQuestions", () => {
  it("emits one noul per block plus is_error, and references blocks by id", () => {
    const { blocks } = chunkIntoBlocks(hundredLines(), 25, 1);
    const { state, questions } = buildSieveQuestions(blocks, readInput(hundredLines()));
    expect(Object.keys(questions).sort()).toEqual(["b001", "b002", "b003", "b004", "is_error"]);
    expect(questions["b001"]!.type).toBe("noul");
    expect(questions["b001"]!.instructions).toContain("`blocks.b001`");
    expect(questions["is_error"]!.instructions).toContain("error");
    const s = state as { blocks: Record<string, string>; tool: { name: string } };
    expect(Object.keys(s.blocks)).toEqual(["b001", "b002", "b003", "b004"]);
    expect(s.tool.name).toBe("Read");
  });
});

// ---------------------------------------------------------------------------
// Pure: policy.
// ---------------------------------------------------------------------------

describe("decideSievePlan", () => {
  const content = hundredLines();
  const normalized = normalizeToolResult("Read", readResponse(content))!;
  const chunked = chunkIntoBlocks(content, 25, 1);

  const answers = (
    map: Readonly<Record<string, number>>,
  ): Readonly<Record<string, JudgeAnswer>> => {
    const out: Record<string, JudgeAnswer> = {
      is_error: { type: "noul", noul: map["is_error"] ?? 0 },
    };
    for (const b of chunked.blocks) out[b.id] = { type: "noul", noul: map[b.id] ?? 0.9 };
    return out;
  };

  it("hides only blocks below dropBelow, keeps uncertain, and preserves numbering", () => {
    const plan = decideSievePlan({
      toolName: "Read",
      chunked,
      answers: answers({ b002: 0.02, b003: 0.05, b001: 0.9, b004: 0.3 }),
      settings: activeSettings,
      normalized,
    });
    expect(plan.applied).toBe(true);
    expect(plan.hiddenBlockIds).toEqual(["b002", "b003"]);
    expect(plan.uncertainBlockIds).toEqual(["b004"]); // 0.1 <= 0.3 < 0.5
    expect(plan.hiddenRanges).toEqual([{ start: 26, count: 50, maxProbability: 0.05 }]);
    const rebuilt = plan.rebuiltResponse as { file: { content: string } };
    // Kept lines verbatim.
    expect(rebuilt.file.content).toContain("content line 001 xxxx");
    expect(rebuilt.file.content).toContain("content line 100 xxxx");
    // Hidden lines gone, replaced by a single stub with a re-run hint.
    expect(rebuilt.file.content).not.toContain("content line 050 xxxx");
    expect(rebuilt.file.content).toContain("[sieve] Lines 26-75 (50 lines) hidden");
    expect(rebuilt.file.content).toContain("Re-run Read with offset=26 limit=50");
  });

  it("error gate: is_error >= keepAbove hides nothing", () => {
    const plan = decideSievePlan({
      toolName: "Read",
      chunked,
      answers: answers({ b001: 0.0, b002: 0.0, b003: 0.0, b004: 0.0, is_error: 0.9 }),
      settings: activeSettings,
      normalized,
    });
    expect(plan.applied).toBe(false);
    expect(plan.reason).toBe("error_gate");
    expect(plan.hiddenBlockIds).toEqual([]);
  });

  it("minPruneRatio: skips the rewrite when too little would be hidden", () => {
    const plan = decideSievePlan({
      toolName: "Read",
      chunked,
      // Only one of four blocks hidden → ~0.25 by lines but tune ratio high.
      answers: answers({ b002: 0.02 }),
      settings: { ...activeSettings, minPruneRatio: 0.5 },
      normalized,
    });
    expect(plan.applied).toBe(false);
    expect(plan.reason).toBe("below_ratio");
  });

  it("missing answers → untouched (invalid_answers)", () => {
    const partial: Record<string, JudgeAnswer> = { is_error: { type: "noul", noul: 0 } };
    // omit block answers
    const plan = decideSievePlan({
      toolName: "Read",
      chunked,
      answers: partial,
      settings: activeSettings,
      normalized,
    });
    expect(plan.applied).toBe(false);
    expect(plan.reason).toBe("invalid_answers");
  });
});

// ---------------------------------------------------------------------------
// Pure: Grep rebuild.
// ---------------------------------------------------------------------------

describe("decideSievePlan (Grep)", () => {
  it("collapses a hidden run into a match/file digest stub", () => {
    const lines: Array<string> = [];
    for (let n = 1; n <= 60; n += 1) {
      const file = n <= 30 ? "src/a.ts" : "src/b.ts";
      lines.push(`${file}:${n}:some matching content here number ${n}`);
    }
    const text = lines.join("\n") + "\n";
    const normalized = normalizeToolResult("Grep", text)!;
    const chunked = chunkIntoBlocks(text, 25, 1);
    const answers: Record<string, JudgeAnswer> = { is_error: { type: "noul", noul: 0 } };
    for (const b of chunked.blocks) answers[b.id] = { type: "noul", noul: 0.9 };
    answers["b002"] = { type: "noul", noul: 0.02 };
    answers["b003"] = { type: "noul", noul: 0.02 };
    const plan = decideSievePlan({
      toolName: "Grep",
      chunked,
      answers,
      settings: activeSettings,
      normalized,
    });
    expect(plan.applied).toBe(true);
    const rebuilt = plan.rebuiltResponse as string;
    expect(rebuilt).toContain("[sieve]");
    expect(rebuilt).toMatch(/\d+ matches in \d+ files hidden/u);
    expect(rebuilt).toContain("re-run Grep with a narrower path or pattern");
    // First kept block's lines survive verbatim.
    expect(rebuilt).toContain("src/a.ts:1:some matching content here number 1");
  });
});

// ---------------------------------------------------------------------------
// Orchestrator: shadow vs active, gates, failure.
// ---------------------------------------------------------------------------

describe("sieveToolResult", () => {
  const content = hundredLines();
  const judge = fakeJudge({ b002: 0.02, b003: 0.02 });

  it("active mode rewrites and returns updatedToolOutput", async () => {
    const out = await run(
      sieveToolResult({ judge, settings: activeSettings, timeoutMs: 15000 }, readInput(content)),
    );
    expect(out.updatedToolOutput).toBeDefined();
    const rebuilt = out.updatedToolOutput as { file: { content: string } };
    expect(rebuilt.file.content).toContain("[sieve] Lines 26-75");
    expect(out.decision?.rewritten).toBe(true);
    expect(out.decision?.hiddenBlockIds).toEqual(["b002", "b003"]);
    expect(out.decision?.judgeModel).toBe("glm-5.3-flash");
  });

  it("shadow mode records a decision but never rewrites", async () => {
    const out = await run(
      sieveToolResult(
        { judge, settings: { ...activeSettings, mode: "shadow" }, timeoutMs: 15000 },
        readInput(content),
      ),
    );
    expect(out.updatedToolOutput).toBeUndefined();
    expect(out.decision?.rewritten).toBe(false);
    expect(out.decision?.hiddenBlockIds).toEqual(["b002", "b003"]);
  });

  it("off mode short-circuits", async () => {
    const out = await run(
      sieveToolResult(
        { judge, settings: { ...activeSettings, mode: "off" }, timeoutMs: 15000 },
        readInput(content),
      ),
    );
    expect(out).toEqual({ skipped: "off" });
  });

  it("passes through subagent (agent_id) calls unjudged", async () => {
    const out = await run(
      sieveToolResult(
        { judge, settings: activeSettings, timeoutMs: 15000 },
        { ...readInput(content), agentId: "sub-1" },
      ),
    );
    expect(out).toEqual({ skipped: "subagent" });
  });

  it("never sieves Bash", async () => {
    const out = await run(
      sieveToolResult(
        {
          judge,
          settings: { ...activeSettings, tools: ["Read", "Grep", "Bash"] },
          timeoutMs: 15000,
        },
        { toolName: "Bash", toolInput: { command: "ls" }, toolResponse: content, task },
      ),
    );
    expect(out).toEqual({ skipped: "bash_never_sieved" });
  });

  it("skips below minChars", async () => {
    const out = await run(
      sieveToolResult({ judge, settings: activeSettings, timeoutMs: 15000 }, readInput("tiny\n")),
    );
    expect(out).toEqual({ skipped: "below_min_chars" });
  });

  it("unknown output shape → untouched", async () => {
    const out = await run(
      sieveToolResult(
        { judge, settings: activeSettings, timeoutMs: 15000 },
        { toolName: "Read", toolInput: {}, toolResponse: { weird: 123 }, task },
      ),
    );
    expect(out).toEqual({ skipped: "unknown_shape" });
  });

  it("judge disabled → untouched", async () => {
    const out = await run(
      sieveToolResult(
        { judge: fakeJudge({}, { enabled: false }), settings: activeSettings, timeoutMs: 15000 },
        readInput(content),
      ),
    );
    expect(out).toEqual({ skipped: "judge_disabled" });
  });

  it("judge failure → untouched (no updatedToolOutput)", async () => {
    const out = await run(
      sieveToolResult(
        { judge: fakeJudge({}, { fail: true }), settings: activeSettings, timeoutMs: 15000 },
        readInput(content),
      ),
    );
    expect(out.updatedToolOutput).toBeUndefined();
    expect(out.skipped).toBe("judge_error");
  });

  it("error gate via orchestrator → decision without rewrite", async () => {
    const out = await run(
      sieveToolResult(
        {
          judge: fakeJudge({ b002: 0.02, b003: 0.02, is_error: 0.95 }),
          settings: activeSettings,
          timeoutMs: 15000,
        },
        readInput(content),
      ),
    );
    expect(out.updatedToolOutput).toBeUndefined();
    expect(out.decision?.reason).toBe("error_gate");
  });
});
