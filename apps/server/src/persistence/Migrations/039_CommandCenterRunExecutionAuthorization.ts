import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A routed Run is durable as soon as it is admitted, but it is not executable
 * until its route receipt has been rendered (or a trusted server-side caller
 * explicitly authorizes it). Keeping this as a separate nullable timestamp
 * preserves the queued Run state without letting restart recovery bypass that
 * acknowledgement boundary.
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
