import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("033_CommandCenterCore", (it) => {
  it.effect("creates the canonical OS records and rejects invalid lifecycle states", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 32 });
      yield* runMigrations({ toMigrationInclusive: 33 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'command_center_%'
        ORDER BY name
      `;

      assert.deepStrictEqual(
        tables.map((table) => table.name),
        [
          "command_center_approvals",
          "command_center_artifacts",
          "command_center_audit_events",
          "command_center_automations",
          "command_center_command_receipts",
          "command_center_connections",
          "command_center_items",
          "command_center_memories",
          "command_center_memory_candidates",
          "command_center_runs",
          "command_center_spaces",
        ],
      );

      yield* sql`
        INSERT INTO command_center_spaces (
          id, slug, name, kind, created_at, updated_at
        ) VALUES (
          'space-example', 'example', 'Example', 'business', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
        )
      `;

      const ownership = yield* sql<{ readonly ownerId: string }>`
        SELECT owner_id AS "ownerId"
        FROM command_center_spaces
        WHERE id = 'space-example'
      `;
      assert.strictEqual(ownership[0]?.ownerId, "local-user");

      const invalidStatus = yield* Effect.exit(sql`
        INSERT INTO command_center_items (
          id, space_id, kind, status, title, created_at, updated_at
        ) VALUES (
          'item-invalid', 'space-example', 'task', 'unknown', 'Invalid',
          '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
        )
      `);
      assert.ok(Exit.isFailure(invalidStatus));

      yield* sql`
        INSERT INTO command_center_audit_events (
          event_id, event_hash, actor_kind, action, space_id, payload_json, occurred_at
        ) VALUES (
          'event-example', 'sha256:example', 'system', 'cc.example', 'space-example', '{}',
          '2026-01-01T00:00:00Z'
        )
      `;

      const updateAudit = yield* Effect.exit(sql`
        UPDATE command_center_audit_events
        SET action = 'cc.tampered'
        WHERE event_id = 'event-example'
      `);
      const deleteAudit = yield* Effect.exit(sql`
        DELETE FROM command_center_audit_events
        WHERE event_id = 'event-example'
      `);
      assert.ok(Exit.isFailure(updateAudit));
      assert.ok(Exit.isFailure(deleteAudit));
    }),
  );
});
