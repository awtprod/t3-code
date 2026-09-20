// @effect-diagnostics preferSchemaOverJson:off cryptoRandomUUID:off globalTimersInEffect:off globalFetchInEffect:off
// This is a raw HTTP judge client with an injectable `fetch`, a JSON wire
// protocol, an AbortController-backed timeout, and a UUID operation id — the
// same shape as the other raw provider runtimes (see `provider/kimiRuntime.ts`),
// so the corresponding Effect diagnostics are disabled at the file level.
/**
 * Judge – one implementation of "ask a cheap model typed questions and get
 * calibrated probabilities back".
 *
 * Two transports live behind one interface:
 *
 * - `typesafe` speaks the TypeSafe System One protocol verbatim
 *   (`POST https://api.typesafe.ai/v1/systemone`). The service returns typed
 *   answers (noul / choice / score) with probabilities and a confidence; we
 *   validate their shape and pass the values through.
 * - `openai-compatible` posts one `/chat/completions` request with a
 *   `json_schema` response format asking the model to return raw probabilities
 *   per question. `choice`, `score`, and `confidence` are then computed **in
 *   code** (see {@link confidenceFromDistribution}) — never trusted from the
 *   model.
 * - `off` (default) fails every `ask` with `JudgeError{reason:"disabled"}`, so
 *   every consumer falls through to today's behavior.
 *
 * Every call is bounded (per-attempt timeout, one retry on 429/529), refuses
 * oversized state instead of truncating it silently, and validates the response
 * at the boundary. Each call is recorded in `internal_generation_usage`
 * (`operation = "judge.<operation>"`) and appended to a rotating JSONL decision
 * log for shadow-mode evidence.
 *
 * @module Judge
 */
import type { EfficiencyJudgeSettings } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { lookupRate, type RateTable } from "../usage/usagePricing.ts";

// ---------------------------------------------------------------------------
// Public request/response shapes (mirrors DESIGN.md §0)
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
  /** e.g. "tier-judgment", "tool-result-sieve". Recorded as `judge.<operation>`. */
  readonly operation: string;
  /** `string` or JSON object; questions reference it by `dotted.path` in backticks. */
  readonly state: unknown;
  readonly questions: Readonly<Record<string, JudgeQuestion>>;
  readonly timeoutMs?: number;
}

export interface JudgeResult {
  readonly answers: Readonly<Record<string, JudgeAnswer>>;
  readonly model: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly latencyMs: number;
}

/** Free-form evidence attached to the decision log line, never to usage rows. */
export type JudgeMeta = Readonly<Record<string, unknown>>;

export type JudgeErrorReason =
  | "disabled"
  | "state-too-large"
  | "timeout"
  | "network"
  | "rate-limited"
  | "http"
  | "invalid-response";

export class JudgeError extends Data.TaggedError("JudgeError")<{
  readonly reason: JudgeErrorReason;
  readonly detail: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return `Judge failed (${this.reason}): ${this.detail}`;
  }
}

export interface JudgeShape {
  readonly enabled: boolean;
  readonly ask: (request: JudgeRequest, meta?: JudgeMeta) => Effect.Effect<JudgeResult, JudgeError>;
}

/**
 * Judge Context.Service. `enabled` reflects the live transport setting (`false`
 * when `off`); `ask` re-reads the current transport on every call and is the
 * authoritative gate — a disabled judge fails with `JudgeError{reason:"disabled"}`.
 */
export class Judge extends Context.Service<Judge, JudgeShape>()(
  "@awtprod/command-center/efficiency/Judge",
) {}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

export interface ResolvedJudgeConfig {
  readonly transport: EfficiencyJudgeSettings["transport"];
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKeyEnv: string;
  readonly timeoutMs: number;
  readonly maxStateChars: number;
}

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const OPENAI_DEFAULT_BASE_URL = "http://127.0.0.1:8317/v1";
const OPENAI_DEFAULT_MODEL = "glm-5.3-flash";
const OPENAI_DEFAULT_KEY_ENV = "COMMAND_CENTER_JUDGE_API_KEY";
/** Schema defaults carry the TypeSafe variants; swap them for the gateway
 * variants when the operator left them at the TypeSafe defaults. */
