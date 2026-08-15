import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_turn_usage (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      project_id TEXT,
      provider_instance_id TEXT NOT NULL,
      provider_driver TEXT NOT NULL,
      model TEXT,
      workload TEXT NOT NULL,
      component_kind TEXT NOT NULL,
      component_id TEXT NOT NULL,
      component_name TEXT,
      quality TEXT NOT NULL,
      uncached_input_tokens INTEGER,
      cache_read_input_tokens INTEGER,
      cache_write_input_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_output_tokens INTEGER,
      context_used_tokens INTEGER,
      context_limit_tokens INTEGER,
      duration_ms INTEGER,
      tool_uses INTEGER,
      cost_micro_usd INTEGER,
      cost_kind TEXT NOT NULL,
      cache_savings_micro_usd INTEGER,
      rate_provenance TEXT,
      completed_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, turn_id, component_kind, component_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turn_usage_completed
    ON projection_turn_usage(completed_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turn_usage_project_completed
    ON projection_turn_usage(project_id, completed_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turn_usage_provider_completed
    ON projection_turn_usage(provider_instance_id, completed_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turn_usage_model_completed
    ON projection_turn_usage(model, completed_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turn_usage_workload_component_completed
    ON projection_turn_usage(workload, component_kind, completed_at)
  `;

  // Best-effort context-only backfill. Old activities cannot recover input
  // categories or price, so every inserted row remains explicitly partial.
  yield* sql`
    INSERT OR IGNORE INTO projection_turn_usage (
      thread_id, turn_id, project_id, provider_instance_id, provider_driver,
      model, workload, component_kind, component_id, component_name, quality,
      uncached_input_tokens, cache_read_input_tokens, cache_write_input_tokens,
      output_tokens, reasoning_output_tokens, context_used_tokens,
      context_limit_tokens, duration_ms, tool_uses, cost_micro_usd, cost_kind,
      cache_savings_micro_usd, rate_provenance, completed_at
    )
    SELECT
      a.thread_id,
      COALESCE(a.turn_id, 'backfill:' || a.activity_id),
      t.project_id,
      COALESCE(s.provider_instance_id, s.provider_name, 'unknown'),
      COALESCE(s.provider_name, 'unknown'),
      NULL,
      'interactive',
      'main',
      'backfill:' || a.activity_id,
      'Historical context snapshot',
      'partial',
      NULL, NULL, NULL, NULL, NULL,
      json_extract(a.payload_json, '$.usedTokens'),
      json_extract(a.payload_json, '$.maxTokens'),
      json_extract(a.payload_json, '$.durationMs'),
      json_extract(a.payload_json, '$.toolUses'),
      NULL, 'unavailable', NULL, 'context-activity-backfill', a.created_at
    FROM projection_thread_activities a
    JOIN projection_threads t ON t.thread_id = a.thread_id
    LEFT JOIN projection_thread_sessions s ON s.thread_id = a.thread_id
    WHERE a.kind = 'context-window.updated'
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_turn_usage_delete_thread
    AFTER DELETE ON projection_threads
    BEGIN
      DELETE FROM projection_turn_usage WHERE thread_id = OLD.thread_id;
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_turn_usage_delete_project
    AFTER DELETE ON projection_projects
    BEGIN
      DELETE FROM projection_turn_usage WHERE project_id = OLD.project_id;
    END
  `;
});
