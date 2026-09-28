import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE command_center_repository_check_signals (
      repository_key TEXT NOT NULL,
      space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
      repository_id TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      check_name TEXT NOT NULL,
      bucket TEXT NOT NULL,
      completed_at TEXT,
      item_id TEXT REFERENCES command_center_items(id),
      observed_at TEXT NOT NULL,
      PRIMARY KEY (repository_key, pr_number, head_sha, check_name)
    )
  `;
  yield* sql`
    CREATE INDEX idx_command_center_repository_check_signals_pr
    ON command_center_repository_check_signals(repository_key, pr_number)
  `;
  yield* sql`
    CREATE TABLE command_center_repository_check_cursors (
      repository_key TEXT PRIMARY KEY,
      next_page INTEGER NOT NULL DEFAULT 1 CHECK (next_page BETWEEN 1 AND 20),
      updated_at TEXT NOT NULL
    )
  `;
});