const TYPESAFE_DEFAULT_MODEL = "jev-latest";
const TYPESAFE_DEFAULT_KEY_ENV = "TYPESAFE_API_KEY";

/**
 * Applies transport-specific defaults. The stored settings carry the TypeSafe
 * model/key-env defaults; for `openai-compatible` we swap in the gateway
 * defaults unless the operator overrode them. Explicit values always win.
 */
export function resolveJudgeConfig(judge: EfficiencyJudgeSettings): ResolvedJudgeConfig {
  if (judge.transport === "openai-compatible") {
    return {
      transport: "openai-compatible",
      baseUrl: judge.baseUrl ?? OPENAI_DEFAULT_BASE_URL,
      model: judge.model === TYPESAFE_DEFAULT_MODEL ? OPENAI_DEFAULT_MODEL : judge.model,
      apiKeyEnv:
        judge.apiKeyEnv === TYPESAFE_DEFAULT_KEY_ENV ? OPENAI_DEFAULT_KEY_ENV : judge.apiKeyEnv,
      timeoutMs: judge.timeoutMs,
      maxStateChars: judge.maxStateChars,
    };
  }
  return {
    transport: judge.transport,
    baseUrl: TYPESAFE_URL,
    model: judge.model,
    apiKeyEnv: judge.apiKeyEnv,
    timeoutMs: judge.timeoutMs,
    maxStateChars: judge.maxStateChars,
  };
}

// ---------------------------------------------------------------------------
// Pure probability math (exported for tests)
// ---------------------------------------------------------------------------

/** Normalizes a raw distribution to sum to 1. A degenerate (all-zero/negative)
 * distribution becomes uniform, so downstream math never divides by zero. */
export function normalizeDistribution(raw: ReadonlyArray<number>): ReadonlyArray<number> {
  const clamped = raw.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  const total = clamped.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return raw.map(() => 1 / Math.max(1, raw.length));
  return clamped.map((value) => value / total);
}

/**
 * Confidence formula: `1 − normalized entropy`.
 *
 * For a normalized distribution `p` over `n` outcomes, Shannon entropy is
 * `H = −Σ pᵢ·ln(pᵢ)` (with the convention `0·ln0 = 0`). Dividing by `ln(n)`
 * scales it to `[0, 1]`. Confidence is the complement:
 *
 * - a one-hot distribution (`[1, 0, …]`) → entropy 0 → **confidence 1**;
 * - a uniform distribution (`[1/n, …]`) → entropy `ln(n)` → **confidence 0**.
 *
 * With `n ≤ 1` there is nothing to be uncertain about, so confidence is 1.
 */
export function confidenceFromDistribution(normalized: ReadonlyArray<number>): number {
  const n = normalized.length;
  if (n <= 1) return 1;
  let entropy = 0;
  for (const p of normalized) {
    if (p > 0) entropy -= p * Math.log(p);
  }
  const normalizedEntropy = entropy / Math.log(n);
  return Math.min(1, Math.max(0, 1 - normalizedEntropy));
}

/** Probability-weighted level index: `Σ i·pᵢ` over a normalized distribution. */
export function weightedScore(normalized: ReadonlyArray<number>): number {
  return normalized.reduce((sum, p, index) => sum + index * p, 0);
}

