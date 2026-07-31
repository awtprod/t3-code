import * as NodeServices from "@effect/platform-node/NodeServices";
import { Automation, AutomationNodeId, SpaceId } from "@command-center/core";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { AutomationRuns, layer as automationRunsLayer } from "../AutomationRuns.ts";
import { CommandCenterService, type CommandCenterServiceShape } from "../Service.ts";
import { canonicalJson } from "./Digest.ts";
import { make as makeRecoveryCoordinator } from "./RecoveryCoordinator.ts";
import {
  type AutomationNodeExecutionContext,
  type AutomationNodeExecutionOutcome,
  layer as runtimeLayer,
} from "./Runtime.ts";

const initialNow = "2026-07-20T12:00:00.000Z";
const commitSha = "1234567890abcdef1234567890abcdef12345678";
const definitionDigest = `sha256:${"a".repeat(64)}`;
const decodeAutomation = Schema.decodeUnknownSync(Automation);

function fixture(input: {
  readonly id: string;
  readonly nodes: ReadonlyArray<{
    readonly id: string;
    readonly kind: "transform" | "delay";
    readonly config?: Readonly<Record<string, Schema.Json>>;
  }>;
}) {
  return decodeAutomation({
    id: input.id,
    spaceId: "space-a",
    name: input.id,
    version: 1,
    enabled: true,
    trigger: { type: "manual" },
    nodes: input.nodes.map((node, index) => ({
      id: AutomationNodeId.make(node.id),
      kind: node.kind,
      config: node.config ?? {},
      position: { x: index * 20, y: 0 },
    })),
    edges: input.nodes.slice(1).map((node, index) => ({
      sourceNodeId: AutomationNodeId.make(input.nodes[index]!.id),
      targetNodeId: AutomationNodeId.make(node.id),
    })),
    definitionDigest,
    configCommit: commitSha,
    createdAt: initialNow,
    updatedAt: initialNow,
  });
}

function recoveryTestLayer(input: {
  readonly automation: Automation;
  readonly now: () => string;
  readonly execute: (context: AutomationNodeExecutionContext) => AutomationNodeExecutionOutcome;
}) {
  let nextId = 0;
  const commandCenter = CommandCenterService.of({
    queryAutomations: () => Effect.succeed({ automations: [input.automation] }),
    queryApprovals: () => Effect.succeed({ approvals: [] }),
    recordAutomationEvent: () => Effect.void,
    getAutomationApprovalBinding: () => Effect.succeed(null),
    ensureAutomationApproval: () => Effect.die("approval nodes are not used in this test"),
  } as unknown as CommandCenterServiceShape);
  const dependencies = Layer.mergeAll(
    Layer.succeed(CommandCenterService, commandCenter),
    runtimeLayer({
      executeNode: (context) => Effect.sync(() => input.execute(context)),
      now: Effect.sync(input.now),
      randomUUID: Effect.sync(() => `recovery-execution-${++nextId}`),
      defaultMaxAttempts: 3,
      defaultRetryDelayMs: 1_000,
    }),
  );
  return automationRunsLayer.pipe(
    Layer.provideMerge(dependencies),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );
}

const seedAutomation = Effect.fn("AutomationRecoveryTest.seedAutomation")(function* (
  automation: Automation,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO command_center_spaces (id, slug, name, kind, created_at, updated_at)
    VALUES ('space-a', 'space-a', 'Space A', 'business', ${initialNow}, ${initialNow})
  `;
  yield* sql`
    INSERT INTO command_center_automations (
      id, space_id, name, enabled, commit_sha, definition_digest,
      definition_json, last_loaded_at
    ) VALUES (
      ${automation.id}, ${automation.spaceId}, ${automation.name}, 1, ${commitSha},
      ${definitionDigest}, ${canonicalJson(automation as Schema.Json)}, ${initialNow}
    )
  `;
});

function startInput(automation: Automation, key: string) {
  return {
    automationId: automation.id,
    spaceId: SpaceId.make("space-a"),
    idempotencyKey: key,
    expectedConfigCommitSha: commitSha,
    expectedDefinitionDigest: definitionDigest,
  } as const;
}

it.effect(
  "recovers due delays and retries from durable checkpoints after a fresh coordinator",
  () => {
    let now = initialNow;
    const invocations = new Map<string, number>();
    const automation = fixture({
      id: "recover-delay-retry",
      nodes: [
        { id: "delay", kind: "delay", config: { durationMs: 1_000 } },
        { id: "retry", kind: "transform" },
      ],
    });
    const testLayer = recoveryTestLayer({
      automation,
      now: () => now,
      execute: (context) => {
        const count = (invocations.get(context.node.id) ?? 0) + 1;
        invocations.set(context.node.id, count);
        return count === 1
          ? { type: "retry", error: "temporary", retryAfterMs: 1_000 }
          : { type: "succeeded", output: { recovered: true } };
      },
    });

    return Effect.gen(function* () {
      yield* seedAutomation(automation);
      const runs = yield* AutomationRuns;
      const waitingDelay = yield* runs.start(startInput(automation, "restart-delay"));
      expect(waitingDelay.state).toBe("waiting_delay");

      now = "2026-07-20T12:00:02.000Z";
      const firstCoordinator = yield* makeRecoveryCoordinator;
      expect(yield* firstCoordinator.tick()).toMatchObject({ scanned: 1, recovered: 1 });
      expect(
        yield* runs.get({ executionId: waitingDelay.id, spaceId: automation.spaceId }),
      ).toMatchObject({ state: "waiting_retry" });

      now = "2026-07-20T12:00:04.000Z";
      const restartedCoordinator = yield* makeRecoveryCoordinator;
      expect(yield* restartedCoordinator.tick()).toMatchObject({ scanned: 1, recovered: 1 });
      expect(
        yield* runs.get({ executionId: waitingDelay.id, spaceId: automation.spaceId }),
      ).toMatchObject({
        state: "succeeded",
        checkpoints: expect.arrayContaining([
          expect.objectContaining({ nodeId: "retry", attemptCount: 2 }),
        ]),
      });
    }).pipe(Effect.provide(testLayer));
  },
);

it.effect(
  "continues executions with more than one drive batch without replaying completed nodes",
  () => {
    const nodes = Array.from({ length: 105 }, (_, index) => ({
      id: `step-${String(index).padStart(3, "0")}`,
      kind: "transform" as const,
    }));
    const automation = fixture({ id: "long-continuation", nodes });
    const invocations: string[] = [];
    const testLayer = recoveryTestLayer({
      automation,
      now: () => initialNow,
      execute: (context) => {
        invocations.push(context.node.id);
        return { type: "succeeded", output: context.node.id };
      },
    });

    return Effect.gen(function* () {
      yield* seedAutomation(automation);
      const runs = yield* AutomationRuns;
      const partial = yield* runs.start(startInput(automation, "long-run"));
      expect(partial).toMatchObject({ state: "running" });
      expect(
        partial.checkpoints.filter((checkpoint) => checkpoint.state === "succeeded"),
      ).toHaveLength(100);

      const coordinator = yield* makeRecoveryCoordinator;
      expect(yield* coordinator.tick()).toMatchObject({ scanned: 1, recovered: 1, remaining: 0 });
      const completed = yield* runs.get({ executionId: partial.id, spaceId: automation.spaceId });
      expect(completed).toMatchObject({ state: "succeeded" });
      expect(invocations).toHaveLength(105);
      expect(new Set(invocations).size).toBe(105);
    }).pipe(Effect.provide(testLayer));
  },
);
