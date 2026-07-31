import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import { SupabaseToolkit } from "./tools.ts";

it("exposes project-scoped Supabase tools without credential or project selectors", () => {
  const tools = Object.values(SupabaseToolkit.tools);
  const names = tools.map((tool) => tool.name);

  expect(names).toEqual([
    "supabase_list_tables",
    "supabase_list_extensions",
    "supabase_list_migrations",
    "supabase_apply_migration",
    "supabase_execute_sql",
    "supabase_get_advisors",
    "supabase_get_project_url",
    "supabase_get_publishable_keys",
    "supabase_generate_typescript_types",
  ]);

  for (const tool of tools) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly properties?: Readonly<Record<string, unknown>>;
    };
    expect(schema.properties ?? {}).not.toHaveProperty("projectRef");
    expect(schema.properties ?? {}).not.toHaveProperty("accessToken");
    expect(Context.get(tool.annotations, Tool.OpenWorld)).toBe(true);
  }

  const listTables = tools.find((tool) => tool.name === "supabase_list_tables")!;
  const listTablesSchema = Tool.getJsonSchema(listTables) as {
    readonly type?: string;
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  expect(listTablesSchema.type).toBe("object");
  expect(listTablesSchema.properties).toHaveProperty("schemas");
  expect(listTablesSchema.properties).toHaveProperty("verbose");
});
