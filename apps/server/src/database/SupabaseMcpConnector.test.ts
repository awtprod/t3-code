// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  buildSupabaseMcpUrl,
  makeSupabaseMcpConnector,
  resolveSupabaseConnection,
  resolveSupabaseConnectionForCwd,
} from "./SupabaseMcpConnector.ts";

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const connections = {
  [projectA]: {
    provider: "supabase" as const,
    workspaceRoot: "/work/repository",
    projectRef: "supabase-a",
    readOnly: true,
    accessToken: "sbp-secret-a",
    accessTokenRedacted: true,
  },
  [projectB]: {
    provider: "supabase" as const,
    workspaceRoot: "/work/repository/packages/nested",
    projectRef: "supabase-b",
    readOnly: false,
    accessToken: "sbp-secret-b",
    accessTokenRedacted: true,
  },
};

it("resolves exact project ids and the longest containing workspace without sibling escapes", () => {
  expect(
    resolveSupabaseConnection(connections, { projectId: projectA })?.connection.projectRef,
  ).toBe("supabase-a");
  expect(
    resolveSupabaseConnectionForCwd(
      connections,
      NodePath.join("/work/repository/packages/nested", "src"),
    )?.connection.projectRef,
  ).toBe("supabase-b");
  expect(resolveSupabaseConnectionForCwd(connections, "/work/repository-sibling")).toBeUndefined();
});

it("builds a project-scoped read-only Supabase MCP URL", () => {
  const url = buildSupabaseMcpUrl(connections[projectA]!);
  expect(url.origin + url.pathname).toBe("https://mcp.supabase.com/mcp");
  expect(url.searchParams.get("project_ref")).toBe("supabase-a");
  expect(url.searchParams.get("read_only")).toBe("true");
  expect(url.searchParams.get("features")).toBe("database,debugging,development");
  expect(url.toString()).not.toContain("sbp-secret-a");
});

it.effect("proxies scoped tools without returning the access token", () =>
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

    const result = yield* connector.callTool({
      projectId: projectA,
      cwd: "/unrelated/worktree",
      tool: "list_tables",
      arguments: { schemas: ["public"] },
    });

    expect(calls).toEqual([{ token: "sbp-secret-a", tool: "list_tables" }]);
    expect(result.projectRef).toBe("supabase-a");
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    expect(JSON.stringify(result)).not.toContain("sbp-secret-a");
  }),
);

it.effect("blocks migrations locally when the project connection is read-only", () =>
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
        tool: "apply_migration",
        arguments: { name: "create_users", query: "create table users(id bigint)" },
      }),
    );

    expect(error.reason).toBe("read-only");
    expect(remoteCalled).toBe(false);
  }),
);