/** Index of the largest probability (first wins ties). */
export function argmaxIndex(normalized: ReadonlyArray<number>): number {
  let best = 0;
  for (let i = 1; i < normalized.length; i += 1) {
    if ((normalized[i] ?? 0) > (normalized[best] ?? 0)) best = i;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Boundary validation helpers (throw; wrapped into JudgeError by the caller)
// ---------------------------------------------------------------------------

class ResponseShapeError extends Error {}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ResponseShapeError(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ResponseShapeError(`${what} is not a finite number`);
  }
  return value;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function probabilityArray(value: unknown, expectedLength: number, what: string): number[] {
  if (!Array.isArray(value) || value.length !== expectedLength) {
    throw new ResponseShapeError(`${what} must be an array of length ${expectedLength}`);
  }
  return value.map((entry, index) => finiteNumber(entry, `${what}[${index}]`));
}

function recordToProbabilities(
  normalized: ReadonlyArray<number>,
  keys: ReadonlyArray<string>,
): Record<string, number> {
  const out: Record<string, number> = {};
  keys.forEach((key, index) => {
    out[key] = normalized[index] ?? 0;
  });
  return out;
}

/**
 * Builds validated answers from the `openai-compatible` payload. `choice`,
 * `score`, and `confidence` are computed here from the model's raw
 * probabilities. Throws {@link ResponseShapeError} on any missing key or
 * malformed shape.
 */
export function buildAnswersFromOpenAi(
  questions: Readonly<Record<string, JudgeQuestion>>,
  raw: unknown,
): Record<string, JudgeAnswer> {
  const root = asRecord(raw, "response");
  const answersRaw = asRecord(root.answers ?? root, "answers");
  const answers: Record<string, JudgeAnswer> = {};
  for (const [key, question] of Object.entries(questions)) {
    if (!(key in answersRaw)) throw new ResponseShapeError(`missing answer for '${key}'`);
    const entry = asRecord(answersRaw[key], `answers.${key}`);
    if (question.type === "noul") {
      answers[key] = {
        type: "noul",
        noul: clamp01(finiteNumber(entry.probability, `${key}.probability`)),
      };
    } else if (question.type === "choice") {
      const options = Object.keys(question.criteria);
      const probsRaw = asRecord(entry.probabilities, `${key}.probabilities`);
      const values = options.map((option) =>
        finiteNumber(probsRaw[option], `${key}.probabilities.${option}`),
      );
      const normalized = normalizeDistribution(values);
      answers[key] = {
        type: "choice",
        choice: options[argmaxIndex(normalized)]!,
        probabilities: recordToProbabilities(normalized, options),
        confidence: confidenceFromDistribution(normalized),
      };
    } else {
      const levels = question.criteria.length;
      const values = probabilityArray(entry.probabilities, levels, `${key}.probabilities`);
      const normalized = normalizeDistribution(values);
      answers[key] = {
        type: "score",
        score: weightedScore(normalized),
        probabilities: recordToProbabilities(
          normalized,
          question.criteria.map((_, index) => String(index)),
        ),
        confidence: confidenceFromDistribution(normalized),
      };
    }
  }
  return answers;
}

/**
 * Builds validated answers from the `typesafe` payload. TypeSafe already returns
 * typed answers with probabilities and confidence, so we validate and pass the
 * values through (dropping the score `legend`, which is not part of JudgeAnswer).
 */
export function buildAnswersFromTypesafe(
  questions: Readonly<Record<string, JudgeQuestion>>,
  raw: unknown,
): Record<string, JudgeAnswer> {
  const root = asRecord(raw, "response");
  const answers: Record<string, JudgeAnswer> = {};
  for (const [key, question] of Object.entries(questions)) {
    if (!(key in root)) throw new ResponseShapeError(`missing answer for '${key}'`);
    const entry = asRecord(root[key], key);
    if (entry.type !== question.type) {
      throw new ResponseShapeError(`answer '${key}' has type '${String(entry.type)}'`);
    }
    if (question.type === "noul") {
      answers[key] = { type: "noul", noul: clamp01(finiteNumber(entry.noul, `${key}.noul`)) };
    } else if (question.type === "choice") {
      const options = Object.keys(question.criteria);
      const probsRaw = asRecord(entry.probabilities, `${key}.probabilities`);
      const choice = typeof entry.choice === "string" ? entry.choice : undefined;
      if (choice === undefined || !options.includes(choice)) {
        throw new ResponseShapeError(`answer '${key}' choice is not one of the options`);
      }
      const probabilities: Record<string, number> = {};
      for (const option of options) {
        probabilities[option] = clamp01(
          finiteNumber(probsRaw[option], `${key}.probabilities.${option}`),
        );
      }
      answers[key] = {
        type: "choice",
        choice,
        probabilities,
        confidence: clamp01(finiteNumber(entry.confidence, `${key}.confidence`)),
      };
    } else {
      const probsRaw = asRecord(entry.probabilities, `${key}.probabilities`);
      const probabilities: Record<string, number> = {};
      question.criteria.forEach((_, index) => {
        probabilities[String(index)] = clamp01(
          finiteNumber(probsRaw[String(index)], `${key}.probabilities.${index}`),
        );
      });
      answers[key] = {
        type: "score",
        score: finiteNumber(entry.score, `${key}.score`),
        probabilities,
        confidence: clamp01(finiteNumber(entry.confidence, `${key}.confidence`)),
      };
    }
  }
  return answers;
}

// ---------------------------------------------------------------------------
// Transport / networking
// ---------------------------------------------------------------------------

const RETRYABLE_STATUSES = new Set([429, 529]);
const RETRY_BACKOFF = Duration.millis(1000);
/** Priced from LOCAL_RATE_OVERRIDES only; the LiteLLM table never carries the
 * judge models, so an empty base table is enough. */
const EMPTY_RATE_TABLE: RateTable = new Map();

interface RawHttpResult {
  readonly status: number;
  readonly bodyText: string;
}

const serializeState = (state: unknown): string =>
  typeof state === "string" ? state : JSON.stringify(state ?? null);

const httpPost = (
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Effect.Effect<RawHttpResult, JudgeError> =>
  Effect.tryPromise({
    try: async (outerSignal) => {
      const controller = new AbortController();
      let timedOut = false;
      const onAbort = () => controller.abort();
      outerSignal.addEventListener("abort", onAbort);
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
        const bodyText = await response.text();
        return { status: response.status, bodyText, timedOut: false };
      } catch (cause) {
        if (timedOut) return { status: 0, bodyText: "", timedOut: true };
        throw cause;
      } finally {
        clearTimeout(timer);
        outerSignal.removeEventListener("abort", onAbort);
      }
    },
    catch: (cause) => new JudgeError({ reason: "network", detail: "request failed", cause }),
  }).pipe(
    Effect.flatMap((result) =>
      result.timedOut
        ? Effect.fail(
            new JudgeError({ reason: "timeout", detail: `request exceeded ${timeoutMs}ms` }),
          )
        : RETRYABLE_STATUSES.has(result.status)
          ? Effect.fail(
              new JudgeError({
                reason: "rate-limited",
                detail: `status ${result.status}`,
                status: result.status,
              }),
            )
          : result.status < 200 || result.status >= 300
            ? Effect.fail(
                new JudgeError({
                  reason: "http",
                  detail: `status ${result.status}`,
                  status: result.status,
                }),
              )
            : Effect.succeed({ status: result.status, bodyText: result.bodyText }),
    ),
  );

const parseJson = (text: string, what: string): Effect.Effect<unknown, JudgeError> =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => new JudgeError({ reason: "invalid-response", detail: `${what} is not JSON` }),
  });

