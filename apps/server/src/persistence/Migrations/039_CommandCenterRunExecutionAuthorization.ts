import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A routed Run is durable once admitted but not executable until its route
 * receipt is rendered or a trusted server caller authorizes it. This nullable
 * timestamp keeps the queued state without letting restart recovery bypass that.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE command_center_runs
    ADD COLUMN execution_authorized_at TEXT
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_command_center_runs_recovery
    ON command_center_runs(kind, state, execution_authorized_at, started_at, id)
  `;
});
