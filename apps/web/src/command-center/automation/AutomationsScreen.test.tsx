import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { AutomationsScreen } from "./AutomationsScreen";
import { projectAutomationForEditor } from "./AutomationsScreen.logic";
import { SAMPLE_AUTOMATION, SAMPLE_SPACE } from "./AutomationsScreen.test-fixtures";

describe("AutomationsScreen", () => {
  it("renders the exact source through the local-commit editor", () => {
    const definition = {
      ...projectAutomationForEditor(SAMPLE_AUTOMATION),
      policy: { requireApprovalForExternalWrites: true },
    };
    const html = renderToStaticMarkup(
      <AutomationsScreen
        automations={[SAMPLE_AUTOMATION]}
        editorDefinition={definition}
        editorStatus="ready"
        isDirty
        onCreate={vi.fn()}
        onDefinitionChange={vi.fn()}
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
    expect(html).toContain("Unsaved");
    expect(html).toContain("Save local commit");
    expect(html).toContain("New automation");
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
        isDirty
        onCreate={vi.fn()}
        onDefinitionChange={vi.fn()}
        onSave={vi.fn()}
        spaces={[SAMPLE_SPACE]}
        status="ready"
      />,
    );

    expect(html).toContain("View and run only");
    expect(html).toContain("Creating and saving automations isn&#x27;t supported");
    expect(html).not.toContain("Linux atomic exchange support is unavailable.");
    expect(html).toContain('data-slot="automation-editor"');
    expect(html).toContain("Read only");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*New automation/su);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Save local commit/su);
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
  });

  it("does not expose environment error details in its unavailable state", () => {
    const html = renderToStaticMarkup(
      <AutomationsScreen automations={[]} spaces={[]} status="unavailable" />,
    );

    expect(html).toContain("Automations could not be loaded");
    expect(html).toContain('href="/"');
  });
});
