import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EfficiencyCandidateId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type EfficiencyDecision,
  type EfficiencySettings,
  type ModelSelection,
  type OrchestrationCommand,
  type ServerProvider,
  type TaskKind,
} from "@t3tools/contracts";

import {
  fromCommandCenterSelection,
  interactiveTurnMatchesRule,
  resolveInteractiveEfficiency,
  toCommandCenterSelection,
} from "./EfficiencyRouting.ts";

const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.6-sol",
  options: [{ id: "reasoningEffort", value: "high" }],
};

const command = {
  type: "thread.turn.start",
  commandId: CommandId.make("command"),
  threadId: ThreadId.make("thread"),
  message: { messageId: MessageId.make("message"), role: "user", text: "hello", attachments: [] },
  modelSelection,
  routingMode: "auto",
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "2026-08-03T00:00:00.000Z",
} satisfies Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

const codex = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-03T00:00:00.000Z",
  models: [
    {
      slug: "gpt-6-terra",
      name: "Terra",
      isCustom: false,
      capabilities: null,
    },
    {
      slug: "gpt-6-sol",
      name: "Sol",
      isCustom: false,
      capabilities: null,
    },
    {
      slug: "gpt-5.6-sol",
      name: "Sol 5.6",
      isCustom: false,
      capabilities: null,
    },
    {
      slug: "gpt-6-astra",
      name: "Astra",
      isCustom: false,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
} satisfies ServerProvider;

const claude = {
  ...codex,
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  models: [
    { slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false, capabilities: null },
    { slug: "claude-opus-4-8", name: "Claude Opus 4.8", isCustom: false, capabilities: null },
  ],
} satisfies ServerProvider;

const providers = [codex, claude];

const opus55 = (effort: string) => ({
  instanceId: "claudeAgent",
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: effort }],
});

describe("interactive efficiency routing", () => {
  it("round-trips provider and model identity without claiming to preserve options", () => {
    expect(fromCommandCenterSelection(toCommandCenterSelection(modelSelection))).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-sol",
    });
  });

  it("selects a known economy candidate deterministically and reattaches its options", () => {
    const input = {
      command,
      settings: { ...DEFAULT_SERVER_SETTINGS.efficiency, enabled: true },
      providers,
    };
    const first = resolveInteractiveEfficiency(input);
    const second = resolveInteractiveEfficiency(input);

    expect(first).toEqual(second);
    expect(first.command.modelSelection).toEqual(opus55("low"));
    expect(first.decision?.source).toBe("tier-policy");
  });

  it("leaves manual commands byte-for-byte unchanged", () => {
    const manual = { ...command, routingMode: "manual" as const };
    expect(
      resolveInteractiveEfficiency({
        command: manual,
        settings: { ...DEFAULT_SERVER_SETTINGS.efficiency, enabled: true },
        providers,
      }).command,
    ).toBe(manual);
  });

  it("uses the concrete compatibility selection when no known tier candidate is available", () => {
    const result = resolveInteractiveEfficiency({
      command,
      settings: {
        ...DEFAULT_SERVER_SETTINGS.efficiency,
        enabled: true,
        candidates: [],
      },
      providers,
    });
    expect(result.command.modelSelection).toEqual(modelSelection);
    expect(result.decision?.source).toBe("fallback");
    expect(result.decision?.fallbackReason).toContain("No enabled economy candidate");
  });

  it("applies a matching metadata rule ahead of the client fallback tier", () => {
    const result = resolveInteractiveEfficiency({
      command: { ...command, efficiencyTier: "economy" },
      projectIdOverride: ProjectId.make("project-routed"),
      settings: {
        ...DEFAULT_SERVER_SETTINGS.efficiency,
        enabled: true,
        rules: [
          {
            id: "quality-for-project",
            projectId: ProjectId.make("project-routed"),
            tier: "quality",
          },
        ],
      },
      providers,
    });

    expect(result.command.modelSelection).toEqual(opus55("high"));
    expect(result.decision?.tier).toBe("quality");
    expect(result.decision?.matchedRuleId).toBe("quality-for-project");
  });
});

