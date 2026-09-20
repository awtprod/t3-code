import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  argmaxIndex,
  buildAnswersFromOpenAi,
  buildAnswersFromTypesafe,
  confidenceFromDistribution,
  JudgeError,
  makeTestJudge,
  normalizeDistribution,
  resolveJudgeConfig,
  weightedScore,
  type JudgeAnswer,
  type JudgeQuestion,
  type ResolvedJudgeConfig,
} from "./Judge.ts";

const asScore = (answer: JudgeAnswer | undefined) => {
  expect(answer?.type).toBe("score");
  return answer as Extract<JudgeAnswer, { type: "score" }>;
};
const asChoice = (answer: JudgeAnswer | undefined) => {
  expect(answer?.type).toBe("choice");
  return answer as Extract<JudgeAnswer, { type: "choice" }>;
};
const asNoul = (answer: JudgeAnswer | undefined) => {
  expect(answer?.type).toBe("noul");
  return answer as Extract<JudgeAnswer, { type: "noul" }>;
};

const scoreQuestion: JudgeQuestion = {
  type: "score",
  instructions: "rate",
  criteria: ["low", "mid", "high"],
};
const choiceQuestion: JudgeQuestion = {
  type: "choice",
  instructions: "pick",
  criteria: { a: "first", b: "second" },
};
const noulQuestion: JudgeQuestion = { type: "noul", instructions: "true?" };

const jsonResponse = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

const openAiChat = (answers: unknown, usage?: unknown): unknown => ({
  choices: [{ message: { content: JSON.stringify({ answers }) } }],
  ...(usage === undefined ? {} : { usage }),
});

const config = (over: Partial<ResolvedJudgeConfig> = {}): ResolvedJudgeConfig => ({
  transport: "openai-compatible",
  baseUrl: "http://127.0.0.1:8317/v1",
  model: "glm-5.3-flash",
  apiKeyEnv: "COMMAND_CENTER_JUDGE_API_KEY_TEST_UNSET",
  timeoutMs: 15000,
  maxStateChars: 120000,
  ...over,
});

