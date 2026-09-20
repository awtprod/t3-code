/**
 * Tool-result sieve (winnow) for the Claude provider — slice B.
 *
 * Large `Read`/`Grep` tool results are split into fixed-size line blocks; a
 * cheap judge returns P(block needed for the current task); confident-no
 * blocks are replaced by a short deterministic stub, everything else stays
 * verbatim. Two hard safety rules mirror the source idea:
 *   1. If the output looks like an error/empty result, nothing is hidden.
 *   2. Uncertain blocks are kept (only `P < dropBelow` is hidden).
 * `shadow` mode judges + records a decision but never rewrites; `active`
 * rewrites. Anything uncertain — unknown output shape, judge failure/timeout,
 * missing answers, too many blocks, below the prune ratio — passes the result
 * through untouched. Defaults keep behaviour byte-for-byte identical.
 *
 * This module is pure and unit-tested; the thin Effect orchestrator
 * (`sieveToolResult`) only adds the judge call, its time bound, and
 * catch-all-to-untouched. The Claude adapter registers a `PostToolUse` hook
 * that calls into it; `ClaudeDriver` builds it from `ServerSettingsService`
 * and the `Judge` service.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

// ---------------------------------------------------------------------------
// Minimal local Judge interface (DESIGN §0). Slice A owns the real `Judge`
// service; this structural interface lets slice B compile and be tested now
// and binds to A's service on rebase. The error channel is a broad structural
// `JudgeError` ({ _tag, reason }) so A's concrete tagged error is assignable at
// the wiring boundary; every consumer here treats any failure as "no judgment"
// and falls through to today's behaviour.
// ---------------------------------------------------------------------------

export type JudgeQuestion =
  | {
      readonly type: "noul";
      readonly instructions: string;
      readonly criteria?: { readonly true: string; readonly false: string };
    }
  | {
      readonly type: "choice";
      readonly instructions: string;
      readonly criteria: Readonly<Record<string, string>>;
    }
  | {
      readonly type: "score";
      readonly instructions: string;
      readonly criteria: ReadonlyArray<string>;
    };

export type JudgeAnswer =
  | { readonly type: "noul"; readonly noul: number }
  | {
      readonly type: "choice";
      readonly choice: string;
      readonly probabilities: Readonly<Record<string, number>>;
      readonly confidence: number;
    }
  | {
      readonly type: "score";
      readonly score: number;
      readonly probabilities: Readonly<Record<string, number>>;
      readonly confidence: number;
    };

export interface JudgeRequest {
  readonly operation: string;
  readonly state: unknown;
  readonly questions: Readonly<Record<string, JudgeQuestion>>;
  readonly timeoutMs?: number;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface JudgeResult {
  readonly answers: Readonly<Record<string, JudgeAnswer>>;
  readonly model: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly latencyMs: number;
}

/**
 * Structural judge error. Slice A's `Judge` fails with a tagged `JudgeError`
 * ({ _tag, reason }); this broad structural shape lets A's concrete error bind
 * to `JudgeLike` on rebase without importing A's module. Every consumer here
 * treats any failure as "no judgment" and falls through to today's behaviour.
 */
export interface JudgeError {
  readonly _tag: string;
  readonly reason?: string;
}

export interface JudgeLike {
  readonly enabled: boolean;
  readonly ask: (req: JudgeRequest) => Effect.Effect<JudgeResult, JudgeError>;
}

// ---------------------------------------------------------------------------
// Settings (mirror of packages/contracts efficiency.sieve, owned by slice A).
// ---------------------------------------------------------------------------

export type SieveMode = "off" | "shadow" | "active";

export interface SieveSettings {
  readonly mode: SieveMode;
  readonly tools: ReadonlyArray<string>;
  readonly minChars: number;
  readonly blockLines: number;
  readonly maxBlocks: number;
  readonly dropBelow: number;
  readonly keepAbove: number;
  readonly minPruneRatio: number;
}

export const DEFAULT_SIEVE_SETTINGS: SieveSettings = {
  mode: "off",
  tools: ["Read", "Grep"],
  minChars: 1500,
  blockLines: 25,
  maxBlocks: 200,
  dropBelow: 0.1,
  keepAbove: 0.5,
  minPruneRatio: 0.2,
};

