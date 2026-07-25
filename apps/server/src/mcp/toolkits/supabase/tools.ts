import { DatabaseToolError, SupabaseToolProxyResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as SupabaseMcpConnector from "../../../database/SupabaseMcpConnector.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  SupabaseMcpConnector.SupabaseMcpConnector,
];

const readonlyTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, true) as T;

const writeTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true)
    .annotate(Tool.Idempotent, false)
    .annotate(Tool.OpenWorld, true) as T;

const makeTool = <Name extends string, Parameters extends Schema.Top>(
  name: Name,
  title: string,
  description: string,
  parameters: Parameters,
  mode: "read" | "write",
) => {
  const tool = Tool.make(name, {
    description,
    parameters,
    success: SupabaseToolProxyResult,
    failure: DatabaseToolError,
    dependencies,
  }).annotate(Tool.Title, title);
  return mode === "read" ? readonlyTool(tool) : writeTool(tool);
};

export const SupabaseListTablesTool = makeTool(
  "supabase_list_tables",
  "List Supabase tables",
  "List tables in the Supabase project connected to this thread's local project.",
  Schema.Struct({
    schemas: Schema.optional(Schema.Array(Schema.String)),
    verbose: Schema.optional(Schema.Boolean),
  }),
  "read",
);

export const SupabaseListExtensionsTool = makeTool(
  "supabase_list_extensions",
  "List Supabase extensions",
  "List Postgres extensions in the Supabase project connected to this thread.",
  Schema.Struct({}),
  "read",
);

export const SupabaseListMigrationsTool = makeTool(
  "supabase_list_migrations",
  "List Supabase migrations",
  "List database migrations in the Supabase project connected to this thread.",
  Schema.Struct({}),
  "read",
);

export const SupabaseApplyMigrationTool = makeTool(
  "supabase_apply_migration",
  "Apply Supabase migration",
  "Apply a named SQL migration to the connected Supabase project. Unavailable for read-only connections.",
  Schema.Struct({ name: Schema.String, query: Schema.String }),
  "write",
);

export const SupabaseExecuteSqlTool = makeTool(
  "supabase_execute_sql",
  "Execute Supabase SQL",
  "Execute SQL against the connected Supabase project. In read-only mode, Supabase enforces read-only SQL.",
  Schema.Struct({ query: Schema.String }),
  "write",
);

export const SupabaseGetAdvisorsTool = makeTool(
  "supabase_get_advisors",
  "Get Supabase advisors",
  "Get security or performance advisors for the connected Supabase project.",
  Schema.Struct({ type: Schema.Literals(["security", "performance"]) }),
  "read",
);

export const SupabaseGetProjectUrlTool = makeTool(
  "supabase_get_project_url",
  "Get Supabase project URL",
  "Get the API URL for the connected Supabase project.",
  Schema.Struct({}),
  "read",
);

export const SupabaseGetPublishableKeysTool = makeTool(
  "supabase_get_publishable_keys",
  "Get Supabase publishable keys",
  "Get client-safe publishable API keys for the connected Supabase project.",
  Schema.Struct({}),
  "read",
);

export const SupabaseGenerateTypescriptTypesTool = makeTool(
  "supabase_generate_typescript_types",
  "Generate Supabase TypeScript types",
  "Generate TypeScript types from the connected Supabase project's database schema.",
  Schema.Struct({}),
  "read",
);

export const SupabaseToolkit = Toolkit.make(
  SupabaseListTablesTool,
  SupabaseListExtensionsTool,
  SupabaseListMigrationsTool,
  SupabaseApplyMigrationTool,
  SupabaseExecuteSqlTool,
  SupabaseGetAdvisorsTool,
  SupabaseGetProjectUrlTool,
  SupabaseGetPublishableKeysTool,
  SupabaseGenerateTypescriptTypesTool,
);
