import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Adds a monotonic request sequence to pending turn-start placeholder rows.
 *
 * The provider-command reactor's supersession guard must decide whether a newer
 * re-request (e.g. a session-exit auto-resume re-issuing the same user message)
 * has replaced the turn-start it is currently processing. Ordering by
 * `requested_at` alone ties when the original and the crash-generated resume
 * land in the same millisecond, letting both drive the turn. `request_sequence`
 * carries the event's globally-monotonic `sequence`, which never ties, so the
 * guard can order re-requests deterministically. Existing rows default to 0,
 * which is strictly below any real event sequence and therefore never
 * spuriously supersedes a live turn-start.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN request_sequence INTEGER NOT NULL DEFAULT 0 CHECK (request_sequence >= 0)
  `;
});
