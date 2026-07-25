import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as SupabaseMcpConnector from "../../../database/SupabaseMcpConnector.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

it.effect("routes a Supabase tool through the credential-bound project scope", () => {
  const calls: Array<SupabaseMcpConnector.SupabaseRemoteToolName> = [];
  const connector = SupabaseMcpConnector.SupabaseMcpConnector.of({
    callTool: (input) => {
      calls.push(input.tool);
      return Effect.succeed({
        projectRef: "supabase-a",
        readOnly: true,
        result: { content: [{ type: "text", text: "ok" }] },
      });
    },
  });
  const invocation = McpInvocationContext.McpInvocationContext.of({
    environmentId: EnvironmentId.make("environment-a"),
    threadId: ThreadId.make("thread-a"),
    providerSessionId: "provider-session-a",
    providerInstanceId: ProviderInstanceId.make("codex"),
    projectId: ProjectId.make("project-a"),
    cwd: "/work/project-a-worktree",
    capabilities: new Set(["preview"]),
    issuedAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
  const client = McpSchema.McpServerClient.of({
    clientId: 1,
    initializePayload: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "supabase-handler-test", version: "1.0.0" },
    },
    getClient: Effect.die("unused"),
  });
  const testLayer = McpHttpServer.SupabaseToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(Layer.succeed(SupabaseMcpConnector.SupabaseMcpConnector, connector)),
  );

  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "supabase_list_tables",
        arguments: { schemas: ["public"] },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      projectRef: "supabase-a",
      readOnly: true,
    });
    expect(calls).toEqual(["list_tables"]);
  }).pipe(Effect.provide(testLayer));
});