/**
 * Tools the sieve will ever consider. `Bash` is never sieved in v1 (re-running
 * has side effects and there is no recall cache) even if a mis-configured
 * settings payload lists it. The adapter's `PostToolUse` matcher is built from
 * this constant; live `settings.tools` narrows further inside the sieve.
 */
export const SIEVE_SUPPORTED_TOOLS: ReadonlyArray<string> = ["Read", "Grep"];

// ---------------------------------------------------------------------------
// Public input / decision types.
// ---------------------------------------------------------------------------

export interface SieveTask {
  readonly user_request: string;
  readonly assistant_intent: string;
}

export interface ToolResultSieveInput {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly toolResponse: unknown;
  readonly task: SieveTask;
  readonly agentId?: string;
}

export interface SieveHiddenRange {
  /** First hidden line number (1-based, file-relative for Read). */
  readonly start: number;
  /** Line count in the hidden run. */
  readonly count: number;
  /** Max P(needed) among the run's hidden blocks, for the stub text. */
  readonly maxProbability: number;
}

export interface SieveDecision {
  readonly tool: string;
  readonly mode: SieveMode;
  readonly agentId?: string;
  /** Short summary of the tool input — never file contents. */
  readonly inputSummary: string;
  readonly blockCount: number;
  readonly hiddenBlockIds: ReadonlyArray<string>;
  readonly uncertainBlockIds: ReadonlyArray<string>;
  readonly hiddenRanges: ReadonlyArray<SieveHiddenRange>;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly isErrorProbability: number;
  readonly charsBefore: number;
  readonly charsAfter: number;
  readonly prunedRatio: number;
  /** True only when `active` mode actually produced replacement output. */
  readonly rewritten: boolean;
  /** Why nothing was rewritten, when applicable (error_gate, below_ratio, …). */
  readonly reason?: string;
  readonly judgeModel?: string;
  readonly latencyMs?: number;
}

