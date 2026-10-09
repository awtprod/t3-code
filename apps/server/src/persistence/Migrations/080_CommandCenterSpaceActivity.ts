import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The per-Space activity feed: one bounded row per finished thread turn or
 * Run, per Space it belongs to. Written by `SpaceActivityReactor`, read by the
 * Space agent. Rows are pruned to the newest few hundred per Space on insert.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE command_center_space_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
      occurred_at TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('thread', 'run')),
      source_id TEXT NOT NULL,
      project_id TEXT,
      title TEXT NOT NULL CHECK (length(title) <= 200),
      status TEXT NOT NULL,
      summary TEXT NOT NULL CHECK (length(summary) <= 1000),
      url TEXT CHECK (url IS NULL OR length(url) <= 500),
      event_sequence INTEGER NOT NULL,
      UNIQUE (source_kind, source_id, event_sequence, space_id)
    )
  `;
  yield* sql`
    CREATE INDEX idx_command_center_space_activity_space_time
    ON command_center_space_activity(space_id, occurred_at DESC)
  `;
});
