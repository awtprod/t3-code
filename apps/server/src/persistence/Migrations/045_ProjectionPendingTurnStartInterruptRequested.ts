import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Records that a user interrupt landed on a pending turn-start placeholder
 * before the provider reported `turn.started`.
 *
 * A `thread.turn.interrupt` that arrives before the provider's `turn.started`
 * has been projected cannot name a turn id (the aggregate mints none at
 * `turn.start`; the id only exists once the provider reports it). The decider
 * therefore emits an id-less `thread.turn-interrupt-requested`, which the
 * projection cannot attribute to a turn row — so the still-to-be-born turn was
 * created `running`, and the ensuing session exit would auto-resume the very
 * work the user just stopped. This column lets the id-less interrupt flag the
 * pending-start placeholder (the only row spanning the
 * turn-start-requested -> session-set(running) window); when that placeholder
 * is consumed the turn is born `interrupted` instead of `running`, so the
 * auto-resume path sees a deliberate user interrupt. Defaults to 0 (not
 * interrupted) for every existing and freshly-inserted pending row.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN pending_interrupt_requested INTEGER NOT NULL DEFAULT 0
  `;
});
