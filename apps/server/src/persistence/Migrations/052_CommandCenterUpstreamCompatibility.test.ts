import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const expectedThreadColumns = new Set([
  "settled_override",
  "settled_at",
  "snoozed_until",
  "snoozed_at",
  "title_regeneration_request_id",
  "title_regeneration_started_at",
]);

const assertIntegratedSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  const names = new Set(columns.map((column) => column.name));
  for (const name of expectedThreadColumns) assert.ok(names.has(name), `missing ${name}`);

  const commandCenterTables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'command_center_spaces',
      'command_center_runs',
      'command_center_audit_events',
      'command_center_memory_search_documents'
    )
  `;
  assert.equal(commandCenterTables.length, 4);
});

layer("Command Center and upstream migration compatibility", (it) => {
  it.effect("creates the combined schema on a clean database", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* assertIntegratedSchema;
    }),
  );

  it.effect("upgrades a populated migration-49 database without losing its thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, pending_approval_count,
          pending_user_input_count, has_actionable_proposed_plan
        ) VALUES (
          'thread-before-upstream', 'project-1', 'Existing thread',
          '{"provider":"codex","model":"gpt-5"}', 'approval-required',
          'default', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0, 0, 0
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* assertIntegratedSchema;
      const rows = yield* sql<{ readonly title: string }>`
        SELECT title FROM projection_threads WHERE thread_id = 'thread-before-upstream'
      `;
      assert.deepStrictEqual(rows, [{ title: "Existing thread" }]);
    }),
  );
});