const buildAnswers = (
  transport: "typesafe" | "openai-compatible",
  questions: Readonly<Record<string, JudgeQuestion>>,
  payload: unknown,
): Effect.Effect<Record<string, JudgeAnswer>, JudgeError> =>
  Effect.try({
    try: () =>
      transport === "typesafe"
        ? buildAnswersFromTypesafe(questions, payload)
        : buildAnswersFromOpenAi(questions, payload),
    catch: (cause) =>
      new JudgeError({
        reason: "invalid-response",
        detail: cause instanceof Error ? cause.message : "malformed answers",
        cause,
      }),
  });

interface RequestOutcome {
  readonly answers: Record<string, JudgeAnswer>;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

const authHeaders = (apiKeyEnv: string): Record<string, string> => {
  const key = process.env[apiKeyEnv];
  const headers: Record<string, string> = { "content-type": "application/json" };
  // Reference the key by env-var name only; never log the value.
  if (key !== undefined && key.length > 0) headers.authorization = `Bearer ${key}`;
  return headers;
};

const openAiSchema = (questions: Readonly<Record<string, JudgeQuestion>>): unknown => {
  const properties: Record<string, unknown> = {};
  for (const [key, question] of Object.entries(questions)) {
    if (question.type === "noul") {
      properties[key] = {
        type: "object",
        additionalProperties: false,
        required: ["probability"],
        properties: { probability: { type: "number", minimum: 0, maximum: 1 } },
      };
    } else if (question.type === "choice") {
      const options = Object.keys(question.criteria);
      properties[key] = {
        type: "object",
        additionalProperties: false,
        required: ["probabilities"],
        properties: {
          probabilities: {
            type: "object",
            additionalProperties: false,
            required: options,
            properties: Object.fromEntries(
              options.map((option) => [option, { type: "number", minimum: 0, maximum: 1 }]),
            ),
          },
        },
      };
    } else {
      properties[key] = {
        type: "object",
        additionalProperties: false,
        required: ["probabilities"],
        properties: {
          probabilities: {
            type: "array",
            minItems: question.criteria.length,
            maxItems: question.criteria.length,
            items: { type: "number", minimum: 0, maximum: 1 },
          },
        },
      };
    }
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["answers"],
    properties: {
      answers: {
        type: "object",
        additionalProperties: false,
        required: Object.keys(questions),
        properties,
      },
    },
  };
};

const OPENAI_SYSTEM_PROMPT =
  "You are a calibrated judge. For each question, return probabilities only — never a final choice, score, or confidence. " +
  "Probabilities must be your honest belief and, for choice/score questions, should sum to 1 across the options. " +
  "Respond strictly in the provided JSON schema.";

const openAiUserPrompt = (
  stateString: string,
  questions: Readonly<Record<string, JudgeQuestion>>,
): string => {
  const rendered = Object.entries(questions).map(([key, question]) => {
    if (question.type === "noul") {
      return `- ${key} (noul, probability the statement is true): ${question.instructions}`;
    }
    if (question.type === "choice") {
      const options = Object.entries(question.criteria)
        .map(([option, desc]) => `    * ${option}: ${desc}`)
        .join("\n");
      return `- ${key} (choice, probability per option):\n  ${question.instructions}\n${options}`;
    }
    const levels = question.criteria
      .map((desc, index) => `    * level ${index}: ${desc}`)
      .join("\n");
    return `- ${key} (score, probability per level 0..${question.criteria.length - 1}):\n  ${question.instructions}\n${levels}`;
  });
  return `STATE:\n${stateString}\n\nQUESTIONS:\n${rendered.join("\n")}`;
};

const extractOpenAiContent = (payload: unknown): Effect.Effect<string, JudgeError> =>
  Effect.try({
    try: () => {
      const root = asRecord(payload, "response");
      const choices = root.choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        throw new ResponseShapeError("no choices in response");
      }
      const message = asRecord(asRecord(choices[0], "choices[0]").message, "message");
      if (typeof message.content !== "string") {
        throw new ResponseShapeError("message.content is not a string");
      }
      return message.content;
    },
    catch: (cause) =>
      new JudgeError({
        reason: "invalid-response",
        detail: cause instanceof Error ? cause.message : "malformed response",
        cause,
      }),
  });

