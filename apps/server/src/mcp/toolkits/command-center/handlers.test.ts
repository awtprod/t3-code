import { describe, expect, it } from "@effect/vitest";
import { RepositoryId, SpaceId } from "@command-center/core";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Tool } from "effect/unstable/ai";

import * as AutomationRuns from "../../../command-center/AutomationRuns.ts";
import * as GoogleReadConnector from "../../../command-center/GoogleReadConnector.ts";
import * as MemorySearchIndex from "../../../command-center/MemorySearchIndex.ts";
import * as ReadinessGate from "../../../command-center/ReadinessGate.ts";
import * as CommandCenterService from "../../../command-center/Service.ts";
import * as SpaceActivity from "../../../command-center/SpaceActivity.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

import {
  automationDefinitionFitsScope,
  automationDefinitionIsSafeForAuthoring,
  automationReplacementFitsScope,
  automationSaveRequiresRunCapability,
  filterAutomationsForScope,
  filterRunsAndApprovalsForScope,
  memoryWriteOperationForScope,
  memoryVisibleToScope,
  resolveProposedMemoryRepository,
  resolveRunStartScope,
  CommandCenterToolkitHandlersLive,
} from "./handlers.ts";
import { CommandCenterSpaceActivityTool, CommandCenterToolkit } from "./tools.ts";

