import { expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";

import * as Context from "effect/Context";

import { capabilitiesAllow, requiredCapabilityFromMeta } from "../../ToolCapability.ts";
import { PreviewSnapshotToolkit, PreviewStandardToolkit, PreviewToolkit } from "./tools.ts";

const schemaHasMultipleAllOfDescriptions = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  const allOf = Array.isArray(record.allOf) ? record.allOf : [];
  const descriptionCount = allOf.filter(
    (member) =>
      member !== null &&
      typeof member === "object" &&
      typeof (member as Record<string, unknown>).description === "string",
  ).length;
  return descriptionCount > 1 || Object.values(record).some(schemaHasMultipleAllOfDescriptions);
};

it("exports provider-compatible object schemas", () => {
  for (const tool of Object.values(PreviewToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
    if (tool.name === "preview_navigate") {
      expect(schemaHasMultipleAllOfDescriptions(schema)).toBe(false);
    }
    expect(
      schema.properties?.tabId,
      `${tool.name} must allow an explicit collaborative browser tab target`,
    ).toBeDefined();
  }
});

it("hides every preview tool from credentials without browser access", () => {
  const tools = [PreviewToolkit, PreviewStandardToolkit, PreviewSnapshotToolkit].flatMap(
    (toolkit) => Object.values(toolkit.tools),
  );
  expect(tools.length).toBeGreaterThan(0);
  for (const tool of tools) {
    const required = requiredCapabilityFromMeta(
      Context.getOrUndefined(tool.annotations, Tool.Meta),
    );
    expect(required, `${tool.name} must require the preview capability`).toBe("preview");
    expect(
      capabilitiesAllow(required, new Set(["orchestration", "worktree", "pull-requests"])),
    ).toBe(false);
    expect(capabilitiesAllow(required, new Set(["preview"]))).toBe(true);
  }
});
