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
 * The claim and barrier tables turn the decision into a single-statement
 * compare-and-set, so there is nothing left to interleave with.
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
 * stop.
 *
 * What this does NOT close: the send itself is not inside that statement. A stop
 * committed after the claim is granted but before the adapter call returns finds
 * a claim already taken, so the barrier alone cannot stop it — the turn is
 * running by then and has to be interrupted rather than prevented. That case is
 * the reason `fenceSendAgainstLateStop` exists in the reactor: it re-reads the
 * claim after the send and interrupts the turn it just started when the barrier
 * has since risen above it. So these tables remove the ambiguity from the
 * DECISION (was this send authorized?), not from the delivery; the post-send
 * fence, not this migration, is what makes a late stop take effect.
 *
 * Claim ownership is likewise not proof that a superseding request DELIVERED
 * anything. A newer request can take the row and then fail its provider RPC; if
 * the older request's successful RPC were interrupted merely because it lost
 * ownership, the claim would turn one healthy turn into no turn at all.
 * `provider_turn_send_deliveries` is the second phase of the protocol. It keeps
 * one durable row for EVERY request whose `sendTurn` succeeded instead of one
 * overwriteable "superseded" slot on the claim. That distinction is
 * load-bearing for chains: if A, B, and C overlap, B returning must not erase
 * A's delivery before C can reconcile both.
 *
 * Reconciliation is ordered by successful DELIVERY, not current ownership. The
 * highest delivered request sequence survives; every lower delivered request
 * naming a distinct turn is stale. Thus if C owns but fails, B remains the
 * survivor and only A is interrupted. Equal turn ids are shared steers rather
 * than duplicate turns and must never be interrupted.
 *
 * Growth: one claim row per user message ever sent, one delivery row per
 * successful request, and one barrier row per thread. These are bounded by the
 * corresponding durable messages/requests that the surrounding event tables
 * already keep, so none needs independent pruning.
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
    CREATE TABLE IF NOT EXISTS provider_turn_send_deliveries (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      request_sequence INTEGER NOT NULL,
      delivered_turn_id TEXT NOT NULL,
      PRIMARY KEY (thread_id, message_id, request_sequence)
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