describe("Command Center MCP repository scopes", () => {
  it("shows Space Memory plus only the credential's exact repository Memory", () => {
    const scope = { spaceId: "space-a", repositoryId: "repo-a" };
    expect(memoryVisibleToScope({ spaceId: "space-a" }, scope)).toBe(true);
    expect(memoryVisibleToScope({ spaceId: "space-a", repositoryId: "repo-a" }, scope)).toBe(true);
    expect(memoryVisibleToScope({ spaceId: "space-a", repositoryId: "repo-b" }, scope)).toBe(false);
    expect(memoryVisibleToScope({ spaceId: "space-b" }, scope)).toBe(false);
  });

  it("does not expose repository Memory to a Space-only credential", () => {
    const scope = { spaceId: "space-a" };
    expect(memoryVisibleToScope({ spaceId: "space-a" }, scope)).toBe(true);
    expect(memoryVisibleToScope({ spaceId: "space-a", repositoryId: "repo-a" }, scope)).toBe(false);
  });

  it("binds proposals to the credential repository and denies cross-repository targets", () => {
    expect(resolveProposedMemoryRepository(undefined, "repo-a")).toEqual({
      allowed: true,
      repositoryId: "repo-a",
    });
    expect(resolveProposedMemoryRepository("repo-a", "repo-a")).toEqual({
      allowed: true,
      repositoryId: "repo-a",
    });
    expect(resolveProposedMemoryRepository("repo-b", "repo-a")).toEqual({ allowed: false });
    expect(resolveProposedMemoryRepository("repo-a", undefined)).toEqual({ allowed: false });
  });

  it("rejects host paths and credential-shaped fields from authoring input", () => {
    expect(
      automationDefinitionIsSafeForAuthoring({
        nodes: [{ config: { template: "weekly summary", repositoryId: "repo-a" } }],
      }),
    ).toBe(true);
    expect(
      automationDefinitionIsSafeForAuthoring({
        nodes: [{ config: { nested: { api_key: "do-not-store" } } }],
      }),
    ).toBe(false);
    expect(
      automationDefinitionIsSafeForAuthoring({
        nodes: [{ config: { source: ["", "home", "operator", "private.txt"].join("/") } }],
      }),
    ).toBe(false);
  });

  it("checks repository ids embedded anywhere in an authored graph", () => {
    const exact = {
      nodes: [
        { kind: "agent.run", config: { repositoryId: "repo-a" } },
        { kind: "transform", config: { template: "safe" } },
      ],
    };
    const crossRepository = {
      nodes: [
        { kind: "agent.run", config: { repositoryId: "repo-a" } },
        { kind: "connector.read", config: { nested: { repositoryId: "repo-b" } } },
      ],
    };
    const scope = { repositoryId: "repo-a", spaceRepositoryIds: ["repo-a", "repo-b"] };
    expect(automationDefinitionFitsScope(exact, scope)).toBe(true);
    expect(automationDefinitionFitsScope(crossRepository, scope)).toBe(false);
  });

  it("requires exact agent repository binding and rejects scoped shell authority", () => {
    const scope = { repositoryId: "repo-a", spaceRepositoryIds: ["repo-a"] };
    expect(
      automationDefinitionFitsScope(
        { nodes: [{ kind: "transform", config: { template: "Space-wide" } }] },
        scope,
      ),
    ).toBe(false);
    expect(
      automationDefinitionFitsScope(
        { nodes: [{ kind: "agent.run", config: { prompt: "work" } }] },
        scope,
      ),
    ).toBe(false);
    expect(
      automationDefinitionFitsScope(
        { nodes: [{ kind: "agent.run", config: { repositoryId: "repo-a" } }] },
        scope,
      ),
    ).toBe(true);
    expect(
      automationDefinitionFitsScope(
        { nodes: [{ kind: "shell.scoped", config: { commandId: "safe-command" } }] },
        scope,
      ),
    ).toBe(false);
  });

  it("allows only repositories that belong to the selected Space for Space-only credentials", () => {
    const scope = { repositoryId: undefined, spaceRepositoryIds: ["repo-a"] };
    expect(
      automationDefinitionFitsScope(
        { nodes: [{ kind: "agent.run", config: { repositoryId: "repo-a" } }] },
        scope,
      ),
    ).toBe(true);
    expect(
      automationDefinitionFitsScope(
        { nodes: [{ kind: "agent.run", config: { repositoryId: "repo-b" } }] },
        scope,
      ),
    ).toBe(false);
  });

  it("requires separate run authority for every save that leaves execution enabled", () => {
    expect(automationSaveRequiresRunCapability(false, true)).toBe(true);
    expect(automationSaveRequiresRunCapability(false, false)).toBe(false);
    expect(automationSaveRequiresRunCapability(true, true)).toBe(true);
    expect(automationSaveRequiresRunCapability(true, false)).toBe(false);
  });

  it("does not list unbound, shell, or another repository's automations", () => {
    const automations = [
      {
        id: "repo-a-flow",
        spaceId: "space-a",
        nodes: [{ kind: "agent", config: { repositoryId: "repo-a" } }],
      },
      {
        id: "repo-b-flow",
        spaceId: "space-a",
        nodes: [{ kind: "agent", config: { repositoryId: "repo-b" } }],
      },
      {
        id: "space-flow",
        spaceId: "space-a",
        nodes: [{ kind: "transform", config: {} }],
      },
      {
        id: "shell-flow",
        spaceId: "space-a",
        nodes: [
          { kind: "transform", config: { repositoryId: "repo-a" } },
          { kind: "shell.scoped", config: {} },
        ],
      },
    ];
    expect(
      filterAutomationsForScope(automations, {
        spaceId: "space-a",
        repositoryId: "repo-a",
        spaceRepositoryIds: ["repo-a", "repo-b"],
      }).map((automation) => automation.id),
    ).toEqual(["repo-a-flow"]);
  });

  it("cannot replace repository B automation content with repository A content", () => {
    const scope = { repositoryId: "repo-a", spaceRepositoryIds: ["repo-a", "repo-b"] };
    expect(
      automationReplacementFitsScope(
        { nodes: [{ kind: "agent.run", config: { repositoryId: "repo-b" } }] },
        { nodes: [{ kind: "agent.run", config: { repositoryId: "repo-a" } }] },
        scope,
      ),
    ).toBe(false);
  });

  it("lists only exact-repository Runs and their Approvals", () => {
    const visible = filterRunsAndApprovalsForScope(
      [
        { id: "run-a", spaceId: "space-a", repositoryId: "repo-a" },
        { id: "run-b", spaceId: "space-a", repositoryId: "repo-b" },
        { id: "run-space", spaceId: "space-a" },
        { id: "run-other", spaceId: "space-b", repositoryId: "repo-a" },
      ],
      [
        { id: "approval-a", runId: "run-a", spaceId: "space-a" },
        { id: "approval-b", runId: "run-b", spaceId: "space-a" },
        { id: "approval-space", runId: "run-space", spaceId: "space-a" },
        { id: "approval-orphan", runId: "missing", spaceId: "space-a" },
      ],
      { spaceId: "space-a", repositoryId: "repo-a" },
    );
    expect(visible.runs.map((run) => run.id)).toEqual(["run-a"]);
    expect(visible.approvals.map((approval) => approval.id)).toEqual(["approval-a"]);
  });

  it("binds child Runs to the credential Space and repository", () => {
    expect(
      resolveRunStartScope({
        scopedSpaceId: "space-a",
        scopedRepositoryId: "repo-a",
      }),
    ).toEqual({ allowed: true, spaceId: "space-a", repositoryId: "repo-a" });
    expect(
      resolveRunStartScope({
        requestedSpaceId: "space-b",
        scopedSpaceId: "space-a",
      }),
    ).toEqual({ allowed: false });
    expect(
      resolveRunStartScope({
        requestedRepositoryId: "repo-b",
        scopedSpaceId: "space-a",
        scopedRepositoryId: "repo-a",
      }),
    ).toEqual({ allowed: false });
    expect(
      resolveRunStartScope({
        requestedProjectId: "project-bypass",
        scopedSpaceId: "space-a",
        scopedRepositoryId: "repo-a",
      }),
    ).toEqual({ allowed: false });
  });
});

