import { describe, expect, it } from "vite-plus/test";

import {
  addAutomationNode,
  addAutomationEdge,
  automationCanvasSize,
  automationEdgeProblem,
  automationEdgePath,
  moveAutomationNode,
  removeAutomationEdge,
  removeAutomationNode,
  renameAutomationNode,
  readAutomationNodePosition,
  reconcileAutomationNodePosition,
  setAutomationNodePosition,
  setAutomationEdgeDirection,
  toSerializableAutomationDefinition,
  validateAutomationEditorDefinition,
} from "./logic";
import type { AutomationEditorDefinition } from "./types";

function sampleDefinition(): AutomationEditorDefinition {
  return {
    schemaVersion: 1,
    id: "sample-weekly-brief",
    name: "Sample weekly brief",
    spaceId: "sample-space",
    enabled: false,
    trigger: { kind: "manual" },
    nodes: [
      {
        id: "collect",
        kind: "connector.read",
        config: {
          connectionId: "sample-google",
          operation: "gmail.search",
          query: "is:unread",
        },
      },
      { id: "draft", kind: "transform", config: { template: "weekly-brief" } },
      { id: "review", kind: "approval", config: { action: "publish" } },
    ],
    edges: [
      { from: "collect", to: "draft" },
      { from: "draft", to: "review" },
    ],
    layout: {
      nodes: {
        collect: { x: 80, y: 140 },
        draft: { x: 380, y: 140 },
        review: { x: 680, y: 140 },
      },
      zoom: 1,
    },
    policy: { requireApprovalForExternalWrites: true },
  };
}

