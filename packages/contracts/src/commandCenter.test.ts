import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  COMMAND_CENTER_WEBHOOK_MAX_PAYLOAD_BYTES,
  CommandCenterAutomationDefinitionCreateInput,
  CommandCenterAutomationWebhookAdmitInput,
  CommandCenterAutomationDefinitionSaveInput,
  CommandCenterAutomationDefinitionSnapshot,
  CommandCenterConnectionRefreshInput,
  CommandCenterItemUpdateInput,
  CommandCenterRunStartInput,
  CommandCenterRunStartResult,
} from "./commandCenter.ts";

const decodeSnapshot = Schema.decodeUnknownSync(CommandCenterAutomationDefinitionSnapshot);
const decodeCreate = Schema.decodeUnknownSync(CommandCenterAutomationDefinitionCreateInput);
const decodeSave = Schema.decodeUnknownSync(CommandCenterAutomationDefinitionSaveInput);
const decodeWebhook = Schema.decodeUnknownSync(CommandCenterAutomationWebhookAdmitInput);
const decodeRunStart = Schema.decodeUnknownSync(CommandCenterRunStartInput);
const decodeRunStartResult = Schema.decodeUnknownSync(CommandCenterRunStartResult);
const decodeItemUpdate = Schema.decodeUnknownSync(CommandCenterItemUpdateInput);
const decodeConnectionRefresh = Schema.decodeUnknownSync(CommandCenterConnectionRefreshInput);

const definition = {
  $schema: "../schemas/automation.schema.json",
  schemaVersion: 1,
  id: "sample-flow",
  name: "Sample flow",
  spaceId: "sample-space",
  enabled: false,
  trigger: { kind: "manual" },
  nodes: [{ id: "start", kind: "transform", config: { source: "sample" } }],
  edges: [],
  layout: { nodes: { start: { x: 80, y: 120 } } },
  policy: { requireApprovalForExternalWrites: true },
};

describe("Command Center automation definition contracts", () => {
  it("binds route acknowledgement and execution receipt to one durable Run", () => {
    expect(decodeRunStart({ runId: "run-example" })).toEqual({ runId: "run-example" });
    expect(
      decodeRunStartResult({
        runId: "run-example",
        projectId: "project-example",
        threadId: "thread-example",
        status: "running",
        duplicate: false,
      }),
    ).toMatchObject({ runId: "run-example", status: "running", duplicate: false });
  });

  it("round-trips exact private source fields without projecting policy away", () => {
    const snapshot = decodeSnapshot({
      automationId: "sample-flow",
      spaceId: "sample-space",
      definition,
      definitionDigest: `sha256:${"a".repeat(64)}`,
      configCommitSha: "b".repeat(40),
    });

    expect(snapshot.definition.$schema).toBe("../schemas/automation.schema.json");
    expect(snapshot.definition.policy).toEqual({ requireApprovalForExternalWrites: true });
  });

  it("rejects an unpinned optimistic-concurrency digest", () => {
    expect(() =>
      decodeSave({
        automationId: "sample-flow",
        spaceId: "sample-space",
        expectedDefinitionDigest: "latest",
        definition,
      }),
    ).toThrow();
  });

  it("keeps server-owned fields out of new-definition drafts", () => {
    expect(
      decodeCreate({
        requestId: "request-weekly-1",
        spaceId: "sample-space",
        preferredAutomationId: "weekly-brief",
        name: "Weekly brief",
        enabled: false,
        trigger: { kind: "schedule", expression: "0 9 * * 1", timezone: "UTC" },
        nodes: definition.nodes,
        edges: [],
        layout: definition.layout,
      }),
    ).not.toHaveProperty("policy");
    expect(() =>
      decodeCreate({
        requestId: "../unsafe",
        spaceId: "sample-space",
        name: "Weekly brief",
        enabled: false,
        trigger: { kind: "manual" },
        nodes: definition.nodes,
        edges: [],
        layout: {},
      }),
    ).toThrow();
    expect(() =>
      decodeCreate({
        requestId: "request-weekly-enabled",
        spaceId: "sample-space",
        name: "Weekly brief",
        enabled: true,
        trigger: { kind: "manual" },
        nodes: definition.nodes,
        edges: [],
        layout: {},
      }),
    ).toThrow();
  });

  it("accepts only canonical bounded webhook admissions", () => {
    expect(
      decodeWebhook({
        spaceId: "sample-space",
        route: "/hooks/weekly",
        deliveryId: "delivery-1",
        payload: { sample: true },
      }),
    ).toEqual({
      spaceId: "sample-space",
      route: "/hooks/weekly",
      deliveryId: "delivery-1",
      payload: { sample: true },
    });

    expect(() =>
      decodeWebhook({
        spaceId: "sample-space",
        route: "/hooks//weekly/",
        deliveryId: "delivery-1",
      }),
    ).toThrow();
    expect(() =>
      decodeWebhook({
        spaceId: "sample-space",
        route: "/hooks/weekly",
        deliveryId: "delivery-1",
        payload: { data: "x".repeat(COMMAND_CENTER_WEBHOOK_MAX_PAYLOAD_BYTES) },
      }),
    ).toThrow();
  });
});

describe("Command Center scoped mutation contracts", () => {
  it("requires an optimistic token and at least one canonical Item field", () => {
    expect(
      decodeItemUpdate({
        itemId: "item-example",
        spaceId: "space-example",
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
        patch: { status: "in_progress", description: null },
      }),
    ).toMatchObject({
      itemId: "item-example",
      spaceId: "space-example",
      patch: { status: "in_progress", description: null },
    });

    expect(() =>
      decodeItemUpdate({
        itemId: "item-example",
        spaceId: "space-example",
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
        patch: {},
      }),
    ).toThrow();
    expect(() =>
      decodeItemUpdate({
        itemId: "item-example",
        spaceId: "space-example",
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
        patch: { status: "unknown" },
      }),
    ).toThrow();
  });

  it("binds connection refresh to an exact Space and connection", () => {
    expect(
      decodeConnectionRefresh({
        spaceId: "space-example",
        connectionId: "google-example",
      }),
    ).toEqual({ spaceId: "space-example", connectionId: "google-example" });
  });
});
