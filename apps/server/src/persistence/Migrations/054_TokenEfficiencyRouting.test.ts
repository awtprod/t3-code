import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("054_TokenEfficiencyRouting", (it) => {
  it.effect("adds thread routing state and a turn-keyed efficiency projection", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });

      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const turnColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_turns)
      `;
      assert.ok(threadColumns.some((column) => column.name === "routing_mode"));
      assert.ok(threadColumns.some((column) => column.name === "efficiency_tier"));
      assert.ok(turnColumns.some((column) => column.name === "efficiency_decision_json"));
    }),
  );
});