export interface SieveOutcome {
  /** Present only in `active` mode when a rewrite was applied. */
  readonly updatedToolOutput?: unknown;
  /** Present whenever the judge ran (shadow or active). */
  readonly decision?: SieveDecision;
  /** Set when the sieve short-circuited before/without rewriting. */
  readonly skipped?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

export function blockId(index: number): string {
  return `b${String(index + 1).padStart(3, "0")}`;
}

/** Normalised, tool-agnostic view of a tool result plus a shape-preserving rebuild. */
interface NormalizedResult {
  /** Verbatim text we chunk (Read: file content; Grep/text: the body). */
  readonly text: string;
  /** File line number of `lines[0]` (Read continuity); 1 when unknown. */
  readonly baseLine: number;
  /** Rebuild the tool response with new body text, preserving the outer shape. */
  readonly rebuild: (newText: string) => unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalise a `Read`/`Grep` tool response to `{ text, baseLine, rebuild }`, or
 * `undefined` when the shape is not one we recognise (→ pass through untouched).
 *
 * Read (claude-code 2.1.258): `{ type:"text", file:{ content, startLine, … } }`
 * — raw content, no `cat -n` prefixes; line numbers derive from `startLine`.
 * A future CLI that embeds `N\t` prefixes is also handled by the block parser.
 *
 * The rebuild only swaps `file.content`, keeping every other key (`type`,
 * `file.filePath`, `file.startLine`, `file.numLines`, `file.totalLines`). The
 * CLI honours a `PostToolUse` `updatedToolOutput` only when it matches the
 * tool's output shape (a bare string is silently discarded); this shape-
 * preserving swap is accepted on CLI 2.1.258 and 2.1.278, and the CLI does not
 * require `numLines`/`totalLines` to be recomputed (verified by probe), so we
 * leave that metadata untouched for a minimal, shape-faithful rewrite.
 */
export function normalizeToolResult(
  toolName: string,
  toolResponse: unknown,
): NormalizedResult | undefined {
  // Read: object with a `file.content` string.
  if (isRecord(toolResponse)) {
    const file = toolResponse["file"];
    if (isRecord(file) && typeof file["content"] === "string") {
      const content = file["content"];
      const startLineRaw = file["startLine"];
      const baseLine =
        typeof startLineRaw === "number" && Number.isFinite(startLineRaw) && startLineRaw >= 1
          ? Math.floor(startLineRaw)
          : 1;
      return {
        text: content,
        baseLine,
        rebuild: (newText) => ({
          ...toolResponse,
          file: { ...file, content: newText },
        }),
      };
    }
    // Generic `{ content: string }` (some Grep shapes).
    if (typeof toolResponse["content"] === "string") {
      const content = toolResponse["content"];
      return {
        text: content,
        baseLine: 1,
        rebuild: (newText) => ({ ...toolResponse, content: newText }),
      };
    }
    // `{ type:"text", text:string }`.
    if (typeof toolResponse["text"] === "string") {
      const body = toolResponse["text"];
      return {
        text: body,
        baseLine: 1,
        rebuild: (newText) => ({ ...toolResponse, text: newText }),
      };
    }
    return undefined;
  }
  // Plain string result (e.g. a Grep content dump).
  if (typeof toolResponse === "string") {
    return { text: toolResponse, baseLine: 1, rebuild: (newText) => newText };
  }
  return undefined;
}

interface Block {
  readonly id: string;
  /** Index of the first physical line (into the split `lines` array). */
  readonly startIndex: number;
  /** Number of physical lines in the block. */
  readonly lineCount: number;
  /** File line number of the block's first line (Read continuity). */
  readonly fileStart: number;
  /** File line number of the block's last line. */
  readonly fileEnd: number;
  readonly text: string;
  readonly chars: number;
}

const LINE_NUMBER_PREFIX = /^\s*(\d+)\t/u;

interface ChunkedResult {
  readonly lines: ReadonlyArray<string>;
  readonly trailingNewline: boolean;
  readonly blocks: ReadonlyArray<Block>;
}

/**
 * Split `text` into `blockLines`-line blocks (`b001`…), computing each block's
 * file line range. If a line carries a `cat -n`-style `N\t` prefix that value
 * wins; otherwise the range is derived from `baseLine` + physical offset.
 */
export function chunkIntoBlocks(text: string, blockLines: number, baseLine: number): ChunkedResult {
  const trailingNewline = text.endsWith("\n");
  const body = trailingNewline ? text.slice(0, -1) : text;
  // An empty body still yields one (empty) line from split; treat "" as no lines.
  const lines = body.length === 0 ? [] : body.split("\n");
  const size = Math.max(1, Math.floor(blockLines));
  const blocks: Array<Block> = [];
  for (let start = 0; start < lines.length; start += size) {
    const slice = lines.slice(start, start + size);
    const blockText = slice.join("\n");
    const firstPrefix = LINE_NUMBER_PREFIX.exec(slice[0] ?? "");
    const lastPrefix = LINE_NUMBER_PREFIX.exec(slice[slice.length - 1] ?? "");
    const fileStart = firstPrefix ? Number(firstPrefix[1]) : baseLine + start;
    const fileEnd = lastPrefix ? Number(lastPrefix[1]) : baseLine + start + slice.length - 1;
    blocks.push({
      id: blockId(blocks.length),
      startIndex: start,
      lineCount: slice.length,
      fileStart,
      fileEnd,
      text: blockText,
      chars: blockText.length,
    });
  }
  return { lines, trailingNewline, blocks };
}

/**
 * Build the judge state + one `noul` question per block plus the `is_error`
 * gate. Questions reference `blocks.bNNN` / the whole output by dotted path.
 */
export function buildSieveQuestions(
  blocks: ReadonlyArray<Block>,
  input: ToolResultSieveInput,
): { readonly state: unknown; readonly questions: Record<string, JudgeQuestion> } {
  const blockState: Record<string, string> = {};
  const questions: Record<string, JudgeQuestion> = {};
  for (const block of blocks) {
    blockState[block.id] = block.text;
    questions[block.id] = {
      type: "noul",
      instructions:
        `Is \`blocks.${block.id}\` needed to accomplish \`task\`? Needed means the ` +
        `agent must see these exact lines (code it will change, the matching error ` +
        `or symbol, the value it asked for). Not needed means unrelated sections, ` +
        `boilerplate, imports or comments the task does not touch.`,
      criteria: {
        true: "These exact lines are required for the task.",
        false: "The task can be accomplished without seeing these lines.",
      },
    };
  }
  questions["is_error"] = {
    type: "noul",
    instructions: "The tool output reports an error, failure, or empty/no-match result.",
    criteria: {
      true: "The output is an error, failure, or empty/no-match result.",
      false: "The output is a normal, non-empty result.",
    },
  };
  const state = {
    task: {
      user_request: input.task.user_request,
      assistant_intent: input.task.assistant_intent,
    },
    tool: { name: input.toolName, input: input.toolInput },
    blocks: blockState,
  };
  return { state, questions };
}

function noulOf(answer: JudgeAnswer | undefined): number | undefined {
  if (answer && answer.type === "noul" && Number.isFinite(answer.noul)) {
    return answer.noul;
  }
  return undefined;
}

/** Deterministic, contents-free digest for a Grep hidden run. */
function grepDigest(hiddenLines: ReadonlyArray<string>): string {
  const files = new Set<string>();
  for (const line of hiddenLines) {
    const match = /^([^:\n]+):\d+[:-]/u.exec(line) ?? /^([^:\n]+):/u.exec(line);
    if (match && match[1]) files.add(match[1]);
  }
  const fileCount = files.size;
  return `${hiddenLines.length} matches${fileCount > 0 ? ` in ${fileCount} file${fileCount === 1 ? "" : "s"}` : ""}`;
}

function readStub(range: SieveHiddenRange): string {
  return (
    `[sieve] Lines ${range.start}-${range.start + range.count - 1} (${range.count} lines) hidden ` +
    `as unlikely to matter for the current task (P<=${range.maxProbability.toFixed(2)}). ` +
    `Re-run Read with offset=${range.start} limit=${range.count} if you need them.`
  );
}

function grepStub(digest: string, maxProbability: number): string {
  return (
    `[sieve] ${digest} hidden as unlikely to matter for the current task ` +
    `(P<=${maxProbability.toFixed(2)}); re-run Grep with a narrower path or pattern if needed.`
  );
}

export interface SievePlan {
  readonly hiddenBlockIds: ReadonlyArray<string>;
  readonly uncertainBlockIds: ReadonlyArray<string>;
  readonly hiddenRanges: ReadonlyArray<SieveHiddenRange>;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly isErrorProbability: number;
  readonly charsBefore: number;
  readonly charsAfter: number;
  readonly prunedRatio: number;
  /** Rebuilt tool response (only meaningful when `applied`). */
  readonly rebuiltResponse: unknown;
  /** True when a rewrite is warranted (mode-independent). */
  readonly applied: boolean;
  /** Present when no rewrite is warranted. */
  readonly reason?: "error_gate" | "below_ratio" | "nothing_hidden" | "invalid_answers";
}

/**
 * Pure policy: given normalised text, blocks, and judge answers, decide which
 * blocks to hide and build the rebuilt response. Never rewrites here for
 * `is_error >= keepAbove`, sub-`minPruneRatio` prunes, or missing answers.
 */
export function decideSievePlan(params: {
  readonly toolName: string;
  readonly chunked: ChunkedResult;
  readonly answers: Readonly<Record<string, JudgeAnswer>>;
  readonly settings: SieveSettings;
  readonly normalized: NormalizedResult;
}): SievePlan {
  const { toolName, chunked, answers, settings, normalized } = params;
  const { blocks, lines, trailingNewline } = chunked;
  const charsBefore = normalized.text.length;

  const emptyPlan = (
    reason: "error_gate" | "below_ratio" | "nothing_hidden" | "invalid_answers",
  ): SievePlan => ({
    hiddenBlockIds: [],
    uncertainBlockIds: [],
    hiddenRanges: [],
    probabilities: {},
    isErrorProbability: noulOf(answers["is_error"]) ?? 0,
    charsBefore,
    charsAfter: charsBefore,
    prunedRatio: 0,
    rebuiltResponse: undefined,
    applied: false,
    reason,
  });

  // Validate every answer is present and numeric (missing → untouched).
  const isErrorProbability = noulOf(answers["is_error"]);
  if (isErrorProbability === undefined) {
    return emptyPlan("invalid_answers");
  }
  const probabilities: Record<string, number> = {};
  for (const block of blocks) {
    const p = noulOf(answers[block.id]);
    if (p === undefined) {
      return emptyPlan("invalid_answers");
    }
    probabilities[block.id] = p;
  }

  // Error gate: an error / empty result hides nothing.
  if (isErrorProbability >= settings.keepAbove) {
    return { ...emptyPlan("error_gate"), isErrorProbability };
  }

  const hiddenBlockIds: Array<string> = [];
  const uncertainBlockIds: Array<string> = [];
  const hiddenSet = new Set<string>();
  for (const block of blocks) {
    const p = probabilities[block.id];
    if (p === undefined) continue; // unreachable: validated above.
    if (p < settings.dropBelow) {
      hiddenBlockIds.push(block.id);
      hiddenSet.add(block.id);
    } else if (p < settings.keepAbove) {
      uncertainBlockIds.push(block.id);
    }
  }

  if (hiddenBlockIds.length === 0) {
    return {
      ...emptyPlan("nothing_hidden"),
      isErrorProbability,
      uncertainBlockIds,
      probabilities,
    };
  }

  const hiddenChars = blocks
    .filter((b) => hiddenSet.has(b.id))
    .reduce((sum, b) => sum + b.chars, 0);
  const prunedRatio = charsBefore === 0 ? 0 : hiddenChars / charsBefore;
  if (prunedRatio < settings.minPruneRatio) {
    return {
      ...emptyPlan("below_ratio"),
      isErrorProbability,
      hiddenBlockIds,
      uncertainBlockIds,
      probabilities,
      prunedRatio,
    };
  }

  // Build the rebuilt text: keep non-hidden lines verbatim; collapse each run
  // of consecutive hidden blocks into one stub line.
  const outLines: Array<string> = [];
  const hiddenRanges: Array<SieveHiddenRange> = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (!block) break;
    if (!hiddenSet.has(block.id)) {
      outLines.push(...lines.slice(block.startIndex, block.startIndex + block.lineCount));
      i += 1;
      continue;
    }
    // Extend the hidden run.
    let j = i;
    let maxProbability = 0;
    while (j < blocks.length) {
      const candidate = blocks[j];
      if (!candidate || !hiddenSet.has(candidate.id)) break;
      maxProbability = Math.max(maxProbability, probabilities[candidate.id] ?? 0);
      j += 1;
    }
    const first = block;
    const last = blocks[j - 1] ?? block;
    const count = last.fileEnd - first.fileStart + 1;
    const range: SieveHiddenRange = { start: first.fileStart, count, maxProbability };
    hiddenRanges.push(range);
    if (toolName === "Grep") {
      const hiddenLines = lines.slice(first.startIndex, last.startIndex + last.lineCount);
      outLines.push(grepStub(grepDigest(hiddenLines), maxProbability));
    } else {
      outLines.push(readStub(range));
    }
    i = j;
  }