describe("confidence-gated tier judgment", () => {
  const enabledSettings = {
    ...DEFAULT_SERVER_SETTINGS.efficiency,
    enabled: true,
    tierJudgment: { enabled: true, minConfidence: 0.6, continuationThreshold: 0.5 },
  };

  it("applies the judged tier when confidence clears the threshold", () => {
    const result = resolveInteractiveEfficiency({
      command,
      settings: enabledSettings,
      providers,
      tierJudgment: { score: 2, confidence: 0.9, model: "glm-5.3-flash" },
    });
    expect(result.command.modelSelection).toEqual(opus55("high"));
    expect(result.decision?.tier).toBe("quality");
    expect(result.decision?.judgment).toEqual({
      score: 2,
      confidence: 0.9,
      tier: "quality",
      applied: true,
      model: "glm-5.3-flash",
    });
  });

  it("records but does not apply a low-confidence judgment", () => {
    const result = resolveInteractiveEfficiency({
      command,
      settings: enabledSettings,
      providers,
      tierJudgment: { score: 2, confidence: 0.3, model: "glm-5.3-flash" },
    });
    // Falls back to today's tier (default economy).
    expect(result.decision?.tier).toBe("economy");
    expect(result.decision?.judgment?.applied).toBe(false);
    expect(result.decision?.judgment?.reason).toContain("confidence");
  });

  it("does not apply a judgment when tier judgment is disabled", () => {
    const result = resolveInteractiveEfficiency({
      command,
      settings: { ...DEFAULT_SERVER_SETTINGS.efficiency, enabled: true },
      providers,
      tierJudgment: { score: 2, confidence: 0.99, model: "glm-5.3-flash" },
    });
    expect(result.decision?.tier).toBe("economy");
    expect(result.decision?.judgment?.applied).toBe(false);
    expect(result.decision?.judgment?.reason).toBe("tier judgment disabled");
  });

  it("keeps rules ahead of a confident judgment", () => {
    const result = resolveInteractiveEfficiency({
      command,
      projectIdOverride: ProjectId.make("project-routed"),
      settings: {
        ...enabledSettings,
        rules: [
          {
            id: "economy-for-project",
            projectId: ProjectId.make("project-routed"),
            tier: "economy",
          },
        ],
      },
      providers,
      tierJudgment: { score: 2, confidence: 0.99, model: "glm-5.3-flash" },
    });
    expect(result.decision?.tier).toBe("economy");
    expect(result.decision?.matchedRuleId).toBe("economy-for-project");
    expect(result.decision?.judgment?.applied).toBe(false);
    expect(result.decision?.judgment?.reason).toContain("rule");
  });

  it("leaves output identical to today when no judgment is supplied", () => {
    const withoutJudgment = resolveInteractiveEfficiency({
      command,
      settings: enabledSettings,
      providers,
    });
    expect(withoutJudgment.decision?.judgment).toBeUndefined();
    expect(withoutJudgment.decision?.tier).toBe("economy");
  });
});

describe("interactiveTurnMatchesRule", () => {
  const projectRule = {
    ...DEFAULT_SERVER_SETTINGS.efficiency,
    enabled: true,
    rules: [
      {
        id: "quality-for-project",
        projectId: ProjectId.make("project-routed"),
        tier: "quality" as const,
      },
    ],
  };

  it("reports a match so the dispatcher can skip the judge round-trip", () => {
    expect(
      interactiveTurnMatchesRule({
        settings: projectRule,
        projectId: "project-routed",
        interactionMode: "default",
        attachmentCount: 0,
      }),
    ).toBe(true);
  });

  it("reports no match when the rule's project differs", () => {
    expect(
      interactiveTurnMatchesRule({
        settings: projectRule,
        projectId: "other-project",
        interactionMode: "default",
        attachmentCount: 0,
      }),
    ).toBe(false);
  });

  it("reports no match when there are no rules", () => {
    expect(
      interactiveTurnMatchesRule({
        settings: { ...DEFAULT_SERVER_SETTINGS.efficiency, enabled: true },
        projectId: "project-routed",
        interactionMode: "default",
        attachmentCount: 0,
      }),
    ).toBe(false);
  });
});

