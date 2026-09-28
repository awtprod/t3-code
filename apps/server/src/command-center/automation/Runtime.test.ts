import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import migration072 from "../../persistence/Migrations/072_CommandCenterResponsibilities.ts";
import { canonicalJson } from "./Digest.ts";
import {
  type AutomationNodeExecutionContext,
  type AutomationNodeExecutionOutcome,
  type AutomationRuntimeDependencies,
  AutomationRuntime,
  layer as automationRuntimeLayer,
  make as makeAutomationRuntime,
} from "./Runtime.ts";

const initialNow = "2026-01-01T00:00:00.000Z";
const commitSha = "1234567890abcdef1234567890abcdef12345678";
const definitionDigest = `sha256:${"a".repeat(64)}`;

interface NodeFixture {
  readonly id: string;
  readonly kind:
    | "agent"
    | "connector.read"
    | "item.mutate"
    | "condition"
    | "transform"
    | "foreach"
    | "delay"
    | "approval"
    | "shell.scoped";
  readonly config?: Readonly<Record<string, Schema.Json>>;
}

interface AutomationFixtureOptions {
  readonly id?: string;
  readonly enabled?: boolean;
  readonly commit?: string;
  readonly digest?: string;
  readonly nodes?: ReadonlyArray<NodeFixture>;
  readonly edges?: ReadonlyArray<readonly [string, string]>;
}

function automationFixture(options: AutomationFixtureOptions = {}) {
  const id = options.id ?? "sample-automation";
  const enabled = options.enabled ?? true;
  const configCommit = options.commit ?? commitSha;
  const digest = options.digest ?? definitionDigest;
  const nodes = options.nodes ?? [{ id: "step", kind: "transform", config: {} }];
  return {
    id,
    spaceId: "sample-space",
    name: "Sample automation",
    version: 1,
    enabled,
    trigger: { type: "manual" },
    nodes: nodes.map((node, index) => ({
      id: node.id,
      kind: node.kind,
      config: node.config ?? {},
      position: { x: index * 200, y: 0 },
    })),
    edges: (options.edges ?? []).map(([sourceNodeId, targetNodeId]) => ({
      sourceNodeId,
      targetNodeId,
    })),
    definitionDigest: digest,
    configCommit,
    createdAt: initialNow,
    updatedAt: initialNow,
  } as const;
}

function harness(
  handler: (context: AutomationNodeExecutionContext) => AutomationNodeExecutionOutcome,
) {
  let now = initialNow;
  let nextId = 0;
  const invocations: AutomationNodeExecutionContext[] = [];
  const dependencies: AutomationRuntimeDependencies = {
    now: Effect.sync(() => now),
    randomUUID: Effect.sync(() => `runtime-id-${++nextId}`),
    executeNode: (context) =>
      Effect.sync(() => {
        invocations.push(context);
        return handler(context);
      }),
    defaultRetryDelayMs: 0,
  };
  return {
    dependencies,
    invocations,
    setNow: (value: string) => {
      now = value;
    },
  };
}

function testLayer(dependencies: AutomationRuntimeDependencies) {
  const persistence = Layer.effectDiscard(migration072).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  return automationRuntimeLayer(dependencies).pipe(Layer.provideMerge(persistence));
}

