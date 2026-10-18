import { DatabaseToolError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as SupabaseMcpConnector from "../../../database/SupabaseMcpConnector.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MODEL_RESULT_LIMITS, capOpaqueResult } from "../../ToolResultBudget.ts";
import { SupabaseToolkit } from "./tools.ts";

const callSupabase = Effect.fn("SupabaseToolkit.call")(function* (
  tool: SupabaseMcpConnector.SupabaseRemoteToolName,
  args: Readonly<Record<string, unknown>>,
  access: "database.read" | "database.write",
) {
  const invocation = yield* McpInvocationContext.requireDatabaseCapability(access);
  if (invocation.projectId === undefined && invocation.cwd === undefined) {
    return yield* new DatabaseToolError({
      reason: "not-configured",
      message: "This thread does not have a project working directory.",
    });
  }
  const connector = yield* SupabaseMcpConnector.SupabaseMcpConnector;
  // `database` selects among the project's connections; it is never forwarded
  // to Supabase, whose tools do not know the field.
  const { database, ...remoteArgs } = args;
  const response = yield* connector.callTool({
    ...(invocation.projectId === undefined ? {} : { projectId: invocation.projectId }),
    ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
    ...(typeof database === "string" && database.trim().length > 0 ? { database } : {}),
    tool,
    arguments: remoteArgs,
  });
  const result = capOpaqueResult(response.result, {
    maxChars: MODEL_RESULT_LIMITS.supabaseChars,
    ...(tool === "execute_sql" ? { maxRows: MODEL_RESULT_LIMITS.supabaseRows } : {}),
  });
  return { ...response, result };
});

const read = (tool: SupabaseMcpConnector.SupabaseRemoteToolName) =>
  McpToolAccess.reads((input: Readonly<Record<string, unknown>>) =>
    callSupabase(tool, input, "database.read"),
  );
// Writes check the credential's `database.write` grant in `callSupabase`.
const write = (tool: SupabaseMcpConnector.SupabaseRemoteToolName) =>
  McpToolAccess.writesWithCapability((input: Readonly<Record<string, unknown>>) =>
    callSupabase(tool, input, "database.write"),
  );

/** Every Supabase tool declares its access (see `McpToolAccess`). */
export const SupabaseToolkitHandlersLive = McpToolAccess.toLayer(SupabaseToolkit, {
  supabase_list_tables: read("list_tables"),
  supabase_list_extensions: read("list_extensions"),
  supabase_list_migrations: read("list_migrations"),
  supabase_apply_migration: write("apply_migration"),
  supabase_execute_sql: write("execute_sql"),
  supabase_get_advisors: read("get_advisors"),
  supabase_get_project_url: read("get_project_url"),
  supabase_get_publishable_keys: read("get_publishable_keys"),
  supabase_generate_typescript_types: read("generate_typescript_types"),
});