  const rebuiltText = outLines.join("\n") + (trailingNewline ? "\n" : "");
  return {
    hiddenBlockIds,
    uncertainBlockIds,
    hiddenRanges,
    probabilities,
    isErrorProbability,
    charsBefore,
    charsAfter: rebuiltText.length,
    prunedRatio,
    rebuiltResponse: normalized.rebuild(rebuiltText),
    applied: true,
  };
}

function summarizeInput(toolName: string, toolInput: unknown): string {
  if (!isRecord(toolInput)) return toolName;
  const parts: Array<string> = [];
  for (const key of ["file_path", "path", "pattern", "glob", "offset", "limit", "output_mode"]) {
    const value = toolInput[key];
    if (typeof value === "string" || typeof value === "number") {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.length > 0 ? `${toolName} ${parts.join(" ")}` : toolName;
}

// ---------------------------------------------------------------------------
// Effect orchestrator: judge + time bound + catch-all-to-untouched.
// ---------------------------------------------------------------------------

export interface SieveDeps {
  readonly judge: JudgeLike;
  readonly settings: SieveSettings;
  /** Hard time budget for one sieve invocation (the judge timeout). */
  readonly timeoutMs: number;
}

const skip = (skipped: string): SieveOutcome => ({ skipped });

/**
 * Run the sieve for one tool result. Returns `{ updatedToolOutput }` only in
 * `active` mode with an applied rewrite; `{ decision }` whenever the judge ran;
 * `{ skipped }` when short-circuited. Never fails — any error/timeout resolves
 * to an untouched result so the caller can safely default to today's behaviour.
 */
export const sieveToolResult = (
  deps: SieveDeps,
  input: ToolResultSieveInput,
): Effect.Effect<SieveOutcome> =>
  Effect.gen(function* () {
    const { settings } = deps;
    if (settings.mode === "off") return skip("off");
    // Bash is never sieved in v1; live settings.tools narrows the supported set.
    if (input.toolName === "Bash") return skip("bash_never_sieved");
    if (!settings.tools.includes(input.toolName)) return skip("tool_not_enabled");
    if (!SIEVE_SUPPORTED_TOOLS.includes(input.toolName)) return skip("tool_unsupported");
    // Subagent tool calls carry an agent_id; pass through unjudged in v1.
    if (input.agentId !== undefined && input.agentId !== "") return skip("subagent");

    const normalized = normalizeToolResult(input.toolName, input.toolResponse);
    if (!normalized) return skip("unknown_shape");
    if (normalized.text.length < settings.minChars) return skip("below_min_chars");

    const chunked = chunkIntoBlocks(normalized.text, settings.blockLines, normalized.baseLine);
    if (chunked.blocks.length === 0) return skip("empty");
    if (chunked.blocks.length > settings.maxBlocks) return skip("too_many_blocks");

    if (!deps.judge.enabled) return skip("judge_disabled");

    const { state, questions } = buildSieveQuestions(chunked.blocks, input);
    const result = yield* deps.judge
      .ask({
        operation: "tool-result-sieve",
        state,
        questions,
        timeoutMs: deps.timeoutMs,
        meta: { tool: input.toolName, blocks: chunked.blocks.length },
      })
      .pipe(
        // Bound the judge with its own timeout; any failure OR timeout → None,
        // which the caller treats as "no judgment" (untouched result).
        Effect.timeout(Duration.millis(deps.timeoutMs)),
        Effect.option,
      );

    if (Option.isNone(result)) return skip("judge_error");
    const judgeResult = result.value;

    const plan = decideSievePlan({
      toolName: input.toolName,
      chunked,
      answers: judgeResult.answers,
      settings,
      normalized,
    });

    const baseDecision: SieveDecision = {
      tool: input.toolName,
      mode: settings.mode,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      inputSummary: summarizeInput(input.toolName, input.toolInput),
      blockCount: chunked.blocks.length,
      hiddenBlockIds: plan.hiddenBlockIds,
      uncertainBlockIds: plan.uncertainBlockIds,
      hiddenRanges: plan.hiddenRanges,
      probabilities: plan.probabilities,
      isErrorProbability: plan.isErrorProbability,
      charsBefore: plan.charsBefore,
      charsAfter: plan.charsAfter,
      prunedRatio: plan.prunedRatio,
      rewritten: false,
      ...(plan.reason ? { reason: plan.reason } : {}),
      judgeModel: judgeResult.model,
      latencyMs: judgeResult.latencyMs,
    };

    // shadow: judge + record, never rewrite. active + applied: rewrite.
    if (settings.mode === "active" && plan.applied) {
      return {
        updatedToolOutput: plan.rebuiltResponse,
        decision: { ...baseDecision, rewritten: true },
      };
    }
    return { decision: baseDecision };
  }).pipe(
    // Absolute belt-and-suspenders: any defect/failure/interrupt → untouched.
    Effect.catchCause(() => Effect.succeed(skip("sieve_error"))),
  );