const seedAutomation = Effect.fn("AutomationRuntimeTest.seedAutomation")(function* (
  automation: ReturnType<typeof automationFixture>,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO command_center_spaces (
      id, slug, name, kind, created_at, updated_at
    ) VALUES (
      'sample-space', 'sample-space', 'Sample Space', 'business', ${initialNow}, ${initialNow}
    )
    ON CONFLICT(id) DO NOTHING
  `;
  yield* sql`
    INSERT INTO command_center_automations (
      id, space_id, name, enabled, commit_sha, definition_digest,
      definition_json, last_loaded_at
    ) VALUES (
      ${automation.id}, ${automation.spaceId}, ${automation.name},
      ${automation.enabled ? 1 : 0}, ${automation.configCommit},
      ${automation.definitionDigest}, ${canonicalJson(automation as Schema.Json)}, ${initialNow}
    )
  `;
});

it.effect("pins every run to the committed digest and rejects unsafe definition sources", () => {
  const fixture = automationFixture();
  const runtimeHarness = harness(() => ({ type: "succeeded" }));

  return Effect.gen(function* () {
    yield* seedAutomation(fixture);
    const runtime = yield* AutomationRuntime;
    const sql = yield* SqlClient.SqlClient;

    const mismatch = yield* runtime
      .start({
        automationId: fixture.id,
        idempotencyKey: "mismatch",
        expectedConfigCommitSha: commitSha,
        expectedDefinitionDigest: `sha256:${"b".repeat(64)}`,
      })
      .pipe(Effect.flip);
    expect(mismatch).toMatchObject({ code: "definition-mismatch" });

    const wrongSpace = yield* runtime
      .start({
        automationId: fixture.id,
        expectedSpaceId: "another-space",
        idempotencyKey: "wrong-space",
        expectedConfigCommitSha: commitSha,
        expectedDefinitionDigest: definitionDigest,
      })
      .pipe(Effect.flip);
    expect(wrongSpace).toMatchObject({ code: "automation-not-found" });

    const started = yield* runtime.start({
      automationId: fixture.id,
      idempotencyKey: "pinned",
      expectedConfigCommitSha: commitSha,
      expectedDefinitionDigest: definitionDigest,
      input: { sample: true },
    });
    expect(started).toMatchObject({
      configCommitSha: commitSha,
      definitionDigest,
      state: "queued",
    });
    expect(
      (yield* runtime.start({
        automationId: fixture.id,
        expectedSpaceId: "sample-space",
        idempotencyKey: "pinned",
        expectedConfigCommitSha: commitSha,
        expectedDefinitionDigest: definitionDigest,
        input: { sample: true },
      })).id,
    ).toBe(started.id);
    const crossSpaceReplay = yield* runtime
      .start({
        automationId: fixture.id,
        expectedSpaceId: "another-space",
        idempotencyKey: "pinned",
        expectedConfigCommitSha: commitSha,
        expectedDefinitionDigest: definitionDigest,
        input: { sample: true },
      })
      .pipe(Effect.flip);
    expect(crossSpaceReplay).toMatchObject({ code: "idempotency-conflict" });

    const replacementDigest = `sha256:${"c".repeat(64)}`;
    yield* sql`
      UPDATE command_center_automations
      SET definition_digest = ${replacementDigest}
      WHERE id = ${fixture.id}
    `;
    expect(yield* runtime.get(started.id)).toMatchObject({
      configCommitSha: commitSha,
      definitionDigest,
    });

    yield* sql`
      UPDATE command_center_automations
      SET enabled = 0
      WHERE id = ${fixture.id}
    `;
    const disabled = yield* runtime
      .start({
        automationId: fixture.id,
        idempotencyKey: "disabled",
        expectedConfigCommitSha: commitSha,
        expectedDefinitionDigest: replacementDigest,
      })
      .pipe(Effect.flip);
    expect(disabled).toMatchObject({ code: "automation-disabled" });

    yield* sql`
      UPDATE command_center_automations
      SET enabled = 1, commit_sha = 'dirty'
      WHERE id = ${fixture.id}
    `;
    const uncommitted = yield* runtime
      .start({
        automationId: fixture.id,
        idempotencyKey: "uncommitted",
        expectedConfigCommitSha: "dirty",
        expectedDefinitionDigest: replacementDigest,
      })
      .pipe(Effect.flip);
    expect(uncommitted).toMatchObject({ code: "automation-uncommitted" });
  }).pipe(Effect.provide(testLayer(runtimeHarness.dependencies)));
});

it.effect("persists bounded retries and resumes only after the retry checkpoint", () => {
  const fixture = automationFixture({
    nodes: [{ id: "step", kind: "connector.read", config: { maxAttempts: 2 } }],
  });
  const runtimeHarness = harness((context) => {
    if (context.runInput.mode === "recover" && context.attempt === 2) {
      return { type: "succeeded", output: { recovered: true } };
    }
    return { type: "retry", error: `attempt ${context.attempt}`, retryAfterMs: 0 };
  });

  return Effect.gen(function* () {
    yield* seedAutomation(fixture);
    const runtime = yield* AutomationRuntime;
    const sql = yield* SqlClient.SqlClient;

    const recover = yield* runtime.start({
      automationId: fixture.id,
      idempotencyKey: "recover",
      expectedConfigCommitSha: commitSha,
      expectedDefinitionDigest: definitionDigest,
      input: { mode: "recover" },
    });
    const recoverLease = yield* runtime.acquireLease({
      executionId: recover.id,
      owner: "worker-a",
      ttlMs: 60_000,
    });
    expect(yield* runtime.advance(recoverLease)).toMatchObject({ state: "waiting_retry" });
    const recovered = yield* runtime.advance(recoverLease);
    expect(recovered).toMatchObject({ state: "succeeded" });
    expect(recovered.checkpoints[0]).toMatchObject({
      state: "succeeded",
      attemptCount: 2,
      maxAttempts: 2,
    });
    expect(
      yield* sql<{ readonly state: string; readonly count: number }>`
        SELECT state, occurrence_count AS count
        FROM command_center_responsibility_incidents
        WHERE latest_execution_id = ${recover.id}
      `,
    ).toEqual([{ state: "resolved", count: 1 }]);

    const exhaust = yield* runtime.start({
      automationId: fixture.id,
      idempotencyKey: "exhaust",
      expectedConfigCommitSha: commitSha,
      expectedDefinitionDigest: definitionDigest,
      input: { mode: "exhaust" },
    });
    const exhaustLease = yield* runtime.acquireLease({
      executionId: exhaust.id,
      owner: "worker-b",
      ttlMs: 60_000,
    });
    yield* runtime.advance(exhaustLease);
    const failed = yield* runtime.advance(exhaustLease);
    expect(failed).toMatchObject({ state: "failed", error: "attempt 2" });
    expect(failed.checkpoints[0]).toMatchObject({
      state: "failed",
      attemptCount: 2,
      maxAttempts: 2,
    });
  }).pipe(Effect.provide(testLayer(runtimeHarness.dependencies)));
});

it.effect("rejects privileged nodes with malformed config before creating an execution", () => {
  const runtimeHarness = harness(() => ({ type: "succeeded" }));

  return Effect.gen(function* () {
    const runtime = yield* AutomationRuntime;
    const sql = yield* SqlClient.SqlClient;
    for (const [index, kind] of ["agent", "shell.scoped"].entries()) {
      const fixture = automationFixture({
        id: `unsupported-${index}`,
        nodes: [{ id: "blocked", kind: kind as "agent" | "shell.scoped" }],
      });
      yield* seedAutomation(fixture);
      const error = yield* runtime
        .start({
          automationId: fixture.id,
          idempotencyKey: `unsupported-${index}`,
          expectedConfigCommitSha: commitSha,
          expectedDefinitionDigest: definitionDigest,
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ code: "definition-invalid" });
      expect(error.message).toContain("pinned automation graph is invalid");
    }
    const executions = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM command_center_automation_executions
    `;
    expect(executions).toEqual([{ count: 0 }]);
    expect(runtimeHarness.invocations).toHaveLength(0);
  }).pipe(Effect.provide(testLayer(runtimeHarness.dependencies)));
});

