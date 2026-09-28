import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** In-app digest preferences and immutable per-recipient daily snapshots. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE command_center_digest_preferences (
      recipient_subject TEXT PRIMARY KEY,
      timezone TEXT NOT NULL,
      quiet_start TEXT,
      quiet_end TEXT,
      version INTEGER NOT NULL CHECK (version >= 1),
      updated_at TEXT NOT NULL,
      CHECK ((quiet_start IS NULL AND quiet_end IS NULL)
        OR (quiet_start IS NOT NULL AND quiet_end IS NOT NULL AND quiet_start != quiet_end))
    )
  `;
  yield* sql`
    CREATE TABLE command_center_digest_snapshots (
      id TEXT PRIMARY KEY,
      recipient_subject TEXT NOT NULL,
      local_date TEXT NOT NULL,
      timezone TEXT NOT NULL,
      period_start_at TEXT NOT NULL,
      period_end_at TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      items_json TEXT NOT NULL,
      supersedes_id TEXT REFERENCES command_center_digest_snapshots(id),
      viewed_at TEXT,
      UNIQUE(recipient_subject, period_start_at, period_end_at, content_digest)
    )
  `;
  yield* sql`
    CREATE INDEX idx_command_center_digest_recipient_period
    ON command_center_digest_snapshots(recipient_subject, period_start_at DESC, generated_at DESC, id DESC)
  `;
  yield* sql`
    CREATE TRIGGER command_center_digest_snapshot_immutable
    BEFORE UPDATE OF recipient_subject, local_date, timezone, period_start_at, period_end_at,
      generated_at, content_digest, items_json, supersedes_id
    ON command_center_digest_snapshots
    BEGIN SELECT RAISE(ABORT, 'Digest snapshot content is immutable'); END
  `;
});
