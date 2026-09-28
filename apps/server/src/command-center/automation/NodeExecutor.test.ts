import { AutomationNodeId } from "@command-center/core";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

import type {
  AutomationAgentRunLinkedResult,
  AutomationAgentRunRequest,
  AutomationAgentRunStarter,
} from "./AgentRunAdapter.ts";
import type {
  AutomationScopedShellRequest,
  AutomationScopedShellResult,
} from "./AutomationScopedShell.ts";
import { ProspectEvaluationError } from "../ProspectEvaluation.ts";
import {
  AUTOMATION_V1_NODE_POLICY,
  makeSafeAutomationNodeExecutor,
  type AutomationItemCreateRequest,
  type ProspectNotificationRequest,
} from "./NodeExecutor.ts";
import type { AutomationNodeExecutionContext } from "./Runtime.ts";

function context(
  kind: AutomationNodeExecutionContext["node"]["kind"],
  config: Readonly<Record<string, Schema.Json>>,
  overrides: Partial<AutomationNodeExecutionContext> = {},
): AutomationNodeExecutionContext {
  return {
    executionId: "execution-1",
    automationId: "automation-1",
    spaceId: "space-a",
    configCommitSha: "1234567890abcdef1234567890abcdef12345678",
    definitionDigest: `sha256:${"a".repeat(64)}`,
    node: { id: AutomationNodeId.make("node-1"), kind, config },
    attempt: 1,
    idempotencyKey: "execution-1:node-1:1",
    runInput: { active: true, people: [{ name: "Ada" }, { name: "Grace" }] },
    predecessorOutputs: { previous: { score: 9 } },
    ...overrides,
  };
}

function dependencies(
  overrides: {
    readonly startAgentRun?: AutomationAgentRunStarter;
    readonly createItem?: (
      input: AutomationItemCreateRequest,
    ) => Effect.Effect<Schema.Json, string>;
    readonly googleRead?: (input: {
      readonly operation: string;
      readonly spaceId: string;
      readonly connectionId: string;
    }) => Effect.Effect<
      { readonly operation: string; readonly contentTrust: string; readonly data: unknown },
      string
    >;
    readonly runScopedShell?: (
      input: AutomationScopedShellRequest,
    ) => Effect.Effect<AutomationScopedShellResult, never>;
    readonly evaluateProspects?: (
      input: import("../ProspectEvaluation.ts").ProspectEvaluationRequest,
    ) => Effect.Effect<
      import("../ProspectEvaluation.ts").ProspectEvaluationResult,
      ProspectEvaluationError
    >;
    readonly notifyProspects?: (input: ProspectNotificationRequest) => Effect.Effect<
      {
        readonly status: "noop" | "queued" | "skipped" | "partial";
        readonly queuedCount: number;
        readonly skippedCount: number;
        readonly failedCount: number;
      },
      { readonly message: string; readonly retryable: boolean }
    >;
  } = {},
) {
  return {
    startAgentRun:
      overrides.startAgentRun ??
      ((input: AutomationAgentRunRequest) =>
        Effect.succeed({
          kind: "command-center-run",
          relationship: "automation-child",
          parentExecutionId: input.executionId,
          automationId: input.automationId,
          nodeId: input.nodeId,
          commandId: `automation-agent:${input.executionId}:${input.nodeId}`,
          runId: "child-run-1",
          spaceId: input.spaceId,
          repositoryId: input.repositoryId ?? null,
          projectId: input.projectId ?? null,
          providerId: input.providerId ?? "codex-primary",
          modelId: input.modelId ?? "default-model",
          state: "queued",
          routeStatus: "ready",
          approvalRequired: false,
          reasons: [],
          duplicate: false,
        } satisfies AutomationAgentRunLinkedResult)),
    createItem:
      overrides.createItem ??
      ((input: AutomationItemCreateRequest) => Effect.succeed({ id: input.requestId })),
    googleRead:
      overrides.googleRead ??
      ((request: { readonly operation: string }) =>
        Effect.succeed({
          operation: request.operation,
          contentTrust: "untrusted-external",
          data: { messages: [] },
        })),
    runScopedShell:
      overrides.runScopedShell ??
      ((input: AutomationScopedShellRequest) =>
        Effect.succeed({
          allowlistId: input.allowlistId,
          spaceId: input.spaceId,
          repositoryId: "repo-a",
          access: "read",
          policyDigest: `sha256:${"a".repeat(64)}`,
          exitCode: 0,
          stdout: "ok\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          retryable: false,
          idempotent: false,
        })),
    evaluateProspects:
      overrides.evaluateProspects ??
      (() =>
        Effect.succeed({
          evaluatedCount: 0,
          actionableCount: 0,
          itemIds: [],
          actionableItemIds: [],
          investigateCount: 0,
          investigateItemIds: [],
          reviewCount: 0,
          noActionCount: 0,
          skippedExistingCount: 0,
          feedbackCount: 0,
          feedbackRemaining: 0,
        })),
    notifyProspects:
      overrides.notifyProspects ??
      (() =>
        Effect.succeed({
          status: "queued" as const,
          queuedCount: 0,
          skippedCount: 0,
          failedCount: 0,
        })),
  };
}

