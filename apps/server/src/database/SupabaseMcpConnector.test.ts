// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, DatabaseConnectionId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  buildSupabaseMcpUrl,
  makeSupabaseMcpConnector,
  resolveSupabaseConnection,
  resolveSupabaseConnectionsForScope,
  selectSupabaseConnection,
} from "./SupabaseMcpConnector.ts";

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const stagingId = DatabaseConnectionId.make("conn-staging");
const prodId = DatabaseConnectionId.make("conn-prod");
const nestedId = DatabaseConnectionId.make("conn-nested");

const staging = {
  provider: "supabase" as const,
  projectId: projectA,
  workspaceRoot: "/work/repository",
  label: "staging",
  isDefault: true,
  projectRef: "wgbouvlzujbsbeokyzgs",
  readOnly: true,
  accessToken: "sbp-secret-staging",
  accessTokenRedacted: true,
};
const prod = {
  ...staging,
  label: "prod",
  isDefault: false,
  projectRef: "nppgkgsugggafefdenuw",
  readOnly: false,
  accessToken: "sbp-secret-prod",
};
const nested = {
  provider: "supabase" as const,
  projectId: projectB,
  workspaceRoot: "/work/repository/packages/nested",
  label: "",
  isDefault: true,
  projectRef: "supabase-nested",
  readOnly: false,
  accessToken: "sbp-secret-nested",
  accessTokenRedacted: true,
};
const connections = { [stagingId]: staging, [prodId]: prod, [nestedId]: nested };

it("scopes candidates to the project, or to the deepest containing workspace by cwd", () => {
  expect(
    resolveSupabaseConnectionsForScope(connections, { projectId: projectA }).map(
      (entry) => entry.connectionId,
    ),
  ).toEqual([stagingId, prodId]);
  expect(
    resolveSupabaseConnectionsForScope(connections, {
      cwd: NodePath.join("/work/repository/packages/nested", "src"),
    }).map((entry) => entry.connectionId),
  ).toEqual([nestedId]);
  expect(
    resolveSupabaseConnectionsForScope(connections, { cwd: "/work/repository/src" }).map(
      (entry) => entry.connectionId,
    ),
  ).toEqual([stagingId, prodId]);
  expect(
    resolveSupabaseConnectionsForScope(connections, { cwd: "/work/repository-sibling" }),
  ).toEqual([]);
});

it("selects by label or project ref, falls back to the default, and reports ambiguity", () => {
  expect(selectSupabaseConnection(connections, { projectId: projectA, database: "Prod" })).toEqual({
    _tag: "resolved",
    resolved: { connectionId: prodId, connection: prod },
  });
  expect(
    selectSupabaseConnection(connections, {
      projectId: projectA,
      database: "nppgkgsugggafefdenuw",
    }),
  ).toMatchObject({ _tag: "resolved", resolved: { connectionId: prodId } });
  expect(selectSupabaseConnection(connections, { projectId: projectA })).toMatchObject({
    _tag: "resolved",
    resolved: { connectionId: stagingId },
  });
  expect(
    selectSupabaseConnection(connections, { projectId: projectA, database: "qa" }),
  ).toMatchObject({ _tag: "unknown", database: "qa" });
  expect(selectSupabaseConnection(connections, { projectId: ProjectId.make("none") })).toEqual({
    _tag: "none",
  });

  const noDefault = { [stagingId]: { ...staging, isDefault: false }, [prodId]: prod };
  expect(selectSupabaseConnection(noDefault, { projectId: projectA })).toMatchObject({
    _tag: "ambiguous",
  });
  // The single-connection lookup used for capability issuance follows the same rules.
  expect(resolveSupabaseConnection(noDefault, { projectId: projectA })).toBeUndefined();
  expect(resolveSupabaseConnection(connections, { projectId: projectB })?.connectionId).toBe(
    nestedId,
  );
});

it("builds a project-scoped read-only Supabase MCP URL", () => {
  const url = buildSupabaseMcpUrl(staging);
  expect(url.origin + url.pathname).toBe("https://mcp.supabase.com/mcp");
  expect(url.searchParams.get("project_ref")).toBe("wgbouvlzujbsbeokyzgs");
  expect(url.searchParams.get("read_only")).toBe("true");
  expect(url.searchParams.get("features")).toBe("database,debugging,development");
  expect(url.toString()).not.toContain("sbp-secret");
});

it.effect("proxies the named database's tools without returning the access token", () =>
  Effect.gen(function* () {
    const calls: Array<{ readonly token: string; readonly tool: string }> = [];
    const connector = makeSupabaseMcpConnector({
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        databaseConnections: connections,
      }),
      remoteCall: async ({ connection, tool }) => {
        calls.push({ token: connection.accessToken, tool });
        return { content: [{ type: "text", text: "ok" }] };
      },
    });

    const defaulted = yield* connector.callTool({
      projectId: projectA,
      cwd: "/unrelated/worktree",
      tool: "list_tables",
      arguments: { schemas: ["public"] },
    });
    const named = yield* connector.callTool({
      projectId: projectA,
      database: "prod",
      tool: "list_tables",
      arguments: {},
    });

    expect(calls).toEqual([
      { token: "sbp-secret-staging", tool: "list_tables" },
      { token: "sbp-secret-prod", tool: "list_tables" },
    ]);
    expect(defaulted).toMatchObject({
      connectionId: stagingId,
      database: "staging",
      projectRef: "wgbouvlzujbsbeokyzgs",
      readOnly: true,
    });
    expect(named).toMatchObject({ connectionId: prodId, database: "prod", readOnly: false });
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    expect(JSON.stringify([defaulted, named])).not.toContain("sbp-secret");
  }),
);

it.effect("explains ambiguity and unknown names instead of guessing a database", () =>
  Effect.gen(function* () {
    let remoteCalled = false;
    const connector = makeSupabaseMcpConnector({
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        databaseConnections: { [stagingId]: { ...staging, isDefault: false }, [prodId]: prod },
      }),
      remoteCall: async () => {
        remoteCalled = true;
        return {};
      },
    });

    const ambiguous = yield* Effect.flip(
      connector.callTool({ projectId: projectA, tool: "list_tables", arguments: {} }),
    );
    expect(ambiguous.reason).toBe("ambiguous");
    expect(ambiguous.message).toContain('"staging"');
    expect(ambiguous.message).toContain('"prod"');

    const unknown = yield* Effect.flip(
      connector.callTool({
        projectId: projectA,
        database: "qa",
        tool: "list_tables",
        arguments: {},
      }),
    );
    expect(unknown.reason).toBe("not-configured");
    expect(unknown.message).toContain('"qa"');
    expect(unknown.message).toContain("staging");
    expect(remoteCalled).toBe(false);
  }),
);

it.effect("blocks migrations locally when the selected connection is read-only", () =>
  Effect.gen(function* () {
    let remoteCalled = false;
    const connector = makeSupabaseMcpConnector({
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        databaseConnections: connections,
      }),
      remoteCall: async () => {
        remoteCalled = true;
        return {};
      },
    });

    const error = yield* Effect.flip(
      connector.callTool({
        projectId: projectA,
        database: "staging",
        tool: "apply_migration",
        arguments: { name: "create_users", query: "create table users(id bigint)" },
      }),
    );

    expect(error.reason).toBe("read-only");
    expect(error.message).toContain("staging");
    expect(remoteCalled).toBe(false);
  }),
);
