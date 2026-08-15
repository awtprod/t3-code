import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type OrchestrationEvent,
  ProviderRuntimeEvent,
  type OrchestrationThreadShell,
  type ProviderSession,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CommandCenterEventStream, layer as eventStreamLayer } from "./EventStream.ts";
import {
  makeRunLifecyclePersistence,
  makeWithDependencies,
  transitionForProviderEvent,
} from "./RunLifecycle.ts";

const fixtureTime = "2026-01-01T00:00:00.000Z";
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeProviderEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

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

const completedEvent = (input: {
  readonly eventId: string;
  readonly threadId: string;
  readonly state: "completed" | "failed" | "interrupted" | "cancelled";
  readonly errorMessage?: string;
}) =>
  decodeProviderEvent({
    eventId: input.eventId,
    provider: "codex",
    providerInstanceId: "codex",
    threadId: input.threadId,
    turnId: `turn-${input.eventId}`,
    type: "turn.completed",
    payload: {
      state: input.state,
      ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
    },
    createdAt: fixtureTime,
  });

const startedEvent = (input: { readonly eventId: string; readonly threadId: string }) =>
  decodeProviderEvent({
    eventId: input.eventId,
    provider: "codex",
    providerInstanceId: "codex",
    threadId: input.threadId,
    turnId: `turn-${input.eventId}`,
    type: "turn.started",
    payload: { model: "example-model" },
    createdAt: fixtureTime,
  });

const failedSessionEvent = (input: {
  readonly eventId: string;
  readonly threadId: string;
  readonly errorMessage: string;
}): OrchestrationEvent => ({
  sequence: 1,
  eventId: EventId.make(input.eventId),
  type: "thread.session-set",
  aggregateKind: "thread",
  aggregateId: ThreadId.make(input.threadId),
  occurredAt: fixtureTime,
  commandId: CommandId.make(`command-${input.eventId}`),
  causationEventId: null,
  correlationId: null,
  metadata: {},
  payload: {
    threadId: ThreadId.make(input.threadId),
    session: {
      threadId: ThreadId.make(input.threadId),
      status: "error",
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "approval-required",
      activeTurnId: null,
      lastError: input.errorMessage,
      updatedAt: fixtureTime,
    },
  },
});

it.effect("projects provider completion, preserves the audit chain, and revokes MCP scope", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const events = yield* CommandCenterEventStream;
    const persistence = yield* makeRunLifecyclePersistence;
    yield* insertRun(sql, { id: "run-success", threadId: "thread-success" });
    yield* appendSeedAudit(sql, {
      runId: "run-success",
      spaceId: "space-run-success",
    });

    const revoked: Array<string> = [];
    const lifecycle = makeWithDependencies({
      persistence,
      getThread: () => Effect.sync((): OrchestrationThreadShell | undefined => undefined),
      listProviderSessions: Effect.succeed([]),
      revokeThread: (threadId) =>
        Effect.sync(() => {
          revoked.push(threadId);
        }),
    });
    const started = yield* lifecycle.handleProviderEvent(
      startedEvent({ eventId: "provider-start", threadId: "thread-success" }),
    );
    const transition = yield* lifecycle.handleProviderEvent(
      completedEvent({
        eventId: "provider-success",
        threadId: "thread-success",
        state: "completed",
      }),
    );

    const rows = yield* sql<{ readonly state: string; readonly finishedAt: string | null }>`
      SELECT state, finished_at AS "finishedAt"
      FROM command_center_runs
      WHERE id = 'run-success'
    `;
    expect(started?.status).toBe("running");
    expect(transition?.status).toBe("succeeded");
    expect(rows[0]).toEqual({ state: "succeeded", finishedAt: fixtureTime });
    expect(revoked).toEqual(["thread-success"]);

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
    yield* insertRun(sql, { id: "run-failure", threadId: "thread-failure" });

    const revoked: Array<string> = [];
    const lifecycle = makeWithDependencies({
      persistence,
      getThread: () => Effect.sync((): OrchestrationThreadShell | undefined => undefined),
      listProviderSessions: Effect.succeed([]),
      revokeThread: (threadId) =>
        Effect.sync(() => {
          revoked.push(threadId);
        }),
    });
    const event = completedEvent({
      eventId: "provider-failure",
      threadId: "thread-failure",
      state: "failed",
      errorMessage: "Example provider failure",
    });
    const first = yield* lifecycle.handleProviderEvent(event);
    const duplicate = yield* lifecycle.handleProviderEvent(event);

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
    expect(revoked).toEqual(["thread-failure"]);

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

it.effect(
  "fails a running command-center run when provider startup sets the session to error",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const persistence = yield* makeRunLifecyclePersistence;
      yield* insertRun(sql, { id: "run-startup-error", threadId: "thread-startup-error" });

      const revoked: Array<string> = [];
      const lifecycle = makeWithDependencies({
        persistence,
        getThread: () => Effect.sync((): OrchestrationThreadShell | undefined => undefined),
        listProviderSessions: Effect.succeed([]),
        revokeThread: (threadId) =>
          Effect.sync(() => {
            revoked.push(threadId);
          }),
      });
      const event = failedSessionEvent({
        eventId: "session-startup-error",
        threadId: "thread-startup-error",
        errorMessage: "The Windows sandbox could not be initialized.",
      });

      const first = yield* lifecycle.handleOrchestrationEvent(event);
      const duplicate = yield* lifecycle.handleOrchestrationEvent(event);
      const rows = yield* sql<{ readonly state: string; readonly error: string | null }>`
      SELECT state, error FROM command_center_runs WHERE id = 'run-startup-error'
    `;

      expect(first?.status).toBe("failed");
      expect(duplicate).toBeUndefined();
      expect(rows[0]).toEqual({
        state: "failed",
        error: "The Windows sandbox could not be initialized.",
      });
      expect(revoked).toEqual(["thread-startup-error"]);
    }).pipe(Effect.provide(testLayer)),
);

