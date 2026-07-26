import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable claim + cancel barrier that closes the reactor's check-to-send race.
 *
 * The provider-command reactor decides whether to send a turn by reading the
 * append-only event log, then calls the provider adapter. Those are two separate
 * operations, so a `thread.turn-interrupt-requested` (or an auto-resume re-issue
 * of the same message) committed between them is invisible to the decision that
 * already passed: the reactor sends work the user stopped, or drives the same
 * prompt twice. Moving the read closer to the send shrank the window but could
 * not remove it — a read followed by a write is not atomic no matter how little
 * sits between them.
 *
 * These two tables turn the decision into a single-statement compare-and-set, so
 * there is nothing left to interleave with.
 *
 * `provider_turn_send_claims` is keyed by (thread_id, message_id), which is the
 * identity of the work rather than of the request. At most one request per
 * message holds the claim at a time, so an original and its auto-resume re-issue
 * contend for one row and only the holder reaches the adapter.
 * `request_sequence` both records WHICH request holds it — a loser can tell "a
 * newer request superseded me" from "I was canceled" and log accordingly — and
 * orders the contenders: the row is taken by the HIGHEST sequence, never a lower
 * one. That direction is load-bearing rather than arbitrary. First-wins would
 * hand the claim to the stale original and permanently lock out the
 * session-exit auto-resume that re-issues the same message at a higher
 * sequence, which is the recovery this table is meant to make safe, not
 * prevent.
 *
 * `provider_turn_send_barriers` is the cancel side, one row per thread holding
 * the highest interrupt sequence seen. A claim write is gated on
 * `canceled_through_sequence >= request_sequence` inside the same statement, so
 * SQLite serializes the two writes: either the barrier lands first and the claim
 * writes zero rows, or the claim lands first and the barrier arrives to find the
 * turn already sent — which is the normal running-turn interrupt path, not a lost
 * stop. The ambiguous middle no longer exists.
 *
 * Growth: one claim row per user message ever sent, the same cardinality as the
 * thread's user messages and far below `orchestration_events`, plus one barrier
 * row per thread. Both are bounded by data the surrounding tables already keep,
 * so neither needs pruning of its own.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_turn_send_claims (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      request_sequence INTEGER NOT NULL,
      claimed_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, message_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_turn_send_barriers (
      thread_id TEXT PRIMARY KEY,
      canceled_through_sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