describe("task-kind specialists", () => {
  const judgingSettings: EfficiencySettings = {
    ...DEFAULT_SERVER_SETTINGS.efficiency,
    enabled: true,
    tierJudgment: { enabled: true, minConfidence: 0.6, continuationThreshold: 0.5 },
  };
  const judged = (score: number, kind: TaskKind, kindConfidence: number) => ({
    score,
    confidence: 0.9,
    model: "jev-latest",
    kind,
    kindConfidence,
  });
  const specialistIds = new Set(
    DEFAULT_SERVER_SETTINGS.efficiency.candidates
      .filter((candidate) => candidate.taskKinds !== undefined)
      .map((candidate) => candidate.candidateId as string),
  );

  it("routes a confident quality review to the astra specialist", () => {
    const result = resolveInteractiveEfficiency({
      command,
      settings: judgingSettings,
      providers,
      tierJudgment: judged(2, "review", 0.9),
    });
    expect(result.decision?.candidateId).toBe("codex-quality-review-astra");
    expect(result.command.modelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-6-astra",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    expect(result.decision?.judgment).toMatchObject({
      kind: "review",
      kindConfidence: 0.9,
      kindApplied: true,
    });
  });

  it("routes a confident balanced implementation to the Opus 4.8 specialist", () => {
    const result = resolveInteractiveEfficiency({
      command,
      settings: judgingSettings,
      providers,
      tierJudgment: judged(1, "implement", 0.8),
    });
    expect(result.decision?.candidateId).toBe("claude-balanced-implement-opus-4-8");
    expect(result.command.modelSelection).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-4-8",
      options: [{ id: "effort", value: "medium" }],
    });
  });

  it("uses the tier's general candidate when the kind is not confident", () => {
    const result = resolveInteractiveEfficiency({
      command,
      settings: judgingSettings,
      providers,
      tierJudgment: judged(2, "review", 0.3),
    });
    expect(result.decision?.candidateId).toBe("claude-quality-opus-5-5");
    expect(result.command.modelSelection).toEqual(opus55("high"));
    expect(result.decision?.judgment?.kindApplied).toBe(false);
  });

  it("uses the tier's general candidate when no specialist lists the kind", () => {
    const result = resolveInteractiveEfficiency({
      command,
      settings: judgingSettings,
      providers,
      tierJudgment: judged(2, "debug", 0.95),
    });
    expect(result.decision?.candidateId).toBe("claude-quality-opus-5-5");
    expect(result.decision?.judgment?.kindApplied).toBe(false);
  });

  it("falls back to the general candidate when the specialist is unavailable", () => {
    const result = resolveInteractiveEfficiency({
      command,
      settings: judgingSettings,
      // No codex provider, so the astra review specialist cannot be routed.
      providers: [claude],
      tierJudgment: judged(2, "review", 0.9),
    });
    expect(result.decision?.candidateId).toBe("claude-quality-opus-5-5");
    expect(result.decision?.source).toBe("tier-policy");
    expect(result.decision?.judgment?.kindApplied).toBe(false);
  });

  it("does not prefer specialists when tier judgment is disabled", () => {
    const result = resolveInteractiveEfficiency({
      command: { ...command, efficiencyTier: "quality" },
      settings: { ...DEFAULT_SERVER_SETTINGS.efficiency, enabled: true },
      providers,
      tierJudgment: judged(2, "review", 0.99),
    });
    expect(result.decision?.candidateId).toBe("claude-quality-opus-5-5");
  });

  it("never picks a specialist for a kind it does not list", () => {
    const kinds = [
      "debug",
      "refactor",
      "design",
      "question",
      "docs",
      "ops",
      "research",
      "creative",
      "other",
    ] as const;
    for (const kind of kinds) {
      for (const score of [0, 1, 2]) {
        const result = resolveInteractiveEfficiency({
          command,
          settings: judgingSettings,
          providers,
          tierJudgment: judged(score, kind, 0.99),
        });
        expect(specialistIds.has(result.decision?.candidateId ?? "")).toBe(false);
      }
    }
    // Economy has no specialists, so even a listed kind stays general there.
    const economyReview = resolveInteractiveEfficiency({
      command,
      settings: judgingSettings,
      providers,
      tierJudgment: judged(0, "review", 0.99),
    });
    expect(economyReview.decision?.candidateId).toBe("claude-economy-opus-5-5");
  });
});