it.effect("executes deterministic condition, transform, and bounded foreach nodes", () =>
  Effect.gen(function* () {
    const execute = makeSafeAutomationNodeExecutor(dependencies());
    const condition = yield* execute(
      context("condition", {
        left: { $path: "predecessors.previous.score" },
        operator: "greaterThan",
        right: 5,
      }),
    );
    const transform = yield* execute(
      context("transform", {
        output: {
          person: "{{run.people.0.name}}",
          score: "{{predecessors.previous.score}}",
        },
      }),
    );
    const foreach = yield* execute(
      context("foreach", {
        itemsPath: "run.people",
        template: { name: "{{item.name}}", position: "{{index}}" },
      }),
    );

    expect(condition).toEqual({ type: "succeeded", output: { matched: true, value: 9 } });
    expect(transform).toEqual({ type: "succeeded", output: { person: "Ada", score: 9 } });
    expect(foreach).toEqual({
      type: "succeeded",
      output: {
        count: 2,
        items: [
          { name: "Ada", position: 0 },
          { name: "Grace", position: 1 },
        ],
      },
    });
  }),
);

it.effect("creates Items with execution idempotency and immutable Space scope", () => {
  const captured: AutomationItemCreateRequest[] = [];
  const execute = makeSafeAutomationNodeExecutor(
    dependencies({
      createItem: (input) => {
        captured.push(input);
        return Effect.succeed({ id: input.requestId, spaceId: input.spaceId });
      },
    }),
  );
  return Effect.gen(function* () {
    const outcome = yield* execute(
      context("item.mutate", {
        operation: "create",
        spaceId: "other-space",
        kind: "task",
        priority: "high",
        title: "Review {{run.people.0.name}}",
      }),
    );

    expect(outcome.type).toBe("succeeded");
    expect(captured).toEqual([
      expect.objectContaining({
        requestId: "execution-1:node-1:1",
        spaceId: "space-a",
        title: "Review Ada",
      }),
    ]);
  });
});

it.effect("admits only scoped read-only Google requests", () => {
  const scopes: Array<{ readonly spaceId: string; readonly connectionId: string }> = [];
  const execute = makeSafeAutomationNodeExecutor(
    dependencies({
      googleRead: (input) => {
        scopes.push({ spaceId: input.spaceId, connectionId: input.connectionId });
        return Effect.succeed({
          operation: input.operation,
          contentTrust: "untrusted-external",
          data: { messages: [] },
        });
      },
    }),
  );
  return Effect.gen(function* () {
    const read = yield* execute(
      context("connector.read", {
        connectionId: "google-primary",
        account: "ambient-account-must-be-ignored",
        operation: "gmail.search",
        query: "newer_than:7d",
      }),
    );
    const write = yield* execute(
      context("connector.read", {
        connectionId: "google-primary",
        operation: "gmail.send",
        to: "recipient@example.test",
      }),
    );

    expect(read).toMatchObject({
      type: "succeeded",
      output: { operation: "gmail.search", contentTrust: "untrusted-external" },
    });
    expect(write).toMatchObject({ type: "failed" });
    expect(scopes).toEqual([{ spaceId: "space-a", connectionId: "google-primary" }]);
  });
});

