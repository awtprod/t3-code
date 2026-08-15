import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "routing_mode")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN routing_mode TEXT NOT NULL DEFAULT 'manual'
    `;
  }
  if (!threadColumns.some((column) => column.name === "efficiency_tier")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN efficiency_tier TEXT
    `;
  }

  const turnColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_turns)
  `;
  if (!turnColumns.some((column) => column.name === "efficiency_decision_json")) {
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN efficiency_decision_json TEXT
    `;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_efficiency_tier
    ON projection_turns(json_extract(efficiency_decision_json, '$.tier'))
    WHERE turn_id IS NOT NULL AND efficiency_decision_json IS NOT NULL
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS internal_generation_usage (
      operation_id TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      model TEXT NOT NULL,
      options_json TEXT,
      duration_ms INTEGER NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_micro_usd INTEGER,
      status TEXT NOT NULL,
      completed_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_internal_generation_usage_completed
    ON internal_generation_usage(completed_at DESC)
  `;
});
