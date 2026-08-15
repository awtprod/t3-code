import { describe, expect, it } from "@effect/vitest";

import {
  digestAutomationDefinition,
  planAutomationExecution,
  prepareAutomationSave,
  validateAutomationDefinition,
} from "./index.ts";

const sampleDefinition = () => ({
  schemaVersion: 1,
  id: " sample-weekly-brief ",
  name: " Sample weekly brief ",
  spaceId: " sample-space ",
  enabled: true,
  trigger: {
    kind: "schedule" as const,
    expression: "0 9 * * 1",
    timezone: "Etc/UTC",
  },
  nodes: [
    { id: " publish-summary ", kind: "item.mutate" as const, config: { mode: "create" } },
    { id: " collect-notes ", kind: "connector.read" as const, config: { source: "sample" } },
    { id: " draft-summary ", kind: "transform" as const, config: { template: "Summarize" } },
  ],
  edges: [
    { from: " draft-summary ", to: " publish-summary " },
    { from: " collect-notes ", to: " draft-summary " },
  ],
  layout: { zoom: 1, positions: { "draft-summary": { y: 20, x: 10 } } },
  policy: { approval: { external: true }, retries: 2 },
});

describe("automation definition validation", () => {
  it("normalizes identifiers, JSON keys, nodes, and edges", () => {
    const result = validateAutomationDefinition(sampleDefinition());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.id).toBe("sample-weekly-brief");
    expect(result.definition.spaceId).toBe("sample-space");
    expect(result.definition.nodes.map((node) => node.id)).toEqual([
      "collect-notes",
      "draft-summary",
      "publish-summary",
    ]);
    expect(Object.keys(result.definition.policy)).toEqual(["approval", "retries"]);
  });

  it("reports duplicate ids, missing edge endpoints, duplicate edges, and cycles", () => {
    const invalid = sampleDefinition();
    invalid.nodes.push({
      id: "collect-notes",
      kind: "connector.read",
      config: { source: "other-sample" },
    });
    invalid.edges.push(
      { from: "collect-notes", to: "draft-summary" },
      { from: "missing-node", to: "draft-summary" },
      { from: "collect-notes", to: "missing-target" },
    );

    const structural = validateAutomationDefinition(invalid);
    expect(structural.ok).toBe(false);
    if (structural.ok) return;
    expect(structural.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "graph.duplicate-node",
        "graph.duplicate-edge",
        "graph.unknown-edge-source",
        "graph.unknown-edge-target",
      ]),
    );

    const cyclic = sampleDefinition();
    cyclic.edges.push({ from: "publish-summary", to: "collect-notes" });
    const cycleResult = validateAutomationDefinition(cyclic);
    expect(cycleResult.ok).toBe(false);
    if (cycleResult.ok) return;
    expect(cycleResult.issues).toEqual([
      expect.objectContaining({
        code: "graph.cycle",
        nodeIds: ["collect-notes", "draft-summary", "publish-summary"],
      }),
    ]);
  });

  it("rejects non-JSON config values at the schema boundary", () => {
    const invalid = sampleDefinition();
    invalid.nodes[0]!.config = { mode: undefined } as never;

    const result = validateAutomationDefinition(invalid);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe("schema.invalid");

    const unsupportedVersion = { ...sampleDefinition(), schemaVersion: 2 };
    const versionResult = validateAutomationDefinition(unsupportedVersion);
    expect(versionResult.ok).toBe(false);
    if (versionResult.ok) return;
    expect(versionResult.issues[0]?.code).toBe("schema.invalid");
  });

  it("accepts normalized webhook triggers and still rejects external waits", () => {
    const webhook = sampleDefinition();
    webhook.trigger = { kind: "webhook", route: "/hooks/sample" } as never;
    const webhookResult = validateAutomationDefinition(webhook);
    expect(webhookResult.ok).toBe(true);
    if (webhookResult.ok) {
      expect(webhookResult.definition.trigger).toEqual({
        kind: "webhook",
        route: "/hooks/sample",
      });
    }

    const unsafeWebhook = sampleDefinition();
    unsafeWebhook.trigger = { kind: "webhook", route: "/hooks/../admin" } as never;
    const unsafeResult = validateAutomationDefinition(unsafeWebhook);
    expect(unsafeResult.ok).toBe(false);
    if (!unsafeResult.ok) {
      expect(unsafeResult.issues[0]?.code).toBe("schema.invalid");
    }

    const externalWait = sampleDefinition();
    externalWait.nodes[0]!.config = { waitForExternalSignal: true } as never;
    const waitResult = validateAutomationDefinition(externalWait);
    expect(waitResult.ok).toBe(false);
    if (!waitResult.ok) {
      expect(waitResult.issues).toContainEqual(
        expect.objectContaining({
          code: "v1.unsupported-external-wait",
          nodeIds: ["publish-summary"],
        }),
      );
    }
  });

  it("accepts typed agent Runs and manifest-only scoped shell references", () => {
    const agent = sampleDefinition();
    agent.nodes[0]!.kind = "agent.run" as never;
    agent.nodes[0]!.config = {
      prompt: "Review {{predecessors.draft-summary}}",
      repositoryId: "sample-repository",
      providerId: "codex-primary",
      modelId: "sample-model",
    } as never;
    expect(validateAutomationDefinition(agent).ok).toBe(true);

    const injected = sampleDefinition();
    injected.nodes[0]!.kind = "agent.run" as never;
    injected.nodes[0]!.config = { prompt: "Review", spaceId: "another-space" } as never;
    const injectedResult = validateAutomationDefinition(injected);
    expect(injectedResult.ok).toBe(false);
    if (!injectedResult.ok) {
      expect(injectedResult.issues).toContainEqual(
        expect.objectContaining({
          code: "node.config.invalid",
          nodeIds: ["publish-summary"],
          path: ["nodes", 0, "config"],
        }),
      );
    }

    const shell = sampleDefinition();
    shell.nodes[0]!.kind = "shell.scoped" as never;
    shell.nodes[0]!.config = { allowlistId: "sample.read" } as never;
    expect(validateAutomationDefinition(shell).ok).toBe(true);

    const selfAuthorizing = sampleDefinition();
    selfAuthorizing.nodes[0]!.kind = "shell.scoped" as never;
    selfAuthorizing.nodes[0]!.config = {
      allowlistId: "sample.read",
      executable: "/bin/sh",
      argv: ["-c", "anything"],
      cwd: "/",
      allowedRoots: ["/"],
    } as never;
    const shellResult = validateAutomationDefinition(selfAuthorizing);
    expect(shellResult.ok).toBe(false);
    if (!shellResult.ok) {
      expect(shellResult.issues).toContainEqual(
        expect.objectContaining({
          code: "node.config.invalid",
          nodeIds: ["publish-summary"],
          path: ["nodes", 0, "config"],
        }),
      );
    }
  });
});

