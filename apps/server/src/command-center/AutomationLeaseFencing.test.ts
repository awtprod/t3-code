import * as NodeServices from "@effect/platform-node/NodeServices";
import { Automation, CAPABILITY_NAMES, Space, SpaceId } from "@command-center/core";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { AutomationRuns, layer as automationRunsLayer } from "./AutomationRuns.ts";
import { CommandCenterConfig, type LoadedCommandCenterConfig } from "./Config.ts";
import * as ConnectionHealth from "./ConnectionHealth.ts";
import { layer as eventStreamLayer } from "./EventStream.ts";
import * as InboxGmailDrafts from "./InboxGmailDrafts.ts";
import { CommandCenterService, layer as serviceLayer } from "./Service.ts";
import { withAutomationInvariants } from "./automationTestInvariants.ts";
import {
  AutomationRuntime,
  type AutomationNodeExecutionContext,
  layer as runtimeLayer,
} from "./automation/Runtime.ts";

// Exclusive execution of automation steps: concurrent approval resumes, a step
// that outlives the 30 s lease, a worker that can no longer renew, and a crash
// before an approval gate was projected. The executor is a gated fake that
// counts invocations; time is advanced explicitly (runtime clock and the
// scheduler's TestClock together), so every interleaving is deterministic.

const start = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-09-28T00:00:00.000Z"));
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const commitSha = "1234567890abcdef1234567890abcdef12345678";
const definitionDigest = `sha256:${"d".repeat(64)}`;
const spaceId = SpaceId.make("space-a");

const space = Schema.decodeUnknownSync(Space)({
  id: spaceId,
  slug: "space-a",
  displayName: "Space A",
  kind: "business",
  instructions: "Use only the selected Space.",
  policy: { allowedCapabilities: CAPABILITY_NAMES, autoRunRiskLevels: ["low", "reversible"] },
  connectionIds: [],
  repositories: [],
  aliases: [],
  lifecycle: "active",
  createdAt: iso(start),
  updatedAt: iso(start),
});

const automation = (id: string, kinds: ReadonlyArray<"approval" | "transform" | "shell.scoped">) =>
  Schema.decodeUnknownSync(Automation)({
    id,
    spaceId,
    name: id,
    version: 1,
    enabled: true,
    trigger: { type: "manual" },
    nodes: kinds.map((kind, index) => ({
      id: kind === "approval" ? "review" : "work",
      kind,
      config:
        kind === "approval"
          ? { approvalKey: "review" }
          : kind === "shell.scoped"
            ? { allowlistId: "qa-shell" }
            : {},
      position: { x: index * 200, y: 0 },
    })),
    edges:
      kinds.length === 2
        ? [{ id: "review-work", sourceNodeId: "review", targetNodeId: "work" }]
        : [],
    definitionDigest,
    configCommit: commitSha,
    createdAt: iso(start),
    updatedAt: iso(start),
  });

const approvedSafe = automation("approved-safe", ["approval", "transform"]);
const longSafe = automation("long-safe", ["transform"]);
const longUnsafe = automation("long-unsafe", ["shell.scoped"]);

interface Harness {
  ms: number;
  readonly invocations: Array<string>;
  interrupted: number;
  gate: Deferred.Deferred<void> | null;
}