const nonNegativeInt = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;

const extractUsage = (
  payload: unknown,
  transport: "typesafe" | "openai-compatible",
): { readonly inputTokens: number; readonly outputTokens: number } => {
  const usage =
    typeof payload === "object" && payload !== null
      ? ((payload as Record<string, unknown>).usage as Record<string, unknown> | undefined)
      : undefined;
  if (usage === undefined) return { inputTokens: 0, outputTokens: 0 };
  return transport === "typesafe"
    ? {
        inputTokens: nonNegativeInt(usage.input_tokens),
        outputTokens: nonNegativeInt(usage.output_tokens),
      }
    : {
        inputTokens: nonNegativeInt(usage.prompt_tokens),
        outputTokens: nonNegativeInt(usage.completion_tokens),
      };
};

const runRequestOnce = (
  config: ResolvedJudgeConfig,
  fetchImpl: typeof fetch,
  request: JudgeRequest,
  stateString: string,
): Effect.Effect<RequestOutcome, JudgeError> => {
  const timeoutMs = request.timeoutMs ?? config.timeoutMs;
  if (config.transport === "typesafe") {
    const body = JSON.stringify({
      model: config.model,
      state: request.state,
      questions: request.questions,
    });
    return httpPost(fetchImpl, TYPESAFE_URL, authHeaders(config.apiKeyEnv), body, timeoutMs).pipe(
      Effect.flatMap(({ bodyText }) => parseJson(bodyText, "typesafe response")),
      Effect.flatMap((payload) =>
        buildAnswers("typesafe", request.questions, payload).pipe(
          Effect.map((answers) => ({ answers, usage: extractUsage(payload, "typesafe") })),
        ),
      ),
    );
  }
  const body = JSON.stringify({
    model: config.model,
    temperature: 0,
    messages: [
      { role: "system", content: OPENAI_SYSTEM_PROMPT },
      { role: "user", content: openAiUserPrompt(stateString, request.questions) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "judge_answers", strict: true, schema: openAiSchema(request.questions) },
    },
  });
  return httpPost(
    fetchImpl,
    `${config.baseUrl}/chat/completions`,
    authHeaders(config.apiKeyEnv),
    body,
    timeoutMs,
  ).pipe(
    Effect.flatMap(({ bodyText }) => parseJson(bodyText, "response")),
    Effect.flatMap((payload) =>
      extractOpenAiContent(payload).pipe(
        Effect.flatMap((content) => parseJson(content, "answers content")),
        Effect.flatMap((answersRaw) =>
          buildAnswers("openai-compatible", request.questions, answersRaw),
        ),
        Effect.map((answers) => ({ answers, usage: extractUsage(payload, "openai-compatible") })),
      ),
    ),
  );
};