describe("credential-bound Memory writes", () => {
  it("allows only a server-issued remember mode to promote governed Memory", () => {
    expect(memoryWriteOperationForScope({ memoryWriteMode: "remember" })).toBe("remember");
    expect(memoryWriteOperationForScope({ memoryWriteMode: "propose" })).toBe("propose");
    expect(memoryWriteOperationForScope({})).toBe("propose");
  });
});

const activityScope = (
  overrides: Partial<McpInvocationContext.McpInvocationScope> = {},
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("cc-space-agent-command-center"),
  providerSessionId: "session-1",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  capabilities: new Set(["cc.items.read"]),
  spaceId: SpaceId.make("command-center"),
  issuedAt: 0,
  ...overrides,
});

const invokeSpaceActivity = (
  scope: McpInvocationContext.McpInvocationScope,
  input: { readonly since?: string; readonly limit?: number },
) =>
  Effect.gen(function* () {
    const requests: Array<unknown> = [];
    const outputs = yield* Effect.gen(function* () {
      const toolkit = yield* CommandCenterToolkit;
      const stream = yield* toolkit.handle("cc_space_activity", input);
      return Array.from(yield* Stream.runCollect(stream)).map((output) => output.isFailure);
    }).pipe(
      // Typed tool failures surface as a failed effect.
      Effect.catch(() => Effect.succeed([true])),
      Effect.provide(
        CommandCenterToolkitHandlersLive.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
              // Unused by this tool; the toolkit still requires them.
              Layer.mock(CommandCenterService.CommandCenterService)({}),
              Layer.mock(AutomationRuns.AutomationRuns)({}),
              Layer.mock(GoogleReadConnector.GoogleReadConnector)({}),
              Layer.mock(MemorySearchIndex.MemorySearchIndex)({}),
              Layer.mock(ProviderRegistry.ProviderRegistry)({}),
              Layer.succeed(
                ReadinessGate.CommandCenterReadinessGate,
                ReadinessGate.CommandCenterReadinessGate.of({
                  state: Effect.succeed("ready"),
                  requireReady: Effect.void,
                  markReady: Effect.void,
                  markFailed: Effect.void,
                }),
              ),
              Layer.mock(SpaceActivity.SpaceActivity)({
                recent: (request) =>
                  Effect.sync(() => {
                    requests.push(request);
                    return [
                      {
                        occurredAt: "2026-10-09T12:00:00.000Z",
                        title: "Build the activity feed",
                        status: "completed",
                        summary: "Done.",
                        sourceKind: "thread" as const,
                        sourceId: "t-feed",
                      },
                    ];
                  }),
              }),
            ),
          ),
        ),
      ),
    );
    return { outputs, requests };
  });

const { spaceId: _spaceId, ...unboundScope } = activityScope();

describe("cc_space_activity scoping", () => {
  it("takes no Space from tool input", () => {
    const schema = Tool.getJsonSchema(CommandCenterSpaceActivityTool) as {
      readonly properties?: Readonly<Record<string, unknown>>;
    };
    expect(Object.keys(schema.properties ?? {}).toSorted()).toEqual(["limit", "since"]);
  });

  it.effect("reads only the session's Space", () =>
    Effect.gen(function* () {
      const { outputs, requests } = yield* invokeSpaceActivity(activityScope(), { limit: 5 });
      expect(outputs).toEqual([false]);
      expect(requests).toEqual([{ spaceId: "command-center", limit: 5 }]);
    }),
  );

  it.effect("refuses repository-scoped, unbound, and under-privileged credentials", () =>
    Effect.gen(function* () {
      for (const scope of [
        activityScope({ repositoryId: RepositoryId.make("t3-code") }),
        unboundScope,
        activityScope({ capabilities: new Set(["cc.memory.read"]) }),
      ]) {
        const { outputs, requests } = yield* invokeSpaceActivity(scope, {});
        expect(outputs).toEqual([true]);
        expect(requests).toEqual([]);
      }
    }),
  );
});

const itemScope = (
  overrides: Partial<McpInvocationContext.McpInvocationScope> = {},
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("cc-space-agent-acme"),
  providerSessionId: "session-1",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  capabilities: new Set(["cc.items.write"]),
  spaceId: SpaceId.make("acme"),
  role: "space-agent",
  issuedAt: 0,
  ...overrides,
});

const ITEM_UPDATED_AT = "2026-10-09T12:00:00.000Z";