describe("sticky continuation routing", () => {
  const judgingSettings: EfficiencySettings = {
    ...DEFAULT_SERVER_SETTINGS.efficiency,
    enabled: true,
    tierJudgment: { enabled: true, minConfidence: 0.6, continuationThreshold: 0.8 },
  };
  const priorDecision: EfficiencyDecision = {
    tier: "quality",
    candidateId: EfficiencyCandidateId.make("codex-quality-review-astra"),
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6-astra",
      options: [{ id: "reasoningEffort", value: "high" }],
    },
    source: "tier-policy",
    workload: "interactive",
    contextThresholdPercent: 90,
    toolWarningThreshold: 24,
    judgment: {
      score: 2,
      confidence: 0.9,
      tier: "quality",
      applied: true,
      model: "jev-latest",
      kind: "review",
      kindConfidence: 0.92,
      kindApplied: true,
    },
  };
  const followUp = (continuation: number) => ({
    score: 0,
    confidence: 0.95,
    model: "jev-latest",
    kind: "ops" as const,
    kindConfidence: 0.9,
    continuation,
  });

  it("reuses the previous route when the message continues it", () => {
    const result = resolveInteractiveEfficiency({
      command: { ...command, message: { ...command.message, text: "proceed" } },
      settings: judgingSettings,
      providers,
      tierJudgment: followUp(0.85),
      priorDecision,
    });
    expect(result.decision?.tier).toBe("quality");
    expect(result.decision?.candidateId).toBe("codex-quality-review-astra");
    expect(result.decision?.modelSelection).toEqual(priorDecision.modelSelection);
    expect(result.command.modelSelection).toEqual(priorDecision.modelSelection);
    expect(result.command.efficiencyTier).toBe("quality");
    expect(result.decision?.judgment).toMatchObject({
      score: 0,
      tier: "economy",
      applied: false,
      kind: "review",
      kindConfidence: 0.92,
      kindApplied: true,
      continuation: 0.85,
      sticky: true,
    });
  });

  it("routes fresh when the continuation probability is below the threshold", () => {
    const result = resolveInteractiveEfficiency({
      command,
      settings: judgingSettings,
      providers,
      tierJudgment: followUp(0.2),
      priorDecision,
    });
    expect(result.decision?.tier).toBe("economy");
    expect(result.decision?.candidateId).toBe("claude-economy-opus-5-5");
    expect(result.decision?.judgment?.sticky).toBeUndefined();
    expect(result.decision?.judgment?.continuation).toBe(0.2);
  });

  it("honours a configured continuation threshold", () => {
    const result = resolveInteractiveEfficiency({
      command,
      settings: {
        ...judgingSettings,
        tierJudgment: { ...judgingSettings.tierJudgment, continuationThreshold: 0.9 },
      },
      providers,
      tierJudgment: followUp(0.85),
      priorDecision,
    });
    expect(result.decision?.judgment?.sticky).toBeUndefined();
    expect(result.decision?.tier).toBe("economy");
  });

  it("routes fresh when the thread has no previous routed decision", () => {
    const result = resolveInteractiveEfficiency({
      command,
      settings: judgingSettings,
      providers,
      tierJudgment: followUp(0.95),
    });
    expect(result.decision?.tier).toBe("economy");
    expect(result.decision?.judgment?.sticky).toBeUndefined();
  });

  it("routes fresh when the previous route's provider is no longer available", () => {
    const result = resolveInteractiveEfficiency({
      command,
      settings: judgingSettings,
      providers: [claude],
      tierJudgment: followUp(0.95),
      priorDecision,
    });
    expect(result.decision?.tier).toBe("economy");
    expect(result.decision?.judgment?.sticky).toBeUndefined();
  });

  it("keeps explicit rules ahead of a continuation", () => {
    const result = resolveInteractiveEfficiency({
      command,
      projectIdOverride: ProjectId.make("project-routed"),
      settings: {
        ...judgingSettings,
        rules: [
          {
            id: "balanced-for-project",
            projectId: ProjectId.make("project-routed"),
            tier: "balanced",
          },
        ],
      },
      providers,
      tierJudgment: followUp(0.99),
      priorDecision,
    });
    expect(result.decision?.tier).toBe("balanced");
    expect(result.decision?.matchedRuleId).toBe("balanced-for-project");
    expect(result.decision?.candidateId).toBe("claude-balanced-opus-5-5");
    expect(result.decision?.judgment?.sticky).toBeUndefined();
  });

  it("does not stick when tier judgment is disabled", () => {
    const result = resolveInteractiveEfficiency({
      command,
      settings: { ...DEFAULT_SERVER_SETTINGS.efficiency, enabled: true },
      providers,
      tierJudgment: followUp(0.99),
      priorDecision,
    });
    expect(result.decision?.tier).toBe("economy");
    expect(result.decision?.judgment?.sticky).toBeUndefined();
  });

  it("is byte-identical to today when the judge is off or failed (no judgment)", () => {
    const withoutPrior = resolveInteractiveEfficiency({
      command,
      settings: judgingSettings,
      providers,
    });
    const withPrior = resolveInteractiveEfficiency({
      command,
      settings: judgingSettings,
      providers,
      priorDecision,
    });
    expect(withPrior).toStrictEqual(withoutPrior);
    expect(withPrior.decision).toStrictEqual({
      tier: "economy",
      candidateId: "claude-economy-opus-5-5",
      modelSelection: opus55("low"),
      source: "tier-policy",
      workload: "interactive",
      contextThresholdPercent: 65,
      toolWarningThreshold: 6,
    });
  });
});