it.effect("persists external waits, delays, and idempotent approval decisions", () => {
  const fixture = automationFixture({
    nodes: [
      { id: "wait", kind: "connector.read" },
      { id: "pause", kind: "delay", config: { durationMs: 1_000 } },
      { id: "approve", kind: "approval", config: { approvalKey: "approval-key" } },
    ],
    edges: [
      ["wait", "pause"],
      ["pause", "approve"],
    ],
  });
  const runtimeHarness = harness(() => ({ type: "wait", resumeKey: "resume-key" }));

  return Effect.gen(function* () {
    yield* seedAutomation(fixture);
    const runtime = yield* AutomationRuntime;
    const started = yield* runtime.start({
      automationId: fixture.id,
      idempotencyKey: "wait-delay-approval",
      expectedConfigCommitSha: commitSha,
      expectedDefinitionDigest: definitionDigest,
    });
    const lease = yield* runtime.acquireLease({
      executionId: started.id,
      owner: "worker",
      ttlMs: 60_000,
    });

    const waiting = yield* runtime.advance(lease);
    expect(waiting).toMatchObject({ state: "waiting_external" });
    const resumed = yield* runtime.resumeWait({
      executionId: started.id,
      nodeId: "wait",
      resumeKey: "resume-key",
      resolutionKey: "wait-resolution",
      output: { payload: "sample" },
    });
    expect(resumed).toMatchObject({ state: "queued" });
    expect(
      yield* runtime.resumeWait({
        executionId: started.id,
        nodeId: "wait",
        resumeKey: "resume-key",
        resolutionKey: "wait-resolution",
        output: { payload: "sample" },
      }),
    ).toMatchObject({ state: "queued" });

    const delayed = yield* runtime.advance(lease);
    expect(delayed).toMatchObject({ state: "waiting_delay" });
    expect(yield* runtime.advance(lease)).toMatchObject({ state: "waiting_delay" });
    runtimeHarness.setNow("2026-01-01T00:00:01.000Z");
    const delayFinished = yield* runtime.advance(lease);
    expect(delayFinished).toMatchObject({ state: "running" });
    expect(
      delayFinished.checkpoints.find((checkpoint) => checkpoint.nodeId === "pause"),
    ).toMatchObject({ state: "succeeded" });

    const needsApproval = yield* runtime.advance(lease);
    expect(needsApproval).toMatchObject({ state: "waiting_approval" });
    const approvalKey = needsApproval.checkpoints.find(
      (checkpoint) => checkpoint.nodeId === "approve",
    )?.resumeKey;
    expect(approvalKey).toContain(definitionDigest);
    const approved = yield* runtime.resolveApproval({
      executionId: started.id,
      nodeId: "approve",
      approvalKey: approvalKey!,
      resolutionKey: "approval-resolution",
      approved: true,
    });
    expect(approved).toMatchObject({ state: "queued" });
    expect(
      yield* runtime.resolveApproval({
        executionId: started.id,
        nodeId: "approve",
        approvalKey: approvalKey!,
        resolutionKey: "approval-resolution",
        approved: true,
      }),
    ).toMatchObject({ state: "queued" });

    expect(yield* runtime.advance(lease)).toMatchObject({ state: "succeeded" });
    expect(runtimeHarness.invocations).toHaveLength(1);
  }).pipe(Effect.provide(testLayer(runtimeHarness.dependencies)));
});