describe("automation editor definition edits", () => {
  it("moves one node while preserving private-file metadata in a JSON-safe value", () => {
    const initial = sampleDefinition();
    const moved = moveAutomationNode(initial, "draft", { x: 42.4, y: -18.8 });
    const serializable = toSerializableAutomationDefinition(moved);

    expect(readAutomationNodePosition(initial, "draft")).toEqual({ x: 380, y: 140 });
    expect(readAutomationNodePosition(serializable, "draft")).toEqual({ x: 422, y: 121 });
    expect(serializable.layout.zoom).toBe(1);
    expect(serializable.policy).toEqual(initial.policy);
    expect(JSON.parse(JSON.stringify(serializable))).toEqual(serializable);
    expect(serializable).not.toBe(moved);
  });

  it("persists a dragged node at its absolute final canvas position", () => {
    const initial = sampleDefinition();
    const positioned = setAutomationNodePosition(initial, "draft", { x: 742.4, y: 411.6 });

    expect(readAutomationNodePosition(positioned, "draft")).toEqual({ x: 742, y: 412 });
    expect(readAutomationNodePosition(positioned, "collect")).toEqual({ x: 80, y: 140 });
    expect(positioned.layout.zoom).toBe(1);
  });

  it("keeps an in-progress canvas position during presentation-only refreshes", () => {
    const persisted = { x: 380, y: 140 };
    const dragged = { x: 740, y: 420 };

    expect(reconcileAutomationNodePosition(dragged, persisted, persisted, false)).toEqual(dragged);
    expect(reconcileAutomationNodePosition(dragged, persisted, { x: 760, y: 440 }, false)).toEqual({
      x: 760,
      y: 440,
    });
    expect(reconcileAutomationNodePosition(dragged, persisted, persisted, true)).toEqual(persisted);
  });

  it("adds typed nodes with stable unique IDs and persisted positions", () => {
    const withTransform = addAutomationNode(sampleDefinition(), "transform");
    const withSecondTransform = addAutomationNode(withTransform, "transform");

    expect(withSecondTransform.nodes.slice(-2)).toEqual([
      { id: "transform", kind: "transform", config: { template: "" } },
      { id: "transform-2", kind: "transform", config: { template: "" } },
    ]);
    expect(readAutomationNodePosition(withSecondTransform, "transform-2")).toEqual({
      x: 408,
      y: 208,
    });
  });

  it("adds agent and scoped-shell nodes with server-valid authority-free defaults", () => {
    const withAgent = addAutomationNode(sampleDefinition(), "agent.run");
    const withShell = addAutomationNode(withAgent, "shell.scoped");
    expect(withShell.nodes.slice(-2)).toEqual([
      {
        id: "agent",
        kind: "agent.run",
        config: { prompt: "Describe the scoped agent task" },
      },
      {
        id: "shell",
        kind: "shell.scoped",
        config: { allowlistId: "configured-command-id" },
      },
    ]);
  });

  it("renames and deletes nodes without leaving dangling edges or layout", () => {
    const renamed = renameAutomationNode(sampleDefinition(), "draft", "compose");
    expect(renamed.nodes.map((node) => node.id)).toContain("compose");
    expect(renamed.edges).toEqual([
      { from: "collect", to: "compose" },
      { from: "compose", to: "review" },
    ]);
    expect(readAutomationNodePosition(renamed, "compose")).toEqual({ x: 380, y: 140 });

    const removed = removeAutomationNode(renamed, "compose");
    expect(removed.nodes.map((node) => node.id)).not.toContain("compose");
    expect(removed.edges).toEqual([]);
    expect(removed.layout.nodes).not.toHaveProperty("compose");
  });

  it("authors and removes only valid acyclic edges", () => {
    const initial = { ...sampleDefinition(), edges: [] };
    const first = addAutomationEdge(initial, { from: "collect", to: "draft" });
    const second = addAutomationEdge(first, { from: "draft", to: "review" });
    expect(addAutomationEdge(second, { from: "review", to: "collect" })).toBe(second);
    expect(addAutomationEdge(second, { from: "draft", to: "review" })).toBe(second);
    expect(removeAutomationEdge(second, { from: "collect", to: "draft" }).edges).toEqual([
      { from: "draft", to: "review" },
    ]);
  });

  it("reverses an existing connection when its direction is changed", () => {
    const initial = sampleDefinition();
    const reversed = setAutomationEdgeDirection(initial, { from: "review", to: "draft" });

    expect(reversed.edges).toEqual([
      { from: "collect", to: "draft" },
      { from: "review", to: "draft" },
    ]);
    expect(setAutomationEdgeDirection(reversed, { from: "review", to: "draft" })).toBe(reversed);
  });

  it("keeps the original connection when reversing it would still create a loop", () => {
    const initial: AutomationEditorDefinition = {
      ...sampleDefinition(),
      edges: [
        { from: "collect", to: "draft" },
        { from: "draft", to: "review" },
        { from: "collect", to: "review" },
      ],
    };

    expect(setAutomationEdgeDirection(initial, { from: "review", to: "collect" })).toBe(initial);
  });

  it("explains rejected connections without validating every node configuration", () => {
    const definition = sampleDefinition();

    expect(automationEdgeProblem(definition, { from: "draft", to: "draft" })).toBe(
      "A step cannot connect to itself.",
    );
    expect(automationEdgeProblem(definition, { from: "draft", to: "missing" })).toBe(
      "That step is no longer available.",
    );
    expect(automationEdgeProblem(definition, { from: "draft", to: "review" })).toBe(
      "Those steps are already connected.",
    );
    expect(automationEdgeProblem(definition, { from: "review", to: "collect" })).toBe(
      "That connection would create a loop.",
    );
    expect(automationEdgeProblem(definition, { from: "collect", to: "review" })).toBeUndefined();
  });

  it("computes deterministic paths and a canvas that contains every node", () => {
    expect(automationEdgePath({ x: 80, y: 140 }, { x: 380, y: 140 })).toBe(
      "M 360 196 C 408 196, 332 196, 380 196",
    );
    expect(automationCanvasSize(sampleDefinition())).toEqual({ width: 1008, height: 520 });
  });
});

