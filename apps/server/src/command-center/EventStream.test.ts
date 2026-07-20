import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { RouteDecision, SpaceId } from "@command-center/core";
import { CommandCenterCommandSubmitInput } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CommandCenterEventStream, layer as eventStreamLayer } from "./EventStream.ts";

type Sql = SqlClient.SqlClient;

const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const decodeRoute = Schema.decodeUnknownSync(RouteDecision);
const decodeCommand = Schema.decodeUnknownSync(CommandCenterCommandSubmitInput);
const fixtureTime = "2026-01-01T00:00:00.000Z";

const makeTestLayer = () =>
  eventStreamLayer.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );

const route = (input: {
  readonly commandId: string;
  readonly spaceId: string;
  readonly projectId?: string;
}) =>
  decodeRoute({
    commandId: input.commandId,
    status: "ready",
    intent: "conversation",
    spaceId: input.spaceId,
    repositoryId: null,
    projectId: input.projectId ?? null,
    providerId: "provider-example",
    modelId: "model-example",
    capabilities: ["cc.runs.start"],
    actionKind: "read",
    risk: "low",
    approvalRequired: false,
    sources: {
      space: "explicit",
      repository: "unresolved",
      project: input.projectId === undefined ? "unresolved" : "explicit",
      provider: "fallback",
      model: "provider-default",
    },
    reasons: [],
  });

const command = (input: {
  readonly commandId: string;
  readonly spaceId: string;
  readonly text: string;
  readonly projectId?: string;
}) =>
  decodeCommand({
    commandId: input.commandId,
    spaceId: input.spaceId,
    text: input.text,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
  });

const insertSpace = (sql: Sql, id: string, name: string) =>
  sql`
    INSERT INTO command_center_spaces (id, slug, name, kind, created_at, updated_at)
    VALUES (${id}, ${id}, ${name}, 'business', ${fixtureTime}, ${fixtureTime})
  `;

const insertRun = (
  sql: Sql,
  input: {
    readonly id: string;
    readonly commandId: string;
    readonly spaceId: string;
    readonly text: string;
    readonly status?: string;
    readonly projectId?: string;
    readonly threadId?: string;
    readonly startedAt?: string;
  },
) => {
  const selectedRoute = route({
    commandId: input.commandId,
    spaceId: input.spaceId,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
  });
  const submittedCommand = command({
    commandId: input.commandId,
    spaceId: input.spaceId,
    text: input.text,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
  });
  return sql`
    INSERT INTO command_center_runs (
      id, command_id, space_id, project_id, thread_id, kind, state,
      route_json, input_json, started_at
    ) VALUES (
      ${input.id}, ${input.commandId}, ${input.spaceId}, ${input.projectId ?? null},
      ${input.threadId ?? null}, 'agent', ${input.status ?? "queued"},
      ${encodeJson(selectedRoute)}, ${encodeJson(submittedCommand)},
      ${input.startedAt ?? fixtureTime}
    )
  `;
};

interface AuditInput {
  readonly eventId: string;
  readonly previousHash: string | null;
  readonly actorKind: string;
  readonly action: string;
  readonly spaceId?: string;
  readonly runId?: string;
  readonly payload: unknown;
  readonly occurredAt?: string;
  readonly storedEventHash?: string;
}

const appendAudit = (sql: Sql, input: AuditInput) => {
  const occurredAt = input.occurredAt ?? fixtureTime;
  const hashInput = {
    previousHash: input.previousHash,
    actorKind: input.actorKind,
    action: input.action,
    ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    payload: input.payload,
    occurredAt,
  };
  const calculatedEventHash = NodeCrypto.createHash("sha256")
    .update(encodeJson(hashInput))
    .digest("hex");
  const eventHash = input.storedEventHash ?? calculatedEventHash;
  return sql<{ readonly sequence: number }>`
    INSERT INTO command_center_audit_events (
      event_id, previous_hash, event_hash, actor_kind, action, space_id,
      run_id, payload_json, occurred_at
    ) VALUES (
      ${input.eventId}, ${input.previousHash}, ${eventHash}, ${input.actorKind},
      ${input.action}, ${input.spaceId ?? null}, ${input.runId ?? null},
      ${encodeJson(input.payload)}, ${occurredAt}
    )
    RETURNING sequence
  `.pipe(Effect.map((rows) => ({ sequence: rows[0]!.sequence, eventHash })));
};

