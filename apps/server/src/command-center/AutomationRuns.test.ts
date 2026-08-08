import * as NodeServices from "@effect/platform-node/NodeServices";
import { Automation, CAPABILITY_NAMES, Space, SpaceId } from "@command-center/core";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { AutomationRuns, layer as automationRunsLayer } from "./AutomationRuns.ts";
import { CommandCenterConfig, type LoadedCommandCenterConfig } from "./Config.ts";
import * as ConnectionHealth from "./ConnectionHealth.ts";
import { CommandCenterEventStream, layer as eventStreamLayer } from "./EventStream.ts";
import { CommandCenterService, layer as serviceLayer } from "./Service.ts";
import {
  automationAgentCommandId,
  automationAgentRunResumeKey,
} from "./automation/AgentRunAdapter.ts";
import {
  type AutomationNodeExecutionContext,
  type AutomationNodeExecutor,
  layer as runtimeLayer,
} from "./automation/Runtime.ts";

const now = "2026-01-01T00:00:00.000Z";
const commitSha = "1234567890abcdef1234567890abcdef12345678";
const definitionDigest = `sha256:${"a".repeat(64)}`;
const decodeSpace = Schema.decodeUnknownSync(Space);
const decodeAutomation = Schema.decodeUnknownSync(Automation);
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const space = decodeSpace({
  id: "space-a",
  slug: "space-a",
  displayName: "Space A",
  kind: "business",
  instructions: "Use only the selected Space.",
  policy: {
    allowedCapabilities: CAPABILITY_NAMES,
    autoRunRiskLevels: ["low", "reversible"],
  },
  connectionIds: [],
  repositories: [],
  aliases: [],
  lifecycle: "active",
  createdAt: now,
  updatedAt: now,
});

const automation = decodeAutomation({
  id: "manual-automation",
  spaceId: space.id,
  name: "Manual automation",
  version: 1,
  enabled: true,
  trigger: { type: "manual" },
  nodes: [{ id: "agent-step", kind: "transform", config: {}, position: { x: 0, y: 0 } }],
  edges: [],
  definitionDigest,
  configCommit: commitSha,
  createdAt: now,
  updatedAt: now,
});

const approvalAutomation = decodeAutomation({
  id: "approval-automation",
  spaceId: space.id,
  name: "Approval automation",
  version: 1,
  enabled: true,
  trigger: { type: "manual" },
  nodes: [
    {
      id: "publish-preview",
      kind: "approval",
      config: { approvalKey: "publish-preview" },
      position: { x: 0, y: 0 },
    },
  ],
  edges: [],
  definitionDigest,
  configCommit: commitSha,
  createdAt: now,
  updatedAt: now,
});

const agentAutomation = decodeAutomation({
  id: "agent-automation",
  spaceId: space.id,
  name: "Agent automation",
  version: 1,
  enabled: true,
  trigger: { type: "manual" },
  nodes: [
    {
      id: "agent-child",
      kind: "agent",
      config: { prompt: "Review the result" },
      position: { x: 0, y: 0 },
    },
  ],
  edges: [],
  definitionDigest,
  configCommit: commitSha,
  createdAt: now,
  updatedAt: now,
});

function agentWaitExecutor(context: AutomationNodeExecutionContext) {
  const commandId = automationAgentCommandId({
    executionId: context.executionId,
    nodeId: context.node.id,
  });
  const runId = `child:${context.executionId}`;
  const binding = {
    parentExecutionId: context.executionId,
    nodeId: context.node.id,
    commandId,
    childRunId: runId,
    spaceId: context.spaceId,
  };
  return Effect.succeed({
    type: "wait" as const,
    resumeKey: automationAgentRunResumeKey(binding),
    output: {
      kind: "command-center-run" as const,
      relationship: "automation-child" as const,
      parentExecutionId: context.executionId,
      automationId: context.automationId,
      nodeId: context.node.id,
      commandId,
      runId,
      spaceId: context.spaceId,
      repositoryId: null,
      projectId: null,
      providerId: "test-provider",
      modelId: "test-model",
      state: "queued" as const,
      routeStatus: "ready" as const,
      approvalRequired: false,
      reasons: [],
      duplicate: false,
    },
  });
}

