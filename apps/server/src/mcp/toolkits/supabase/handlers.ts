import { DatabaseToolError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as SupabaseMcpConnector from "../../../database/SupabaseMcpConnector.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { SupabaseToolkit } from "./tools.ts";

const callSupabase = Effect.fn("SupabaseToolkit.call")(function* (
  tool: SupabaseMcpConnector.SupabaseRemoteToolName,
  args: Readonly<Record<string, unknown>>,
) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (invocation.projectId === undefined && invocation.cwd === undefined) {
    return yield* new DatabaseToolError({
      reason: "not-configured",
      message: "This thread does not have a project working directory.",
    });
  }
  const connector = yield* SupabaseMcpConnector.SupabaseMcpConnector;
  return yield* connector.callTool({
    ...(invocation.projectId === undefined ? {} : { projectId: invocation.projectId }),
    ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
    tool,
    arguments: args,
  });
});

const handlers = SupabaseToolkit.of({
  supabase_list_tables: (input) => callSupabase("list_tables", input),
  supabase_list_extensions: (input) => callSupabase("list_extensions", input),
  supabase_list_migrations: (input) => callSupabase("list_migrations", input),
  supabase_apply_migration: (input) => callSupabase("apply_migration", input),
  supabase_execute_sql: (input) => callSupabase("execute_sql", input),
  supabase_get_advisors: (input) => callSupabase("get_advisors", input),
  supabase_get_project_url: (input) => callSupabase("get_project_url", input),
  supabase_get_publishable_keys: (input) => callSupabase("get_publishable_keys", input),
  supabase_generate_typescript_types: (input) => callSupabase("generate_typescript_types", input),
} satisfies Parameters<typeof SupabaseToolkit.toLayer>[0]);

export const SupabaseToolkitHandlersLive = SupabaseToolkit.toLayer(handlers);
