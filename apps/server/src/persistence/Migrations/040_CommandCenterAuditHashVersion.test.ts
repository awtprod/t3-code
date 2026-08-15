import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("040_CommandCenterAuditHashVersion", (it) => {
  it.effect("marks legacy events as v1 without rewriting their stored digest", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 39 });
      yield* sql`
        INSERT INTO command_center_audit_events (
          event_id, previous_hash, event_hash, actor_kind, action, payload_json, occurred_at
        ) VALUES (
          'legacy-event', NULL, 'legacy-digest', 'system', 'fixture.legacy', '{}',
          '2026-01-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 40 });

      const rows = yield* sql<{
        readonly eventId: string;
        readonly eventHash: string;
        readonly hashVersion: number;
      }>`
        SELECT event_id AS "eventId", event_hash AS "eventHash",
          hash_version AS "hashVersion"
        FROM command_center_audit_events
      `;
      assert.deepStrictEqual(rows, [
        { eventId: "legacy-event", eventHash: "legacy-digest", hashVersion: 1 },
      ]);
    }),
  );
});
