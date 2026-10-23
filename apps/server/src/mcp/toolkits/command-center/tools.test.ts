import { expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";

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

it("advertises cc_memory_propose confidence as a plain bounded number", () => {
  const tool = Object.values(CommandCenterToolkit.tools).find(
    (candidate) => candidate.name === "cc_memory_propose",
  )!;
  const schema = Tool.getJsonSchema(tool) as {
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
  };
  expect(schema.properties?.confidence).toEqual({ type: "number", minimum: 0, maximum: 1 });
  expect(schema.required).toContain("confidence");
});

// `Schema.Number` advertises these string literals beside `number`, and models
// then send numbers as strings, which the tool rejects.
it("advertises no NaN or Infinity string literals in any tool input", () => {
  for (const tool of Object.values(CommandCenterToolkit.tools)) {
    expect(JSON.stringify(Tool.getJsonSchema(tool)), tool.name).not.toMatch(/"(?:-?Infinity|NaN)"/);
  }
});

it("advertises cc_google_draft_create as plain strings with no send path", () => {
  const tool = Object.values(CommandCenterToolkit.tools).find(
    (candidate) => candidate.name === "cc_google_draft_create",
  )!;
  const schema = Tool.getJsonSchema(tool) as {
    readonly type?: string;
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
  };
  expect(schema.type).toBe("object");
  expect(Object.keys(schema.properties ?? {}).toSorted()).toEqual([
    "body",
    "cc",
    "connectionId",
    "replyToMessageId",
    "spaceId",
    "subject",
    "threadId",
    "to",
  ]);
  expect([...(schema.required ?? [])].toSorted()).toEqual(["body", "spaceId", "subject", "to"]);
  const json = JSON.stringify(schema);
  expect(json).not.toMatch(/"type":"(?:number|integer)"/);
  expect(json).not.toMatch(/"(?:-?Infinity|NaN)"/);
  expect(tool.description).toContain("never sends");
  expect(tool.description).toContain("sends it from Gmail");
});
