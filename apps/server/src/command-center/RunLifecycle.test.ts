// @effect-diagnostics nodeBuiltinImport:off - Command Center module that predates the Effect platform port.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EventId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId as OrchestrationRunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { CommandCenterEventStream, layer as eventStreamLayer } from "./EventStream.ts";
import {
  makeRunLifecyclePersistence,
  makeWithDependencies,
  transitionForRunStatus,
} from "./RunLifecycle.ts";

const fixtureTime = "2026-01-01T00:00:00.000Z";
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const testLayer = eventStreamLayer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const insertRun = (
  sql: SqlClient.SqlClient,
  input: {
    readonly id: string;
    readonly threadId: string | null;
    readonly state?: "queued" | "running";
  },
) =>
  Effect.gen(function* () {
    const spaceId = `space-${input.id}`;
    yield* sql`
      INSERT INTO command_center_spaces (id, slug, name, kind, created_at, updated_at)
      VALUES (${spaceId}, ${spaceId}, 'Example Space', 'business', ${fixtureTime}, ${fixtureTime})
    `;
    yield* sql`
      INSERT INTO command_center_runs (
        id, command_id, space_id, project_id, thread_id, kind, state,
        route_json, input_json, started_at
      ) VALUES (
        ${input.id}, ${`command-${input.id}`}, ${spaceId}, 'project-example',
        ${input.threadId}, 'agent', ${input.state ?? "running"}, '{}', '{}', ${fixtureTime}
      )
    `;
  });

const appendSeedAudit = (
  sql: SqlClient.SqlClient,
  input: { readonly runId: string; readonly spaceId: string },
) => {
  const hashInput = {
    previousHash: null,
    actorKind: "system",
    action: "fixture.seed",
    spaceId: input.spaceId,
    runId: input.runId,
    payload: { seeded: true },
    occurredAt: fixtureTime,
  };
  const eventHash = NodeCrypto.createHash("sha256").update(encodeJson(hashInput)).digest("hex");
  return sql`
    INSERT INTO command_center_audit_events (
      event_id, previous_hash, event_hash, actor_kind, action, space_id, run_id,
      payload_json, occurred_at
    ) VALUES (
      'fixture-seed', NULL, ${eventHash}, 'system', 'fixture.seed', ${input.spaceId},
      ${input.runId}, ${encodeJson({ seeded: true })}, ${fixtureTime}
    )
  `;
};

/** A V2 `run.updated` event, as the orchestrator stores it, with the fields Run lifecycle reads. */
const runUpdated = (input: {
  readonly eventId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly status: OrchestrationV2Run["status"];
  readonly occurredAt?: string;
}): OrchestrationV2DomainEvent =>
  ({
    id: EventId.make(input.eventId),
    type: "run.updated",
    threadId: ThreadId.make(input.threadId),
    runId: OrchestrationRunId.make(input.runId),
    occurredAt: DateTime.makeUnsafe(input.occurredAt ?? fixtureTime),
    payload: {
      id: OrchestrationRunId.make(input.runId),
      threadId: ThreadId.make(input.threadId),
      status: input.status,
      completedAt: null,
    },
  }) as unknown as OrchestrationV2DomainEvent;

const lifecycleFor = (
  persistence: Effect.Success<typeof makeRunLifecyclePersistence>,
  options: {
    readonly revoked: Array<string>;
    readonly threads?: ReadonlyMap<string, OrchestrationV2ThreadShell>;
    readonly failures?: ReadonlyMap<string, string>;
  },
) =>
  makeWithDependencies({
    persistence,
    getThread: (threadId) => Effect.succeed(options.threads?.get(threadId)),
    getRunFailureMessage: ({ runId }) => Effect.succeed(options.failures?.get(runId)),
    revokeThread: (threadId) =>
      Effect.sync(() => {
        options.revoked.push(threadId);
      }),
  });

