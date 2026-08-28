import {
  CommandId,
  ModelId,
  ProviderId,
  RunId,
  SpaceId,
  type ProviderAvailability,
} from "@command-center/core";
import type {
  CommandCenterCommandSubmitInput,
  CommandCenterCommandSubmitResult,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  automationAgentCommandId,
  makeAutomationAgentRunAdapter,
  type AutomationAgentRunAdapterDependencies,
  type AutomationAgentRunRequest,
} from "./AgentRunAdapter.ts";

const providers: ReadonlyArray<ProviderAvailability> = [
  {
    providerId: ProviderId.make("codex-primary"),
    healthy: true,
    priority: 0,
    modelIds: [ModelId.make("model-a")],
    defaultModelId: ModelId.make("model-a"),
    capabilities: ["cc.runs.start"],
  },
];

const request = (
  overrides: Partial<AutomationAgentRunRequest> = {},
): AutomationAgentRunRequest => ({
  executionId: "execution-1",
  automationId: "automation-1",
  nodeId: "agent-1",
  spaceId: "space-a",
  text: "Review the current branch",
  repositoryId: "repo-a",
  providerId: "codex-primary",
  modelId: "model-a",
  ...overrides,
});

function submissionResult(
  command: CommandCenterCommandSubmitInput,
  overrides: Partial<CommandCenterCommandSubmitResult> = {},
): CommandCenterCommandSubmitResult {
  return {
    run: {
      id: RunId.make("child-run-1"),
      spaceId: command.spaceId ?? SpaceId.make("space-a"),
      kind: "agent",
      status: "queued",
      commandId: command.commandId,
      repositoryId: command.repositoryId,
      projectId: command.projectId,
      providerId: command.providerId,
      modelId: command.modelId,
      artifactIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    route: {
      commandId: command.commandId,
      status: "ready",
      intent: command.repositoryId === undefined ? "conversation" : "repository",
      spaceId: command.spaceId ?? null,
      repositoryId: command.repositoryId ?? null,
      projectId: command.projectId ?? null,
      providerId: command.providerId ?? null,
      modelId: command.modelId ?? null,
      capabilities: ["cc.runs.start"],
      actionKind: command.repositoryId === undefined ? "read" : "worktree.edit",
      risk: command.repositoryId === undefined ? "low" : "reversible",
      approvalRequired: false,
      sources: {
        space: "explicit",
        repository: command.repositoryId === undefined ? "unresolved" : "explicit",
        project: command.projectId === undefined ? "unresolved" : "explicit",
        provider: command.providerId === undefined ? "fallback" : "explicit",
        model: command.modelId === undefined ? "provider-default" : "explicit",
      },
      reasons: ["Routed through the scoped Command Center service"],
    },
    duplicate: false,
    ...overrides,
  };
}

it.effect("submits an exact-Space command and atomically links its parent execution", () => {
  const commands: CommandCenterCommandSubmitInput[] = [];
  const links: Array<{
    readonly parentExecutionId: string;
    readonly childRunId: string;
    readonly commandId: string;
    readonly spaceId: string;
  }> = [];
  const authorized: string[] = [];
  const adapter = makeAutomationAgentRunAdapter({
    providerAvailability: Effect.succeed(providers),
    submitCommand: (command) => {
      commands.push(command);
      return Effect.succeed(submissionResult(command));
    },
    linkParent: (input) => {
      links.push(input);
      return Effect.void;
    },
    authorizeRun: (runId) => {
      authorized.push(runId);
      return Effect.void;
    },
  });

  return Effect.gen(function* () {
    const result = yield* adapter(request());

    expect(commands).toEqual([
      expect.objectContaining({
        commandId: CommandId.make("automation-agent:execution-1:agent-1"),
        text: "Review the current branch",
        spaceId: SpaceId.make("space-a"),
        repositoryId: "repo-a",
        providerId: "codex-primary",
        modelId: "model-a",
      }),
    ]);
    expect(links).toEqual([
      {
        parentExecutionId: "execution-1",
        childRunId: "child-run-1",
        commandId: "automation-agent:execution-1:agent-1",
        spaceId: "space-a",
      },
    ]);
    expect(authorized).toEqual(["child-run-1"]);
    expect(result).toMatchObject({
      relationship: "automation-child",
      parentExecutionId: "execution-1",
      runId: "child-run-1",
      state: "queued",
      routeStatus: "ready",
    });
  });
});

it("derives one child command key across executor retry attempts", () => {
  expect(automationAgentCommandId(request())).toBe(
    automationAgentCommandId(request({ text: "A replay uses the committed node identity" })),
  );
});

it.effect("refuses router-only child models and filters them from worker availability", () => {
  const seenProviders: Array<ReadonlyArray<ProviderAvailability>> = [];
  const adapter = makeAutomationAgentRunAdapter({
    providerAvailability: Effect.succeed([
      ...providers,
      {
        providerId: ProviderId.make("codex-router"),
        healthy: true,
        priority: 1,
        modelIds: [ModelId.make("gpt-5.6-sol")],
        defaultModelId: ModelId.make("gpt-5.6-sol"),
        capabilities: ["cc.runs.start"],
      },
    ]),
    submitCommand: (command, available) => {
      seenProviders.push(available);
      return Effect.succeed(submissionResult(command));
    },
    linkParent: () => Effect.void,
    authorizeRun: () => Effect.void,
  });

  return Effect.gen(function* () {
    const explicit = yield* adapter(
      request({ providerId: undefined, modelId: "gpt-5.6-sol" }),
    ).pipe(Effect.flip);
    expect(explicit.retryable).toBe(false);
    expect(explicit.message).toContain("Router-only models");
    expect(seenProviders).toHaveLength(0);

    yield* adapter(request({ providerId: undefined, modelId: undefined }));
    expect(seenProviders).toHaveLength(1);
    expect(seenProviders[0]?.map((provider) => String(provider.providerId))).toEqual([
      "codex-primary",
    ]);
  });
});

it.effect("rejects a routed result that escapes the requested Space before linking", () => {
  let linked = false;
  const adapter = makeAutomationAgentRunAdapter({
    providerAvailability: Effect.succeed(providers),
    submitCommand: (command) =>
      Effect.succeed(
        submissionResult(command, {
          run: {
            ...submissionResult(command).run,
            spaceId: SpaceId.make("space-b"),
          },
        }),
      ),
    linkParent: () => {
      linked = true;
      return Effect.void;
    },
    authorizeRun: () => Effect.void,
  });

  return Effect.gen(function* () {
    const error = yield* adapter(request()).pipe(Effect.flip);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("Space scope");
    expect(linked).toBe(false);
  });
});

it.effect("preserves retryability when durable parent linking is temporarily unavailable", () => {
  let authorizationCount = 0;
  const dependencies: AutomationAgentRunAdapterDependencies = {
    providerAvailability: Effect.succeed(providers),
    submitCommand: (command) => Effect.succeed(submissionResult(command)),
    linkParent: () => Effect.fail({ message: "database temporarily unavailable", retryable: true }),
    authorizeRun: () =>
      Effect.sync(() => {
        authorizationCount += 1;
      }),
  };

  return Effect.gen(function* () {
    const error = yield* makeAutomationAgentRunAdapter(dependencies)(request()).pipe(Effect.flip);
    expect(error).toEqual({ message: "database temporarily unavailable", retryable: true });
    expect(authorizationCount).toBe(0);
  });
});
