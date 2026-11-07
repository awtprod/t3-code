import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Lets a thread hold several pending turn-start placeholders, one per request.
 * `request_sequence` (migration 043) becomes the placeholder identity so a
 * delayed `turn.started` consumes the oldest row rather than evicting or
 * mis-attributing a later message's row.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Partial: concrete turn rows share this table with `request_sequence` 0, so a
  // total index would collide on a thread's second concrete turn. The predicate
  // matches every placeholder query. Safe on existing data: the old single-slot
  // write path never left two placeholders in one thread.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_turns_pending_request_sequence
    ON projection_turns(thread_id, request_sequence)
    WHERE turn_id IS NULL
      AND state = 'pending'
      AND pending_message_id IS NOT NULL
      AND checkpoint_turn_count IS NULL
  `;
});