function testLayer(options: { readonly executeNode?: AutomationNodeExecutor } = {}) {
  let nextRuntimeId = 0;
  const config: LoadedCommandCenterConfig = {
    spaces: [space],
    connections: [],
    automations: [automation, approvalAutomation, agentAutomation],
    timezone: "Etc/UTC",
    routing: {
      mode: "auto",
      showPreview: true,
      explicitSelectionWins: true,
      providerFallback: "first-healthy-compatible",
    },
    health: { status: "loaded", configDirectory: "test-config" },
  };
  const configLayer = Layer.succeed(
    CommandCenterConfig,
    CommandCenterConfig.of({
      configDirectory: "test-config",
      load: Effect.succeed(config),
      resolveGoogleAccount: () => Effect.die("Google account resolution is not used here."),
    }),
  );
  const commandCenterLayer = serviceLayer.pipe(
    Layer.provide(configLayer),
    Layer.provide(ConnectionHealth.layer),
  );
  const durableRuntimeLayer = runtimeLayer({
    executeNode:
      options.executeNode ??
      ((context) =>
        Effect.fail(`No executor is enabled for ${context.node.id} (${context.node.kind}).`)),
    now: Effect.succeed(now),
    randomUUID: Effect.sync(() => `execution-${++nextRuntimeId}`),
    defaultMaxAttempts: 1,
  });
  const dependencies = Layer.mergeAll(commandCenterLayer, durableRuntimeLayer, eventStreamLayer);
  return automationRunsLayer.pipe(
    Layer.provideMerge(dependencies),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );
}

