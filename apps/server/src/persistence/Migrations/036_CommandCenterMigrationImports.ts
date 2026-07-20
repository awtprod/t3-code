import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_import_receipts (
      plan_id TEXT PRIMARY KEY,
      manifest_sha256 TEXT NOT NULL,
      archive_artifact_count INTEGER NOT NULL CHECK (archive_artifact_count >= 0),
      untrusted_memory_count INTEGER NOT NULL CHECK (untrusted_memory_count >= 0),
      disabled_automation_count INTEGER NOT NULL CHECK (disabled_automation_count >= 0),
      target_backup_sha256 TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `;
});
