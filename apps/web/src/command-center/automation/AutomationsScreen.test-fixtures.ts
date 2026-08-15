import { Automation, Space } from "@command-center/core";
import * as Schema from "effect/Schema";

const decodeAutomation = Schema.decodeUnknownSync(Automation);
const decodeSpace = Schema.decodeUnknownSync(Space);

export const SAMPLE_AUTOMATION = decodeAutomation({
  id: "sample-weekly-brief",
  spaceId: "sample-space",
  name: "Sample weekly brief",
  version: 1,
  enabled: false,
  trigger: { type: "schedule", expression: "0 9 * * 1", timezone: "Etc/UTC" },
  nodes: [
    {
      id: "collect",
      kind: "connector.read",
      config: { source: "sample", options: { limit: 5 } },
      position: { x: 80, y: 120 },
    },
    {
      id: "draft",
      kind: "transform",
      config: { template: "sample-brief" },
      position: { x: 380, y: 120 },
    },
  ],
  edges: [{ sourceNodeId: "collect", targetNodeId: "draft" }],
  definitionDigest: `sha256:${"1".repeat(64)}`,
  configCommit: "sample-commit",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

export const SAMPLE_SPACE = decodeSpace({
  id: "sample-space",
  slug: "sample-space",
  displayName: "Sample Space",
  kind: "business",
  instructions: "",
  policy: {
    allowedCapabilities: ["cc.automations.read"],
    autoRunRiskLevels: ["low"],
  },
  connectionIds: [],
  repositories: [],
  aliases: [],
  lifecycle: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