describe("Judge probability math", () => {
  it("confidence is 1 for a one-hot distribution and 0 for a uniform one", () => {
    expect(confidenceFromDistribution([1, 0, 0])).toBe(1);
    expect(confidenceFromDistribution([0.5, 0.5])).toBeCloseTo(0, 10);
    expect(confidenceFromDistribution([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(0, 10);
    // A single outcome carries no uncertainty.
    expect(confidenceFromDistribution([1])).toBe(1);
  });

  it("confidence sits between 0 and 1 for a skewed distribution", () => {
    const c = confidenceFromDistribution([0.7, 0.2, 0.1]);
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(1);
  });

  it("weightedScore is the probability-weighted level index", () => {
    expect(weightedScore([0.2, 0.3, 0.5])).toBeCloseTo(1.3, 10);
    expect(weightedScore([1, 0, 0])).toBe(0);
    expect(weightedScore([0, 0, 1])).toBe(2);
  });

  it("normalizeDistribution sums to 1 and falls back to uniform on a degenerate input", () => {
    const n = normalizeDistribution([2, 2, 4]);
    expect(n.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(n).toEqual([0.25, 0.25, 0.5]);
    expect(normalizeDistribution([0, 0])).toEqual([0.5, 0.5]);
  });

  it("argmaxIndex returns the first maximal index", () => {
    expect(argmaxIndex([0.1, 0.6, 0.3])).toBe(1);
    expect(argmaxIndex([0.5, 0.5])).toBe(0);
  });
});

describe("Judge OpenAI answer building (computed in code)", () => {
  it("computes score, choice, and noul from raw probabilities", () => {
    const answers = buildAnswersFromOpenAi(
      { complexity: scoreQuestion, which: choiceQuestion, flag: noulQuestion },
      {
        answers: {
          complexity: { probabilities: [0.2, 0.3, 0.5] },
          which: { probabilities: { a: 0.25, b: 0.75 } },
          flag: { probability: 1.4 },
        },
      },
    );
    expect(asScore(answers.complexity).score).toBeCloseTo(1.3, 10);
    expect(asChoice(answers.which).choice).toBe("b");
    // noul is clamped into [0, 1].
    expect(asNoul(answers.flag).noul).toBe(1);
  });

  it("throws on a missing answer key", () => {
    expect(() => buildAnswersFromOpenAi({ complexity: scoreQuestion }, { answers: {} })).toThrow();
  });

  it("throws when a score distribution has the wrong length", () => {
    expect(() =>
      buildAnswersFromOpenAi(
        { complexity: scoreQuestion },
        { answers: { complexity: { probabilities: [0.5, 0.5] } } },
      ),
    ).toThrow();
  });
});

describe("Judge TypeSafe answer building (passthrough, validated)", () => {
  it("passes through typed answers and drops the score legend", () => {
    const answers = buildAnswersFromTypesafe(
      { complexity: scoreQuestion, which: choiceQuestion },
      {
        complexity: {
          type: "score",
          score: 1.7,
          legend: ["low", "mid", "high"],
          probabilities: { "0": 0.1, "1": 0.1, "2": 0.8 },
          confidence: 0.6,
        },
        which: {
          type: "choice",
          choice: "a",
          probabilities: { a: 0.9, b: 0.1 },
          confidence: 0.8,
        },
      },
    );
    const complexity = asScore(answers.complexity);
    expect(complexity.score).toBe(1.7);
    expect("legend" in complexity).toBe(false);
  });

  it("throws when the answer type does not match the question", () => {
    expect(() =>
      buildAnswersFromTypesafe(
        { complexity: scoreQuestion },
        { complexity: { type: "noul", noul: 0.5 } },
      ),
    ).toThrow();
  });
});

describe("Judge config resolution", () => {
  it("keeps TypeSafe defaults for the typesafe transport", () => {
    const resolved = resolveJudgeConfig({
      transport: "typesafe",
      model: "jev-latest",
      apiKeyEnv: "TYPESAFE_API_KEY",
      timeoutMs: 15000,
      maxStateChars: 120000,
    });
    expect(resolved.model).toBe("jev-latest");
    expect(resolved.apiKeyEnv).toBe("TYPESAFE_API_KEY");
  });

  it("swaps in gateway defaults for openai-compatible when left untouched", () => {
    const resolved = resolveJudgeConfig({
      transport: "openai-compatible",
      model: "jev-latest",
      apiKeyEnv: "TYPESAFE_API_KEY",
      timeoutMs: 15000,
      maxStateChars: 120000,
    });
    expect(resolved.baseUrl).toBe("http://127.0.0.1:8317/v1");
    expect(resolved.model).toBe("glm-5.3-flash");
    expect(resolved.apiKeyEnv).toBe("COMMAND_CENTER_JUDGE_API_KEY");
  });
});

describe("Judge.ask", () => {
  it.effect("resolves computed answers and usage over the openai-compatible transport", () =>
    Effect.gen(function* () {
      const judge = makeTestJudge(
        config(),
        jsonResponse(
          openAiChat(
            { complexity: { probabilities: [0.1, 0.2, 0.7] } },
            { prompt_tokens: 123, completion_tokens: 4 },
          ),
        ),
      );
      const result = yield* judge.ask({
        operation: "tier-judgment",
        state: { message: "add a feature" },
        questions: { complexity: scoreQuestion },
      });
      expect(asScore(result.answers.complexity).score).toBeCloseTo(1.6, 10);
      expect(result.usage).toEqual({ inputTokens: 123, outputTokens: 4 });
      expect(result.model).toBe("glm-5.3-flash");
    }),
  );

  it.effect("fails with 'disabled' when the transport is off", () =>
    Effect.gen(function* () {
      const judge = makeTestJudge(config({ transport: "off" }), jsonResponse({}));
      const error = yield* Effect.flip(judge.ask({ operation: "x", state: "", questions: {} }));
      expect(error).toBeInstanceOf(JudgeError);
      expect(error.reason).toBe("disabled");
    }),
  );

  it.effect("refuses oversized state instead of truncating", () =>
    Effect.gen(function* () {
      const judge = makeTestJudge(config({ maxStateChars: 10 }), jsonResponse({}));
      const error = yield* Effect.flip(
        judge.ask({
          operation: "x",
          state: "0123456789ABCDEF",
          questions: { complexity: scoreQuestion },
        }),
      );
      expect(error.reason).toBe("state-too-large");
    }),
  );

  it.effect("fails with 'invalid-response' on a malformed body", () =>
    Effect.gen(function* () {
      const judge = makeTestJudge(
        config(),
        jsonResponse(openAiChat({ complexity: { nope: true } })),
      );
      const error = yield* Effect.flip(
        judge.ask({
          operation: "x",
          state: "",
          questions: { complexity: scoreQuestion },
        }),
      );
      expect(error.reason).toBe("invalid-response");
    }),
  );

  it.effect("maps a non-retryable HTTP status to an 'http' error", () =>
    Effect.gen(function* () {
      const judge = makeTestJudge(config(), jsonResponse({ error: "bad" }, 400));
      const error = yield* Effect.flip(
        judge.ask({ operation: "x", state: "", questions: { complexity: scoreQuestion } }),
      );
      expect(error.reason).toBe("http");
      expect(error.status).toBe(400);
    }),
  );

  // Uses the live clock: the retry path sleeps for a real backoff between the
  // 429 and the successful retry, which a TestClock would never advance.
  it.live("retries once on 429 and then succeeds", () =>
    Effect.gen(function* () {
      let calls = 0;
      const fetchImpl = (async () => {
        calls += 1;
        return calls === 1
          ? new Response("rate limited", { status: 429 })
          : new Response(JSON.stringify(openAiChat({ complexity: { probabilities: [1, 0, 0] } })), {
              status: 200,
            });
      }) as unknown as typeof fetch;
      const judge = makeTestJudge(config(), fetchImpl);
      const result = yield* judge.ask({
        operation: "x",
        state: "",
        questions: { complexity: scoreQuestion },
      });
      expect(calls).toBe(2);
      expect(asScore(result.answers.complexity).score).toBe(0);
    }),
  );
});
