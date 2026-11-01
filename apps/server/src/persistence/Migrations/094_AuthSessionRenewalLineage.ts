import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Bearer session renewal lineage. `renewed_from_session_id` links a renewed
// session to its predecessor; `renewed_at` marks it renewed so it mints at most
// one successor. The partial unique index enforces that and serves revocation
// lineage walks.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;

  if (!columns.some((column) => column.name === "renewed_from_session_id")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN renewed_from_session_id TEXT
    `;
  }

  if (!columns.some((column) => column.name === "renewed_at")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN renewed_at TEXT
    `;
  }

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_sessions_renewed_from
    ON auth_sessions(renewed_from_session_id)
    WHERE renewed_from_session_id IS NOT NULL
  `;
});
