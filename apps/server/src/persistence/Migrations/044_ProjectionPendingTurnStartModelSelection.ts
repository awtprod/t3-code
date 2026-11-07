import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Persists the model selection of a pending turn-start placeholder row. A
 * resumed still-pending steer must use its own `thread.turn-start-requested`
 * model, not the provider session binding (which describes the older sent turn).
 * NULL means the thread default, as for existing and default-model rows.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN model_selection TEXT
  `;
});
