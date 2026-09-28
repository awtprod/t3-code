// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  DatabaseToolError,
  databaseConnectionDisplayName,
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
  readonly connectionId: string;
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

function entries(connections: ServerSettings["databaseConnections"]) {
  return Object.entries(connections).map(
    ([connectionId, connection]): ResolvedSupabaseConnection => ({ connectionId, connection }),
  );
}

/**
 * Every connection a thread may use: those bound to its project, or, when the
 * thread has no project, those whose workspace root contains its directory.
 * The cwd fallback keeps only the deepest matching workspace so a nested
 * project's databases shadow its parent's.
 */
export function resolveSupabaseConnectionsForScope(
  connections: ServerSettings["databaseConnections"],
  input: { readonly projectId?: ProjectId; readonly cwd?: string },
): ReadonlyArray<ResolvedSupabaseConnection> {
  if (input.projectId !== undefined) {
    const byProject = entries(connections).filter(
      (entry) => entry.connection.projectId === input.projectId,
    );
    if (byProject.length > 0) return byProject;
  }
  if (input.cwd === undefined) return [];
  const cwd = input.cwd;
  const containing = entries(connections).filter((entry) =>
    pathContains(entry.connection.workspaceRoot, cwd),
  );
  if (containing.length === 0) return [];
  const deepest = Math.max(
    ...containing.map((entry) => NodePath.resolve(entry.connection.workspaceRoot).length),
  );
  return containing.filter(
    (entry) => NodePath.resolve(entry.connection.workspaceRoot).length === deepest,
  );
}

export type SupabaseConnectionSelection =
  | { readonly _tag: "resolved"; readonly resolved: ResolvedSupabaseConnection }
  | { readonly _tag: "none" }
  | {
      readonly _tag: "ambiguous";
      readonly candidates: ReadonlyArray<ResolvedSupabaseConnection>;
    }
  | {
      readonly _tag: "unknown";
      readonly database: string;
      readonly candidates: ReadonlyArray<ResolvedSupabaseConnection>;
    };

/**
 * Pick one connection for a tool call. `database` matches a connection's label
 * or project ref (case-insensitive) among the thread's candidates. Without it,
 * a single candidate or the project's default wins; several candidates with no
 * default is ambiguous and the caller must name one.
 */
export function selectSupabaseConnection(
  connections: ServerSettings["databaseConnections"],
  input: { readonly projectId?: ProjectId; readonly cwd?: string; readonly database?: string },
): SupabaseConnectionSelection {
  const candidates = resolveSupabaseConnectionsForScope(connections, input);
  if (candidates.length === 0) return { _tag: "none" };
  const requested = input.database?.trim().toLowerCase() ?? "";
  if (requested.length > 0) {
    const match =
      candidates.find((entry) => entry.connection.label.toLowerCase() === requested) ??
      candidates.find((entry) => entry.connection.projectRef.toLowerCase() === requested) ??
      candidates.find((entry) => entry.connectionId.toLowerCase() === requested);
    return match === undefined
      ? { _tag: "unknown", database: input.database!.trim(), candidates }
      : { _tag: "resolved", resolved: match };
  }
  if (candidates.length === 1) return { _tag: "resolved", resolved: candidates[0]! };
  const fallback = candidates.find((entry) => entry.connection.isDefault);
  return fallback === undefined
    ? { _tag: "ambiguous", candidates }
    : { _tag: "resolved", resolved: fallback };
}

/** Backwards-compatible single-connection lookup used by capability issuance. */
export function resolveSupabaseConnection(
  connections: ServerSettings["databaseConnections"],
  input: { readonly projectId?: ProjectId; readonly cwd?: string },
): ResolvedSupabaseConnection | undefined {
  const selection = selectSupabaseConnection(connections, input);
  return selection._tag === "resolved" ? selection.resolved : undefined;
}

const describeCandidates = (candidates: ReadonlyArray<ResolvedSupabaseConnection>): string =>
  candidates
    .map((entry) => {
      const name = databaseConnectionDisplayName(entry.connection);
      const access = entry.connection.readOnly ? "read-only" : "write";
      const suffix = entry.connection.isDefault ? ", default" : "";
      return `"${name}" (${entry.connection.projectRef}, ${access}${suffix})`;
    })
    .join(", ");

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
    /** Label or project ref of the database to use when the project has several. */
    readonly database?: string;
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
      const selection = selectSupabaseConnection(settings.databaseConnections, request);
      if (selection._tag === "none") {
        return yield* new DatabaseToolError({
          reason: "not-configured",
          message: "This thread's project is not connected to a Supabase project.",
        });
      }
      if (selection._tag === "ambiguous") {
        return yield* new DatabaseToolError({
          reason: "ambiguous",
          message: `This project has several Supabase databases and no default. Pass database=<name> with one of: ${describeCandidates(selection.candidates)}.`,
        });
      }
      if (selection._tag === "unknown") {
        return yield* new DatabaseToolError({
          reason: "not-configured",
          message: `No Supabase database named "${selection.database}" is connected to this project. Available: ${describeCandidates(selection.candidates)}.`,
        });
      }
      const { connectionId, connection } = selection.resolved;
      if (connection.accessToken.length === 0) {
        return yield* new DatabaseToolError({
          reason: "credential-missing",
          message: "The Supabase connection does not have a configured access token.",
        });
      }
      if (connection.readOnly && request.tool === "apply_migration") {
        return yield* new DatabaseToolError({
          reason: "read-only",
          message: `The "${databaseConnectionDisplayName(connection)}" Supabase connection is read-only. Enable write access in Settings first.`,
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
        connectionId,
        database: databaseConnectionDisplayName(connection),
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
>()("@awtprod/command-center/database/SupabaseMcpConnector") {}

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
  return SupabaseMcpConnector.of(
    makeSupabaseMcpConnector({
      getSettings: serverSettings.getSettings,
    }),
  );
});

export const layer = Layer.effect(SupabaseMcpConnector, make);
