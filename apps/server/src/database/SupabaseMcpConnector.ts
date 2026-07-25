// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  DatabaseToolError,
  type ProjectId,
  type ServerSettings,
  type ServerSettingsError,
  type SupabaseDatabaseConnection,
  type SupabaseToolProxyResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettingsModule from "../serverSettings.ts";

export type SupabaseRemoteToolName =
  | "list_tables"
  | "list_extensions"
  | "list_migrations"
  | "apply_migration"
  | "execute_sql"
  | "get_advisors"
  | "get_project_url"
  | "get_publishable_keys"
  | "generate_typescript_types";

export interface ResolvedSupabaseConnection {
  readonly projectId: string;
  readonly connection: SupabaseDatabaseConnection;
}

export interface SupabaseRemoteCallInput {
  readonly connection: SupabaseDatabaseConnection;
  readonly tool: SupabaseRemoteToolName;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export type SupabaseRemoteCall = (input: SupabaseRemoteCallInput) => Promise<unknown>;

export function buildSupabaseMcpUrl(connection: SupabaseDatabaseConnection): URL {
  const url = new URL("https://mcp.supabase.com/mcp");
  url.searchParams.set("project_ref", connection.projectRef);
  url.searchParams.set("features", "database,debugging,development");
  if (connection.readOnly) url.searchParams.set("read_only", "true");
  return url;
}

function pathContains(root: string, candidate: string): boolean {
  const relative = NodePath.relative(NodePath.resolve(root), NodePath.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

export function resolveSupabaseConnectionForCwd(
  connections: ServerSettings["databaseConnections"],
  cwd: string,
): ResolvedSupabaseConnection | undefined {
  return Object.entries(connections)
    .filter(([, connection]) => pathContains(connection.workspaceRoot, cwd))
    .sort(
      ([, left], [, right]) =>
        NodePath.resolve(right.workspaceRoot).length - NodePath.resolve(left.workspaceRoot).length,
    )
    .map(([projectId, connection]) => ({ projectId, connection }))[0];
}

export function resolveSupabaseConnection(
  connections: ServerSettings["databaseConnections"],
  input: { readonly projectId?: ProjectId; readonly cwd?: string },
): ResolvedSupabaseConnection | undefined {
  if (input.projectId !== undefined) {
    const connection = connections[input.projectId];
    if (connection !== undefined) return { projectId: input.projectId, connection };
  }
  return input.cwd === undefined
    ? undefined
    : resolveSupabaseConnectionForCwd(connections, input.cwd);
}

const defaultRemoteCall: SupabaseRemoteCall = async ({ connection, tool, arguments: args }) => {
  const client = new Client({
    name: "t3-code-supabase-proxy",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(buildSupabaseMcpUrl(connection), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${connection.accessToken}`,
      },
    },
  });
  try {
    await client.connect(transport as Parameters<Client["connect"]>[0]);
    return await client.callTool({ name: tool, arguments: { ...args } }, undefined, {
      timeout: 30_000,
    });
  } finally {
    await client.close().catch(() => undefined);
  }
};

export interface SupabaseMcpConnectorShape {
  readonly callTool: (input: {
    readonly projectId?: ProjectId;
    readonly cwd?: string;
    readonly tool: SupabaseRemoteToolName;
    readonly arguments: Readonly<Record<string, unknown>>;
  }) => Effect.Effect<SupabaseToolProxyResult, DatabaseToolError>;
}

export function makeSupabaseMcpConnector(input: {
  readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;
  readonly remoteCall?: SupabaseRemoteCall;
}): SupabaseMcpConnectorShape {
  const remoteCall = input.remoteCall ?? defaultRemoteCall;
  return {
    callTool: Effect.fn("SupabaseMcpConnector.callTool")(function* (request) {
      const settings = yield* input.getSettings.pipe(
        Effect.mapError(
          () =>
            new DatabaseToolError({
              reason: "remote-unavailable",
              message: "Database settings are temporarily unavailable.",
            }),
        ),
      );
      const resolved = resolveSupabaseConnection(settings.databaseConnections, request);
      if (!resolved) {
        return yield* new DatabaseToolError({
          reason: "not-configured",
          message: "This thread's project is not connected to a Supabase project.",
        });
      }
      const { connection } = resolved;
      if (connection.accessToken.length === 0) {
        return yield* new DatabaseToolError({
          reason: "credential-missing",
          message: "The Supabase connection does not have a configured access token.",
        });
      }
      if (connection.readOnly && request.tool === "apply_migration") {
        return yield* new DatabaseToolError({
          reason: "read-only",
          message: "This Supabase connection is read-only. Enable write access in Settings first.",
        });
      }

      const result = yield* Effect.tryPromise({
        try: () =>
          remoteCall({
            connection,
            tool: request.tool,
            arguments: request.arguments,
          }),
        catch: () =>
          new DatabaseToolError({
            reason: "remote-error",
            message:
              "Supabase rejected the request or could not be reached. Check the project reference and access token.",
          }),
      });
      return {
        projectRef: connection.projectRef,
        readOnly: connection.readOnly,
        result,
      };
    }),
  };
}

export class SupabaseMcpConnector extends Context.Service<
  SupabaseMcpConnector,
  SupabaseMcpConnectorShape
>()("t3/database/SupabaseMcpConnector") {}

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
  return SupabaseMcpConnector.of(
    makeSupabaseMcpConnector({
      getSettings: serverSettings.getSettings,
    }),
  );
});

export const layer = Layer.effect(SupabaseMcpConnector, make);
