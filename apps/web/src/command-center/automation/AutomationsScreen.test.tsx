import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { AutomationsScreen } from "./AutomationsScreen";
import { projectAutomationForEditor } from "./AutomationsScreen.logic";
import {
  SAMPLE_AUTOMATION,
  SAMPLE_FAILED_RUN,
  SAMPLE_FAILED_SCHEDULED_TASK,
  SAMPLE_PAUSED_SCHEDULED_TASK,
  SAMPLE_SCHEDULED_TASK,
  SAMPLE_SPACE,
} from "./AutomationsScreen.test-fixtures";

// Each of these renders the whole automations screen synchronously through
// renderToStaticMarkup. That costs ~5s under full-suite load locally and was
// already measured at 8.9s on a green main CI run, against vitest's 15s
// default — one slow runner away from a spurious failure. Give the SSR renders
// room rather than letting runner variance decide the build.
const SSR_RENDER_TIMEOUT_MS = 60_000;

const navMarkup = (html: string, label: string) =>
  new RegExp(`<nav aria-label="${label}"[\\s\\S]*?</nav>`, "u").exec(html)?.[0] ?? "";

describe("AutomationsScreen", () => {
  const windowsEnvironmentId = EnvironmentId.make("windows-primary");
  const linuxEnvironmentId = EnvironmentId.make("linux-runner");
  const validEditorDefinition = () => {
    const definition = projectAutomationForEditor(SAMPLE_AUTOMATION);
    return {
      ...definition,
      nodes: definition.nodes.map((node) =>
        node.id === "collect"
          ? {
              ...node,
              config: {
                connectionId: "sample-google",
                operation: "gmail.search",
                query: "is:unread",
              },
            }
          : node,
      ),
    };
  };

  it(
    "renders the exact source through the local-commit editor",
    () => {
      const definition = {
        ...validEditorDefinition(),
        policy: { requireApprovalForExternalWrites: true },
      };
      const html = renderToStaticMarkup(
        <AutomationsScreen
          automations={[SAMPLE_AUTOMATION]}
          editorDefinition={definition}
          editorStatus="ready"
          environmentId={linuxEnvironmentId}
          environmentOptions={[
            { id: windowsEnvironmentId, label: "Windows PC" },
            { id: linuxEnvironmentId, label: "Linux box" },
          ]}
          isDirty
          onCreate={vi.fn()}
          onDefinitionChange={vi.fn()}
          onEnvironmentChange={vi.fn()}
          onSave={vi.fn()}
          spaces={[SAMPLE_SPACE]}
          status="ready"
        />,
      );

      expect(html).toContain('data-slot="automations-screen"');
      expect(html).toContain('aria-label="Automation definitions"');
      expect(html).toContain("Sample weekly brief");
      expect(html).toContain("Sample Space");
      expect(html).toContain('data-slot="automation-editor"');
      expect(html).toContain("Private config");
      expect(html).toContain("Runs on");
      expect(html).toContain('aria-label="Automation runtime environment"');
      expect(html).toContain("Linux box");
      expect(html).toContain("Autosave pending");
      expect(html).toContain("Save now");
      expect(html).toContain("New automation");
      expect(html).toContain('href="/settings/connections"');
      expect(html).toMatch(
        /<select[^>]*aria-label="Automation runtime environment"(?![^>]*disabled)/u,
      );
      expect(html).not.toContain("Read only");
      expect(html).not.toContain("Push");
    },
    SSR_RENDER_TIMEOUT_MS,
  );

  it("offers private local creation from the empty state", () => {
    const html = renderToStaticMarkup(
      <AutomationsScreen
        automations={[]}
        onCreate={vi.fn()}
        spaces={[SAMPLE_SPACE]}
        status="ready"
      />,
    );

    expect(html).toContain('data-slot="automations-empty"');
    expect(html).toContain("New automation");
    expect(html).toContain('data-slot="automations-nothing-recurring"');
    expect(html).not.toContain("Push");
  });

  it(
    "shows a failed authoring preflight before save while keeping definitions readable",
    () => {
      const html = renderToStaticMarkup(
        <AutomationsScreen
          authoringHealth={{
            status: "unavailable",
            message: "Linux atomic exchange support is unavailable.",
          }}
          automations={[SAMPLE_AUTOMATION]}
          editorDefinition={projectAutomationForEditor(SAMPLE_AUTOMATION)}
          editorStatus="ready"
          environmentId={windowsEnvironmentId}
          environmentOptions={[
            { id: windowsEnvironmentId, label: "Windows PC" },
            { id: linuxEnvironmentId, label: "Linux box" },
          ]}
          isDirty
          onCreate={vi.fn()}
          onDefinitionChange={vi.fn()}
          onEnvironmentChange={vi.fn()}
          onSave={vi.fn()}
          spaces={[SAMPLE_SPACE]}
          status="ready"
        />,
      );

      expect(html).toContain("Windows PC is view and run only");
      expect(html).toContain("choose a Linux environment");
      expect(html).not.toContain("Linux atomic exchange support is unavailable.");
      expect(html).toContain('data-slot="automation-editor"');
      expect(html).toContain("Read only");
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*New automation/su);
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Save now/su);
    },
    SSR_RENDER_TIMEOUT_MS,
  );

  it(
    "keeps autosave and manual save available when validation issues remain",
    () => {
      const definition = {
        ...validEditorDefinition(),
        nodes: [
          ...validEditorDefinition().nodes,
          { id: "broken-agent", kind: "agent.run" as const, config: {} },
        ],
      };
      const html = renderToStaticMarkup(
        <AutomationsScreen
          automations={[SAMPLE_AUTOMATION]}
          editorDefinition={definition}
          editorStatus="ready"
          isDirty
          onDefinitionChange={vi.fn()}
          onSave={vi.fn()}
          spaces={[SAMPLE_SPACE]}
          status="ready"
        />,
      );

      expect(html).toContain("Autosave pending");
      expect(html).not.toContain("Fix issues to save");
      expect(html).toMatch(/<button(?![^>]*disabled="")[^>]*title="Save immediately/u);
    },
    SSR_RENDER_TIMEOUT_MS,
  );

  it("renders explicit loading and empty committed-definition states", () => {
    const loading = renderToStaticMarkup(
      <AutomationsScreen automations={[]} spaces={[]} status="loading" />,
    );
    const empty = renderToStaticMarkup(
      <AutomationsScreen automations={[]} onRefresh={vi.fn()} spaces={[]} status="ready" />,
    );

    expect(loading).toContain('data-slot="automations-loading"');
    expect(loading).toContain("Loading committed automation definitions");
    expect(empty).toContain('data-slot="automations-empty"');
    expect(empty).toContain("No committed automations yet");
    expect(empty).toContain("Check again");
    expect(empty).toContain("Add environment");
  });

  it("does not expose environment error details in its unavailable state", () => {
    const html = renderToStaticMarkup(
      <AutomationsScreen automations={[]} spaces={[]} status="unavailable" />,
    );

    expect(html).toContain("Automations could not be loaded");
    expect(html).toContain('href="/"');
  });

  it(
    "lists scheduled tasks failing first and opens the failing one with its error and controls",
    () => {
      const html = renderToStaticMarkup(
        <AutomationsScreen
          automations={[SAMPLE_AUTOMATION]}
          canOperateScheduledTasks
          onOpenScheduledTaskThread={vi.fn()}
          onRunScheduledTaskNow={vi.fn()}
          onSetScheduledTaskEnabled={vi.fn()}
          runs={[SAMPLE_FAILED_RUN]}
          scheduledTasks={[
            SAMPLE_PAUSED_SCHEDULED_TASK,
            SAMPLE_SCHEDULED_TASK,
            SAMPLE_FAILED_SCHEDULED_TASK,
          ]}
          spaces={[SAMPLE_SPACE]}
          status="ready"
        />,
      );

      const tasksNav = navMarkup(html, "Scheduled tasks");
      const titles = ["Weekday prospect digest", "Editing opportunity watch", "Paused inbox sync"];
      const positions = titles.map((title) => tasksNav.indexOf(title));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((left, right) => left - right));
      // Enabled rows lead with the outcome and point at the next run; paused rows show the schedule.
      expect(tasksNav).toMatch(/text-destructive">Failed /u);
      expect(tasksNav).toContain("Paused · Every 15 min");

      expect(html).toContain('data-slot="scheduled-task-details"');
      expect(html).toContain('aria-label="Scheduled task Weekday prospect digest"');
      expect(html).toContain("Workspace preparation failed during provision worktree.");
      expect(html).toContain("claude-haiku-5-5");
      expect(html).toContain("Run now");
      expect(html).toContain("Pause");
      expect(html).toContain("New worktree each run");
      // The failing task has no bound thread, so there is nothing to open.
      expect(html).not.toContain("Open thread");
      expect(html).not.toContain('data-slot="automation-editor"');

      // Header summary: three tasks plus one automation whose latest run failed, but it is paused.
      expect(html).toContain("4 recurring");
      expect(html).toContain("1 failing");
      expect(html).toContain("2 paused");
    },
    SSR_RENDER_TIMEOUT_MS,
  );

  it(
    "keeps scheduled tasks usable when the private configuration is unavailable",
    () => {
      const html = renderToStaticMarkup(
        <AutomationsScreen
          automations={[]}
          canOperateScheduledTasks
          onOpenScheduledTaskThread={vi.fn()}
          scheduledTasks={[SAMPLE_SCHEDULED_TASK]}
          spaces={[]}
          status="config-unavailable"
        />,
      );

      expect(html).toContain('data-slot="automations-config-unavailable"');
      expect(html).toContain("Private configuration is unavailable");
      expect(html).toContain('aria-label="Scheduled task Editing opportunity watch"');
      expect(html).toContain("Daily at 17:00");
      expect(html).toContain("Open thread");
      expect(html).toContain("Last run succeeded");
    },
    SSR_RENDER_TIMEOUT_MS,
  );

  it("explains where recurring work comes from when there is none", () => {
    const html = renderToStaticMarkup(
      <AutomationsScreen
        automations={[]}
        onOpenScheduledTasksSettings={vi.fn()}
        scheduledTasks={[]}
        spaces={[]}
        status="ready"
      />,
    );

    expect(html).toContain('data-slot="scheduled-tasks-empty"');
    expect(html).toContain("Scheduled tasks settings");
    expect(html).toContain("Nothing recurring yet");
  });
});