/** One request plus a single backoff retry on 429/529. */
const runRequestWithRetry = (
  config: ResolvedJudgeConfig,
  fetchImpl: typeof fetch,
  request: JudgeRequest,
  stateString: string,
): Effect.Effect<RequestOutcome, JudgeError> => {
  const once = runRequestOnce(config, fetchImpl, request, stateString);
  return once.pipe(
    Effect.catch((error) =>
      error.reason === "rate-limited"
        ? Effect.sleep(RETRY_BACKOFF).pipe(Effect.andThen(once))
        : Effect.fail(error),
    ),
  );
};

// ---------------------------------------------------------------------------
// Usage + decision-log side effects (injectable so tests need no DB/FS)
// ---------------------------------------------------------------------------

export interface JudgeSideEffects {
  readonly recordUsage: (row: {
    readonly operation: string;
    readonly model: string;
    readonly durationMs: number;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly costMicroUsd: number | null;
    readonly status: "success" | "error";
    readonly completedAt: string;
  }) => Effect.Effect<void>;
  readonly appendDecision: (line: string) => Effect.Effect<void>;
}

const NO_SIDE_EFFECTS: JudgeSideEffects = {
  recordUsage: () => Effect.void,
  appendDecision: () => Effect.void,
};

const costMicroUsd = (
  model: string,
  usage: { readonly inputTokens: number; readonly outputTokens: number },
): number | null => {
  const rate = lookupRate(EMPTY_RATE_TABLE, model);
  if (rate === null) return null;
  const usd =
    usage.inputTokens * rate.inputCostPerToken + usage.outputTokens * rate.outputCostPerToken;
  return Math.max(0, Math.round(usd * 1_000_000));
};