describe("automation digest and planner", () => {
  it("produces the same digest for equivalent object, node, and edge ordering", () => {
    const first = validateAutomationDefinition(sampleDefinition());
    const reorderedInput = sampleDefinition();
    reorderedInput.nodes.reverse();
    reorderedInput.edges.reverse();
    reorderedInput.policy = { retries: 2, approval: { external: true } };
    const second = validateAutomationDefinition(reorderedInput);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(digestAutomationDefinition(first.definition)).toBe(
      digestAutomationDefinition(second.definition),
    );
    expect(digestAutomationDefinition(first.definition)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("returns deterministic stages and only dependency-ready nodes", () => {
    const parallel = sampleDefinition();
    parallel.nodes.push({
      id: "collect-events",
      kind: "connector.read",
      config: { source: "sample-calendar" },
    });
    parallel.edges.push({ from: "collect-events", to: "draft-summary" });

    const initial = planAutomationExecution(parallel);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    expect(initial.plan.stages.map((stage) => stage.map((node) => node.id))).toEqual([
      ["collect-events", "collect-notes"],
      ["draft-summary"],
      ["publish-summary"],
    ]);
    expect(initial.plan.readyNodes.map((node) => node.id)).toEqual([
      "collect-events",
      "collect-notes",
    ]);

    const resumed = planAutomationExecution(parallel, {
      completedNodeIds: ["collect-notes"],
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.plan.readyNodes.map((node) => node.id)).toEqual(["collect-events"]);
    expect(resumed.plan.blockedNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ waitingForNodeIds: ["collect-events"] }),
        expect.objectContaining({ waitingForNodeIds: ["draft-summary"] }),
      ]),
    );
  });

  it("rejects execution state from another definition", () => {
    const result = planAutomationExecution(sampleDefinition(), {
      completedNodeIds: ["unrelated-node"],
    });
    expect(result).toEqual({
      ok: false,
      issues: [expect.objectContaining({ code: "state.unknown-node" })],
    });
  });
});

