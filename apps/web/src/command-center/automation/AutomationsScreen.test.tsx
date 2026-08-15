import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { AutomationsScreen } from "./AutomationsScreen";
import { projectAutomationForEditor } from "./AutomationsScreen.logic";
import { SAMPLE_AUTOMATION, SAMPLE_SPACE } from "./AutomationsScreen.test-fixtures";

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

  it("renders the exact source through the local-commit editor", () => {
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
  });

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
    expect(html).not.toContain("Push");
  });

  it("shows a failed authoring preflight before save while keeping definitions readable", () => {
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
  });

  it("keeps autosave and manual save available when validation issues remain", () => {
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
  });

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
});
