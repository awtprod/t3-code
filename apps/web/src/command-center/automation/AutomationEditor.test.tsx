import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { AutomationEditor } from "./AutomationEditor";
import type { AutomationEditorDefinition } from "./types";

const DEFINITION: AutomationEditorDefinition = {
  schemaVersion: 1,
  id: "sample-review-flow",
  name: "Sample review flow",
  spaceId: "sample-space",
  enabled: false,
  trigger: { kind: "manual" },
  nodes: [
    {
      id: "gather",
      kind: "connector.read",
      config: {
        connectionId: "sample-google",
        operation: "gmail.search",
        query: "is:unread",
      },
    },
    { id: "summarize", kind: "transform", config: { template: "sample-summary" } },
  ],
  edges: [{ from: "gather", to: "summarize" }],
  layout: {
    nodes: {
      gather: { x: 72, y: 96 },
      summarize: { x: 380, y: 96 },
    },
  },
  policy: {},
};

describe("AutomationEditor", () => {
  it("renders the React Flow canvas and primary workflow controls", () => {
    const html = renderToStaticMarkup(
      <AutomationEditor definition={DEFINITION} onDefinitionChange={vi.fn()} />,
    );

    expect(html).toContain('data-slot="automation-editor"');
    expect(html).toContain("@container/automation");
    expect(html).toContain('data-slot="automation-canvas"');
    expect(html).toContain('data-testid="rf__wrapper"');
    expect(html).toContain('aria-label="Control Panel"');
    expect(html).toContain("Add step");
    expect(html).toContain('aria-label="Fit workflow"');
    expect(html).toContain("Ready");
    expect(html).toContain('aria-label="Automation name"');
    expect(html).toContain('aria-label="Automation trigger type"');
  });

  it("exposes local and server validation issues without drawing broken edges", () => {
    const invalid: AutomationEditorDefinition = {
      ...DEFINITION,
      edges: [...DEFINITION.edges, { from: "summarize", to: "missing" }],
    };
    const html = renderToStaticMarkup(
      <AutomationEditor
        definition={invalid}
        onDefinitionChange={vi.fn()}
        validationIssues={[
          {
            code: "policy.disallowed-capability",
            message: "One node requests a capability outside this Space.",
            nodeIds: ["summarize"],
            severity: "error",
          },
        ]}
      />,
    );

    expect(html).toContain("2 issues");
    expect(html).not.toContain("One node requests a capability outside this Space.");
  });

  it("marks malformed agent and scoped-shell drafts invalid", () => {
    const unsupported: AutomationEditorDefinition = {
      ...DEFINITION,
      nodes: [
        ...DEFINITION.nodes,
        { id: "agent", kind: "agent.run", config: {} },
        { id: "shell", kind: "shell.scoped", config: {} },
      ],
    };
    const html = renderToStaticMarkup(
      <AutomationEditor definition={unsupported} onDefinitionChange={vi.fn()} />,
    );

    expect(html).toContain("2 issues");
    expect(html).not.toContain("Ready");
  });

  it("renders editable schedule and authenticated webhook trigger fields", () => {
    const schedule = renderToStaticMarkup(
      <AutomationEditor
        definition={{
          ...DEFINITION,
          trigger: { kind: "schedule", expression: "0 9 * * 1", timezone: "UTC" },
        }}
        onDefinitionChange={vi.fn()}
      />,
    );
    const webhook = renderToStaticMarkup(
      <AutomationEditor
        definition={{ ...DEFINITION, trigger: { kind: "webhook", route: "/hooks/sample" } }}
        onDefinitionChange={vi.fn()}
      />,
    );

    expect(schedule).toContain("When should this run?");
    expect(schedule).toContain("Timezone");
    expect(schedule).toContain("Choose manually");
    expect(schedule).not.toContain("0 9 * * 1");
    expect(webhook).toContain('aria-label="Webhook route"');
    expect(webhook).not.toContain("Webhook triggers are unavailable");
  });

  it("disables editing controls in read-only mode", () => {
    const html = renderToStaticMarkup(
      <AutomationEditor definition={DEFINITION} onDefinitionChange={vi.fn()} readOnly />,
    );

    expect(html).toContain("Read only");
    expect(html).toMatch(/disabled=""[^>]*>[^<]*<svg[^>]*>.*Add step/s);
  });
});
