import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("103_EfficiencyRoutingSideChannel", (it) => {
  it.effect("creates the side-channel tables and carries V1 routing state over", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 102 });

      // A V1 thread row needs every NOT NULL column without a default.
      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`PRAGMA table_info(projection_threads)`;
      const required = columns.filter(
        (column) =>
          column.notnull === 1 &&
          column.dflt_value === null &&
          !["thread_id", "routing_mode", "efficiency_tier", "updated_at"].includes(column.name),
      );
      const insertThread = (threadId: string, routingMode: string, tier: string | null) =>
        sql.unsafe(
          `INSERT INTO projection_threads (thread_id, routing_mode, efficiency_tier, updated_at${required
            .map((column) => `, ${column.name}`)
            .join("")}) VALUES (?, ?, ?, ?${required.map(() => ", ?").join("")})`,
          [
            threadId,
            routingMode,
            tier,
            "2026-10-01T00:00:00.000Z",
            ...required.map((column) => `${column.name}-value`),
          ],
        );
      yield* insertThread("thread:auto", "auto", "quality");
      yield* insertThread("thread:manual-tier", "manual", "balanced");
      yield* insertThread("thread:manual", "manual", null);

      assert.deepStrictEqual(yield* runMigrations(), [[103, "EfficiencyRoutingSideChannel"]]);

      const rows = yield* sql<{
        readonly threadId: string;
        readonly routingMode: string;
        readonly efficiencyTier: string | null;
      }>`
        SELECT thread_id AS "threadId", routing_mode AS "routingMode",
          efficiency_tier AS "efficiencyTier"
        FROM efficiency_thread_routing ORDER BY thread_id
      `;
      assert.deepStrictEqual(rows, [
        { threadId: "thread:auto", routingMode: "auto", efficiencyTier: "quality" },
        { threadId: "thread:manual-tier", routingMode: "manual", efficiencyTier: "balanced" },
      ]);

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'efficiency_%' ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map((table) => table.name),
        ["efficiency_delegations", "efficiency_run_decisions", "efficiency_thread_routing"],
      );

      const invalid = yield* sql`
        INSERT INTO efficiency_thread_routing (thread_id, routing_mode, updated_at)
        VALUES ('thread:bad', 'sometimes', '2026-10-01T00:00:00.000Z')
      `.pipe(Effect.flip);
      assert.include(String((invalid as { readonly cause?: unknown }).cause), "ConstraintError");
    }),
  );
});
