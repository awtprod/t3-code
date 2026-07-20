import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Durable minute cursors let schedule admission catch up safely after restart. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_automation_schedule_cursors (
      automation_id TEXT PRIMARY KEY,
      last_checked_minute TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