const insertAgentChild = Effect.fn("AutomationRunsTest.insertAgentChild")(function* (input: {
  readonly executionId: string;
  readonly state:
    | "queued"
    | "running"
    | "waiting_approval"
    | "waiting"
    | "succeeded"
    | "failed"
    | "canceled";
  readonly error?: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const commandId = automationAgentCommandId({
    executionId: input.executionId,
    nodeId: "agent-child",
  });
  const terminal = ["succeeded", "failed", "canceled"].includes(input.state);
  yield* sql`
    INSERT INTO command_center_runs (
      id, command_id, parent_run_id, space_id, kind, state,
      route_json, input_json, error, started_at, finished_at
    ) VALUES (
      ${`child:${input.executionId}`}, ${commandId}, ${input.executionId}, ${space.id},
      'agent', ${input.state}, '{}', '{}', ${input.error ?? null}, ${now},
      ${terminal ? now : null}
    )
  `;
});

it.effect("starts pinned automation work fail-closed and replays idempotently", () =>
  Effect.gen(function* () {
    const runs = yield* AutomationRuns;
    const events = yield* CommandCenterEventStream;
    const sql = yield* SqlClient.SqlClient;
    const input = {
      automationId: automation.id,
      spaceId: space.id,
      idempotencyKey: "manual-request-1",
      expectedConfigCommitSha: commitSha,
      expectedDefinitionDigest: definitionDigest,
    } as const;

    const started = yield* runs.start(input);
    const replay = yield* runs.start(input);
    const auditRows = yield* sql<{ readonly action: string }>`
      SELECT action FROM command_center_audit_events
      WHERE action = 'cc.automations.run.changed'
      ORDER BY sequence
    `;
    const eventPage = yield* events.replay({ afterSequence: 0 });

    expect(started).toMatchObject({
      id: "execution-1",
      state: "failed",
      spaceId: space.id,
      configCommitSha: commitSha,
      definitionDigest,
      lease: null,
    });
    expect(started.error).toContain("No executor is enabled");
    expect(replay.id).toBe(started.id);
    expect(auditRows).toHaveLength(2);
    expect(eventPage.events.map((event) => event._tag)).toEqual([
      "AutomationRunChanged",
      "AutomationRunChanged",
    ]);
    expect(eventPage.events.at(-1)).toMatchObject({
      _tag: "AutomationRunChanged",
      payload: { state: "failed" },
    });
  }).pipe(Effect.provide(testLayer())),
);

it.effect("hides automation execution status across Space boundaries", () =>
  Effect.gen(function* () {
    const runs = yield* AutomationRuns;
    const started = yield* runs.start({
      automationId: automation.id,
      spaceId: space.id,
      idempotencyKey: "manual-request-2",
      expectedConfigCommitSha: commitSha,
      expectedDefinitionDigest: definitionDigest,
    });
    const error = yield* runs
      .get({ executionId: started.id, spaceId: SpaceId.make("space-b") })
      .pipe(Effect.flip);
    expect(error).toMatchObject({ reason: "not_found" });
  }).pipe(Effect.provide(testLayer())),
);

it.effect(
  "projects approval checkpoints into Needs You and resumes the exact digest idempotently",
  () =>
    Effect.gen(function* () {
      const runs = yield* AutomationRuns;
      const commandCenter = yield* CommandCenterService;
      const sql = yield* SqlClient.SqlClient;
      const started = yield* runs.start({
        automationId: approvalAutomation.id,
        spaceId: space.id,
        idempotencyKey: "approval-request-1",
        expectedConfigCommitSha: commitSha,
        expectedDefinitionDigest: definitionDigest,
      });
      expect(started).toMatchObject({
        id: "execution-1",
        state: "waiting_approval",
        automationId: approvalAutomation.id,
      });

      const bootstrap = yield* commandCenter.bootstrap;
      const approval = bootstrap.approvals.find((candidate) => candidate.runId === started.id);
      expect(bootstrap.runs).toContainEqual(
        expect.objectContaining({
          id: started.id,
          kind: "automation",
          status: "waiting_approval",
        }),
      );
      expect(approval).toMatchObject({
        status: "requested",
        actionKind: "automation.run",
        risk: "approval-required",
      });
      expect(bootstrap.needsYou).toContainEqual(
        expect.objectContaining({
          kind: "approval",
          status: "waiting",
          metadata: expect.objectContaining({
            executionId: started.id,
            nodeId: "publish-preview",
            definitionDigest,
          }),
        }),
      );

      const wrongDigest = yield* runs
        .decideApproval({
          approvalId: approval!.id,
          payloadDigest: `sha256:${"f".repeat(64)}`,
          decision: "approved",
        })
        .pipe(Effect.flip);
      expect(wrongDigest).toMatchObject({ reason: "conflict" });
      expect(yield* runs.get({ executionId: started.id, spaceId: space.id })).toMatchObject({
        state: "waiting_approval",
      });

      const decision = {
        approvalId: approval!.id,
        payloadDigest: approval!.payloadDigest,
        decision: "approved" as const,
      };
      const resolved = yield* runs.decideApproval(decision);
      const replay = yield* runs.decideApproval(decision);
      expect(resolved).toMatchObject({
        automation: true,
        approval: { status: "approved" },
        execution: { state: "succeeded" },
      });
      expect(replay).toMatchObject({
        automation: true,
        approval: { status: "approved" },
        execution: { state: "succeeded" },
      });

      const checkpointRows = yield* sql<{
        readonly state: string;
        readonly resolutionKey: string | null;
      }>`
        SELECT state, resolution_key AS "resolutionKey"
        FROM command_center_automation_node_checkpoints
        WHERE execution_id = ${started.id} AND node_id = 'publish-preview'
      `;
      expect(checkpointRows).toEqual([
        {
          state: "succeeded",
          resolutionKey: [
            "canonical-approval",
            approval!.id,
            approval!.payloadDigest,
            "approved",
          ].join(":"),
        },
      ]);

      const oppositeReplay = yield* runs
        .decideApproval({ ...decision, decision: "declined" })
        .pipe(Effect.flip);
      expect(oppositeReplay).toMatchObject({ reason: "conflict" });
      expect(yield* runs.get({ executionId: started.id, spaceId: space.id })).toMatchObject({
        state: "succeeded",
      });
    }).pipe(Effect.provide(testLayer())),
);

it.effect("expires canonical automation approvals without authorizing the checkpoint", () =>
  Effect.gen(function* () {
    const runs = yield* AutomationRuns;
    const commandCenter = yield* CommandCenterService;
    const sql = yield* SqlClient.SqlClient;
    const started = yield* runs.start({
      automationId: approvalAutomation.id,
      spaceId: space.id,
      idempotencyKey: "approval-request-expired",
      expectedConfigCommitSha: commitSha,
      expectedDefinitionDigest: definitionDigest,
    });
    const approval = (yield* commandCenter.queryApprovals({})).approvals.find(
      (candidate) => candidate.runId === started.id,
    );
    yield* sql`
      UPDATE command_center_approvals
      SET expires_at = '1960-01-01T00:00:00.000Z'
      WHERE id = ${approval!.id}
    `;

    const error = yield* runs
      .decideApproval({
        approvalId: approval!.id,
        payloadDigest: approval!.payloadDigest,
        decision: "approved",
      })
      .pipe(Effect.flip);
    expect(error).toMatchObject({ reason: "conflict" });
    expect((yield* commandCenter.queryApprovals({})).approvals).toContainEqual(
      expect.objectContaining({ id: approval!.id, status: "expired" }),
    );
    expect(yield* runs.get({ executionId: started.id, spaceId: space.id })).toMatchObject({
      state: "canceled",
      checkpoints: [
        expect.objectContaining({
          state: "failed",
          resolutionKey: [
            "canonical-approval",
            approval!.id,
            approval!.payloadDigest,
            "expired",
          ].join(":"),
          output: expect.objectContaining({ decision: "expired" }),
        }),
      ],
    });
  }).pipe(Effect.provide(testLayer())),
);

it.effect(
  "recovers a decided checkpoint after a crash between the canonical decision and resume",
  () =>
    Effect.gen(function* () {
      const runs = yield* AutomationRuns;
      const commandCenter = yield* CommandCenterService;
      const input = {
        automationId: approvalAutomation.id,
        spaceId: space.id,
        idempotencyKey: "approval-crash-recovery",
        expectedConfigCommitSha: commitSha,
        expectedDefinitionDigest: definitionDigest,
      } as const;
      const waiting = yield* runs.start(input);
      const approval = (yield* commandCenter.queryApprovals({})).approvals.find(
        (candidate) => candidate.runId === waiting.id,
      );

      // This models process loss immediately after the canonical transaction:
      // the approval is durable, while the runtime checkpoint has not resumed.
      yield* commandCenter.decideApproval({
        approvalId: approval!.id,
        payloadDigest: approval!.payloadDigest,
        decision: "approved",
      });
      expect(yield* runs.recoverDue({ owner: "restart-worker" })).toMatchObject({
        scanned: 1,
        recovered: 1,
        remaining: 0,
        failures: [],
      });
      expect(yield* runs.get({ executionId: waiting.id, spaceId: space.id })).toMatchObject({
        state: "succeeded",
        checkpoints: [expect.objectContaining({ state: "succeeded" })],
      });
    }).pipe(Effect.provide(testLayer())),
);

it.effect("declines an automation checkpoint once and leaves later nodes inert", () =>
  Effect.gen(function* () {
    const runs = yield* AutomationRuns;
    const commandCenter = yield* CommandCenterService;
    const waiting = yield* runs.start({
      automationId: approvalAutomation.id,
      spaceId: space.id,
      idempotencyKey: "approval-declined",
      expectedConfigCommitSha: commitSha,
      expectedDefinitionDigest: definitionDigest,
    });
    const approval = (yield* commandCenter.queryApprovals({})).approvals.find(
      (candidate) => candidate.runId === waiting.id,
    );
    const decision = {
      approvalId: approval!.id,
      payloadDigest: approval!.payloadDigest,
      decision: "declined" as const,
    };
    expect(yield* runs.decideApproval(decision)).toMatchObject({
      automation: true,
      approval: { status: "declined" },
      execution: {
        state: "canceled",
        checkpoints: [expect.objectContaining({ state: "failed" })],
      },
    });
    expect(yield* runs.decideApproval(decision)).toMatchObject({
      execution: { state: "canceled" },
    });
  }).pipe(Effect.provide(testLayer())),
);

it.effect("durably joins a child agent Run from queued through running to succeeded", () =>
  Effect.gen(function* () {
    const runs = yield* AutomationRuns;
    const sql = yield* SqlClient.SqlClient;
    const waiting = yield* runs.start({
      automationId: agentAutomation.id,
      spaceId: space.id,
      idempotencyKey: "agent-child-success",
      expectedConfigCommitSha: commitSha,
      expectedDefinitionDigest: definitionDigest,
    });
    expect(waiting).toMatchObject({
      id: "execution-1",
      state: "waiting_external",
      checkpoints: [
        expect.objectContaining({
          nodeId: "agent-child",
          nodeKind: "agent",
          state: "waiting_external",
        }),
      ],
    });

    yield* insertAgentChild({ executionId: waiting.id, state: "queued" });
    expect(yield* runs.recoverDue({ owner: "agent-join" })).toMatchObject({
      scanned: 1,
      recovered: 1,
      remaining: 1,
      failures: [],
    });
    expect(yield* runs.get({ executionId: waiting.id, spaceId: space.id })).toMatchObject({
      state: "waiting_external",
    });

    yield* sql`
      UPDATE command_center_runs
      SET state = 'running'
      WHERE id = ${`child:${waiting.id}`}
    `;
    yield* runs.recoverDue({ owner: "agent-join" });
    expect(yield* runs.get({ executionId: waiting.id, spaceId: space.id })).toMatchObject({
      state: "waiting_external",
    });

    yield* sql`
      UPDATE command_center_runs
      SET state = 'succeeded', result_json = ${encodeJson({ summary: "complete" })},
        finished_at = ${now}
      WHERE id = ${`child:${waiting.id}`}
    `;
    expect(yield* runs.recoverDue({ owner: "agent-join" })).toMatchObject({
      scanned: 1,
      recovered: 1,
      remaining: 0,
      failures: [],
    });
    expect(yield* runs.get({ executionId: waiting.id, spaceId: space.id })).toMatchObject({
      state: "succeeded",
      checkpoints: [
        expect.objectContaining({
          state: "succeeded",
          output: expect.objectContaining({
            state: "succeeded",
            terminal: {
              state: "succeeded",
              result: { summary: "complete" },
              error: null,
              finishedAt: now,
            },
          }),
        }),
      ],
    });
    expect(yield* runs.recoverDue({ owner: "agent-join-replay" })).toMatchObject({
      scanned: 0,
      recovered: 0,
      remaining: 0,
      failures: [],
    });
  }).pipe(Effect.provide(testLayer({ executeNode: agentWaitExecutor }))),
);

it.effect("keeps the automation durable while its child Run waits for approval", () =>
  Effect.gen(function* () {
    const runs = yield* AutomationRuns;
    const waiting = yield* runs.start({
      automationId: agentAutomation.id,
      spaceId: space.id,
      idempotencyKey: "agent-child-approval",
      expectedConfigCommitSha: commitSha,
      expectedDefinitionDigest: definitionDigest,
    });
    yield* insertAgentChild({ executionId: waiting.id, state: "waiting_approval" });

    expect(yield* runs.recoverDue({ owner: "agent-approval-join" })).toMatchObject({
      scanned: 1,
      recovered: 1,
      remaining: 1,
      failures: [],
    });
    expect(yield* runs.get({ executionId: waiting.id, spaceId: space.id })).toMatchObject({
      state: "waiting_external",
      checkpoints: [expect.objectContaining({ state: "waiting_external" })],
    });
  }).pipe(Effect.provide(testLayer({ executeNode: agentWaitExecutor }))),
);

it.effect("propagates failed and canceled child Run states without re-executing the node", () =>
  Effect.gen(function* () {
    const runs = yield* AutomationRuns;
    for (const state of ["failed", "canceled"] as const) {
      const waiting = yield* runs.start({
        automationId: agentAutomation.id,
        spaceId: space.id,
        idempotencyKey: `agent-child-${state}`,
        expectedConfigCommitSha: commitSha,
        expectedDefinitionDigest: definitionDigest,
      });
      yield* insertAgentChild({
        executionId: waiting.id,
        state,
        error: `Child Run ${state}.`,
      });
      expect(yield* runs.recoverDue({ owner: `agent-${state}-join` })).toMatchObject({
        failures: [],
      });
      expect(yield* runs.get({ executionId: waiting.id, spaceId: space.id })).toMatchObject({
        state,
        error: `Child Run ${state}.`,
        checkpoints: [
          expect.objectContaining({
            state: "failed",
            error: `Child Run ${state}.`,
            output: expect.objectContaining({ state }),
          }),
        ],
      });
    }
  }).pipe(Effect.provide(testLayer({ executeNode: agentWaitExecutor }))),
);
