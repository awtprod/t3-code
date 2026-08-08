import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  automationSpaceName,
  projectAutomationForEditor,
  resolveAutomationEnvironmentId,
  resolveAutomationsScreenStatus,
} from "./AutomationsScreen.logic";
import { SAMPLE_AUTOMATION, SAMPLE_SPACE } from "./AutomationsScreen.test-fixtures";

describe("automations route state", () => {
  it("routes automations to an explicitly selected remote environment", () => {
    const windows = EnvironmentId.make("windows-primary");
    const linux = EnvironmentId.make("linux-runner");

    expect(
      resolveAutomationEnvironmentId({
        requestedEnvironmentId: linux,
        primaryEnvironmentId: windows,
        environments: [{ id: windows }, { id: linux }],
      }),
    ).toBe(linux);
    expect(
      resolveAutomationEnvironmentId({
        requestedEnvironmentId: EnvironmentId.make("removed-environment"),
        primaryEnvironmentId: windows,
        environments: [{ id: windows }, { id: linux }],
      }),
    ).toBe(windows);
  });

  it("uses safe disconnected, loading, unavailable, and config states", () => {
    expect(
      resolveAutomationsScreenStatus({
        connected: false,
        isPending: false,
        hasData: false,
        hasError: false,
      }),
    ).toBe("disconnected");
    expect(
      resolveAutomationsScreenStatus({
        connected: true,
        isPending: true,
        hasData: false,
        hasError: false,
      }),
    ).toBe("loading");
    expect(
      resolveAutomationsScreenStatus({
        connected: true,
        isPending: false,
        hasData: false,
        hasError: true,
      }),
    ).toBe("unavailable");
    expect(
      resolveAutomationsScreenStatus({
        connected: true,
        isPending: false,
        hasData: true,
        hasError: false,
        configStatus: "invalid",
      }),
    ).toBe("config-unavailable");
    expect(
      resolveAutomationsScreenStatus({
        connected: true,
        isPending: false,
        hasData: true,
        hasError: false,
        configStatus: "loaded",
      }),
    ).toBe("ready");
  });
});

describe("committed automation projection", () => {
  it("maps the entity API shape to the editor without inventing editable policy", () => {
    const definition = projectAutomationForEditor(SAMPLE_AUTOMATION);

    expect(definition).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        id: "sample-weekly-brief",
        spaceId: "sample-space",
        enabled: false,
        trigger: { kind: "schedule", expression: "0 9 * * 1", timezone: "Etc/UTC" },
        policy: {},
      }),
    );
    expect(definition.nodes).toEqual([
      {
        id: "collect",
        kind: "connector.read",
        config: { source: "sample", options: { limit: 5 } },
      },
      { id: "draft", kind: "transform", config: { template: "sample-brief" } },
    ]);
    expect(definition.edges).toEqual([{ from: "collect", to: "draft" }]);
    expect(definition.layout).toEqual({
      nodes: {
        collect: { x: 80, y: 120 },
        draft: { x: 380, y: 120 },
      },
    });
    expect(automationSpaceName(SAMPLE_AUTOMATION, [SAMPLE_SPACE])).toBe("Sample Space");
  });
});