it.effect("projects V2 run completion once, preserves the audit chain, and revokes MCP scope", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const events = yield* CommandCenterEventStream;
    const persistence = yield* makeRunLifecyclePersistence;
    const threadId = "cc:automation:thread-success";
    yield* insertRun(sql, { id: "run-success", threadId });
    yield* appendSeedAudit(sql, {
      runId: "run-success",
      spaceId: "space-run-success",
    });

    const revoked: Array<string> = [];
    const lifecycle = lifecycleFor(persistence, { revoked });
    const started = yield* lifecycle.handleThreadEvent(
      runUpdated({ eventId: "v2-1", threadId, runId: "v2-run-a", status: "starting" }),
    );
    // Further updates of the same run while it works add no audit rows. V2
    // stamps each one with its own time, so they are not byte-identical replays.
    const running = yield* lifecycle.handleThreadEvent(
      runUpdated({
        eventId: "v2-1b",
        threadId,
        runId: "v2-run-a",
        status: "running",
        occurredAt: "2026-01-01T00:00:05.000Z",
      }),
    );
    const restarted = yield* lifecycle.handleThreadEvent(
      runUpdated({
        eventId: "v2-2",
        threadId,
        runId: "v2-run-a",
        status: "waiting",
        occurredAt: "2026-01-01T00:00:19.000Z",
      }),
    );
    const transition = yield* lifecycle.handleThreadEvent(
      runUpdated({ eventId: "v2-3", threadId, runId: "v2-run-a", status: "completed" }),
    );
    const repeated = yield* lifecycle.handleThreadEvent(
      runUpdated({ eventId: "v2-4", threadId, runId: "v2-run-a", status: "completed" }),
    );

    const rows = yield* sql<{ readonly state: string; readonly finishedAt: string | null }>`
      SELECT state, finished_at AS "finishedAt"
      FROM command_center_runs
      WHERE id = 'run-success'
    `;
    expect(started?.status).toBe("running");
    expect(running).toBeUndefined();
    expect(restarted).toBeUndefined();
    expect(transition?.status).toBe("succeeded");
    expect(repeated).toBeUndefined();
    expect(rows[0]).toEqual({ state: "succeeded", finishedAt: fixtureTime });
    expect(revoked).toEqual([threadId]);

    const replay = yield* events.replay({ afterSequence: 0, limit: 20 });
    expect(replay.events.map((event) => event._tag)).toEqual([
      "AuditRecorded",
      "RunStateChanged",
      "RunStateChanged",
    ]);
    expect(replay.events[1]).toMatchObject({
      _tag: "RunStateChanged",
      runId: "run-success",
      payload: { status: "running", previousStatus: "queued" },
    });
    expect(replay.events[2]).toMatchObject({
      _tag: "RunStateChanged",
      runId: "run-success",
      payload: { status: "succeeded", previousStatus: "running" },
    });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("records one actionable failure and one urgent Needs You alert under replay", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const events = yield* CommandCenterEventStream;
    const persistence = yield* makeRunLifecyclePersistence;
    const threadId = "cc:automation:thread-failure";
    yield* insertRun(sql, { id: "run-failure", threadId });

    const revoked: Array<string> = [];
    const lifecycle = lifecycleFor(persistence, {
      revoked,
      failures: new Map([["v2-run-failed", "Example provider failure"]]),
    });
    const event = runUpdated({
      eventId: "v2-failed",
      threadId,
      runId: "v2-run-failed",
      status: "failed",
    });
    const first = yield* lifecycle.handleThreadEvent(event);
    const duplicate = yield* lifecycle.handleThreadEvent(event);

    const runRows = yield* sql<{ readonly state: string; readonly error: string | null }>`
      SELECT state, error FROM command_center_runs WHERE id = 'run-failure'
    `;
    const itemRows = yield* sql<{
      readonly kind: string;
      readonly status: string;
      readonly priority: string;
      readonly body: string | null;
    }>`
      SELECT kind, status, priority, body
      FROM command_center_items
      WHERE id = 'run-failure-run-failure'
    `;
    expect(first?.status).toBe("failed");
    expect(duplicate).toBeUndefined();
    expect(runRows[0]).toEqual({ state: "failed", error: "Example provider failure" });
    expect(itemRows[0]).toEqual({
      kind: "alert",
      status: "review",
      priority: "urgent",
      body: "Example provider failure",
    });
    expect(revoked).toEqual([threadId]);

    const replay = yield* events.replay({ afterSequence: 0, limit: 20 });
    expect(replay.events.map((entry) => entry._tag)).toEqual([
      "RunStateChanged",
      "CommandCenterFailure",
      "ItemChanged",
    ]);
    expect(replay.events[1]).toMatchObject({
      _tag: "CommandCenterFailure",
      payload: {
        scope: "run",
        reason: "provider-turn-failed",
        retryable: true,
      },
    });
    expect(replay.events[2]).toMatchObject({
      _tag: "ItemChanged",
      payload: { kind: "alert", status: "review", change: "created" },
    });
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["cancelled", "interrupted"] as const)(
  "terminalizes a %s V2 run as canceled without a failure or Needs You alert",
  (status) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const events = yield* CommandCenterEventStream;
      const persistence = yield* makeRunLifecyclePersistence;
      const threadId = `cc:automation:thread-${status}`;
      yield* insertRun(sql, { id: `run-${status}`, threadId });
      const revoked: Array<string> = [];
      const lifecycle = lifecycleFor(persistence, {
        revoked,
        // A failure message must not be consulted or recorded for a cancellation.
        failures: new Map([[`v2-run-${status}`, "Example failure that must not be used"]]),
      });

      const transition = yield* lifecycle.handleThreadEvent(
        runUpdated({ eventId: `v2-${status}`, threadId, runId: `v2-run-${status}`, status }),
      );

      const runRows = yield* sql<{ readonly state: string; readonly error: string | null }>`
        SELECT state, error FROM command_center_runs WHERE id = ${`run-${status}`}
      `;
      const itemRows = yield* sql<{ readonly id: string }>`
        SELECT id FROM command_center_items
      `;
      expect(transition?.status).toBe("canceled");
      expect(runRows[0]?.state).toBe("canceled");
      expect(runRows[0]?.error).not.toBe("Example failure that must not be used");
      expect(itemRows).toEqual([]);
      expect(revoked).toEqual([threadId]);
      const replay = yield* events.replay({ afterSequence: 0, limit: 20 });
      expect(replay.events.map((event) => event._tag)).toEqual(["RunStateChanged"]);
      expect(replay.events[0]).toMatchObject({ payload: { status: "canceled" } });
    }).pipe(Effect.provide(testLayer)),
);

