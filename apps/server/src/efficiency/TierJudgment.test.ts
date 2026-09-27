import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type EfficiencyDecision } from "@t3tools/contracts";

import {
  TASK_KIND_CRITERIA,
  TIER_JUDGMENT_MESSAGE_CHARS,
  buildTierJudgmentRequest,
  findRouteContext,
  tierJudgmentFromAnswers,
} from "./TierJudgment.ts";

const baseState = {
  message: "commit and push",
  attachmentCount: 0,
  interactionMode: "default" as const,
  priorTurnCount: 3,
};

describe("buildTierJudgmentRequest", () => {
  it("asks complexity, task_kind, and continuation in one request", () => {
    const request = buildTierJudgmentRequest(baseState);
    expect(Object.keys(request.questions)).toEqual([
      "complexity",
      "needs_investigation",
      "task_kind",
      "continuation",
    ]);
    const taskKind = request.questions.task_kind;
    expect(taskKind?.type).toBe("choice");
    expect(taskKind?.type === "choice" ? Object.keys(taskKind.criteria) : []).toEqual([
      "review",
      "debug",
      "implement",
      "refactor",
      "design",
      "question",
      "docs",
      "ops",
      "research",
      "creative",
      "other",
    ]);
    expect(taskKind?.type === "choice" ? taskKind.criteria : {}).toBe(TASK_KIND_CRITERIA);
    const continuation = request.questions.continuation;
    expect(continuation?.type).toBe("noul");
    expect(continuation?.instructions).toContain("continues the task already under way");
  });

  it("includes the thread title and the route's task message, truncated", () => {
    const request = buildTierJudgmentRequest({
      ...baseState,
      threadTitle: "Fix flaky login test",
      taskMessage: "x".repeat(TIER_JUDGMENT_MESSAGE_CHARS + 50),
    });
    const state = request.state as Record<string, unknown>;
    expect(state.threadTitle).toBe("Fix flaky login test");
    expect(state.taskMessage).toBe("x".repeat(TIER_JUDGMENT_MESSAGE_CHARS));
    expect(state.message).toBe("commit and push");
  });

  it("omits the thread context when it is not known", () => {
    const state = buildTierJudgmentRequest(baseState).state as Record<string, unknown>;
    expect("threadTitle" in state).toBe(false);
    expect("taskMessage" in state).toBe(false);
  });
});

describe("tierJudgmentFromAnswers", () => {
  const complexity = {
    type: "score" as const,
    score: 1.2,
    probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 },
    confidence: 0.7,
  };

  it("maps kind and continuation alongside complexity", () => {
    expect(
      tierJudgmentFromAnswers(
        {
          complexity,
          task_kind: {
            type: "choice",
            choice: "review",
            probabilities: { review: 0.9 },
            confidence: 0.8,
          },
          continuation: { type: "noul", noul: 0.75 },
        },
        "jev-latest",
      ),
    ).toEqual({
      score: 1.2,
      confidence: 0.7,
      model: "jev-latest",
      kind: "review",
      kindConfidence: 0.8,
      continuation: 0.75,
    });
  });

  it("omits kind and continuation when they are missing or malformed", () => {
    expect(
      tierJudgmentFromAnswers(
        {
          complexity,
          task_kind: { type: "choice", choice: "gardening", probabilities: {}, confidence: 1 },
          continuation: complexity,
        },
        "jev-latest",
      ),
    ).toEqual({ score: 1.2, confidence: 0.7, model: "jev-latest" });
  });
});

describe("findRouteContext", () => {
  const decision = (sticky: boolean): EfficiencyDecision => ({
    tier: "balanced",
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5-5",
    },
    source: "tier-policy",
    workload: "interactive",
    contextThresholdPercent: 80,
    toolWarningThreshold: 12,
    judgment: {
      score: 1,
      confidence: 0.9,
      tier: "balanced",
      applied: true,
      model: "jev-latest",
      ...(sticky ? { sticky: true } : {}),
    },
  });
  const turn = (turnId: string, minute: number, efficiencyDecision: EfficiencyDecision | null) => ({
    turnId,
    pendingMessageId: `message-${turnId}`,
    requestedAt: `2026-09-27T10:0${minute}:00.000Z`,
    requestSequence: minute,
    efficiencyDecision,
  });

  it("returns the latest decision and the message that started the route", () => {
    const turns = [
      turn("t3", 3, decision(true)),
      turn("t1", 1, decision(false)),
      turn("t2", 2, decision(true)),
      turn("t0", 0, decision(false)),
    ];
    const context = findRouteContext(turns, "t3");
    expect(context.priorDecision).toBe(turns[0]!.efficiencyDecision);
    expect(context.taskMessageId).toBe("message-t1");
  });

  it("returns nothing when the latest turn was not routed", () => {
    expect(findRouteContext([turn("t1", 1, decision(false)), turn("t2", 2, null)], "t2")).toEqual(
      {},
    );
  });
});
