import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Persists the model selection of a pending turn-start placeholder row.
 *
 * A session-exit auto-resume re-issues the newest user message. When that
 * message is a still-pending steer (a newer turn queued behind an older,
 * already-sent turn), its intended model lives only on its own
 * `thread.turn-start-requested` event — not on the provider session binding,
 * which still describes the older, last-sent turn. Ingestion previously sourced
 * the resume model from that binding, so the steer would resume on the wrong
 * model. Storing the pending start's model here lets the resume prefer the
 * steer's own selection over the stale binding. The column is nullable: absent
 * means the start used the thread default (no override), which existing rows
 * and default-model starts leave NULL.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN model_selection TEXT
  `;
});
