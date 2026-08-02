import { expect, it } from "@effect/vitest";
import { Space } from "@command-center/core";
import * as Schema from "effect/Schema";

const decodeSpace = Schema.decodeUnknownSync(Space);

it("preserves the feature-disabled Space contract without adding fields", () => {
  const legacy = {
    id: "ordinary-space",
    slug: "ordinary-space",
    displayName: "Ordinary Space",
    kind: "business",
    instructions: "Existing behavior",
    policy: {
      allowedCapabilities: ["cc.items.read"],
      autoRunRiskLevels: ["low"],
    },
    connectionIds: [],
    repositories: [],
    aliases: [],
    lifecycle: "active",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  } as const;

  const decoded = decodeSpace(legacy);

  expect(decoded).toEqual(legacy);
  expect(Object.hasOwn(decoded, "features")).toBe(false);
});

it("decodes the sales feature only when explicitly enabled", () => {
  const enabled = decodeSpace({
    id: "sales-space",
    slug: "sales-space",
    displayName: "Sales",
    kind: "business",
    instructions: "Agency sales",
    policy: {
      allowedCapabilities: ["cc.sales.read", "cc.sales.propose", "cc.sales.write"],
      autoRunRiskLevels: ["low"],
    },
    features: { salesPipeline: true },
    connectionIds: [],
    repositories: [],
    aliases: [],
    lifecycle: "active",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  });

  expect(enabled.features?.salesPipeline).toBe(true);
});
