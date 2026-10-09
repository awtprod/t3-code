import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Projects the optional per-Space always-on agent block. NULL means the Space
 * has no agent configured, which is the default.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE command_center_spaces ADD COLUMN agent_json TEXT`;
});