it.effect("restarts an orphaned node without changing its executor or policy pins", () => {
  const fixture = automationFixture();
  const runtimeHarness = harness(() => ({ type: "succeeded", output: { done: true } }));

  return Effect.gen(function* () {
    yield* seedAutomation(fixture);
    const runtime = yield* AutomationRuntime;
    const sql = yield* SqlClient.SqlClient;
    const started = yield* runtime.start({
      automationId: fixture.id,
      idempotencyKey: "restart",
      expectedConfigCommitSha: commitSha,
      expectedDefinitionDigest: definitionDigest,
    });
    const firstLease = yield* runtime.acquireLease({
      executionId: started.id,
      owner: "worker-a",
      ttlMs: 1_000,
    });
    const executorKey = `${started.id}:step:1`;
    const policyDigest = `sha256:${"b".repeat(64)}`;
    yield* sql`
      UPDATE command_center_automation_node_checkpoints
      SET state = 'running', attempt_count = 1, executor_idempotency_key = ${executorKey},
        scoped_shell_policy_digest = ${policyDigest}, lease_token = ${firstLease.token},
        started_at = ${initialNow}, updated_at = ${initialNow}
      WHERE execution_id = ${started.id} AND node_id = 'step'
    `;
    yield* sql`
      UPDATE command_center_automation_executions
      SET state = 'running', updated_at = ${initialNow}
      WHERE id = ${started.id}
    `;

    runtimeHarness.setNow("2026-01-01T00:00:02.000Z");
    const restartedRuntime = yield* makeAutomationRuntime(runtimeHarness.dependencies);
    const secondLease = yield* restartedRuntime.acquireLease({
      executionId: started.id,
      owner: "worker-b",
      ttlMs: 60_000,
    });
    const completed = yield* restartedRuntime.advance(secondLease);
    expect(completed).toMatchObject({
      state: "succeeded",
      checkpoints: [expect.objectContaining({ scopedShellPolicyDigest: policyDigest })],
    });
    expect(runtimeHarness.invocations.map((invocation) => invocation.idempotencyKey)).toEqual([
      executorKey,
    ]);

    const replay = yield* restartedRuntime.start({
      automationId: fixture.id,
      idempotencyKey: "restart",
      expectedConfigCommitSha: commitSha,
      expectedDefinitionDigest: definitionDigest,
    });
    expect(replay.id).toBe(started.id);
    expect(runtimeHarness.invocations).toHaveLength(1);
  }).pipe(Effect.provide(testLayer(runtimeHarness.dependencies)));
});

