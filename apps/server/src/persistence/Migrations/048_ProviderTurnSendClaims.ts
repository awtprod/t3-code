import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Durable claim + cancel barrier closing the reactor's check-to-send race: a
 * `thread.turn-interrupt-requested` or auto-resume re-issue committed between
 * the event-log read and the adapter call must not send stopped work or drive
 * the same prompt twice. The decision becomes a single-statement compare-and-set.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Keyed by (thread_id, message_id): the identity of the work, not the request.
  // The HIGHEST request_sequence takes the row; first-wins would lock out the
  // higher-sequence session-exit auto-resume this table exists to make safe.
  // request_sequence also tells a loser "superseded" apart from "canceled".
  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_turn_send_claims (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      request_sequence INTEGER NOT NULL,
      claimed_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, message_id)
    )
  `;

  // One row per concrete turn whose `sendTurn` succeeded; claim ownership is no
  // proof of delivery. Order by (request_sequence, delivery_id): the last
  // unreconciled row survives, earlier rows naming a distinct turn are stale,
  // and equal turn ids are shared steers that must never be interrupted.

  // `reconciled_at` retires stale rows once their interrupt succeeds or a widened
  // stop is dispatched. `teardown_dispatched_at` records every delivery that stop
  // covered, even the survivor, so redrive can retire it without re-stopping a
  // destroyed session.
  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_turn_send_deliveries (
      delivery_id INTEGER PRIMARY KEY,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      request_sequence INTEGER NOT NULL,
      delivered_turn_id TEXT NOT NULL,
      reconciled_at TEXT,
      teardown_dispatched_at TEXT,
      UNIQUE (thread_id, message_id, request_sequence, delivered_turn_id)
    )
  `;

  // One row per thread holding the highest interrupt sequence. A claim write is
  // gated on `canceled_through_sequence >= request_sequence` in the same
  // statement, so SQLite serializes it with the barrier. A stop landing after
  // the claim is granted is not closed here; `fenceSendAgainstLateStop` does it.
  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_turn_send_barriers (
      thread_id TEXT PRIMARY KEY,
      canceled_through_sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