const decisionLine = (input: {
  readonly completedAt: string;
  readonly operation: string;
  readonly model: string;
  readonly transport: string;
  readonly latencyMs: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly questionKeys: ReadonlyArray<string>;
  readonly answers?: Readonly<Record<string, JudgeAnswer>>;
  readonly error?: { readonly reason: string; readonly detail: string };
  readonly meta?: JudgeMeta;
}): string =>
  `${JSON.stringify({
    ts: input.completedAt,
    operation: input.operation,
    model: input.model,
    transport: input.transport,
    latencyMs: input.latencyMs,
    usage: input.usage,
    questionKeys: input.questionKeys,
    ...(input.answers === undefined ? {} : { answers: input.answers }),
    ...(input.error === undefined ? {} : { error: input.error }),
    ...(input.meta === undefined ? {} : { meta: input.meta }),
  })}\n`;

// ---------------------------------------------------------------------------
// Service construction
// ---------------------------------------------------------------------------

export interface JudgeDeps {
  readonly fetchImpl: typeof fetch;
  readonly sideEffects: JudgeSideEffects;
}

/**
 * Builds the service value. `getConfig` is a thunk so the live layer can serve
 * the current settings (transport changes at runtime) while tests pass a fixed
 * config.
 */
export const makeJudge = (getConfig: () => ResolvedJudgeConfig, deps: JudgeDeps): JudgeShape => {
  const ask = (request: JudgeRequest, meta?: JudgeMeta): Effect.Effect<JudgeResult, JudgeError> =>
    Effect.gen(function* () {
      const config = getConfig();
      const operation = `judge.${request.operation}`;
      if (config.transport === "off") {
        return yield* new JudgeError({ reason: "disabled", detail: "Judge transport is off" });
      }
      const stateString = serializeState(request.state);
      if (stateString.length > config.maxStateChars) {
        return yield* new JudgeError({
          reason: "state-too-large",
          detail: `state is ${stateString.length} chars (max ${config.maxStateChars})`,
        });
      }
      const startedAt = yield* DateTime.now;
      const questionKeys = Object.keys(request.questions);
      const elapsed = DateTime.now.pipe(
        Effect.map((completedAt) => ({
          latencyMs: Math.max(0, completedAt.epochMilliseconds - startedAt.epochMilliseconds),
          completedIso: DateTime.formatIso(completedAt),
        })),
      );

      return yield* runRequestWithRetry(config, deps.fetchImpl, request, stateString).pipe(
        Effect.matchEffect({
          onSuccess: ({ answers, usage }) =>
            Effect.gen(function* () {
              const { latencyMs, completedIso } = yield* elapsed;
              yield* deps.sideEffects
                .recordUsage({
                  operation,
                  model: config.model,
                  durationMs: latencyMs,
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  costMicroUsd: costMicroUsd(config.model, usage),
                  status: "success",
                  completedAt: completedIso,
                })
                .pipe(Effect.ignore);
              yield* deps.sideEffects
                .appendDecision(
                  decisionLine({
                    completedAt: completedIso,
                    operation,
                    model: config.model,
                    transport: config.transport,
                    latencyMs,
                    usage,
                    questionKeys,
                    answers,
                    ...(meta === undefined ? {} : { meta }),
                  }),
                )
                .pipe(Effect.ignore);
              return { answers, model: config.model, usage, latencyMs } satisfies JudgeResult;
            }),
          onFailure: (error) =>
            Effect.gen(function* () {
              const { latencyMs, completedIso } = yield* elapsed;
              yield* deps.sideEffects
                .recordUsage({
                  operation,
                  model: config.model,
                  durationMs: latencyMs,
                  inputTokens: null,
                  outputTokens: null,
                  costMicroUsd: null,
                  status: "error",
                  completedAt: completedIso,
                })
                .pipe(Effect.ignore);
              yield* deps.sideEffects
                .appendDecision(
                  decisionLine({
                    completedAt: completedIso,
                    operation,
                    model: config.model,
                    transport: config.transport,
                    latencyMs,
                    usage: null,
                    questionKeys,
                    error: { reason: error.reason, detail: error.detail },
                    ...(meta === undefined ? {} : { meta }),
                  }),
                )
                .pipe(Effect.ignore);
              return yield* error;
            }),
        }),
      );
    });

  return {
    get enabled() {
      return getConfig().transport !== "off";
    },
    ask,
  };
};

