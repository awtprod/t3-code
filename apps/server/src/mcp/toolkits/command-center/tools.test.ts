import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { CommandCenterToolkit } from "./tools.ts";

it("exposes scoped automation create/save tools without any publication tool", () => {
  const tools = Object.values(CommandCenterToolkit.tools);
  const names = tools.map((tool) => tool.name);

  expect(names).toContain("cc_automations_create");
  expect(names).toContain("cc_automations_save");
  expect(names.some((name) => /push|publish/iu.test(name))).toBe(false);
  for (const name of ["cc_automations_create", "cc_automations_save"]) {
    const tool = tools.find((candidate) => candidate.name === name)!;
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: string;
      readonly properties?: Readonly<Record<string, unknown>>;
    };
    expect(schema.type).toBe("object");
    expect(schema.properties?.spaceId).toBeDefined();
    expect(schema.properties).not.toHaveProperty("path");
    expect(schema.properties).not.toHaveProperty("credential");
    expect(tool.description).toContain("never pushes");
  }
});

it("exposes a path-free, idempotent Prospector proposal boundary", () => {
  const tool = Object.values(CommandCenterToolkit.tools).find(
    (candidate) => candidate.name === "cc_sales_prospector_import",
  )!;
  const schema = Tool.getJsonSchema(tool) as {
    readonly type?: string;
    readonly properties?: Readonly<Record<string, unknown>>;
  };

  expect(schema.type).toBe("object");
  expect(schema.properties?.spaceId).toBeDefined();
  expect(schema.properties?.limit).toBeDefined();
  expect(schema.properties).not.toHaveProperty("path");
  expect(schema.properties).not.toHaveProperty("database");
  expect(tool.description).toContain("opened read-only");
  expect(tool.description).toContain("cannot approve outreach");
  expect(tool.description).toContain("send email");
});
