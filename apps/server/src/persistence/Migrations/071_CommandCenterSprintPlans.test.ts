import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration071 from "./071_CommandCenterSprintPlans.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("071_CommandCenterSprintPlans", (it) => {
  it.effect("creates bounded plan, immutable import, history, and resolution storage", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // The shared registry is owned by another slice. Compose 071 explicitly
      // until the coordinator adds it to Migrations.ts.
      yield* runMigrations({ toMigrationInclusive: 69 });
      yield* Migration071;
      yield* sql`
        INSERT INTO command_center_spaces (
          id, slug, name, kind, created_at, updated_at
        ) VALUES (
          'space-1', 'space-1', 'Space 1', 'business',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO command_center_sprint_plans (
          id, space_id, version, source_version, current_import_id, current_json,
          created_at, updated_at
        ) VALUES (
          'plan-1', 'space-1', 1, 2, 'import-1', '{}',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO command_center_sprint_plan_imports (
          id, plan_id, mutation_id, source_sha256, source_version, source_updated_at,
          source_json, provenance_json, applied_plan_version, imported_at
        ) VALUES (
          'import-1', 'plan-1', 'mutation-1',
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          2, '2026-01-01T00:00:00.000Z', '{}', '{}', 1,
          '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO command_center_sprint_plan_mutation_receipts (
          mutation_id, plan_id, space_id, operation, request_digest, plan_version, occurred_at
        ) VALUES (
          'mutation-1', 'plan-1', 'space-1', 'import',
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1,
          '2026-01-01T00:00:00.000Z'
        )
      `;

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'command_center_sprint_plan%'
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map((row) => row.name),
        [
          "command_center_sprint_plan_date_resolutions",
          "command_center_sprint_plan_history",
          "command_center_sprint_plan_imports",
          "command_center_sprint_plan_mutation_receipts",
          "command_center_sprint_plans",
        ],
      );

      const updateImport = yield* Effect.exit(sql`
        UPDATE command_center_sprint_plan_imports SET source_json = '{"changed":true}'
        WHERE id = 'import-1'
      `);
      assert.strictEqual(updateImport._tag, "Failure");
      const updateReceipt = yield* Effect.exit(sql`
        UPDATE command_center_sprint_plan_mutation_receipts SET plan_version = 2
        WHERE mutation_id = 'mutation-1'
      `);
      assert.strictEqual(updateReceipt._tag, "Failure");
    }),
  );
});
