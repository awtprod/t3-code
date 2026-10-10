import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import migration072 from "./072_CommandCenterResponsibilities.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("072_CommandCenterResponsibilities", (it) => {
  it.effect("adds operational controls, active slots, status, and grouped incidents", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 69 });
      // Registry wiring is owned by the integration coordinator. Compose the
      // migration explicitly here so this test never runs against missing tables.
      yield* migration072;

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'command_center_responsibility_%'
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map((row) => row.name),
        [
          "command_center_responsibility_active_slots",
          "command_center_responsibility_admissions",
          "command_center_responsibility_controls",
          "command_center_responsibility_incidents",
          "command_center_responsibility_status",
        ],
      );

      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('command_center_automation_executions')
        WHERE name = 'work_identity'
      `;
      assert.deepStrictEqual(columns, [{ name: "work_identity" }]);

      const statusColumns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('command_center_responsibility_status')
        WHERE name IN ('last_admission_attempt_at', 'last_admission_status')
        ORDER BY name
      `;
      assert.deepStrictEqual(statusColumns, [
        { name: "last_admission_attempt_at" },
        { name: "last_admission_status" },
      ]);
      const incidentExecution = yield* sql<{
        readonly notNull: number;
        readonly onDelete: string;
      }>`
        SELECT column_info."notnull" AS "notNull", foreign_keys.on_delete AS "onDelete"
        FROM pragma_table_info('command_center_responsibility_incidents') column_info
        JOIN pragma_foreign_key_list('command_center_responsibility_incidents') foreign_keys
          ON foreign_keys."from" = column_info.name
        WHERE column_info.name = 'latest_execution_id'
      `;
      assert.deepStrictEqual(incidentExecution, [{ notNull: 0, onDelete: "SET NULL" }]);
    }),
  );
});