it.effect("ignores V2 events outside Command Center Run threads", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const persistence = yield* makeRunLifecyclePersistence;
    // A Run row whose thread id is not a `cc:` thread is never touched by V2 events.
    yield* insertRun(sql, { id: "run-plain", threadId: "thread-plain" });
    const revoked: Array<string> = [];
    const lifecycle = lifecycleFor(persistence, { revoked });

    const plain = yield* lifecycle.handleThreadEvent(
      runUpdated({ eventId: "v2-plain", threadId: "thread-plain", runId: "r", status: "failed" }),
    );
    const rows = yield* sql<{ readonly state: string }>`
      SELECT state FROM command_center_runs WHERE id = 'run-plain'
    `;
    expect(plain).toBeUndefined();
    expect(rows[0]?.state).toBe("running");
    expect(revoked).toEqual([]);
  }).pipe(Effect.provide(testLayer)),
);

const v2StatusForLegacyTurnState = {
  running: "running",
  interrupted: "interrupted",
  completed: "completed",
  error: "failed",
} as const;

const threadShell = (input: {
  readonly threadId: string;
  readonly state: "running" | "interrupted" | "completed" | "error";
}): OrchestrationV2ThreadShell =>
  ({
    id: ThreadId.make(input.threadId),
    projectId: ProjectId.make("project-example"),
    title: "Example thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "example-model" },
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestRunId: OrchestrationRunId.make(`run-${input.threadId}`),
    activeRunId:
      input.state === "running" ? OrchestrationRunId.make(`run-${input.threadId}`) : null,
    status: v2StatusForLegacyTurnState[input.state],
    latestRunCompletedAt: input.state === "running" ? null : DateTime.makeUnsafe(fixtureTime),
    createdAt: DateTime.makeUnsafe(fixtureTime),
    updatedAt: DateTime.makeUnsafe(fixtureTime),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
  }) as unknown as OrchestrationV2ThreadShell;

