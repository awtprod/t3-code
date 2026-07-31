import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("035_CommandCenterMemorySearchIndex", (it) => {
  it.effect("creates a rebuildable FTS index and provider-neutral embedding storage", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 34 });
      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE name = 'command_center_memory_search_documents'
      `;
      assert.strictEqual(before.length, 0);

      yield* runMigrations({ toMigrationInclusive: 35 });
      const tables = yield* sql<{ readonly name: string; readonly sql: string }>`
        SELECT name, sql
        FROM sqlite_master
        WHERE name IN (
          'command_center_memory_search_documents',
          'command_center_memory_search_embeddings',
          'command_center_memory_search_fts',
          'command_center_memory_search_state'
        )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map((table) => table.name),
        [
          "command_center_memory_search_documents",
          "command_center_memory_search_embeddings",
          "command_center_memory_search_fts",
          "command_center_memory_search_state",
        ],
      );
      assert.match(
        tables.find((table) => table.name === "command_center_memory_search_fts")?.sql ?? "",
        /USING fts5/u,
      );

      const state = yield* sql<{
        readonly generation: number;
        readonly documentCount: number;
      }>`
        SELECT generation, document_count AS "documentCount"
        FROM command_center_memory_search_state
        WHERE singleton = 1
      `;
      assert.deepStrictEqual(state, [{ generation: 0, documentCount: 0 }]);

      yield* sql`
        INSERT INTO command_center_spaces (id, slug, name, kind, created_at, updated_at)
        VALUES (
          'sample-space', 'sample-space', 'Sample Space', 'business',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO command_center_memories (
          id, space_id, scope, kind, content, status, confidence, provenance_json,
          created_at, updated_at
        ) VALUES (
          'sample-memory', 'sample-space', 'space', 'fact', 'sample searchable memory',
          'approved', 1, '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO command_center_memory_search_documents (
          memory_id, space_id, scope, kind, trust, read_only, content, confidence,
          content_digest, provenance_json, source_status, source_created_at,
          source_updated_at, indexed_at
        ) VALUES (
          'sample-memory', 'sample-space', 'space', 'fact', 'trusted', 0,
          'sample searchable memory', 1,
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '{}',
          'approved', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO command_center_memory_search_fts (memory_id, content)
        VALUES ('sample-memory', 'sample searchable memory')
      `;
      const matches = yield* sql<{ readonly memoryId: string }>`
        SELECT memory_id AS "memoryId"
        FROM command_center_memory_search_fts
        WHERE command_center_memory_search_fts MATCH 'searchable'
      `;
      assert.deepStrictEqual(matches, [{ memoryId: "sample-memory" }]);

      const invalidEmbedding = yield* Effect.exit(sql`
        INSERT INTO command_center_memory_search_embeddings (
          memory_id, provider, model, dimensions, vector_format, vector_data,
          source_content_digest, embedded_at
        ) VALUES (
          'sample-memory', 'sample-provider', 'sample-model', 0, 'float32-le', X'0000',
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          '2026-01-01T00:00:00.000Z'
        )
      `);
      assert.ok(Exit.isFailure(invalidEmbedding));
    }),
  );
});
