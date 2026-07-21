import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("042_CommandCenterMemorySearchGeneration", (it) => {
  it.effect("marks the search projection stale for every canonical memory mutation", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 42 });
      yield* sql`
        INSERT INTO command_center_spaces (id, slug, name, kind, created_at, updated_at)
        VALUES ('space-a', 'space-a', 'Space A', 'business', '2026-01-01', '2026-01-01')
      `;

      const generation = () =>
        sql<{ readonly sourceGeneration: number; readonly indexedGeneration: number }>`
          SELECT source_generation AS "sourceGeneration",
            indexed_source_generation AS "indexedGeneration"
          FROM command_center_memory_search_state WHERE singleton = 1
        `;
      assert.deepStrictEqual(yield* generation(), [{ sourceGeneration: 0, indexedGeneration: 0 }]);

      yield* sql`
        INSERT INTO command_center_memories (
          id, space_id, scope, kind, content, status, confidence, provenance_json,
          created_at, updated_at
        ) VALUES (
          'memory-a', 'space-a', 'space', 'fact', 'Example', 'approved', 1, '{}',
          '2026-01-01', '2026-01-01'
        )
      `;
      yield* sql`UPDATE command_center_memories SET content = 'Updated' WHERE id = 'memory-a'`;
      yield* sql`DELETE FROM command_center_memories WHERE id = 'memory-a'`;

      assert.deepStrictEqual(yield* generation(), [{ sourceGeneration: 3, indexedGeneration: 0 }]);
    }),
  );
});
