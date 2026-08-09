import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  automationSpaceName,
  projectAutomationForEditor,
  reconcileAutomationDraftAfterSave,
  resolveAutomationEnvironmentId,
  resolveAutomationsScreenStatus,
  shouldAutosaveAutomationDraft,
} from "./AutomationsScreen.logic";
import { SAMPLE_AUTOMATION, SAMPLE_SPACE } from "./AutomationsScreen.test-fixtures";

describe("automations route state", () => {
  it("keeps newer edits dirty when an older save finishes", () => {
    const submitted = projectAutomationForEditor(SAMPLE_AUTOMATION);
    const newer = { ...submitted, name: "Edited while saving" };
    const reconciled = reconcileAutomationDraftAfterSave({
      currentDraft: {
        definition: newer,
        baseDigest: "old-digest",
        configCommitSha: "old-commit",
        dirty: true,
        revision: 2,
      },
      submittedRevision: 1,
      savedDefinition: submitted,
      savedDefinitionDigest: "new-digest",
      savedConfigCommitSha: "new-commit",
    });

    expect(reconciled).toEqual({
      definition: newer,
      baseDigest: "new-digest",
      configCommitSha: "new-commit",
      dirty: true,
      revision: 2,
    });

    expect(
      reconcileAutomationDraftAfterSave({
        currentDraft: { ...reconciled, definition: submitted, revision: 1 },
        submittedRevision: 1,
        savedDefinition: submitted,
        savedDefinitionDigest: "settled-digest",
        savedConfigCommitSha: "settled-commit",
      }),
    ).toEqual({
      definition: submitted,
      baseDigest: "settled-digest",
      configCommitSha: "settled-commit",
      dirty: false,
      revision: 1,
    });
  });

  it("autosaves only valid dirty drafts that are not already saving", () => {
    expect(
      shouldAutosaveAutomationDraft({
        dirty: true,
        isSaving: false,
        hasBlockingIssues: false,
        hasSaveError: false,
        authoringUnavailable: false,
      }),
    ).toBe(true);
    expect(
      shouldAutosaveAutomationDraft({
        dirty: true,
        isSaving: true,
        hasBlockingIssues: false,
        hasSaveError: false,
        authoringUnavailable: false,
      }),
    ).toBe(false);
    expect(
      shouldAutosaveAutomationDraft({
        dirty: true,
        isSaving: false,
        hasBlockingIssues: true,
        hasSaveError: false,
        authoringUnavailable: false,
      }),
    ).toBe(false);
  });

  it("routes automations to an explicitly selected remote environment", () => {
    const windows = EnvironmentId.make("windows-primary");
    const linux = EnvironmentId.make("linux-runner");

    expect(
      resolveAutomationEnvironmentId({
        requestedEnvironmentId: linux,
        primaryEnvironmentId: windows,
        environments: [
          { id: windows, isPrimary: true, platformOs: "windows" },
          { id: linux, isPrimary: false, platformOs: "linux" },
        ],
      }),
    ).toBe(linux);
    expect(
      resolveAutomationEnvironmentId({
        requestedEnvironmentId: EnvironmentId.make("removed-environment"),
        primaryEnvironmentId: windows,
        environments: [
          { id: windows, isPrimary: true, platformOs: "windows" },
          { id: linux, isPrimary: false, platformOs: "linux" },
        ],
      }),
    ).toBe(linux);
  });

  it("defaults away from the local primary when a remote automation host is available", () => {
    const windows = EnvironmentId.make("windows-primary");
    const linux = EnvironmentId.make("openclaw-server");

    expect(
      resolveAutomationEnvironmentId({
        requestedEnvironmentId: null,
        primaryEnvironmentId: windows,
        environments: [
          { id: windows, isPrimary: true, platformOs: "windows" },
          { id: linux, isPrimary: false, platformOs: "linux" },
        ],
      }),
    ).toBe(linux);
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