const invokeItemTool = (
  scope: McpInvocationContext.McpInvocationScope,
  name: "cc_items_create" | "cc_items_update",
  input: unknown,
) =>
  Effect.gen(function* () {
    const calls: Array<{
      readonly method: string;
      readonly input: unknown;
      readonly actor: unknown;
    }> = [];
    const item = {
      id: "item-1",
      spaceId: "acme",
      kind: "decision",
      status: "review",
      priority: "normal",
      title: "Pick a vendor",
      artifactIds: [],
      provenance: { kind: "agent", capturedAt: ITEM_UPDATED_AT },
      metadata: { spaceAgent: true },
      createdAt: ITEM_UPDATED_AT,
      updatedAt: ITEM_UPDATED_AT,
    };
    const outputs = yield* Effect.gen(function* () {
      const toolkit = yield* CommandCenterToolkit;
      const stream = yield* toolkit.handle(name, input as never);
      return Array.from(yield* Stream.runCollect(stream)).map((output) => output.isFailure);
    }).pipe(
      Effect.catch(() => Effect.succeed([true])),
      Effect.provide(
        CommandCenterToolkitHandlersLive.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
              Layer.mock(CommandCenterService.CommandCenterService)({
                getConfiguredSpace: () =>
                  Effect.succeed({
                    agent: { enabled: true },
                    policy: { allowedCapabilities: ["cc.items.write"] },
                  } as never),
                createItem: (request, actor) =>
                  Effect.sync(() => {
                    calls.push({ method: "createItem", input: request, actor });
                    return item as never;
                  }),
                updateItem: (request, actor) =>
                  Effect.sync(() => {
                    calls.push({ method: "updateItem", input: request, actor });
                    return { item, duplicate: false } as never;
                  }),
              }),
              Layer.mock(AutomationRuns.AutomationRuns)({}),
              Layer.mock(GoogleReadConnector.GoogleReadConnector)({}),
              Layer.mock(MemorySearchIndex.MemorySearchIndex)({}),
              Layer.mock(ProviderRegistry.ProviderRegistry)({}),
              Layer.mock(SpaceActivity.SpaceActivity)({}),
              Layer.succeed(
                ReadinessGate.CommandCenterReadinessGate,
                ReadinessGate.CommandCenterReadinessGate.of({
                  state: Effect.succeed("ready"),
                  requireReady: Effect.void,
                  markReady: Effect.void,
                  markFailed: Effect.void,
                }),
              ),
            ),
          ),
        ),
      ),
    );
    return { outputs, calls };
  });

const updateInput = (overrides: Record<string, unknown> = {}) => ({
  itemId: "item-1",
  spaceId: "acme",
  expectedUpdatedAt: ITEM_UPDATED_AT,
  patch: { status: "done", description: "Went with the example vendor." },
  ...overrides,
});

describe("Command Center MCP Item writes", () => {
  it("exposes only status, title, and description on cc_items_update", () => {
    const tool = Object.values(CommandCenterToolkit.tools).find(
      (candidate) => candidate.name === "cc_items_update",
    )!;
    const schema = Tool.getJsonSchema(tool) as {
      readonly properties?: {
        readonly patch?: { readonly properties?: Readonly<Record<string, unknown>> };
      };
    };
    expect(Object.keys(schema.properties?.patch?.properties ?? {}).toSorted()).toEqual([
      "description",
      "status",
      "title",
    ]);
  });

  it.effect("updates a Space agent's Item as the agent", () =>
    Effect.gen(function* () {
      const { outputs, calls } = yield* invokeItemTool(
        itemScope(),
        "cc_items_update",
        updateInput(),
      );
      expect(outputs).toEqual([false]);
      expect(calls).toEqual([
        {
          method: "updateItem",
          input: updateInput(),
          actor: { kind: "space-agent", threadId: "cc-space-agent-acme" },
        },
      ]);
    }),
  );

  it.effect("refuses another Space, missing write capability, and an empty patch", () =>
    Effect.gen(function* () {
      for (const [scope, input] of [
        [itemScope(), updateInput({ spaceId: "example" })],
        [itemScope({ capabilities: new Set(["cc.items.read"]) }), updateInput()],
        [itemScope(), updateInput({ patch: {} })],
      ] as const) {
        const { outputs, calls } = yield* invokeItemTool(scope, "cc_items_update", input);
        expect(outputs).toEqual([true]);
        expect(calls).toEqual([]);
      }
    }),
  );

  it.effect("marks Items the Space agent creates, and leaves other credentials as the user", () =>
    Effect.gen(function* () {
      const createInput = {
        requestId: "request-1",
        spaceId: "acme",
        kind: "decision",
        priority: "normal",
        title: "Pick a vendor",
      };
      const agent = yield* invokeItemTool(itemScope(), "cc_items_create", createInput);
      expect(agent.outputs).toEqual([false]);
      expect(agent.calls[0]?.actor).toEqual({
        kind: "space-agent",
        threadId: "cc-space-agent-acme",
      });

      const { role: _role, ...userScope } = itemScope();
      const user = yield* invokeItemTool(userScope, "cc_items_create", createInput);
      expect(user.outputs).toEqual([false]);
      expect(user.calls[0]?.actor).toBeUndefined();
    }),
  );
});
