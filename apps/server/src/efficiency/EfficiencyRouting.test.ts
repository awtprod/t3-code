import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationCommand,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  fromCommandCenterSelection,
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
      slug: "gpt-5.6-terra",
      name: "Terra",
      isCustom: false,
      capabilities: null,
    },
    {
      slug: "gpt-5.6-sol",
      name: "Sol",
      isCustom: false,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
} satisfies ServerProvider;

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
      providers: [codex],
    };
    const first = resolveInteractiveEfficiency(input);
    const second = resolveInteractiveEfficiency(input);

    expect(first).toEqual(second);
    expect(first.command.modelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-terra",
      options: [{ id: "reasoningEffort", value: "low" }],
    });
    expect(first.decision?.source).toBe("tier-policy");
  });

  it("leaves manual commands byte-for-byte unchanged", () => {
    const manual = { ...command, routingMode: "manual" as const };
    expect(
      resolveInteractiveEfficiency({
        command: manual,
        settings: { ...DEFAULT_SERVER_SETTINGS.efficiency, enabled: true },
        providers: [codex],
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
      providers: [codex],
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
      providers: [codex],
    });

    expect(result.command.modelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    expect(result.decision?.tier).toBe("quality");
    expect(result.decision?.matchedRuleId).toBe("quality-for-project");
  });
});
