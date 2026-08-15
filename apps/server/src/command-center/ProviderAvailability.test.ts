import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { commandCenterProviderAvailability } from "./ProviderAvailability.ts";

function provider(
  driver: "codex" | "claudeAgent" | "kimi",
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(`${driver}-primary`),
    driver: ProviderDriverKind.make(driver),
    status: "ready",
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
    checkedAt: "2026-07-20T00:00:00.000Z",
    version: "1.0.0",
    models: [{ slug: "example-model", name: "Example model", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("Command Center provider availability", () => {
  it("excludes provider adapters without the v1 Command Center isolation boundary", () => {
    const availability = commandCenterProviderAvailability([
      provider("claudeAgent"),
      provider("codex"),
    ]);

    expect(availability).toHaveLength(1);
    expect(availability[0]).toMatchObject({
      providerId: "codex-primary",
      healthy: true,
      priority: 1,
    });
  });

  it("retains unavailable Codex instances as unhealthy explicit-routing candidates", () => {
    const availability = commandCenterProviderAvailability([
      provider("codex", { availability: "unavailable" }),
    ]);

    expect(availability).toHaveLength(1);
    expect(availability[0]?.healthy).toBe(false);
  });

  it("offers Kimi to Command Center routing on Linux", () => {
    const availability = commandCenterProviderAvailability([
      provider("kimi", {
        capabilities: {
          cacheTelemetry: "read-write",
          nativeSubagents: true,
          usageTelemetry: true,
          commandCenterAutomation: true,
        },
      }),
    ]);

    expect(availability).toHaveLength(NodeProcess.platform === "linux" ? 1 : 0);
    if (NodeProcess.platform === "linux") {
      expect(availability[0]).toMatchObject({ providerId: "kimi-primary", healthy: true });
    }
  });

  it("keeps interactive-only Kimi installs out of automation routing", () => {
    expect(commandCenterProviderAvailability([provider("kimi")])).toHaveLength(0);
  });
});
import * as NodeProcess from "node:process";