it.effect("discovers and resolves durable agent waits after a fresh runtime starts", () => {
  const fixture = automationFixture({
    nodes: [{ id: "agent-step", kind: "agent", config: { prompt: "Review the result" } }],
  });
  const runtimeHarness = harness((context) => ({
    type: "wait",
    resumeKey: `agent-child:${context.executionId}`,
    output: { runId: `child:${context.executionId}`, state: "queued" },
  }));

  return Effect.gen(function* () {
    yield* seedAutomation(fixture);
    const runtime = yield* AutomationRuntime;
    const started = yield* runtime.start({
      automationId: fixture.id,
      idempotencyKey: "agent-restart",
      expectedConfigCommitSha: commitSha,
      expectedDefinitionDigest: definitionDigest,
    });
    const lease = yield* runtime.acquireLease({
      executionId: started.id,
      owner: "worker-before-crash",
      ttlMs: 1_000,
    });
    expect(yield* runtime.advance(lease)).toMatchObject({
      state: "waiting_external",
      checkpoints: [expect.objectContaining({ nodeKind: "agent" })],
    });

    runtimeHarness.setNow("2026-01-01T00:00:02.000Z");
    const restarted = yield* makeAutomationRuntime(runtimeHarness.dependencies);
    expect(yield* restarted.listWaitingExternal()).toHaveLength(1);
    const resolved = yield* restarted.resolveWait({
      executionId: started.id,
      nodeId: "agent-step",
      resumeKey: `agent-child:${started.id}`,
      resolutionKey: `agent-child:${started.id}:succeeded`,
      outcome: "succeeded",
      output: { runId: `child:${started.id}`, state: "succeeded" },
    });
    expect(resolved).toMatchObject({ state: "queued" });

    const restartedLease = yield* restarted.acquireLease({
      executionId: started.id,
      owner: "worker-after-crash",
      ttlMs: 60_000,
    });
    expect(yield* restarted.advance(restartedLease)).toMatchObject({ state: "succeeded" });
    expect(runtimeHarness.invocations).toHaveLength(1);
  }).pipe(Effect.provide(testLayer(runtimeHarness.dependencies)));
});

it.effect("propagates failed and canceled external agent results idempotently", () => {
  const fixture = automationFixture({
    nodes: [{ id: "agent-step", kind: "agent", config: { prompt: "Review the result" } }],
  });
  const runtimeHarness = harness((context) => ({
    type: "wait",
    resumeKey: `agent-child:${context.executionId}`,
  }));

  return Effect.gen(function* () {
    yield* seedAutomation(fixture);
    const runtime = yield* AutomationRuntime;
    for (const outcome of ["failed", "canceled"] as const) {
      const started = yield* runtime.start({
        automationId: fixture.id,
        idempotencyKey: `agent-${outcome}`,
        expectedConfigCommitSha: commitSha,
        expectedDefinitionDigest: definitionDigest,
      });
      const lease = yield* runtime.acquireLease({
        executionId: started.id,
        owner: `worker-${outcome}`,
        ttlMs: 60_000,
      });
      yield* runtime.advance(lease);
      const resolution = {
        executionId: started.id,
        nodeId: "agent-step",
        resumeKey: `agent-child:${started.id}`,
        resolutionKey: `agent-child:${started.id}:${outcome}`,
        outcome,
        error: `Child Run ${outcome}.`,
        output: { runId: `child:${started.id}`, state: outcome },
      } as const;
      expect(yield* runtime.resolveWait(resolution)).toMatchObject({
        state: outcome,
        error: `Child Run ${outcome}.`,
        checkpoints: [expect.objectContaining({ state: "failed" })],
      });
      expect(yield* runtime.resolveWait(resolution)).toMatchObject({ state: outcome });
    }
  }).pipe(Effect.provide(testLayer(runtimeHarness.dependencies)));
});

it.effect("denies concurrent leases and fences an expired worker", () => {
  const fixture = automationFixture();
  const runtimeHarness = harness(() => ({ type: "succeeded" }));

  return Effect.gen(function* () {
    yield* seedAutomation(fixture);
    const runtime = yield* AutomationRuntime;
    const started = yield* runtime.start({
      automationId: fixture.id,
      idempotencyKey: "lease",
      expectedConfigCommitSha: commitSha,
      expectedDefinitionDigest: definitionDigest,
    });
    const first = yield* runtime.acquireLease({
      executionId: started.id,
      owner: "worker-a",
      ttlMs: 1_000,
    });
    const denied = yield* runtime
      .acquireLease({ executionId: started.id, owner: "worker-b", ttlMs: 1_000 })
      .pipe(Effect.flip);
    expect(denied).toMatchObject({ code: "lease-denied" });

    runtimeHarness.setNow("2026-01-01T00:00:02.000Z");
    const second = yield* runtime.acquireLease({
      executionId: started.id,
      owner: "worker-b",
      ttlMs: 60_000,
    });
    expect(second.generation).toBe(first.generation + 1);
    const fenced = yield* runtime.advance(first).pipe(Effect.flip);
    expect(fenced).toMatchObject({ code: "lease-lost" });
    expect(yield* runtime.advance(second)).toMatchObject({ state: "succeeded" });
  }).pipe(Effect.provide(testLayer(runtimeHarness.dependencies)));
});