it.effect("reconciles finished and orphaned Runs and leaves active V2 runs to V2 recovery", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const persistence = yield* makeRunLifecyclePersistence;
    yield* insertRun(sql, { id: "run-recovered", threadId: "thread-recovered" });
    yield* insertRun(sql, { id: "run-failed", threadId: "thread-failed" });
    yield* insertRun(sql, { id: "run-live", threadId: "thread-live" });
    yield* insertRun(sql, { id: "run-missing", threadId: "thread-missing" });
    yield* insertRun(sql, { id: "run-unlinked", threadId: null });

    const threads = new Map<string, OrchestrationV2ThreadShell>([
      ["thread-recovered", threadShell({ threadId: "thread-recovered", state: "completed" })],
      ["thread-failed", threadShell({ threadId: "thread-failed", state: "error" })],
      ["thread-live", threadShell({ threadId: "thread-live", state: "running" })],
    ]);
    const revoked: Array<string> = [];
    const lifecycle = lifecycleFor(persistence, {
      revoked,
      threads,
      failures: new Map([["run-thread-failed", "Example usage limit reached"]]),
    });

    const transitions = yield* lifecycle.reconcile;
    const rows = yield* sql<{
      readonly id: string;
      readonly state: string;
      readonly error: string | null;
    }>`
      SELECT id, state, error FROM command_center_runs ORDER BY id
    `;
    expect(rows).toEqual([
      { id: "run-failed", state: "failed", error: "Example usage limit reached" },
      { id: "run-live", state: "running", error: null },
      {
        id: "run-missing",
        state: "failed",
        error: "The server restarted before this Run's thread was created.",
      },
      { id: "run-recovered", state: "succeeded", error: null },
      {
        id: "run-unlinked",
        state: "failed",
        error: "The server restarted before this Run was linked to a provider thread.",
      },
    ]);
    expect(transitions.map((transition) => transition.status).sort()).toEqual([
      "failed",
      "failed",
      "failed",
      "succeeded",
    ]);
    expect(revoked.sort()).toEqual(["thread-failed", "thread-missing", "thread-recovered"]);

    // The live run's terminal event later settles it through the same path.
    const later = yield* lifecycle.reconcile;
    expect(later).toEqual([]);
  }).pipe(Effect.provide(testLayer)),
);

it("maps V2 run statuses onto the Run lifecycle", () => {
  expect(transitionForRunStatus("completed")).toEqual({ status: "succeeded" });
  expect(transitionForRunStatus("cancelled")).toMatchObject({ status: "canceled" });
  expect(transitionForRunStatus("interrupted")).toMatchObject({ status: "canceled" });
  expect(transitionForRunStatus("failed")).toMatchObject({ status: "failed" });
  expect(transitionForRunStatus("rolled_back")).toMatchObject({ status: "failed" });
  expect(transitionForRunStatus("running")).toEqual({ status: "running" });
  expect(transitionForRunStatus("queued")).toBeUndefined();
  expect(transitionForRunStatus("preparing")).toBeUndefined();
});
