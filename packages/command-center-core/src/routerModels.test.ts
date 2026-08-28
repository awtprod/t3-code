import { describe, expect, it } from "@effect/vitest";

import { ModelId, ProviderId } from "./domain.ts";
import {
  isRouterOnlyModel,
  ROUTER_ONLY_CHILD_MODEL_ERROR,
  routerCapabilityScope,
  workerProviderAvailability,
} from "./routerModels.ts";

describe("router-only models", () => {
  it("classifies Sol and Fable canonically", () => {
    expect(isRouterOnlyModel("gpt-5.6-sol")).toBe(true);
    expect(isRouterOnlyModel("claude-fable-5")).toBe(true);
    expect(isRouterOnlyModel("gpt-5.6-terra")).toBe(false);
  });

  it("keeps only routed reads plus cc.runs.start in the router scope", () => {
    expect(routerCapabilityScope(["cc.items.read", "cc.items.write", "cc.memory.propose"])).toEqual(
      ["cc.items.read", "cc.runs.start"],
    );
    expect(
      routerCapabilityScope([
        "cc.memory.read",
        "cc.sales.read",
        "cc.sales.write",
        "cc.automations.run",
        "cc.connections.google.gmail.drafts.create",
        "cc.runs.start",
      ]),
    ).toEqual(["cc.memory.read", "cc.sales.read", "cc.runs.start"]);
    expect(routerCapabilityScope([])).toEqual(["cc.runs.start"]);
  });

  it("removes router-only child candidates and fails closed when none remain", () => {
    const providers = workerProviderAvailability([
      {
        providerId: ProviderId.make("codex"),
        healthy: true,
        priority: 0,
        modelIds: [ModelId.make("gpt-5.6-sol"), ModelId.make("gpt-5.6-terra")],
        defaultModelId: ModelId.make("gpt-5.6-sol"),
        capabilities: ["cc.runs.start"],
      },
      {
        providerId: ProviderId.make("claude"),
        healthy: true,
        priority: 1,
        modelIds: [ModelId.make("claude-fable-5")],
        defaultModelId: ModelId.make("claude-fable-5"),
        capabilities: ["cc.runs.start"],
      },
    ]);

    expect(providers).toHaveLength(1);
    expect(providers[0]?.modelIds).toEqual([ModelId.make("gpt-5.6-terra")]);
    expect(providers[0]?.defaultModelId).toBe(ModelId.make("gpt-5.6-terra"));
    expect(
      workerProviderAvailability([
        {
          providerId: ProviderId.make("claude"),
          healthy: true,
          priority: 0,
          modelIds: [ModelId.make("claude-fable-5")],
          defaultModelId: ModelId.make("claude-fable-5"),
          capabilities: ["cc.runs.start"],
        },
      ]),
    ).toEqual([]);
    expect(ROUTER_ONLY_CHILD_MODEL_ERROR).toMatch(/Router-only models/u);
  });
});
