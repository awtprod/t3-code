import * as NodeServices from "@effect/platform-node/NodeServices";
import { CAPABILITY_NAMES, Space } from "@command-center/core";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeCommandCenterAuditLog } from "./AuditLog.ts";
import { CommandCenterConfig } from "./Config.ts";
import * as ConnectionHealth from "./ConnectionHealth.ts";
import { CommandCenterService, layer as serviceLayer } from "./Service.ts";

// Automation execution audit identity: one event per runtime transition.
// Exact replays (retries, restarts) are idempotent, a legitimate re-entry of
// a state is a new event, any other content for the same transition is still
// rejected, and history written with the older per-state identity is kept.

const fixtureTime = "2026-09-28T00:00:00.000Z";
const space = Schema.decodeUnknownSync(Space)({
  id: "space-a",
  slug: "space-a",
  displayName: "Space A",
  kind: "business",
  instructions: "Use only the selected Space.",
  policy: { allowedCapabilities: CAPABILITY_NAMES, autoRunRiskLevels: ["low", "reversible"] },
  connectionIds: [],
  repositories: [],
  aliases: [],
  lifecycle: "active",
  createdAt: fixtureTime,
  updatedAt: fixtureTime,
});
const configLayer = Layer.succeed(
  CommandCenterConfig,
  CommandCenterConfig.of({
    configDirectory: "test-config",
    load: Effect.succeed({
      spaces: [space],
      connections: [],
      automations: [],
      timezone: "Etc/UTC",
      routing: null,
      health: { status: "loaded", configDirectory: "test-config" },
    }),
    resolveGoogleAccount: () => Effect.die("not used"),
  }),
);
const testLayer = serviceLayer.pipe(
  Layer.provide(ConnectionHealth.layer),
  Layer.provideMerge(configLayer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const transition = (
  overrides: {
    readonly state?: "queued" | "waiting_approval" | "succeeded";
    readonly updatedAt?: string;
    readonly approvalState?: string;
    readonly output?: Schema.Json | null;
  } = {},
) => ({
  executionId: "execution-a",
  automationId: "automation-a",
  spaceId: space.id,
  state: overrides.state ?? "queued",
  configCommitSha: "1234567890abcdef1234567890abcdef12345678",
  definitionDigest: `sha256:${"c".repeat(64)}`,
  input: { mutationId: "approve-a" },
  output: overrides.output ?? null,
  createdAt: fixtureTime,
  updatedAt: overrides.updatedAt ?? fixtureTime,
  checkpoints: [
    {
      nodeId: "approve",
      state: overrides.approvalState ?? "pending",
      attemptCount: 0,
      resolutionKey: null,
    },
  ],
  finishedAt: null,
});

const executionEvents = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly eventId: string; readonly occurredAt: string }>`
    SELECT event_id AS "eventId", occurred_at AS "occurredAt"
    FROM command_center_audit_events
    WHERE event_id LIKE 'automation-execution:execution-a:%'
    ORDER BY sequence
  `;
});

