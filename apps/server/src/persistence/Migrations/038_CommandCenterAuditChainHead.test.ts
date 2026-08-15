import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("038_CommandCenterAuditChainHead", (it) => {
  it.effect("backfills the head and atomically rejects forks and head tampering", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });

      yield* sql`
        INSERT INTO command_center_audit_events (
          event_id, previous_hash, event_hash, actor_kind, action, payload_json, occurred_at
        ) VALUES
          ('before-head-1', NULL, 'hash-1', 'system', 'fixture.first', '{}',
            '2026-01-01T00:00:00.000Z'),
          ('before-head-2', 'hash-1', 'hash-2', 'system', 'fixture.second', '{}',
            '2026-01-01T00:00:01.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 38 });

      const backfilled = yield* sql<{
        readonly eventSequence: number | null;
        readonly eventHash: string | null;
      }>`
        SELECT event_sequence AS "eventSequence", event_hash AS "eventHash"
        FROM command_center_audit_chain_head
        WHERE singleton_id = 1
      `;
      assert.deepStrictEqual(backfilled, [{ eventSequence: 2, eventHash: "hash-2" }]);

      yield* sql`
        INSERT INTO command_center_audit_events (
          event_id, previous_hash, event_hash, actor_kind, action, payload_json, occurred_at
        ) VALUES (
          'after-head', 'hash-2', 'hash-3', 'system', 'fixture.third', '{}',
          '2026-01-01T00:00:02.000Z'
        )
      `;

      const stalePredecessor = yield* Effect.exit(sql`
        INSERT INTO command_center_audit_events (
          event_id, previous_hash, event_hash, actor_kind, action, payload_json, occurred_at
        ) VALUES (
          'fork', 'hash-2', 'hash-fork', 'system', 'fixture.fork', '{}',
          '2026-01-01T00:00:03.000Z'
        )
      `);
      const secondGenesis = yield* Effect.exit(sql`
        INSERT INTO command_center_audit_events (
          event_id, previous_hash, event_hash, actor_kind, action, payload_json, occurred_at
        ) VALUES (
          'second-genesis', NULL, 'hash-genesis', 'system', 'fixture.genesis', '{}',
          '2026-01-01T00:00:04.000Z'
        )
      `);
      const tamperHead = yield* Effect.exit(sql`
        UPDATE command_center_audit_chain_head
        SET event_hash = 'not-the-final-event'
        WHERE singleton_id = 1
      `);
      const deleteHead = yield* Effect.exit(sql`
        DELETE FROM command_center_audit_chain_head WHERE singleton_id = 1
      `);

      assert.ok(Exit.isFailure(stalePredecessor));
      assert.ok(Exit.isFailure(secondGenesis));
      assert.ok(Exit.isFailure(tamperHead));
      assert.ok(Exit.isFailure(deleteHead));

      const finalHead = yield* sql<{
        readonly eventSequence: number | null;
        readonly eventHash: string | null;
      }>`
        SELECT event_sequence AS "eventSequence", event_hash AS "eventHash"
        FROM command_center_audit_chain_head
        WHERE singleton_id = 1
      `;
      const events = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM command_center_audit_events
      `;
      assert.deepStrictEqual(finalHead, [{ eventSequence: 3, eventHash: "hash-3" }]);
      assert.strictEqual(events[0]?.count, 3);
    }),
  );
});

it.effect("refuses to migrate a pre-existing audit fork", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 37 });
    yield* sql`
      INSERT INTO command_center_audit_events (
        event_id, previous_hash, event_hash, actor_kind, action, payload_json, occurred_at
      ) VALUES
        ('genesis', NULL, 'legacy-hash-1', 'system', 'fixture.first', '{}',
          '2026-01-01T00:00:00.000Z'),
        ('successor-a', 'legacy-hash-1', 'legacy-hash-2a', 'system', 'fixture.second-a', '{}',
          '2026-01-01T00:00:01.000Z'),
        ('successor-b', 'legacy-hash-1', 'legacy-hash-2b', 'system', 'fixture.second-b', '{}',
          '2026-01-01T00:00:02.000Z')
    `;

    const migration = yield* Effect.exit(runMigrations({ toMigrationInclusive: 38 }));
    assert.ok(Exit.isFailure(migration));
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
