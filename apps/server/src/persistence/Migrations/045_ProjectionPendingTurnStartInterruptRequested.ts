import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Records a user interrupt that landed on a pending turn-start placeholder
 * before `turn.started`, when no turn id exists yet to attribute it to. When the
 * placeholder is consumed the turn is born `interrupted`, so auto-resume does
 * not restart stopped work. Defaults to 0 (not interrupted).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN pending_interrupt_requested INTEGER NOT NULL DEFAULT 0
  `;
});
