import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Fork-owned efficiency routing side channel for orchestration V2.
 *
 * V2 thread shells and start-turn commands carry no routing fields, and they
 * stay that way (upstream core types are not extended). Routing lives here:
 *
 * - `efficiency_thread_routing`: the composer's per-thread routing mode and
 *   tier, plus a one-shot "retry one tier higher" marker.
 * - `efficiency_run_decisions`: one routing decision per routed V2 run (the
 *   user-facing turn), read by the usage report's tier columns and by sticky
 *   routing.
 * - `efficiency_delegations`: child threads auto-routing forked for a parent.
 *
 * Threads keep their V1 ids through the legacy importer, so V1 routing state
 * (`projection_threads.routing_mode` / `efficiency_tier`, migration 54) is
 * carried over for threads that were not plain manual.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS efficiency_thread_routing (
      thread_id TEXT PRIMARY KEY,
      routing_mode TEXT NOT NULL CHECK (routing_mode IN ('manual', 'auto')),
      efficiency_tier TEXT
        CHECK (efficiency_tier IS NULL OR efficiency_tier IN ('economy', 'balanced', 'quality')),
      pending_retry_of_turn_id TEXT,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS efficiency_run_decisions (
      run_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      decision_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS efficiency_run_decisions_thread_idx
    ON efficiency_run_decisions(thread_id, created_at DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS efficiency_delegations (
      message_id TEXT PRIMARY KEY,
      parent_thread_id TEXT NOT NULL,
      child_thread_id TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      reused_child INTEGER NOT NULL CHECK (reused_child IN (0, 1)),
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS efficiency_delegations_parent_idx
    ON efficiency_delegations(parent_thread_id, created_at DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS efficiency_delegations_child_idx
    ON efficiency_delegations(child_thread_id)
  `;

  const legacyThreadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const hasLegacyRouting =
    legacyThreadColumns.some((column) => column.name === "routing_mode") &&
    legacyThreadColumns.some((column) => column.name === "efficiency_tier");
  if (hasLegacyRouting) {
    yield* sql`
      INSERT OR IGNORE INTO efficiency_thread_routing (
        thread_id, routing_mode, efficiency_tier, pending_retry_of_turn_id, updated_at
      )
      SELECT
        thread_id,
        CASE WHEN routing_mode = 'auto' THEN 'auto' ELSE 'manual' END,
        CASE
          WHEN efficiency_tier IN ('economy', 'balanced', 'quality') THEN efficiency_tier
          ELSE NULL
        END,
        NULL,
        updated_at
      FROM projection_threads
      WHERE routing_mode = 'auto' OR efficiency_tier IS NOT NULL
    `;
  }
});
