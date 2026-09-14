import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Bounded durable reservations for pending turns proven never sent.
 *
 * A reservation is the restart-recovery attempt. Its command id remains stable
 * until the orchestration receipt is accepted, so a crash on either side of
 * dispatch can replay the command without appending another turn-start event.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_restart_recoveries (
      recovery_id INTEGER PRIMARY KEY,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      original_request_sequence INTEGER NOT NULL,
      root_request_sequence INTEGER NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 2),
      command_id TEXT NOT NULL,
      reserved_at TEXT NOT NULL,
      replacement_request_sequence INTEGER,
      dispatched_at TEXT,
      UNIQUE (thread_id, message_id, original_request_sequence),
      UNIQUE (thread_id, message_id, attempt),
      UNIQUE (command_id)
    )
  `;
});