const threadShell = (input: {
  readonly threadId: string;
  readonly state: "running" | "interrupted" | "completed" | "error";
}): OrchestrationThreadShell => ({
  id: ThreadId.make(input.threadId),
  projectId: ProjectId.make("project-example"),
  title: "Example thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "example-model" },
  runtimeMode: "auto-accept-edits",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: {
    turnId: TurnId.make(`turn-${input.threadId}`),
    state: input.state,
    requestedAt: fixtureTime,
    startedAt: fixtureTime,
    completedAt: input.state === "running" ? null : fixtureTime,
    assistantMessageId: null,
  },
  createdAt: fixtureTime,
  updatedAt: fixtureTime,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: fixtureTime,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

it.effect("reconciles completed and orphaned Runs while preserving a live in-flight session", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const persistence = yield* makeRunLifecyclePersistence;
    yield* insertRun(sql, { id: "run-recovered", threadId: "thread-recovered" });
    yield* insertRun(sql, { id: "run-orphaned", threadId: "thread-orphaned" });
    yield* insertRun(sql, { id: "run-live", threadId: "thread-live" });

    const threads = new Map<string, OrchestrationThreadShell>([
      ["thread-recovered", threadShell({ threadId: "thread-recovered", state: "completed" })],
      ["thread-orphaned", threadShell({ threadId: "thread-orphaned", state: "running" })],
      ["thread-live", threadShell({ threadId: "thread-live", state: "running" })],
    ]);
    const liveSession: ProviderSession = {
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "running",
      runtimeMode: "auto-accept-edits",
      model: "example-model",
      threadId: ThreadId.make("thread-live"),
      activeTurnId: TurnId.make("turn-thread-live"),
      createdAt: fixtureTime,
      updatedAt: fixtureTime,
    };
    const revoked: Array<string> = [];
    const lifecycle = makeWithDependencies({
      persistence,
      getThread: (threadId) => Effect.succeed(threads.get(threadId)),
      listProviderSessions: Effect.succeed([liveSession]),
      revokeThread: (threadId) =>
        Effect.sync(() => {
          revoked.push(threadId);
        }),
    });

    const transitions = yield* lifecycle.reconcile;
    const rows = yield* sql<{ readonly id: string; readonly state: string }>`
      SELECT id, state FROM command_center_runs ORDER BY id
    `;
    expect(rows).toEqual([
      { id: "run-live", state: "running" },
      { id: "run-orphaned", state: "failed" },
      { id: "run-recovered", state: "succeeded" },
    ]);
    expect(transitions.map((transition) => transition.status).sort()).toEqual([
      "failed",
      "succeeded",
    ]);
    expect(revoked.sort()).toEqual(["thread-orphaned", "thread-recovered"]);
  }).pipe(Effect.provide(testLayer)),
);

it("maps cancellation events without escalating them as failures", () => {
  expect(
    transitionForProviderEvent(
      completedEvent({
        eventId: "provider-canceled",
        threadId: "thread-canceled",
        state: "cancelled",
      }),
    ),
  ).toMatchObject({ status: "canceled" });
});