it.effect("starts an agent child Run and durably waits for its terminal state", () => {
  const captured: AutomationAgentRunRequest[] = [];
  const execute = makeSafeAutomationNodeExecutor(
    dependencies({
      startAgentRun: (input) => {
        captured.push(input);
        return Effect.succeed({
          kind: "command-center-run",
          relationship: "automation-child",
          parentExecutionId: input.executionId,
          automationId: input.automationId,
          nodeId: input.nodeId,
          commandId: `automation-agent:${input.executionId}:${input.nodeId}`,
          runId: "child-run-1",
          spaceId: input.spaceId,
          repositoryId: input.repositoryId ?? null,
          projectId: input.projectId ?? null,
          providerId: input.providerId ?? null,
          modelId: input.modelId ?? null,
          state: "queued",
          routeStatus: "ready",
          approvalRequired: false,
          reasons: ["Explicit automation route"],
          duplicate: false,
        });
      },
    }),
  );

  return Effect.gen(function* () {
    const outcome = yield* execute(
      context("agent.run", {
        prompt: "Review {{run.people.0.name}} with score {{predecessors.previous.score}}",
        repositoryId: "repo-a",
        projectId: "project-a",
        providerId: "codex-primary",
        modelId: "model-a",
      }),
    );

    expect(captured).toEqual([
      {
        executionId: "execution-1",
        automationId: "automation-1",
        nodeId: "node-1",
        spaceId: "space-a",
        text: "Review Ada with score 9",
        repositoryId: "repo-a",
        projectId: "project-a",
        providerId: "codex-primary",
        modelId: "model-a",
      },
    ]);
    expect(outcome).toMatchObject({
      type: "wait",
      resumeKey: expect.stringMatching(/^automation-agent-wait:[a-f0-9]{64}$/u),
      output: {
        relationship: "automation-child",
        parentExecutionId: "execution-1",
        runId: "child-run-1",
      },
    });
  });
});

it.effect("preserves approval waits and propagates terminal agent outcomes", () => {
  const linkedResult = (
    state: "waiting_approval" | "succeeded" | "failed" | "canceled",
  ): AutomationAgentRunLinkedResult => ({
    kind: "command-center-run",
    relationship: "automation-child",
    parentExecutionId: "execution-1",
    automationId: "automation-1",
    nodeId: "node-1",
    commandId: "automation-agent:execution-1:node-1",
    runId: "child-run-1",
    spaceId: "space-a",
    repositoryId: null,
    projectId: null,
    providerId: "codex-primary",
    modelId: "model-a",
    state,
    routeStatus: state === "waiting_approval" ? "approval-required" : "ready",
    approvalRequired: state === "waiting_approval",
    reasons: state === "failed" ? ["Child provider failed"] : [],
    duplicate: false,
  });

  return Effect.gen(function* () {
    for (const state of ["waiting_approval", "succeeded", "failed", "canceled"] as const) {
      const execute = makeSafeAutomationNodeExecutor(
        dependencies({ startAgentRun: () => Effect.succeed(linkedResult(state)) }),
      );
      const outcome = yield* execute(context("agent.run", { prompt: "Review the result" }));
      if (state === "waiting_approval") {
        expect(outcome).toMatchObject({ type: "wait" });
      } else if (state === "succeeded") {
        expect(outcome).toMatchObject({ type: "succeeded" });
      } else {
        expect(outcome).toMatchObject({ type: "failed" });
      }
    }
  });
});

it.effect("fails malformed agent and scope-authoring shell config closed", () =>
  Effect.gen(function* () {
    const execute = makeSafeAutomationNodeExecutor(dependencies());
    const agent = yield* execute(
      context("agent.run", { prompt: "Do work", spaceId: "other-space" }),
    );
    const shell = yield* execute(
      context("shell.scoped", {
        allowlistId: "safe.read",
        executable: "/bin/sh",
      }),
    );

    expect(agent).toMatchObject({ type: "failed" });
    expect(shell).toMatchObject({ type: "failed" });
    expect(AUTOMATION_V1_NODE_POLICY.routed).toEqual(["agent.run"]);
    expect(AUTOMATION_V1_NODE_POLICY.automatic).toContain("shell.scoped");
    expect(AUTOMATION_V1_NODE_POLICY.blocked).toEqual([]);
  }),
);

