import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  CommandCenterAuditReplayConflictError,
  commandCenterAuditHashDocument,
  makeCommandCenterAuditLog,
} from "./AuditLog.ts";

const fixtureTime = "2026-01-01T00:00:00.000Z";
const testLayer = Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer);

it.effect("serializes concurrent appends into one verified chain without forks", () =>
  Effect.gen(function* () {
    const audit = yield* makeCommandCenterAuditLog;
    const sql = yield* SqlClient.SqlClient;
    const appended = yield* Effect.all(
      Array.from({ length: 64 }, (_, index) =>
        audit.append({
          eventId: `concurrent-${index}`,
          actorKind: "system",
          action: "fixture.concurrent",
          payload: { index },
          occurredAt: fixtureTime,
        }),
      ),
      { concurrency: "unbounded" },
    );

    const verification = yield* audit.verify;
    const shape = yield* sql<{
      readonly eventCount: number;
      readonly predecessorCount: number;
    }>`
      SELECT
        COUNT(*) AS "eventCount",
        COUNT(DISTINCT CASE
          WHEN previous_hash IS NULL THEN 'genesis:'
          ELSE 'hash:' || previous_hash
        END) AS "predecessorCount"
      FROM command_center_audit_events
    `;

    expect(appended.every(Boolean)).toBe(true);
    expect(verification).toMatchObject({ valid: true, eventCount: 64, headSequence: 64 });
    expect(shape).toEqual([{ eventCount: 64, predecessorCount: 64 }]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("continues from the persisted head after the audit writer restarts", () =>
  Effect.gen(function* () {
    const firstWriter = yield* makeCommandCenterAuditLog;
    yield* firstWriter.append({
      eventId: "before-restart",
      actorKind: "system",
      action: "fixture.before-restart",
      payload: { phase: 1 },
      occurredAt: fixtureTime,
    });

    // Rebuild the writer (including its process-local lock) against the same
    // migrated database, as happens when the owning service is restarted.
    const restartedWriter = yield* makeCommandCenterAuditLog;
    yield* restartedWriter.append({
      eventId: "after-restart",
      actorKind: "system",
      action: "fixture.after-restart",
      payload: { phase: 2 },
      occurredAt: "2026-01-01T00:00:01.000Z",
    });

    expect(yield* restartedWriter.verify).toMatchObject({
      valid: true,
      eventCount: 2,
      headSequence: 2,
    });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("verifies legacy v1 history without rewriting it", () =>
  Effect.gen(function* () {
    const audit = yield* makeCommandCenterAuditLog;
    const sql = yield* SqlClient.SqlClient;
    const eventId = "legacy-v1-event";
    const eventHash = NodeCrypto.createHash("sha256")
      .update(
        commandCenterAuditHashDocument({
          hashVersion: 1,
          eventId,
          previousHash: null,
          actorKind: "system",
          action: "fixture.legacy",
          payload: { legacy: true },
          occurredAt: fixtureTime,
        }),
      )
      .digest("hex");
    yield* sql`
      INSERT INTO command_center_audit_events (
        event_id, hash_version, previous_hash, event_hash, actor_kind, action,
        payload_json, occurred_at
      ) VALUES (
        ${eventId}, 1, NULL, ${eventHash}, 'system', 'fixture.legacy',
        '{"legacy":true}', ${fixtureTime}
      )
    `;

    expect(yield* audit.verify).toMatchObject({ valid: true, eventCount: 1 });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("treats an identical deterministic event replay as idempotent", () =>
  Effect.gen(function* () {
    const audit = yield* makeCommandCenterAuditLog;
    const sql = yield* SqlClient.SqlClient;
    const first = yield* audit.append({
      eventId: "idempotent-event",
      actorKind: "system",
      action: "fixture.idempotent",
      payload: { alpha: 1, nested: { beta: true } },
      occurredAt: fixtureTime,
    });
    const replay = yield* audit.append({
      eventId: "idempotent-event",
      actorKind: "system",
      action: "fixture.idempotent",
      payload: { nested: { beta: true }, alpha: 1 },
      occurredAt: fixtureTime,
    });
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM command_center_audit_events
    `;

    expect(first).toBe(true);
    expect(replay).toBe(false);
    expect(rows).toEqual([{ count: 1 }]);
    expect(yield* audit.verify).toMatchObject({ valid: true, eventCount: 1 });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects a mismatched deterministic replay without advancing the chain", () =>
  Effect.gen(function* () {
    const audit = yield* makeCommandCenterAuditLog;
    const sql = yield* SqlClient.SqlClient;
    yield* audit.append({
      eventId: "conflicting-event",
      actorKind: "system",
      action: "fixture.original",
      payload: { value: "original" },
      occurredAt: fixtureTime,
    });
    const before = yield* sql<{
      readonly eventSequence: number | null;
      readonly eventHash: string | null;
    }>`
      SELECT event_sequence AS "eventSequence", event_hash AS "eventHash"
      FROM command_center_audit_chain_head
      WHERE singleton_id = 1
    `;

    const error = yield* audit
      .append({
        eventId: "conflicting-event",
        actorKind: "system",
        action: "fixture.changed",
        payload: { value: "changed" },
        occurredAt: fixtureTime,
      })
      .pipe(Effect.flip);
    const after = yield* sql<{
      readonly eventSequence: number | null;
      readonly eventHash: string | null;
    }>`
      SELECT event_sequence AS "eventSequence", event_hash AS "eventHash"
      FROM command_center_audit_chain_head
      WHERE singleton_id = 1
    `;
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM command_center_audit_events
    `;

    expect(error).toBeInstanceOf(CommandCenterAuditReplayConflictError);
    expect(before).toEqual(after);
    expect(rows).toEqual([{ count: 1 }]);
    expect(yield* audit.verify).toMatchObject({ valid: true, eventCount: 1 });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("detects historical payload tampering during an integrity check", () =>
  Effect.gen(function* () {
    const audit = yield* makeCommandCenterAuditLog;
    const sql = yield* SqlClient.SqlClient;
    yield* audit.append({
      eventId: "integrity-event",
      actorKind: "system",
      action: "fixture.integrity",
      payload: { original: true },
      occurredAt: fixtureTime,
    });

    // Simulate storage corruption by removing the append-only guard. Normal
    // application code cannot perform this update.
    yield* sql`DROP TRIGGER command_center_audit_events_no_update`;
    yield* sql`
      UPDATE command_center_audit_events
      SET payload_json = '{"original":false}'
      WHERE event_id = 'integrity-event'
    `;

    expect(yield* audit.verify).toMatchObject({
      valid: false,
      eventCount: 1,
      invalidSequence: 1,
      reason: "event-hash",
    });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("detects event ID tampering for v2 audit events", () =>
  Effect.gen(function* () {
    const audit = yield* makeCommandCenterAuditLog;
    const sql = yield* SqlClient.SqlClient;
    yield* audit.append({
      eventId: "bound-event-id",
      actorKind: "system",
      action: "fixture.identity-bound",
      payload: { original: true },
      occurredAt: fixtureTime,
    });

    yield* sql`DROP TRIGGER command_center_audit_events_no_update`;
    yield* sql`
      UPDATE command_center_audit_events
      SET event_id = 'changed-event-id'
      WHERE event_id = 'bound-event-id'
    `;

    expect(yield* audit.verify).toMatchObject({
      valid: false,
      eventCount: 1,
      invalidSequence: 1,
      reason: "event-hash",
    });
  }).pipe(Effect.provide(testLayer)),
);