it.effect(
  "admits one active execution across concurrent trigger identities and permits the next terminal check",
  () => {
    const fixture = automationFixture();
    const runtimeHarness = harness(() => ({ type: "succeeded", output: { checked: true } }));

    return Effect.gen(function* () {
      yield* seedAutomation(fixture);
      const runtime = yield* AutomationRuntime;
      const starts = yield* Effect.all(
        ["manual-overlap", "schedule-overlap"].map((idempotencyKey) =>
          runtime.start({
            automationId: fixture.id,
            expectedSpaceId: "sample-space",
            idempotencyKey,
            expectedConfigCommitSha: commitSha,
            expectedDefinitionDigest: definitionDigest,
          }),
        ),
        { concurrency: "unbounded" },
      );
      expect(new Set(starts.map((execution) => execution.id)).size).toBe(1);

      const lease = yield* runtime.acquireLease({
        executionId: starts[0]!.id,
        owner: "overlap-worker",
        ttlMs: 60_000,
      });
      expect(yield* runtime.advance(lease)).toMatchObject({ state: "succeeded" });
      expect(
        (yield* runtime.start({
          automationId: fixture.id,
          expectedSpaceId: "sample-space",
          idempotencyKey: "schedule-overlap",
          expectedConfigCommitSha: commitSha,
          expectedDefinitionDigest: definitionDigest,
        })).id,
      ).toBe(starts[0]!.id);

      const next = yield* runtime.start({
        automationId: fixture.id,
        expectedSpaceId: "sample-space",
        idempotencyKey: "next-legitimate-check",
        expectedConfigCommitSha: commitSha,
        expectedDefinitionDigest: definitionDigest,
      });
      expect(next.id).not.toBe(starts[0]!.id);
    }).pipe(Effect.provide(testLayer(runtimeHarness.dependencies)));
  },
);

it.effect(
  "blocks direct runtime admission while paused without canceling the current execution",
  () => {
    const fixture = automationFixture();
    const runtimeHarness = harness(() => ({ type: "succeeded" }));

    return Effect.gen(function* () {
      yield* seedAutomation(fixture);
      const runtime = yield* AutomationRuntime;
      const sql = yield* SqlClient.SqlClient;
      const previousCheck = "2025-12-31T23:00:00.000Z";
      yield* sql`
        INSERT INTO command_center_responsibility_status (
          space_id, automation_id, last_checked_at, last_check_status, updated_at
        ) VALUES ('sample-space', ${fixture.id}, ${previousCheck}, 'ok', ${previousCheck})
      `;
      const current = yield* runtime.start({
        automationId: fixture.id,
        idempotencyKey: "already-running",
        expectedConfigCommitSha: commitSha,
        expectedDefinitionDigest: definitionDigest,
      });
      expect(
        yield* sql<{ readonly checkedAt: string | null }>`
          SELECT last_checked_at AS "checkedAt"
          FROM command_center_responsibility_status
          WHERE automation_id = ${fixture.id}
        `,
      ).toEqual([{ checkedAt: previousCheck }]);
      yield* sql`
      INSERT INTO command_center_responsibility_controls (
        space_id, automation_id, paused, actor, reason, revision, changed_at
      ) VALUES ('sample-space', ${fixture.id}, 1, 'andrew', 'hold', 1, ${initialNow})
    `;

      const blocked = yield* runtime
        .start({
          automationId: fixture.id,
          idempotencyKey: "paused-direct",
          expectedConfigCommitSha: commitSha,
          expectedDefinitionDigest: definitionDigest,
        })
        .pipe(Effect.flip);
      expect(blocked).toMatchObject({ code: "automation-paused" });
      expect(yield* runtime.get(current.id)).toMatchObject({ state: "queued" });
      expect(
        yield* sql<{ readonly checkedAt: string | null; readonly admission: string }>`
          SELECT last_checked_at AS "checkedAt", last_admission_status AS admission
          FROM command_center_responsibility_status
          WHERE automation_id = ${fixture.id}
        `,
      ).toEqual([{ checkedAt: previousCheck, admission: "paused" }]);

      yield* sql`
      UPDATE command_center_responsibility_controls
      SET paused = 0, revision = 2
      WHERE space_id = 'sample-space' AND automation_id = ${fixture.id}
    `;
      // Resume does not replay the blocked request; the pre-existing active slot
      // remains the only work until it reaches a terminal state.
      const resumed = yield* runtime.start({
        automationId: fixture.id,
        idempotencyKey: "after-resume",
        expectedConfigCommitSha: commitSha,
        expectedDefinitionDigest: definitionDigest,
      });
      expect(resumed.id).toBe(current.id);
    }).pipe(Effect.provide(testLayer(runtimeHarness.dependencies)));
  },
);

