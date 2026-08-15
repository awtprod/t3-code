import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("034_CommandCenterAutomationRuntime", (it) => {
  it.effect("creates pinned execution and checkpoint storage with constrained states", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 33 });
      yield* runMigrations({ toMigrationInclusive: 34 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'command_center_automation_%'
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map((table) => table.name),
        [
          "command_center_automation_executions",
          "command_center_automation_node_checkpoints",
          "command_center_automations",
        ],
      );

      yield* sql`
        INSERT INTO command_center_spaces (
          id, slug, name, kind, created_at, updated_at
        ) VALUES (
          'sample-space', 'sample-space', 'Sample Space', 'business',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;

      const invalidState = yield* Effect.exit(sql`
        INSERT INTO command_center_automation_executions (
          id, automation_id, idempotency_key, space_id, config_commit_sha,
          definition_digest, definition_json, state, created_at, updated_at
        ) VALUES (
          'sample-run', 'sample-automation', 'sample-request', 'sample-space',
          '1234567890abcdef1234567890abcdef12345678',
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          '{}', 'unknown', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `);
      assert.ok(Exit.isFailure(invalidState));
    }),
  );
});
