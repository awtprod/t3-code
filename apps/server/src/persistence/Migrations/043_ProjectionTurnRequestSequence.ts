import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Adds a monotonic `request_sequence` to pending turn-start placeholder rows so
 * the supersession guard can order re-requests that tie on `requested_at`.
 * Default 0 sits below any real event sequence, so existing rows never
 * spuriously supersede a live turn-start.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN request_sequence INTEGER NOT NULL DEFAULT 0 CHECK (request_sequence >= 0)
  `;
});
