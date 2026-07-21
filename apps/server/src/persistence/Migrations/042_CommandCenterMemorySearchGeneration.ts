import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Marks the rebuildable memory-search projection stale at the canonical write boundary. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE command_center_memory_search_state
    ADD COLUMN source_generation INTEGER NOT NULL DEFAULT 0 CHECK (source_generation >= 0)
  `;
  yield* sql`
    ALTER TABLE command_center_memory_search_state
    ADD COLUMN indexed_source_generation INTEGER NOT NULL DEFAULT 0
      CHECK (indexed_source_generation >= 0)
  `;

  yield* sql`
    UPDATE command_center_memory_search_state
    SET source_generation = CASE
      WHEN EXISTS (SELECT 1 FROM command_center_memories) THEN 1
      ELSE 0
    END,
    indexed_source_generation = 0
    WHERE singleton = 1
  `;

  yield* sql`
    CREATE TRIGGER command_center_memory_search_source_insert
    AFTER INSERT ON command_center_memories
    BEGIN
      UPDATE command_center_memory_search_state
      SET source_generation = source_generation + 1
      WHERE singleton = 1;
    END
  `;
  yield* sql`
    CREATE TRIGGER command_center_memory_search_source_update
    AFTER UPDATE ON command_center_memories
    BEGIN
      UPDATE command_center_memory_search_state
      SET source_generation = source_generation + 1
      WHERE singleton = 1;
    END
  `;
  yield* sql`
    CREATE TRIGGER command_center_memory_search_source_delete
    AFTER DELETE ON command_center_memories
    BEGIN
      UPDATE command_center_memory_search_state
      SET source_generation = source_generation + 1
      WHERE singleton = 1;
    END
  `;
});