it.effect("runs only a resolved scoped-shell id and preserves retry metadata", () => {
  const captured: AutomationScopedShellRequest[] = [];
  const execute = makeSafeAutomationNodeExecutor(
    dependencies({
      runScopedShell: (input) => {
        captured.push(input);
        return Effect.succeed({
          allowlistId: input.allowlistId,
          spaceId: input.spaceId,
          repositoryId: "repo-a",
          access: "read",
          policyDigest: `sha256:${"a".repeat(64)}`,
          exitCode: 9,
          stdout: "",
          stderr: "temporary failure",
          stdoutTruncated: false,
          stderrTruncated: false,
          retryable: true,
          idempotent: true,
          idempotencyKey: "server-derived",
        });
      },
    }),
  );

  return Effect.gen(function* () {
    const outcome = yield* execute(context("shell.scoped", { allowlistId: "repo.status" }));
    expect(captured).toEqual([
      {
        executionId: "execution-1",
        nodeId: "node-1",
        spaceId: "space-a",
        allowlistId: "repo.status",
      },
    ]);
    expect(outcome).toEqual({
      type: "retry",
      error: "Scoped shell 'repo.status' exited 9: temporary failure",
    });
  });
});

it.effect("admits only a named bounded prospect profile and returns a sanitized aggregate", () => {
  const captured: Array<import("../ProspectEvaluation.ts").ProspectEvaluationRequest> = [];
  const execute = makeSafeAutomationNodeExecutor(
    dependencies({
      evaluateProspects: (input) => {
        captured.push(input);
        return Effect.succeed({
          evaluatedCount: 2,
          actionableCount: 1,
          itemIds: ["prospect-review:one:fingerprint"],
          actionableItemIds: ["prospect-review:one:fingerprint"],
          investigateCount: 1,
          investigateItemIds: ["prospect-review:one:fingerprint"],
          reviewCount: 0,
          noActionCount: 1,
          skippedExistingCount: 3,
          feedbackCount: 1,
          feedbackRemaining: 0,
        });
      },
    }),
  );

  return Effect.gen(function* () {
    const valid = yield* execute(
      context("prospect.evaluate", { profile: "prospect-primary", limit: 2 }),
    );
    const pathInjection = yield* execute(
      context("prospect.evaluate", {
        profile: "prospect-primary",
        limit: 2,
        dbPath: "/srv/prospector.sqlite",
      }),
    );
    const unbounded = yield* execute(
      context("prospect.evaluate", { profile: "prospect-primary", limit: 11 }),
    );

    expect(captured).toEqual([
      {
        profile: "prospect-primary",
        limit: 2,
        spaceId: "space-a",
        executionId: "execution-1",
        nodeId: "node-1",
      },
    ]);
    expect(valid).toMatchObject({
      type: "succeeded",
      output: { evaluatedCount: 2, actionableCount: 1 },
    });
    expect(pathInjection).toMatchObject({ type: "failed" });
    expect(unbounded).toMatchObject({ type: "failed" });
    expect(AUTOMATION_V1_NODE_POLICY.automatic).toContain("prospect.evaluate");
  });
});

it.effect("preserves prospect retryability without exposing connector internals", () => {
  const execute = makeSafeAutomationNodeExecutor(
    dependencies({
      evaluateProspects: () =>
        Effect.fail(
          new ProspectEvaluationError({
            message: "The Jev evaluation request failed or exceeded its bounds.",
            retryable: true,
          }),
        ),
    }),
  );
  return Effect.gen(function* () {
    const outcome = yield* execute(
      context("prospect.evaluate", { profile: "prospect-primary", limit: 1 }),
    );
    expect(outcome).toEqual({
      type: "retry",
      error: "The Jev evaluation request failed or exceeded its bounds.",
    });
  });
});

