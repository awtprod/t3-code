import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Lets a thread hold more than one pending turn-start placeholder at a time.
 *
 * Until now the pending placeholder was a single slot per thread: the write path
 * deleted every pending row for the thread and inserted one. Queueing a second
 * message while the first had not yet reported `turn.started` therefore evicted
 * the first one's row, and the damage was double-sided. The delayed
 * `turn.started` for the FIRST turn consumed whatever row it found — the
 * SECOND message's row — so that turn was born carrying the wrong message id,
 * model selection, source plan, and interrupt flag; and consuming it deleted the
 * row, so the second message lost the only record that it was ever requested.
 * Reconciliation could not surface it either, because reconciliation looks for a
 * surviving pending row.
 *
 * `request_sequence` (migration 043) already carries the originating event's
 * globally-monotonic sequence, which is unique per request and orders them
 * without ties. This index makes it the placeholder's identity, so placeholders
 * accumulate one per request and are consumed individually, oldest first, in the
 * same order the provider was asked to run them.
 *
 * The index is partial so it constrains ONLY placeholder rows. Concrete turn
 * rows share this table and all carry `request_sequence` 0 (the column default);
 * a total index would collide on the second concrete turn in any thread. The
 * predicate matches the one every placeholder query already uses.
 *
 * Safe on existing data: the old write path allowed at most one placeholder per
 * thread, so no thread can already hold two rows that would collide here.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_turns_pending_request_sequence
    ON projection_turns(thread_id, request_sequence)
    WHERE turn_id IS NULL
      AND state = 'pending'
      AND pending_message_id IS NOT NULL
      AND checkpoint_turn_count IS NULL
  `;
});