function testLayer(harness: Harness, options: { readonly invariants?: boolean } = {}) {
  let nextId = 0;
  const config: LoadedCommandCenterConfig = {
    spaces: [space],
    connections: [],
    automations: [approvedSafe, longSafe, longUnsafe],
    timezone: "Etc/UTC",
    routing: null,
    health: { status: "loaded", configDirectory: "test-config" },
  };
  const configLayer = Layer.succeed(
    CommandCenterConfig,
    CommandCenterConfig.of({
      configDirectory: "test-config",
      load: Effect.succeed(config),
      resolveGoogleAccount: () => Effect.die("not used"),
    }),
  );
  const commandCenterLayer = serviceLayer.pipe(
    Layer.provide(configLayer),
    Layer.provide(ConnectionHealth.layer),
  );
  const executeNode = (context: AutomationNodeExecutionContext) =>
    Effect.gen(function* () {
      harness.invocations.push(`${context.executionId}:${context.node.id}`);
      if (harness.gate !== null) {
        yield* Deferred.await(harness.gate).pipe(
          Effect.onInterrupt(() => Effect.sync(() => (harness.interrupted += 1))),
        );
      }
      return { type: "succeeded" as const, output: { done: true } };
    });
  const scenario = automationRunsLayer.pipe(
    Layer.provideMerge(InboxGmailDrafts.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        commandCenterLayer,
        runtimeLayer({
          executeNode,
          now: Effect.sync(() => iso(harness.ms)),
          randomUUID: Effect.sync(() => `uuid-${++nextId}`),
          defaultMaxAttempts: 3,
        }),
        eventStreamLayer,
      ),
    ),
    Layer.provideMerge(configLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );
  // Runtime-boundary tests drive the runtime directly, without recording Runs.
  return options.invariants === false ? scenario : withAutomationInvariants(scenario);
}

const freshHarness = (): Harness => ({ ms: start, invocations: [], interrupted: 0, gate: null });

/** Advances the runtime clock and the scheduler together, in small steps. */
const advance = (harness: Harness, ms: number) =>
  Effect.gen(function* () {
    for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
      harness.ms += 1_000;
      yield* TestClock.adjust("1 second");
    }
  });

/** Lets every runnable fiber make progress (bounded). */
const settle = Effect.gen(function* () {
  for (let spin = 0; spin < 2_000; spin++) yield* Effect.yieldNow;
});

/** Bounded wait until the executor has been entered `count` times. */
const awaitInvocations = (harness: Harness, count: number) =>
  Effect.gen(function* () {
    for (let spin = 0; spin < 10_000; spin++) {
      if (harness.invocations.length >= count) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error(`executor reached ${harness.invocations.length}/${count}`));
  });

const startInput = (target: Automation, key: string) =>
  ({
    automationId: target.id,
    spaceId,
    idempotencyKey: key,
    expectedConfigCommitSha: commitSha,
    expectedDefinitionDigest: definitionDigest,
  }) as const;