it.effect(
  "groups repeated permanent faults and resolves the same incident after correction",
  () => {
    const fixture = automationFixture();
    let corrected = false;
    const runtimeHarness = harness(() =>
      corrected
        ? { type: "succeeded", output: { corrected: true } }
        : { type: "failed", error: "token /secret/path\ninvalid" },
    );

    return Effect.gen(function* () {
      yield* seedAutomation(fixture);
      const runtime = yield* AutomationRuntime;
      const sql = yield* SqlClient.SqlClient;
      for (const key of ["fault-one", "fault-two"]) {
        const started = yield* runtime.start({
          automationId: fixture.id,
          idempotencyKey: key,
          expectedConfigCommitSha: commitSha,
          expectedDefinitionDigest: definitionDigest,
        });
        const lease = yield* runtime.acquireLease({
          executionId: started.id,
          owner: key,
          ttlMs: 60_000,
        });
        expect(yield* runtime.advance(lease)).toMatchObject({ state: "failed" });
      }

      const incidents = yield* sql<{
        readonly state: string;
        readonly count: number;
        readonly displayError: string;
      }>`
      SELECT state, occurrence_count AS count, display_error AS "displayError"
      FROM command_center_responsibility_incidents
    `;
      expect(incidents).toEqual([
        { state: "blocked", count: 2, displayError: "token /secret/path invalid" },
      ]);
      const items = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM command_center_items
      WHERE id LIKE 'responsibility-incident:%'
    `;
      expect(items).toEqual([{ count: 1 }]);

      corrected = true;
      const correctedRun = yield* runtime.start({
        automationId: fixture.id,
        idempotencyKey: "fault-corrected",
        expectedConfigCommitSha: commitSha,
        expectedDefinitionDigest: definitionDigest,
      });
      const correctedLease = yield* runtime.acquireLease({
        executionId: correctedRun.id,
        owner: "corrected",
        ttlMs: 60_000,
      });
      yield* sql`
        CREATE TRIGGER fail_responsibility_incident_resolution
        BEFORE UPDATE ON command_center_responsibility_incidents
        WHEN NEW.state = 'resolved'
        BEGIN
          SELECT RAISE(ABORT, 'forced incident resolution failure');
        END
      `;
      yield* runtime.advance(correctedLease).pipe(Effect.flip);
      expect(yield* runtime.get(correctedRun.id)).toMatchObject({
        state: "running",
        checkpoints: [expect.objectContaining({ state: "running" })],
      });
      expect(
        yield* sql<{ readonly state: string }>`
          SELECT state FROM command_center_responsibility_incidents
        `,
      ).toEqual([{ state: "blocked" }]);
      yield* sql`DROP TRIGGER fail_responsibility_incident_resolution`;
      expect(yield* runtime.advance(correctedLease)).toMatchObject({ state: "succeeded" });
      expect(
        yield* sql<{ readonly state: string; readonly resolvedAt: string | null }>`
        SELECT state, resolved_at AS "resolvedAt"
        FROM command_center_responsibility_incidents
      `,
      ).toEqual([{ state: "resolved", resolvedAt: initialNow }]);
      expect(
        yield* sql<{ readonly status: string }>`
        SELECT status FROM command_center_items WHERE id LIKE 'responsibility-incident:%'
      `,
      ).toEqual([{ status: "done" }]);
    }).pipe(Effect.provide(testLayer(runtimeHarness.dependencies)));
  },
);

it.effect("rolls back the terminal projection when incident insertion fails", () => {
  const fixture = automationFixture();
  const runtimeHarness = harness(() => ({ type: "failed", error: "credential unavailable" }));

  return Effect.gen(function* () {
    yield* seedAutomation(fixture);
    const runtime = yield* AutomationRuntime;
    const sql = yield* SqlClient.SqlClient;
    const started = yield* runtime.start({
      automationId: fixture.id,
      idempotencyKey: "incident-write-failure",
      expectedConfigCommitSha: commitSha,
      expectedDefinitionDigest: definitionDigest,
    });
    const lease = yield* runtime.acquireLease({
      executionId: started.id,
      owner: "worker",
      ttlMs: 60_000,
    });
    yield* sql`
      CREATE TRIGGER fail_responsibility_incident_insert
      BEFORE INSERT ON command_center_responsibility_incidents
      BEGIN
        SELECT RAISE(ABORT, 'forced incident insert failure');
      END
    `;

    yield* runtime.advance(lease).pipe(Effect.flip);
    expect(yield* runtime.get(started.id)).toMatchObject({
      state: "running",
      checkpoints: [expect.objectContaining({ state: "running", attemptCount: 1 })],
    });
    expect(
      yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM command_center_responsibility_active_slots
        WHERE execution_id = ${started.id}
      `,
    ).toEqual([{ count: 1 }]);
    expect(
      yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM command_center_responsibility_incidents
      `,
    ).toEqual([{ count: 0 }]);

    yield* sql`DROP TRIGGER fail_responsibility_incident_insert`;
    expect(yield* runtime.advance(lease)).toMatchObject({ state: "failed" });
    expect(runtimeHarness.invocations.map((invocation) => invocation.idempotencyKey)).toEqual([
      `${started.id}:step:1`,
      `${started.id}:step:1`,
    ]);
  }).pipe(Effect.provide(testLayer(runtimeHarness.dependencies)));
});

it.effect("separates canonical causes on one node and groups repeated occurrences", () => {
  const fixture = automationFixture({
    nodes: [{ id: "connector", kind: "connector.read" }],
  });
  const runtimeHarness = harness((context) =>
    context.runInput.cause === "credential"
      ? {
          type: "failed",
          error: "credential unavailable",
          failure: {
            canonicalCode: "connector-credential-unavailable",
            resource: "google-connection",
            subject: "connection-a",
          },
        }
      : {
          type: "failed",
          error: "malformed request",
          failure: {
            canonicalCode: "connector-request-invalid",
            resource: "automation-node",
            subject: "connector",
          },
        },
  );

  return Effect.gen(function* () {
    yield* seedAutomation(fixture);
    const runtime = yield* AutomationRuntime;
    const sql = yield* SqlClient.SqlClient;
    for (const [index, cause] of ["credential", "malformed", "credential"].entries()) {
      const started = yield* runtime.start({
        automationId: fixture.id,
        idempotencyKey: `canonical-${index}`,
        expectedConfigCommitSha: commitSha,
        expectedDefinitionDigest: definitionDigest,
        input: { cause },
      });
      const lease = yield* runtime.acquireLease({
        executionId: started.id,
        owner: `worker-${index}`,
        ttlMs: 60_000,
      });
      expect(yield* runtime.advance(lease)).toMatchObject({ state: "failed" });
    }

    expect(
      yield* sql<{ readonly code: string; readonly count: number }>`
        SELECT canonical_code AS code, occurrence_count AS count
        FROM command_center_responsibility_incidents
        ORDER BY canonical_code
      `,
    ).toEqual([
      { code: "connector-credential-unavailable", count: 2 },
      { code: "connector-request-invalid", count: 1 },
    ]);
  }).pipe(Effect.provide(testLayer(runtimeHarness.dependencies)));
});

it.effect("read recovery keeps a draft fault open until draft recovery", () => {
  const fixture = automationFixture({
    nodes: [{ id: "connector", kind: "connector.read" }],
  });
  const runtimeHarness = harness((context) => {
    const operation = context.runInput.operation;
    if (operation === "draft-fault") {
      return {
        type: "failed",
        error: "Gmail draft creation is not configured.",
        failure: {
          canonicalCode: "connector-capability-unavailable",
          resource: "google:gmail.draft.create",
          subject: "connection-a",
        },
      };
    }
    return {
      type: "succeeded",
      resolvedFailureScopes: [
        {
          resource: operation === "read" ? "google:gmail.search" : "google:gmail.draft.create",
          subject: "connection-a",
        },
      ],
    };
  });

  return Effect.gen(function* () {
    yield* seedAutomation(fixture);
    const runtime = yield* AutomationRuntime;
    const sql = yield* SqlClient.SqlClient;
    for (const [index, operation] of ["draft-fault", "read", "read", "draft-recovered"].entries()) {
      const started = yield* runtime.start({
        automationId: fixture.id,
        idempotencyKey: `scope-${operation}-${index}`,
        expectedConfigCommitSha: commitSha,
        expectedDefinitionDigest: definitionDigest,
        input: { operation },
      });
      const lease = yield* runtime.acquireLease({
        executionId: started.id,
        owner: `worker-${operation}`,
        ttlMs: 60_000,
      });
      yield* runtime.advance(lease);
      const incident = yield* sql<{ readonly state: string }>`
        SELECT state FROM command_center_responsibility_incidents
        WHERE canonical_code = 'connector-capability-unavailable'
      `;
      expect(incident).toEqual([
        { state: operation === "draft-recovered" ? "resolved" : "blocked" },
      ]);
      const item = yield* sql<{ readonly status: string }>`
        SELECT status FROM command_center_items
        WHERE id LIKE 'responsibility-incident:%'
      `;
      expect(item).toEqual([{ status: operation === "draft-recovered" ? "done" : "ready" }]);
    }
  }).pipe(Effect.provide(testLayer(runtimeHarness.dependencies)));
});
