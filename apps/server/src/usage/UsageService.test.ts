import { describe, expect, it } from "@effect/vitest";
import { ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { configuredUsageProviders } from "./UsageService.ts";

const decodeSettings = Schema.decodeSync(ServerSettings);

describe("configuredUsageProviders", () => {
  it("uses every enabled supported provider instance", () => {
    const settings = decodeSettings({
      providerInstances: {
        "codex-awtprod": {
          driver: "codex",
          enabled: true,
          config: { homePath: "/providers/codex/awtprod/.codex" },
        },
        "codex-secondary": {
          driver: "codex",
          config: { homePath: "/providers/codex/secondary/.codex" },
        },
        "claude-awtprod": {
          driver: "claudeAgent",
          enabled: true,
          config: { homePath: "/providers/claude/awtprod/.claude" },
        },
        disabled: {
          driver: "claudeAgent",
          enabled: false,
          config: { homePath: "/providers/claude/disabled/.claude" },
        },
        kimi: { driver: "kimi", enabled: true, config: {} },
      },
    });

    expect(
      configuredUsageProviders(settings).map(({ provider, config }) => [provider, config.homePath]),
    ).toEqual([
      ["codex", "/providers/codex/awtprod/.codex"],
      ["codex", "/providers/codex/secondary/.codex"],
      ["claude", "/providers/claude/awtprod/.claude"],
    ]);
  });

  it("falls back per driver when only legacy settings exist", () => {
    const settings = decodeSettings({
      providers: {
        codex: { homePath: "/legacy/.codex" },
        claudeAgent: { homePath: "/legacy/.claude" },
      },
    });

    expect(
      configuredUsageProviders(settings).map(({ provider, config }) => [provider, config.homePath]),
    ).toEqual([
      ["claude", "/legacy/.claude"],
      ["codex", "/legacy/.codex"],
    ]);
  });

  it("uses an explicit legacy home when a wrapper instance does not declare one", () => {
    const settings = decodeSettings({
      providers: {
        codex: { homePath: "/providers/codex/awtprod/.codex" },
      },
      providerInstances: {
        codex: {
          driver: "codex",
          enabled: true,
          config: { binaryPath: "/runtime/provider-bin/codex" },
        },
      },
    });

    expect(
      configuredUsageProviders(settings)
        .filter(({ provider }) => provider === "codex")
        .map(({ config }) => config.homePath),
    ).toEqual(["/providers/codex/awtprod/.codex"]);
  });
});
