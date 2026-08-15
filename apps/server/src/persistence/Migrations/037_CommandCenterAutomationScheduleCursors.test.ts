import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("037_CommandCenterAutomationScheduleCursors", (it) => {
  it.effect("persists one monotonic schedule cursor per automation", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* sql`
        INSERT INTO command_center_automation_schedule_cursors (
          automation_id, last_checked_minute, updated_at
        ) VALUES (
          'sample', '2026-07-20T12:00:00.000Z', '2026-07-20T12:00:00.000Z'
        )
      `;
      const rows = yield* sql<{ readonly minute: string }>`
        SELECT last_checked_minute AS minute
        FROM command_center_automation_schedule_cursors
        WHERE automation_id = 'sample'
      `;
      assert.deepStrictEqual(rows, [{ minute: "2026-07-20T12:00:00.000Z" }]);
    }),
  );
});
