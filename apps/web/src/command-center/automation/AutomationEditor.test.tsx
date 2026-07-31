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
    { id: "gather", kind: "connector.read", config: { source: "sample" } },
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
  it("renders typed draggable nodes and SVG connections", () => {
    const html = renderToStaticMarkup(
      <AutomationEditor definition={DEFINITION} onDefinitionChange={vi.fn()} />,
    );

    expect(html).toContain('data-slot="automation-editor"');
    expect(html).toContain('data-slot="automation-canvas"');
    expect(html).toContain('data-slot="automation-edges"');
    expect(html).toContain('data-kind="connector.read"');
    expect(html).toContain('data-kind="transform"');
    expect(html).toContain('data-edge="gather:summarize"');
    expect(html).toContain('aria-label="Move gather"');
    expect(html).toContain("Valid graph");
    expect(html).toContain('aria-label="Add Agent node"');
    expect(html).toContain('aria-label="Add Scoped shell node"');
    expect(html).toContain('aria-label="Automation name"');
    expect(html).toContain('aria-label="Automation trigger type"');
    expect(html).toContain('aria-label="Edit gather"');
    expect(html).toContain('aria-label="Delete gather"');
    expect(html).toContain('data-slot="automation-inspector"');
    expect(html).toContain('aria-label="Node ID for gather"');
    expect(html).toContain('aria-label="Node type for gather"');
    expect(html).toContain('aria-label="Config for gather"');
    expect(html).toContain('aria-label="Connection source node"');
    expect(html).toContain('aria-label="Remove connection gather to summarize"');
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

    expect(html).toContain('data-slot="automation-validation"');
    expect(html).toContain('data-issue-code="graph.unknown-edge-target"');
    expect(html).toContain('data-issue-code="policy.disallowed-capability"');
    expect(html).toContain("One node requests a capability outside this Space.");
    expect(html).not.toContain('data-edge="summarize:missing"');
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

    expect(html).toContain('data-issue-code="node.config.invalid"');
    expect(html).toContain("2 issues");
    expect(html).not.toContain("Valid graph");
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

    expect(schedule).toContain('aria-label="Schedule expression"');
    expect(schedule).toContain('aria-label="Schedule timezone"');
    expect(webhook).toContain('aria-label="Webhook route"');
    expect(webhook).not.toContain("Webhook triggers are unavailable");
  });

  it("disables editing controls in read-only mode", () => {
    const html = renderToStaticMarkup(
      <AutomationEditor definition={DEFINITION} onDefinitionChange={vi.fn()} readOnly />,
    );

    expect(html).toContain("Read only");
    expect(html).toMatch(/aria-label="Move gather"[^>]*disabled=""/);
    expect(html).toMatch(/aria-label="Add Connector read node"[^>]*disabled=""/);
  });
});