{
  const harness = freshHarness();
  it.effect("runs an approved step once when the approval is resumed concurrently", () =>
    Effect.gen(function* () {
      const runs = yield* AutomationRuns;
      const commandCenter = yield* CommandCenterService;
      const waiting = yield* runs.start(startInput(approvedSafe, "concurrent-resume"));
      expect(waiting.state).toBe("waiting_approval");
      const approval = (yield* commandCenter.queryApprovals({})).approvals.find(
        (candidate) => candidate.runId === waiting.id,
      )!;
      const decision = {
        approvalId: approval.id,
        payloadDigest: approval.payloadDigest,
        decision: "approved" as const,
      };

      harness.gate = yield* Deferred.make<void>();
      // Three clicks arrive together; the step blocks while they race.
      const clicks = yield* Effect.all(
        [1, 2, 3].map(() => runs.decideApproval(decision).pipe(Effect.exit)),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* awaitInvocations(harness, 1);
      yield* settle;
      const tick = yield* runs.recoverDue({ owner: "tick" }).pipe(Effect.exit, Effect.forkChild);
      yield* settle;
      const duringStep = harness.invocations.length;
      yield* Deferred.succeed(harness.gate, undefined);
      const exits = yield* Fiber.join(clicks);
      yield* Fiber.join(tick);
      expect(duringStep).toBe(1);
      // A click that finds another click driving the step is not an error.
      expect(exits.map((exit) => exit._tag)).toEqual(["Success", "Success", "Success"]);
      expect(harness.invocations).toEqual([`${waiting.id}:work`]);
      expect((yield* runs.get({ executionId: waiting.id, spaceId })).state).toBe("succeeded");
    }).pipe(Effect.provide(testLayer(harness))),
  );
}

{
  const harness = freshHarness();
  it.effect("keeps a step that outlives the lease from being run again by recovery", () =>
    Effect.gen(function* () {
      const runs = yield* AutomationRuns;
      harness.gate = yield* Deferred.make<void>();
      const running = yield* runs.start(startInput(longSafe, "long-step")).pipe(Effect.forkChild);
      yield* awaitInvocations(harness, 1);
      // The step is still working 45 s later; recovery ticks meanwhile.
      yield* advance(harness, 45_000);
      const tick = yield* runs.recoverDue({ owner: "tick" }).pipe(Effect.exit, Effect.forkChild);
      yield* settle;
      const duringStep = harness.invocations.length;
      yield* Deferred.succeed(harness.gate, undefined);
      const report = yield* Fiber.join(tick);
      const finished = yield* Fiber.join(running);
      expect(duringStep).toBe(1);
      expect(report._tag).toBe("Success");
      // Committed with the time the step finished, not when it started.
      expect(finished.finishedAt).toBe(iso(harness.ms));
      expect(finished.state).toBe("succeeded");
      expect(harness.invocations).toHaveLength(1);
    }).pipe(Effect.provide(testLayer(harness))),
  );
}

/** A worker that stopped renewing (killed, or stalled past its lease). */
const loseLease = (executionId: string, harness: Harness) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE command_center_automation_executions
      SET lease_expires_at = ${iso(harness.ms - 1)}
      WHERE id = ${executionId}
    `;
  });

const executionIdFor = (key: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly id: string }>`
      SELECT id FROM command_center_automation_executions WHERE idempotency_key = ${key}
    `;
    return rows[0]!.id;
  });

{
  const harness = freshHarness();
  it.effect(
    "fails closed instead of re-running an interrupted step whose effect cannot be fenced",
    () =>
      Effect.gen(function* () {
        const runs = yield* AutomationRuns;
        harness.gate = yield* Deferred.make<void>();
        const running = yield* runs
          .start(startInput(longUnsafe, "unsafe-step"))
          .pipe(Effect.exit, Effect.forkChild);
        yield* awaitInvocations(harness, 1);
        const executionId = yield* executionIdFor("unsafe-step");
        yield* loseLease(executionId, harness);

        const tick = yield* runs.recoverDue({ owner: "tick" }).pipe(Effect.exit, Effect.forkChild);
        yield* settle;
        const duringStep = harness.invocations.length;
        if (duringStep > 1) yield* Deferred.succeed(harness.gate, undefined);
        yield* Fiber.join(tick);
        expect(duringStep).toBe(1);
        const recovered = yield* runs.get({ executionId, spaceId });
        expect(recovered.state).toBe("failed");
        expect(recovered.error).toMatch(/outcome is unknown/u);

        // The stalled worker's next renewal fails, which stops its step.
        yield* advance(harness, 11_000);
        yield* settle;
        expect(harness.interrupted).toBe(1);
        // The stalled worker finishing later cannot overwrite the decision.
        yield* Deferred.succeed(harness.gate, undefined);
        const staleExit = yield* Fiber.join(running);
        expect(staleExit._tag).toBe("Failure");
        expect((yield* runs.get({ executionId, spaceId })).state).toBe("failed");
        expect(harness.invocations).toHaveLength(1);
      }).pipe(Effect.provide(testLayer(harness))),
  );
}

{
  const harness = freshHarness();
  it.effect("re-runs an interrupted step that is safe to repeat, and fences the stale worker", () =>
    Effect.gen(function* () {
      const runs = yield* AutomationRuns;
      harness.gate = yield* Deferred.make<void>();
      const running = yield* runs
        .start(startInput(longSafe, "safe-step"))
        .pipe(Effect.exit, Effect.forkChild);
      yield* awaitInvocations(harness, 1);
      const executionId = yield* executionIdFor("safe-step");
      yield* loseLease(executionId, harness);

      const recovering = yield* runs.recoverDue({ owner: "tick" }).pipe(Effect.forkChild);
      yield* awaitInvocations(harness, 2);
      yield* Deferred.succeed(harness.gate, undefined);
      yield* Fiber.join(recovering);
      // The stale worker's own commit is fenced by the lease token.
      expect((yield* Fiber.join(running))._tag).toBe("Failure");
      const finished = yield* runs.get({ executionId, spaceId });
      expect(finished.state).toBe("succeeded");
      expect(finished.checkpoints.map((checkpoint) => checkpoint.attemptCount)).toEqual([1]);
    }).pipe(Effect.provide(testLayer(harness))),
  );
}

{
  const harness = freshHarness();
  it.effect("projects an approval gate that a crash left unprojected", () =>
    Effect.gen(function* () {
      const runs = yield* AutomationRuns;
      const commandCenter = yield* CommandCenterService;
      const sql = yield* SqlClient.SqlClient;
      const waiting = yield* runs.start(startInput(approvedSafe, "gate-crash"));
      expect(waiting.state).toBe("waiting_approval");
      // The process died after the runtime reached waiting_approval but before
      // the Run and its approval gate were projected.
      yield* sql`DELETE FROM command_center_approvals WHERE run_id = ${waiting.id}`;
      yield* sql`DELETE FROM command_center_items WHERE id LIKE ${`automation-approval-item:${waiting.id}:%`}`;
      yield* sql`UPDATE command_center_runs SET state = 'queued' WHERE id = ${waiting.id}`;
      expect(
        (yield* commandCenter.queryApprovals({})).approvals.filter(
          (approval) => approval.runId === waiting.id,
        ),
      ).toEqual([]);

      const report = yield* runs.recoverDue({ owner: "tick" });
      expect(report.failures).toEqual([]);
      const gates = (yield* commandCenter.queryApprovals({})).approvals.filter(
        (approval) => approval.runId === waiting.id,
      );
      expect(gates.map((gate) => gate.status)).toEqual(["requested"]);
    }).pipe(Effect.provide(testLayer(harness))),
  );
}

{
  const harness = freshHarness();
  it.effect("never hands one live lease to two drivers that share an owner name", () =>
    Effect.gen(function* () {
      const runtime = yield* AutomationRuntime;
      // Load config so the automation is projected, then create a queued run.
      yield* (yield* CommandCenterService).queryAutomations({ spaceId });
      const queued = yield* runtime.start({
        automationId: longSafe.id,
        expectedSpaceId: spaceId,
        idempotencyKey: "shared-owner",
        expectedConfigCommitSha: commitSha,
        expectedDefinitionDigest: definitionDigest,
      });
      const owner = "approval:automation-approval:shared";
      const first = yield* runtime.acquireLease({ executionId: queued.id, owner, ttlMs: 30_000 });
      const second = yield* Effect.flip(
        runtime.acquireLease({ executionId: queued.id, owner, ttlMs: 30_000 }),
      );
      expect(second).toMatchObject({ code: "lease-denied" });
      yield* runtime.releaseLease({ executionId: queued.id, owner, token: first.token });
    }).pipe(Effect.provide(testLayer(harness, { invariants: false }))),
  );
}

{
  const harness = freshHarness();
  it.effect("reports a run another worker is driving instead of failing the caller", () =>
    Effect.gen(function* () {
      const runs = yield* AutomationRuns;
      const runtime = yield* AutomationRuntime;
      yield* (yield* CommandCenterService).queryAutomations({ spaceId });
      const queued = yield* runtime.start({
        automationId: longSafe.id,
        expectedSpaceId: spaceId,
        idempotencyKey: "held-elsewhere",
        expectedConfigCommitSha: commitSha,
        expectedDefinitionDigest: definitionDigest,
      });
      // Another worker holds the live lease on this run.
      yield* runtime.acquireLease({ executionId: queued.id, owner: "other-worker", ttlMs: 30_000 });
      const replay = yield* runs.start(startInput(longSafe, "held-elsewhere"));
      expect(replay).toMatchObject({ id: queued.id, state: "queued" });
      expect(harness.invocations).toEqual([]);
    }).pipe(Effect.provide(testLayer(harness))),
  );
}

{
  const harness = freshHarness();
  it.effect("does not resume a run stranded before a held process started, on any path", () =>
    Effect.gen(function* () {
      const runtime = yield* AutomationRuntime;
      yield* (yield* CommandCenterService).queryAutomations({ spaceId });
      // Stranded by the previous process: queued, never driven.
      const stranded = yield* runtime.start({
        automationId: longSafe.id,
        expectedSpaceId: spaceId,
        idempotencyKey: "stranded",
        expectedConfigCommitSha: commitSha,
        expectedDefinitionDigest: definitionDigest,
      });
      yield* advance(harness, 1_000);
      // The new process starts with the operator hold set.
      const heldRuns = Layer.fresh(automationRunsLayer).pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { COMMAND_CENTER_AUTOMATION_RECOVERY_HOLD: "1" } }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const runs = yield* AutomationRuns;
        // A new admission coalesces onto the stranded run, and a status poll
        // reads it; neither may drive it.
        const coalesced = yield* runs.start(startInput(longSafe, "new-admission"));
        expect(coalesced).toMatchObject({ id: stranded.id, state: "queued" });
        yield* runs.get({ executionId: stranded.id, spaceId });
        yield* runs.recoverDue({ owner: "tick" });
        expect(harness.invocations).toEqual([]);
        // Work started after the process came up still runs, including when
        // only recovery drives it.
        const fresh = yield* runs.start(startInput(longUnsafe, "after-start"));
        expect(fresh.state).toBe("succeeded");
        const recoverable = yield* runtime.start({
          automationId: approvedSafe.id,
          expectedSpaceId: spaceId,
          idempotencyKey: "after-start-recovered",
          expectedConfigCommitSha: commitSha,
          expectedDefinitionDigest: definitionDigest,
        });
        // Even with a batch of one, the held run cannot crowd out new work.
        yield* runs.recoverDue({ owner: "tick", limit: 1 });
        expect((yield* runtime.get(recoverable.id)).state).toBe("waiting_approval");
        expect(harness.invocations).toEqual([`${fresh.id}:work`]);
      }).pipe(Effect.provide(heldRuns));
    }).pipe(Effect.provide(testLayer(harness, { invariants: false }))),
  );
}

{
  const harness = freshHarness();
  it.effect("projects the result of a step whose request was cancelled mid-step", () =>
    Effect.gen(function* () {
      const runs = yield* AutomationRuns;
      const sql = yield* SqlClient.SqlClient;
      harness.gate = yield* Deferred.make<void>();
      const request = yield* runs
        .start(startInput(longSafe, "cancelled-request"))
        .pipe(Effect.forkChild);
      yield* awaitInvocations(harness, 1);
      // The client goes away; the step carries on detached from the request.
      yield* Fiber.interrupt(request);
      const executionId = yield* executionIdFor("cancelled-request");
      yield* Deferred.succeed(harness.gate, undefined);
      yield* settle;
      // No recovery tick ran: the detached drive projected its own result.
      const projected = yield* sql<{ readonly state: string }>`
        SELECT state FROM command_center_runs WHERE id = ${executionId}
      `;
      expect(projected[0]?.state).toBe("succeeded");
      expect(harness.invocations).toHaveLength(1);
    }).pipe(Effect.provide(testLayer(harness))),
  );
}