it.effect("notifies only unique bounded actionable Item IDs from direct predecessors", () => {
  const captured: ProspectNotificationRequest[] = [];
  const execute = makeSafeAutomationNodeExecutor(
    dependencies({
      notifyProspects: (input) => {
        captured.push(input);
        return Effect.succeed({
          status: "queued",
          queuedCount: 2,
          skippedCount: 0,
          failedCount: 0,
        });
      },
    }),
  );
  return Effect.gen(function* () {
    const outcome = yield* execute(
      context(
        "prospect.notify",
        {},
        {
          predecessorOutputs: {
            evaluate: {
              itemIds: ["prospect-review:one:fingerprint", "prospect-review:no-action:fingerprint"],
              actionableItemIds: [
                "prospect-review:one:fingerprint",
                "prospect-review:one:fingerprint",
                "prospect-review:two:fingerprint",
              ],
              title: "untrusted notification copy",
            },
          },
        },
      ),
    );

    expect(captured).toEqual([
      {
        spaceId: "space-a",
        itemIds: ["prospect-review:one:fingerprint", "prospect-review:two:fingerprint"],
      },
    ]);
    expect(outcome).toEqual({
      type: "succeeded",
      output: { status: "queued", queuedCount: 2, skippedCount: 0, failedCount: 0 },
    });
    expect(AUTOMATION_V1_NODE_POLICY.automatic).toContain("prospect.notify");
  });
});

it.effect("succeeds as a no-op when direct predecessors have no actionable Items", () => {
  let notifyCalls = 0;
  const execute = makeSafeAutomationNodeExecutor(
    dependencies({
      notifyProspects: () => {
        notifyCalls += 1;
        return Effect.die("an empty actionable batch reached the relay adapter");
      },
    }),
  );
  return Effect.gen(function* () {
    const outcome = yield* execute(
      context(
        "prospect.notify",
        {},
        {
          predecessorOutputs: {
            evaluate: {
              itemIds: ["prospect-review:no-action:fingerprint"],
              actionableItemIds: [],
            },
          },
        },
      ),
    );

    expect(outcome).toEqual({
      type: "succeeded",
      output: { status: "noop", queuedCount: 0, skippedCount: 0, failedCount: 0 },
    });
    expect(notifyCalls).toBe(0);
  });
});

it.effect(
  "fails malformed prospect notification config and predecessor Item IDs permanently",
  () => {
    let notifyCalls = 0;
    const execute = makeSafeAutomationNodeExecutor(
      dependencies({
        notifyProspects: () => {
          notifyCalls += 1;
          return Effect.succeed({
            status: "queued",
            queuedCount: 0,
            skippedCount: 0,
            failedCount: 0,
          });
        },
      }),
    );
    const tooMany = Array.from(
      { length: 11 },
      (_, index) => `prospect-review:${index}:fingerprint`,
    );
    return Effect.gen(function* () {
      const outcomes = yield* Effect.all([
        execute(
          context(
            "prospect.notify",
            { title: "Injected copy" },
            {
              predecessorOutputs: {
                evaluate: { actionableItemIds: ["prospect-review:one:id"] },
              },
            },
          ),
        ),
        execute(context("prospect.notify", {}, { predecessorOutputs: {} })),
        execute(context("prospect.notify", {}, { predecessorOutputs: { evaluate: { count: 1 } } })),
        execute(
          context(
            "prospect.notify",
            {},
            {
              predecessorOutputs: { evaluate: { actionableItemIds: "not-an-array" } },
            },
          ),
        ),
        execute(
          context(
            "prospect.notify",
            {},
            {
              predecessorOutputs: { evaluate: { actionableItemIds: ["task:not-a-prospect"] } },
            },
          ),
        ),
        execute(
          context(
            "prospect.notify",
            {},
            {
              predecessorOutputs: { evaluate: { actionableItemIds: tooMany } },
            },
          ),
        ),
        execute(
          context(
            "prospect.notify",
            {},
            {
              spaceId: " ",
              predecessorOutputs: {
                evaluate: { actionableItemIds: ["prospect-review:one:id"] },
              },
            },
          ),
        ),
      ]);

      expect(outcomes.every((outcome) => outcome.type === "failed")).toBe(true);
      expect(notifyCalls).toBe(0);
    });
  },
);

it.effect("retries retryable prospect notification adapter failures", () => {
  const execute = makeSafeAutomationNodeExecutor(
    dependencies({
      notifyProspects: () =>
        Effect.fail({ message: "Relay temporarily unavailable.", retryable: true }),
    }),
  );
  return Effect.gen(function* () {
    const outcome = yield* execute(
      context(
        "prospect.notify",
        {},
        {
          predecessorOutputs: {
            evaluate: { actionableItemIds: ["prospect-review:one:fingerprint"] },
          },
        },
      ),
    );
    expect(outcome).toEqual({ type: "retry", error: "Relay temporarily unavailable." });
  });
});