describe("automation editor graph validation", () => {
  it("supports authenticated webhook triggers while blocking malformed privileged nodes", () => {
    const initial = sampleDefinition();
    const invalid: AutomationEditorDefinition = {
      ...initial,
      trigger: { kind: "webhook", route: "/hooks/sample" },
      nodes: [
        ...initial.nodes,
        { id: "agent", kind: "agent.run", config: {} },
        { id: "shell", kind: "shell.scoped", config: {} },
        {
          id: "external-wait",
          kind: "transform",
          config: { waitForExternalSignal: true },
        },
      ],
    };

    expect(validateAutomationEditorDefinition(invalid)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "node.config.invalid",
          nodeIds: ["agent"],
          severity: "error",
        }),
        expect.objectContaining({
          code: "node.config.invalid",
          nodeIds: ["shell"],
          severity: "error",
        }),
        expect.objectContaining({
          code: "v1.unsupported-external-wait",
          nodeIds: ["external-wait"],
          severity: "error",
        }),
      ]),
    );
    expect(validateAutomationEditorDefinition(invalid).map((issue) => issue.code)).not.toContain(
      "trigger.invalid",
    );
  });

  it("rejects malformed schedule and webhook trigger fields", () => {
    const invalidSchedule = {
      ...sampleDefinition(),
      trigger: { kind: "schedule", expression: "every monday", timezone: "Not/AZone" },
    } as const satisfies AutomationEditorDefinition;
    const invalidWebhook = {
      ...sampleDefinition(),
      trigger: { kind: "webhook", route: "/hooks//weekly/" },
    } as const satisfies AutomationEditorDefinition;

    expect(validateAutomationEditorDefinition(invalidSchedule)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "trigger.invalid" })]),
    );
    expect(validateAutomationEditorDefinition(invalidWebhook)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "trigger.invalid" })]),
    );
  });

  it("blocks credential-shaped fields and host paths from private config commits", () => {
    const withCredential = {
      ...sampleDefinition(),
      nodes: [{ id: "unsafe", kind: "transform", config: { api_token: "sample" } }],
      edges: [],
      layout: { nodes: { unsafe: { x: 80, y: 80 } } },
    } as const satisfies AutomationEditorDefinition;
    const withPath = {
      ...withCredential,
      nodes: [
        {
          id: "unsafe",
          kind: "transform",
          config: { source: ["", "home", "user", "file"].join("/") },
        },
      ],
    } as const satisfies AutomationEditorDefinition;

    expect(validateAutomationEditorDefinition(withCredential)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "node.config.private-data" })]),
    );
    expect(validateAutomationEditorDefinition(withPath)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "node.config.private-data" })]),
    );
  });

  it("finds duplicate nodes, duplicate edges, and missing endpoints", () => {
    const initial = sampleDefinition();
    const invalid: AutomationEditorDefinition = {
      ...initial,
      nodes: [...initial.nodes, initial.nodes[0]!],
      edges: [
        ...initial.edges,
        initial.edges[0]!,
        { from: "missing", to: "draft" },
        { from: "draft", to: "gone" },
      ],
    };

    expect(validateAutomationEditorDefinition(invalid).map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "graph.duplicate-node",
        "graph.duplicate-edge",
        "graph.unknown-edge-source",
        "graph.unknown-edge-target",
      ]),
    );
  });

  it("finds cycles and reports generated layout positions as non-blocking notices", () => {
    const initial = sampleDefinition();
    const cyclic: AutomationEditorDefinition = {
      ...initial,
      edges: [...initial.edges, { from: "review", to: "collect" }],
      layout: {},
    };
    const issues = validateAutomationEditorDefinition(cyclic);

    expect(issues).toContainEqual(
      expect.objectContaining({
        code: "graph.cycle",
        nodeIds: ["collect", "draft", "review"],
        severity: "error",
      }),
    );
    expect(issues.filter((issue) => issue.code === "layout.invalid-position")).toHaveLength(3);
    expect(
      issues
        .filter((issue) => issue.code === "layout.invalid-position")
        .every((issue) => issue.severity === "warning"),
    ).toBe(true);
  });
});
