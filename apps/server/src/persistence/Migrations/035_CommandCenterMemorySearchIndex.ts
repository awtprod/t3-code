import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Rebuildable search projections for governed Command Center memory. Canonical
 * memory remains in command_center_memories; every table in this migration may
 * be discarded and reconstructed from those records.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_memory_search_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL UNIQUE
        REFERENCES command_center_memories(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL DEFAULT 'local-user',
      space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
      repository_ref TEXT,
      scope TEXT NOT NULL CHECK (scope IN ('global', 'space', 'repository')),
      kind TEXT NOT NULL,
      trust TEXT NOT NULL CHECK (trust IN ('trusted', 'untrusted_archive')),
      read_only INTEGER NOT NULL CHECK (read_only IN (0, 1)),
      content TEXT NOT NULL,
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      content_digest TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      source_status TEXT NOT NULL CHECK (source_status IN ('approved', 'archive')),
      source_created_at TEXT NOT NULL,
      source_updated_at TEXT NOT NULL,
      expires_at TEXT,
      indexed_at TEXT NOT NULL,
      CHECK (scope != 'repository' OR repository_ref IS NOT NULL),
      CHECK (
        (trust = 'trusted' AND read_only = 0 AND source_status = 'approved') OR
        (trust = 'untrusted_archive' AND read_only = 1)
      )
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_command_center_memory_search_scope
    ON command_center_memory_search_documents(
      owner_id, space_id, repository_ref, scope, trust, source_updated_at DESC
    )
  `;

  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS command_center_memory_search_fts USING fts5(
      memory_id UNINDEXED,
      content,
      tokenize = 'unicode61 remove_diacritics 2'
    )
  `;

  /**
   * Vector storage is deliberately provider-neutral. No vector extension is
   * required: an optional embedding implementation can persist a portable
   * vector plus enough metadata to detect stale embeddings, then replace this
   * projection during a rebuild.
   */
  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_memory_search_embeddings (
      memory_id TEXT PRIMARY KEY
        REFERENCES command_center_memory_search_documents(memory_id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL CHECK (dimensions > 0),
      vector_format TEXT NOT NULL CHECK (vector_format IN ('float32-le', 'float64-le', 'json')),
      vector_data BLOB NOT NULL,
      source_content_digest TEXT NOT NULL,
      embedded_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_memory_search_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
      rebuilt_at TEXT,
      document_count INTEGER NOT NULL DEFAULT 0 CHECK (document_count >= 0),
      trusted_count INTEGER NOT NULL DEFAULT 0 CHECK (trusted_count >= 0),
      archive_count INTEGER NOT NULL DEFAULT 0 CHECK (archive_count >= 0)
    )
  `;

  yield* sql`
    INSERT OR IGNORE INTO command_center_memory_search_state (singleton)
    VALUES (1)
  `;
});