it.effect(
  "replays typed events in sequence order and filters by Space without breaking cursors",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const events = yield* CommandCenterEventStream;
      yield* insertSpace(sql, "space-alpha", "Alpha Example");
      yield* insertSpace(sql, "space-beta", "Beta Example");
      yield* insertRun(sql, {
        id: "run-alpha",
        commandId: "command-alpha",
        spaceId: "space-alpha",
        text: "Review the alpha example",
      });
      yield* insertRun(sql, {
        id: "run-beta",
        commandId: "command-beta",
        spaceId: "space-beta",
        text: "Review the beta example",
      });

      let previousHash: string | null = null;
      const append = Effect.fn("EventStreamTest.append")(function* (
        input: Omit<AuditInput, "previousHash" | "eventId" | "actorKind">,
        eventId: string,
      ) {
        const appended = yield* appendAudit(sql, {
          ...input,
          eventId,
          previousHash,
          actorKind: "agent",
        });
        previousHash = appended.eventHash;
      });

      yield* append(
        {
          action: "cc.command.submit",
          spaceId: "space-alpha",
          runId: "run-alpha",
          payload: {
            commandId: "command-alpha",
            route: route({ commandId: "command-alpha", spaceId: "space-alpha" }),
            state: "queued",
          },
        },
        "event-route",
      );
      yield* append(
        {
          action: "cc.items.changed",
          spaceId: "space-beta",
          runId: "run-beta",
          payload: {
            itemId: "item-beta",
            change: "created",
            kind: "task",
            status: "ready",
          },
        },
        "event-item",
      );
      yield* append(
        {
          action: "cc.runs.state",
          spaceId: "space-alpha",
          runId: "run-alpha",
          payload: {
            status: "running",
            previousStatus: "queued",
            projectId: "project-alpha",
            threadId: "thread-alpha",
          },
        },
        "event-run",
      );
      yield* append(
        {
          action: "cc.approvals.changed",
          spaceId: "space-alpha",
          runId: "run-alpha",
          payload: {
            approvalId: "approval-alpha",
            status: "approved",
            payloadDigest: "a".repeat(64),
          },
        },
        "event-approval",
      );
      yield* append(
        {
          action: "cc.artifacts.changed",
          spaceId: "space-beta",
          runId: "run-beta",
          payload: {
            change: "created",
            artifact: {
              id: "artifact-beta",
              spaceId: "space-beta",
              runId: "run-beta",
              kind: "report",
              name: "Example report",
              locator: "runtime:artifact-beta",
              contentDigest: "b".repeat(64),
              provenance: { kind: "agent", capturedAt: fixtureTime },
              createdAt: fixtureTime,
            },
          },
        },
        "event-artifact",
      );
      yield* append(
        {
          action: "cc.failures.recorded",
          spaceId: "space-alpha",
          runId: "run-alpha",
          payload: {
            scope: "run",
            reason: "example-failure",
            message: "The example run needs attention.",
            retryable: true,
          },
        },
        "event-failure",
      );

      const all = yield* events.replay({ afterSequence: 0, limit: 20 });
      expect(all.events.map((event) => event._tag)).toEqual([
        "RouteSelected",
        "ItemChanged",
        "RunStateChanged",
        "ApprovalChanged",
        "ArtifactChanged",
        "CommandCenterFailure",
      ]);
      expect(all.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(all.nextSequence).toBe(6);

      const alpha = yield* events.replay({
        afterSequence: 0,
        spaceId: SpaceId.make("space-alpha"),
        limit: 20,
      });
      expect(alpha.events.map((event) => event.sequence)).toEqual([1, 3, 4, 6]);
      expect(alpha.nextSequence).toBe(6);

      const afterCursor = yield* events.replay({ afterSequence: 2, limit: 20 });
      expect(afterCursor.events.map((event) => event.sequence)).toEqual([3, 4, 5, 6]);
    }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("rejects a changed event digest", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const events = yield* CommandCenterEventStream;
    yield* insertSpace(sql, "space-hash", "Hash Example");
    yield* appendAudit(sql, {
      eventId: "event-hash",
      previousHash: null,
      actorKind: "system",
      action: "cc.failures.recorded",
      spaceId: "space-hash",
      payload: {
        scope: "system",
        reason: "example",
        message: "Example failure.",
        retryable: false,
      },
      storedEventHash: "changed",
    });

    const error = yield* events.replay({ afterSequence: 0 }).pipe(Effect.flip);
    expect(error).toMatchObject({ reason: "hash-mismatch", sequence: 1 });
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("rejects a discontinuous hash chain before decoding later events", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const events = yield* CommandCenterEventStream;
    yield* insertSpace(sql, "space-chain", "Chain Example");
    const first = yield* appendAudit(sql, {
      eventId: "event-chain-one",
      previousHash: null,
      actorKind: "user",
      action: "cc.items.create",
      spaceId: "space-chain",
      payload: { itemId: "item-chain", kind: "task" },
    });
    yield* appendAudit(sql, {
      eventId: "event-chain-two",
      previousHash: first.eventHash,
      actorKind: "user",
      action: "cc.items.create",
      spaceId: "space-chain",
      payload: { itemId: "item-chain-two", kind: "task" },
    });
    // The database rejects a discontinuous insert. Remove the append-only
    // update guard solely to model legacy storage corruption for the replay
    // verifier's defense-in-depth behavior.
    yield* sql`DROP TRIGGER command_center_audit_events_no_update`;
    yield* sql`
      UPDATE command_center_audit_events
      SET previous_hash = ${"0".repeat(64)}
      WHERE event_id = 'event-chain-two'
    `;

    const error = yield* events.replay({ afterSequence: 0 }).pipe(Effect.flip);
    expect(error).toMatchObject({ reason: "hash-chain", sequence: 2 });
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("rejects malformed payloads for known typed actions", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const events = yield* CommandCenterEventStream;
    yield* insertSpace(sql, "space-decode", "Decode Example");
    yield* appendAudit(sql, {
      eventId: "event-decode",
      previousHash: null,
      actorKind: "agent",
      action: "cc.runs.state",
      spaceId: "space-decode",
      payload: { status: "not-a-run-status" },
    });

    const error = yield* events.replay({ afterSequence: 0 }).pipe(Effect.flip);
    expect(error).toMatchObject({ reason: "decode", sequence: 1 });
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("polls for new durable events after replaying the current cursor", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const events = yield* CommandCenterEventStream;
    yield* insertSpace(sql, "space-live", "Live Example");
    const first = yield* appendAudit(sql, {
      eventId: "event-live-one",
      previousHash: null,
      actorKind: "user",
      action: "cc.items.create",
      spaceId: "space-live",
      payload: { itemId: "item-live-one", kind: "task" },
    });
    const firstObserved = yield* Deferred.make<void>();
    const collected = events.changes({ afterSequence: 0, pollIntervalMs: 100 }).pipe(
      Stream.tap((event) =>
        event.sequence === first.sequence
          ? Deferred.succeed(firstObserved, undefined).pipe(Effect.asVoid)
          : Effect.void,
      ),
      Stream.take(2),
      Stream.runCollect,
    );
    const fiber = yield* Effect.forkChild(collected);
    yield* Deferred.await(firstObserved).pipe(Effect.timeout("1 second"));

    yield* appendAudit(sql, {
      eventId: "event-live-two",
      previousHash: first.eventHash,
      actorKind: "user",
      action: "cc.items.create",
      spaceId: "space-live",
      payload: { itemId: "item-live-two", kind: "task" },
    });
    const received = Array.from(yield* Fiber.join(fiber).pipe(Effect.timeout("2 seconds")));

    expect(received.map((event) => event.sequence)).toEqual([1, 2]);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("reconstructs the durable Command timeline with route and thread links", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const events = yield* CommandCenterEventStream;
    yield* insertSpace(sql, "space-timeline", "Timeline Example");
    yield* insertSpace(sql, "space-other", "Other Example");
    yield* insertRun(sql, {
      id: "run-timeline-one",
      commandId: "command-timeline-one",
      spaceId: "space-timeline",
      text: "Open the first example",
      status: "running",
      projectId: "project-timeline",
      threadId: "thread-timeline",
      startedAt: "2026-01-01T01:00:00.000Z",
    });
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, attachments_json,
        is_streaming, created_at, updated_at
      ) VALUES (
        'message-timeline-one', 'thread-timeline', 'turn-timeline-one', 'assistant',
        'The first example is open.', '[]', 0,
        '2026-01-01T01:01:00.000Z', '2026-01-01T01:01:00.000Z'
      )
    `;
    yield* sql`
      INSERT INTO command_center_artifacts (
        id, space_id, run_id, kind, title, uri, content_digest,
        provenance_json, metadata_json, created_at
      ) VALUES (
        'artifact-timeline-one', 'space-timeline', 'run-timeline-one', 'report',
        'Example report', 'cc-artifact://artifact-timeline-one', ${`sha256:${"a".repeat(64)}`},
        ${encodeJson({
          kind: "agent",
          sourceRef: "thread-timeline",
          capturedAt: "2026-01-01T01:01:00.000Z",
        })},
        ${encodeJson({ mimeType: "text/markdown" })}, '2026-01-01T01:01:00.000Z'
      )
    `;
    yield* insertRun(sql, {
      id: "run-timeline-two",
      commandId: "command-timeline-two",
      spaceId: "space-other",
      text: "Open the second example",
      startedAt: "2026-01-01T02:00:00.000Z",
    });
    const first = yield* appendAudit(sql, {
      eventId: "event-timeline-one",
      previousHash: null,
      actorKind: "user",
      action: "cc.command.submit",
      spaceId: "space-timeline",
      runId: "run-timeline-one",
      payload: {
        commandId: "command-timeline-one",
        route: route({
          commandId: "command-timeline-one",
          spaceId: "space-timeline",
          projectId: "project-timeline",
        }),
        state: "queued",
      },
    });
    yield* appendAudit(sql, {
      eventId: "event-timeline-two",
      previousHash: first.eventHash,
      actorKind: "user",
      action: "cc.command.submit",
      spaceId: "space-other",
      runId: "run-timeline-two",
      payload: {
        commandId: "command-timeline-two",
        route: route({ commandId: "command-timeline-two", spaceId: "space-other" }),
        state: "queued",
      },
    });

    const timeline = yield* events.timeline({ limit: 20 });
    expect(timeline.entries.map((entry) => entry.text)).toEqual([
      "Open the first example",
      "Open the second example",
    ]);
    expect(timeline.entries[0]).toMatchObject({
      sequence: 1,
      runId: "run-timeline-one",
      projectId: "project-timeline",
      threadId: "thread-timeline",
      status: "running",
      response: {
        kind: "assistant",
        text: "The first example is open.",
      },
    });
    expect(timeline.entries[0]?.artifacts).toMatchObject([
      {
        id: "artifact-timeline-one",
        name: "Example report",
        locator: "cc-artifact://artifact-timeline-one",
      },
    ]);
    expect(timeline.nextSequence).toBe(2);

    const filtered = yield* events.timeline({
      spaceId: SpaceId.make("space-timeline"),
      limit: 20,
    });
    expect(filtered.entries.map((entry) => entry.runId)).toEqual(["run-timeline-one"]);

    const afterCursor = yield* events.timeline({ afterSequence: 1, limit: 20 });
    expect(afterCursor.entries.map((entry) => entry.runId)).toEqual(["run-timeline-two"]);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("keeps archived-Space events and timeline commands out of active projections", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const events = yield* CommandCenterEventStream;
    yield* insertSpace(sql, "space-retired", "Retired Example");
    yield* insertRun(sql, {
      id: "run-retired",
      commandId: "command-retired",
      spaceId: "space-retired",
      text: "Open the retired example",
    });
    yield* appendAudit(sql, {
      eventId: "event-retired",
      previousHash: null,
      actorKind: "user",
      action: "cc.command.submit",
      spaceId: "space-retired",
      runId: "run-retired",
      payload: {
        commandId: "command-retired",
        route: route({ commandId: "command-retired", spaceId: "space-retired" }),
        state: "queued",
      },
    });
    yield* sql`
      UPDATE command_center_spaces SET lifecycle = 'archived' WHERE id = 'space-retired'
    `;

    expect((yield* events.replay({ afterSequence: 0 })).events).toEqual([]);
    expect((yield* events.timeline({ limit: 20 })).entries).toEqual([]);
  }).pipe(Effect.provide(makeTestLayer())),
);
