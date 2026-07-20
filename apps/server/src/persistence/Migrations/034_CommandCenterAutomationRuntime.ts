import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable execution state for committed Command Center automations. The
 * definition snapshot is copied into each execution so a later config sync
 * cannot silently change work that is already in progress.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_automation_executions (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
      config_commit_sha TEXT NOT NULL,
      definition_digest TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      input_json TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL CHECK (
        state IN (
          'queued', 'running', 'waiting_retry', 'waiting_delay',
          'waiting_external', 'waiting_approval', 'succeeded', 'failed', 'canceled'
        )
      ),
      lease_owner TEXT,
      lease_token TEXT,
      lease_generation INTEGER NOT NULL DEFAULT 0,
      lease_acquired_at TEXT,
      lease_expires_at TEXT,
      output_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      UNIQUE(id, config_commit_sha, definition_digest)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_command_center_automation_executions_ready
    ON command_center_automation_executions(state, lease_expires_at, updated_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_command_center_automation_executions_automation
    ON command_center_automation_executions(automation_id, created_at DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_automation_node_checkpoints (
      execution_id TEXT NOT NULL
        REFERENCES command_center_automation_executions(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      node_kind TEXT NOT NULL,
      state TEXT NOT NULL CHECK (
        state IN (
          'pending', 'running', 'waiting_retry', 'waiting_delay',
          'waiting_external', 'waiting_approval', 'succeeded', 'failed', 'skipped'
        )
      ),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
      executor_idempotency_key TEXT,
      lease_token TEXT,
      waiting_until TEXT,
      resume_key TEXT,
      resolution_key TEXT,
      input_json TEXT,
      output_json TEXT,
      error TEXT,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(execution_id, node_id),
      UNIQUE(executor_idempotency_key)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_command_center_automation_checkpoints_waiting
    ON command_center_automation_node_checkpoints(state, waiting_until, updated_at)
  `;
});
