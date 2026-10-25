import { AutomationNodeId } from "@command-center/core";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  automationHealth,
  automationSpaceName,
  countFailingRecurringTasks,
  describeAutomationTrigger,
  latestAutomationRun,
  projectAutomationForEditor,
  reconcileAutomationDraftAfterSave,
  resolveAutomationEnvironmentId,
  resolveAutomationsScreenStatus,
  resolveAutomationsSelection,
  scheduledTaskHealth,
  shouldAutosaveAutomationDraft,
  sortByHealth,
  summarizeRecurringHealth,
} from "./AutomationsScreen.logic";
import {
  SAMPLE_AUTOMATION,
  SAMPLE_FAILED_RUN,
  SAMPLE_FAILED_SCHEDULED_TASK,
  SAMPLE_OLDER_SUCCEEDED_RUN,
  SAMPLE_PAUSED_SCHEDULED_TASK,
  SAMPLE_SCHEDULED_TASK,
  SAMPLE_SPACE,
} from "./AutomationsScreen.test-fixtures";
import { AUTOMATION_EDITOR_ADDABLE_NODE_KINDS } from "./types";

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

  it("autosaves dirty drafts, including drafts with validation issues", () => {
    expect(
      shouldAutosaveAutomationDraft({
        dirty: true,
        isSaving: false,
        hasSaveError: false,
        authoringUnavailable: false,
      }),
    ).toBe(true);
    expect(
      shouldAutosaveAutomationDraft({
        dirty: true,
        isSaving: true,
        hasSaveError: false,
        authoringUnavailable: false,
      }),
    ).toBe(false);
    expect(
      shouldAutosaveAutomationDraft({
        dirty: true,
        isSaving: false,
        hasSaveError: false,
        authoringUnavailable: false,
      }),
    ).toBe(true);
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
  it("preserves a committed repository check step without offering a new unbound step", () => {
    const definition = projectAutomationForEditor({
      ...SAMPLE_AUTOMATION,
      nodes: [
        {
          id: AutomationNodeId.make("required-checks"),
          kind: "repository.checks",
          config: { repositoryId: "repo-a" },
          position: { x: 80, y: 120 },
        },
      ],
    });

    expect(definition.nodes).toEqual([
      {
        id: "required-checks",
        kind: "repository.checks",
        config: { repositoryId: "repo-a" },
      },
    ]);
    expect(AUTOMATION_EDITOR_ADDABLE_NODE_KINDS).not.toContain("repository.checks");
  });
  it("preserves server-managed prospect nodes without making them addable", () => {
    const definition = projectAutomationForEditor({
      ...SAMPLE_AUTOMATION,
      nodes: [
        ...SAMPLE_AUTOMATION.nodes,
        {
          id: AutomationNodeId.make("evaluate"),
          kind: "prospect.evaluate",
          config: { profile: "prospect", limit: 3 },
          position: { x: 680, y: 120 },
        },
      ],
    });

    expect(definition.nodes.slice(-1)).toEqual([
      { id: "evaluate", kind: "prospect.evaluate", config: { profile: "prospect", limit: 3 } },
    ]);
  });

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

describe("recurring task health", () => {
  const enabledAutomation = { ...SAMPLE_AUTOMATION, enabled: true };

  it("ranks a scheduled task by its enabled flag and last run", () => {
    expect(scheduledTaskHealth(SAMPLE_FAILED_SCHEDULED_TASK)).toBe("failing");
    expect(scheduledTaskHealth(SAMPLE_SCHEDULED_TASK)).toBe("ok");
    expect(scheduledTaskHealth(SAMPLE_PAUSED_SCHEDULED_TASK)).toBe("paused");
    expect(scheduledTaskHealth({ enabled: true, lastRunStatus: "running" })).toBe("running");
    expect(scheduledTaskHealth({ enabled: true, lastRunStatus: "never" })).toBe("idle");
    // A failing task that was paused no longer needs anyone.
    expect(scheduledTaskHealth({ enabled: false, lastRunStatus: "failed" })).toBe("paused");
  });

  it("judges a committed automation by its newest run, whatever order runs arrive in", () => {
    const runs = [SAMPLE_OLDER_SUCCEEDED_RUN, SAMPLE_FAILED_RUN];
    expect(latestAutomationRun(SAMPLE_AUTOMATION, runs)?.id).toBe(SAMPLE_FAILED_RUN.id);
    expect(latestAutomationRun(SAMPLE_AUTOMATION, runs.toReversed())?.id).toBe(
      SAMPLE_FAILED_RUN.id,
    );
    expect(automationHealth(enabledAutomation, runs)).toBe("failing");
    expect(automationHealth(enabledAutomation, [SAMPLE_OLDER_SUCCEEDED_RUN])).toBe("ok");
    expect(automationHealth(enabledAutomation, [])).toBe("idle");
    expect(automationHealth(SAMPLE_AUTOMATION, runs)).toBe("paused");
    expect(
      automationHealth(enabledAutomation, [{ ...SAMPLE_FAILED_RUN, status: "waiting_approval" }]),
    ).toBe("running");
  });

  it("ignores runs that belong to other automations", () => {
    const other = { ...SAMPLE_FAILED_RUN, automationId: undefined };
    expect(latestAutomationRun(SAMPLE_AUTOMATION, [other])).toBeUndefined();
  });

  it("sorts most urgent first and keeps the incoming order within a rank", () => {
    const sorted = sortByHealth(
      [
        SAMPLE_PAUSED_SCHEDULED_TASK,
        SAMPLE_SCHEDULED_TASK,
        { ...SAMPLE_SCHEDULED_TASK, id: "second-ok" },
        SAMPLE_FAILED_SCHEDULED_TASK,
      ],
      scheduledTaskHealth,
    ).map((task) => task.id);
    expect(sorted).toEqual([
      SAMPLE_FAILED_SCHEDULED_TASK.id,
      SAMPLE_SCHEDULED_TASK.id,
      "second-ok",
      SAMPLE_PAUSED_SCHEDULED_TASK.id,
    ]);
  });

  it("counts failing tasks across both systems, skipping paused ones", () => {
    const input = {
      tasks: [SAMPLE_FAILED_SCHEDULED_TASK, SAMPLE_SCHEDULED_TASK, SAMPLE_PAUSED_SCHEDULED_TASK],
      automations: [enabledAutomation, SAMPLE_AUTOMATION],
      runs: [SAMPLE_FAILED_RUN],
    };
    expect(summarizeRecurringHealth(input)).toEqual({
      total: 5,
      failing: 2,
      running: 0,
      paused: 2,
    });
    expect(countFailingRecurringTasks(input)).toBe(2);
    expect(countFailingRecurringTasks({ tasks: [], automations: [], runs: [] })).toBe(0);
  });

  it("describes committed triggers the way the editor does", () => {
    expect(describeAutomationTrigger({ type: "manual" })).toBe("Manual");
    expect(describeAutomationTrigger(SAMPLE_AUTOMATION.trigger)).toBe("Every Monday at 9:00 AM");
    expect(describeAutomationTrigger({ type: "webhook", route: "/hooks/x" })).toBe("On webhook");
  });
});

describe("resolveAutomationsSelection", () => {
  const input = {
    tasks: [SAMPLE_PAUSED_SCHEDULED_TASK, SAMPLE_SCHEDULED_TASK, SAMPLE_FAILED_SCHEDULED_TASK],
    automations: [SAMPLE_AUTOMATION],
    runs: [SAMPLE_FAILED_RUN],
  };

  it("keeps a selection that still exists", () => {
    const selection = { kind: "automation" as const, id: SAMPLE_AUTOMATION.id };
    expect(resolveAutomationsSelection(selection, input)).toEqual(selection);
  });

  it("opens the failing scheduled task when nothing is selected", () => {
    expect(resolveAutomationsSelection(undefined, input)).toEqual({
      kind: "scheduled-task",
      id: SAMPLE_FAILED_SCHEDULED_TASK.id,
    });
  });

  it("drops a selection that disappeared and falls back to the most urgent item", () => {
    expect(resolveAutomationsSelection({ kind: "scheduled-task", id: "deleted" }, input)).toEqual({
      kind: "scheduled-task",
      id: SAMPLE_FAILED_SCHEDULED_TASK.id,
    });
  });

  it("prefers a failing automation over healthy scheduled tasks", () => {
    expect(
      resolveAutomationsSelection(undefined, {
        tasks: [SAMPLE_SCHEDULED_TASK],
        automations: [{ ...SAMPLE_AUTOMATION, enabled: true }],
        runs: [SAMPLE_FAILED_RUN],
      }),
    ).toEqual({ kind: "automation", id: SAMPLE_AUTOMATION.id });
  });

  it("is undefined with nothing to show", () => {
    expect(
      resolveAutomationsSelection(undefined, { tasks: [], automations: [], runs: [] }),
    ).toBeUndefined();
  });
});