/** For tests: a service that never touches a DB or the filesystem. */
export const makeTestJudge = (config: ResolvedJudgeConfig, fetchImpl: typeof fetch): JudgeShape =>
  makeJudge(() => config, { fetchImpl, sideEffects: NO_SIDE_EFFECTS });

const MAX_DECISION_LOG_BYTES = FileSystem.MiB(20);

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const sql = yield* SqlClient.SqlClient;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const initial = yield* settingsService.getSettings;
  const holder = { config: resolveJudgeConfig(initial.efficiency.judge) };
  // Keep `enabled` and the transport config live without a per-call settings
  // read. The fiber dies with the layer scope.
  yield* settingsService.streamChanges.pipe(
    Stream.runForEach((settings) =>
      Effect.sync(() => {
        holder.config = resolveJudgeConfig(settings.efficiency.judge);
      }),
    ),
    // Swallow inside the fiber so a settings-stream fault leaves `enabled`
    // pinned at its last value rather than killing the forked fiber.
    Effect.catchCause(() => Effect.void),
    Effect.forkScoped,
  );

  const decisionLogDir = path.join(serverConfig.stateDir, "efficiency");
  const decisionLogPath = path.join(decisionLogDir, "judge-decisions.jsonl");

  const sideEffects: JudgeSideEffects = {
    recordUsage: (row) =>
      sql`
        INSERT INTO internal_generation_usage (
          operation_id, operation, provider_instance_id, model, options_json,
          duration_ms, input_tokens, output_tokens, cost_micro_usd, status, completed_at
        ) VALUES (
          ${`judge-${globalThis.crypto.randomUUID()}`}, ${row.operation}, ${"judge"}, ${row.model}, ${null},
          ${row.durationMs}, ${row.inputTokens}, ${row.outputTokens}, ${row.costMicroUsd},
          ${row.status}, ${row.completedAt}
        )
        ON CONFLICT (operation_id) DO NOTHING
      `.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to record judge usage", { operation: row.operation, cause }),
        ),
      ),
    appendDecision: (line) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(decisionLogDir, { recursive: true });
        const stats = yield* fs.stat(decisionLogPath).pipe(Effect.option);
        if (stats._tag === "Some" && stats.value.size >= MAX_DECISION_LOG_BYTES) {
          yield* fs.rename(decisionLogPath, `${decisionLogPath}.1`);
        }
        yield* fs.writeFileString(decisionLogPath, line, { flag: "a" });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to append judge decision log", { cause }),
        ),
      ),
  };

  return Judge.of(makeJudge(() => holder.config, { fetchImpl: globalThis.fetch, sideEffects }));
});

export const layer = Layer.effect(Judge, make);

/**
 * A disabled Judge with no external requirements, for test harnesses that
 * compose the orchestration/route layers directly and do not exercise the judge.
 * `ask` always fails with `disabled`, matching the `off` transport.
 */
export const layerTest: Layer.Layer<Judge> = Layer.succeed(
  Judge,
  Judge.of({
    enabled: false,
    ask: () =>
      Effect.fail(new JudgeError({ reason: "disabled", detail: "Judge is disabled (test layer)" })),
  }),
);