it.effect("records an exact replay of one transition once, at its durable time", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    yield* service.recordAutomationEvent(transition());
    yield* service.recordAutomationEvent(transition());
    const events = yield* executionEvents;
    expect(events).toHaveLength(1);
    expect(events[0]!.eventId).toMatch(/^automation-execution:execution-a:queued:[0-9a-f]{64}$/u);
    expect(events[0]!.occurredAt).toBe(fixtureTime);
    expect(yield* (yield* makeCommandCenterAuditLog).verify).toMatchObject({ valid: true });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("records re-entering a state as a new transition, even in the same instant", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    yield* service.recordAutomationEvent(transition());
    yield* service.recordAutomationEvent(transition({ state: "waiting_approval" }));
    // Resumed after approval: queued again, same millisecond, node advanced.
    yield* service.recordAutomationEvent(transition({ approvalState: "succeeded" }));
    const events = yield* executionEvents;
    expect(events.map((event) => event.eventId.split(":")[2])).toEqual([
      "queued",
      "waiting_approval",
      "queued",
    ]);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(3);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("still rejects different content for the same transition", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    yield* service.recordAutomationEvent(transition());
    const before = yield* (yield* makeCommandCenterAuditLog).verify;
    const mismatch = yield* Effect.flip(
      service.recordAutomationEvent(transition({ output: { forged: true } })),
    );
    expect(mismatch.reason).toBe("persistence");
    expect(String(mismatch.cause)).toContain("already bound to different content");
    expect(yield* executionEvents).toHaveLength(1);
    expect(yield* (yield* makeCommandCenterAuditLog).verify).toEqual(before);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("keeps history written with the older per-state identity and stays verifiable", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const audit = yield* makeCommandCenterAuditLog;
    const sql = yield* SqlClient.SqlClient;
    // An existing database: the run row and its audit events were written by
    // the previous recorder, with the pre-transition per-state identity.
    yield* service.queryConnections({ spaceId: space.id });
    yield* sql`
      INSERT INTO command_center_runs (
        id, command_id, space_id, kind, state, route_json, input_json,
        result_json, error, started_at, finished_at
      ) VALUES (
        'execution-a', 'automation:execution-a', ${space.id}, 'automation', 'waiting_approval',
        '{}', '{}', NULL, NULL, ${fixtureTime}, NULL
      )
    `;
    for (const state of ["queued", "waiting_approval"] as const) {
      yield* audit.append({
        eventId: `automation-execution:execution-a:${state}`,
        actorKind: "automation",
        action: "cc.automations.run.changed",
        spaceId: space.id,
        runId: "execution-a",
        payload: { state, legacy: true },
        occurredAt: "2026-09-27T23:59:00.000Z",
      });
    }
    const legacy = yield* sql<{ readonly eventId: string; readonly eventHash: string }>`
      SELECT event_id AS "eventId", event_hash AS "eventHash"
      FROM command_center_audit_events ORDER BY sequence
    `;

    // After upgrade the same execution resumes and re-enters queued.
    yield* service.recordAutomationEvent(transition({ approvalState: "succeeded" }));
    yield* service.recordAutomationEvent(
      transition({ state: "succeeded", approvalState: "succeeded" }),
    );

    const after = yield* sql<{ readonly eventId: string; readonly eventHash: string }>`
      SELECT event_id AS "eventId", event_hash AS "eventHash"
      FROM command_center_audit_events ORDER BY sequence
    `;
    expect(after.slice(0, legacy.length)).toEqual(legacy);
    expect(after.length).toBeGreaterThan(legacy.length);
    expect(yield* audit.verify).toMatchObject({ valid: true });
  }).pipe(Effect.provide(testLayer)),
);

const seedRuntimeExecution = (state: string, updatedAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* (yield* CommandCenterService).queryConnections({ spaceId: space.id });
    yield* sql`
      INSERT INTO command_center_automation_executions (
        id, automation_id, idempotency_key, space_id, config_commit_sha, definition_digest,
        definition_json, input_json, state, created_at, updated_at, finished_at
      ) VALUES (
        'execution-a', 'automation-a', 'key-a', ${space.id},
        '1234567890abcdef1234567890abcdef12345678', ${`sha256:${"c".repeat(64)}`},
        '{}', '{}', ${state}, ${fixtureTime}, ${updatedAt}, NULL
      )
    `;
  });

const projectedState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly state: string }>`
    SELECT state FROM command_center_runs WHERE id = 'execution-a'
  `;
  return rows[0]?.state;
});

it.effect("audits a superseded snapshot but never projects it over the current run", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    // The durable runtime already moved on to a later transition.
    const later = "2026-09-28T00:00:05.000Z";
    yield* seedRuntimeExecution("waiting_approval", later);
    const current = yield* service.recordAutomationEvent(
      transition({ state: "waiting_approval", updatedAt: later }),
    );
    // A slow replay of the earlier queued snapshot arrives afterwards.
    const replay = yield* service.recordAutomationEvent(transition());
    expect(current).toEqual({ projected: true });
    expect(replay).toEqual({ projected: false });
    expect(yield* projectedState).toBe("waiting_approval");
    // Both transitions really happened; neither is dropped from history.
    expect((yield* executionEvents).map((event) => event.eventId.split(":")[2])).toEqual([
      "waiting_approval",
      "queued",
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("never projects an earlier snapshot from the same millisecond", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    // Resume, run and finish all stamped with one instant.
    yield* seedRuntimeExecution("waiting_approval", fixtureTime);
    yield* service.recordAutomationEvent(
      transition({ state: "waiting_approval", approvalState: "succeeded" }),
    );
    const earlier = yield* service.recordAutomationEvent(transition());
    expect(earlier).toEqual({ projected: false });
    expect(yield* projectedState).toBe("waiting_approval");
  }).pipe(Effect.provide(testLayer)),
);
