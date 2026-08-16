import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("064_ProjectionThreadSandbox", (it) => {
  it.effect("adds nullable sandbox JSON to thread projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 63 });
      yield* runMigrations({ toMigrationInclusive: 64 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_threads)
      `;
      const sandbox = columns.find((column) => column.name === "sandbox_json");

      assert.equal(sandbox?.name, "sandbox_json");
      assert.equal(sandbox?.notnull, 0);
    }),
  );
});