describe("expected-digest save protection", () => {
  it("saves drafts without applying semantic validation", () => {
    const incomplete = sampleDefinition();
    incomplete.nodes[0]!.kind = "connector.write" as never;
    incomplete.nodes[0]!.config = { operation: "gmail.draft.create" } as never;
    expect(
      prepareAutomationSave({
        expectedDigest: null,
        currentDefinition: null,
        nextDefinition: incomplete,
      }).status,
    ).toBe("ready");

    const unsafe = sampleDefinition();
    unsafe.nodes[0]!.config = { apiKey: "must-not-be-committed" } as never;
    expect(
      prepareAutomationSave({
        expectedDigest: null,
        currentDefinition: null,
        nextDefinition: unsafe,
      }).status,
    ).toBe("ready");
  });

  it("saves typed agent and manifest-only shell definitions", () => {
    const agent = sampleDefinition();
    agent.nodes[0]!.kind = "agent.run" as never;
    agent.nodes[0]!.config = { prompt: "Review the generated summary" } as never;
    expect(
      prepareAutomationSave({
        expectedDigest: null,
        currentDefinition: null,
        nextDefinition: agent,
      }).status,
    ).toBe("ready");

    const shell = sampleDefinition();
    shell.nodes[0]!.kind = "shell.scoped" as never;
    shell.nodes[0]!.config = { allowlistId: "sample.read" } as never;
    expect(
      prepareAutomationSave({
        expectedDigest: null,
        currentDefinition: null,
        nextDefinition: shell,
      }).status,
    ).toBe("ready");
  });

  it("allows create and update only against the observed digest", () => {
    const created = prepareAutomationSave({
      expectedDigest: null,
      currentDefinition: null,
      nextDefinition: sampleDefinition(),
    });
    expect(created.status).toBe("ready");
    if (created.status !== "ready") return;

    const changed = sampleDefinition();
    changed.name = "Revised sample weekly brief";
    const updated = prepareAutomationSave({
      expectedDigest: created.nextDigest,
      currentDefinition: sampleDefinition(),
      nextDefinition: changed,
    });
    expect(updated.status).toBe("ready");
    if (updated.status !== "ready") return;
    expect(updated.nextDigest).not.toBe(created.nextDigest);
  });

  it("returns a conflict before a stale writer can overwrite the file", () => {
    const current = validateAutomationDefinition(sampleDefinition());
    expect(current.ok).toBe(true);
    if (!current.ok) return;

    const result = prepareAutomationSave({
      expectedDigest: `sha256:${"0".repeat(64)}`,
      currentDefinition: current.definition,
      nextDefinition: sampleDefinition(),
    });
    expect(result).toEqual({
      status: "conflict",
      expectedDigest: `sha256:${"0".repeat(64)}`,
      currentDigest: digestAutomationDefinition(current.definition),
    });
  });
});
