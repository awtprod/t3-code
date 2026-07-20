import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Command Center owns a deliberately small set of canonical records. Provider
 * conversations and repository work continue to live in the upstream
 * orchestration tables; these records link the cross-project OS layer to them.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_spaces (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL DEFAULT 'local-user',
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('personal', 'business', 'system')),
      instructions TEXT,
      policy_json TEXT NOT NULL DEFAULT '{}',
      model_defaults_json TEXT NOT NULL DEFAULT '{}',
      connections_json TEXT NOT NULL DEFAULT '[]',
      repositories_json TEXT NOT NULL DEFAULT '[]',
      aliases_json TEXT NOT NULL DEFAULT '[]',
      lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'archived')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_items (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL DEFAULT 'local-user',
      space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
      kind TEXT NOT NULL CHECK (kind IN ('idea', 'task', 'decision', 'alert', 'approval')),
      status TEXT NOT NULL CHECK (
        status IN ('captured', 'ready', 'in_progress', 'waiting', 'review', 'done', 'canceled')
      ),
      title TEXT NOT NULL,
      body TEXT,
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
      due_at TEXT,
      source_json TEXT NOT NULL DEFAULT '{}',
      links_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_command_center_items_space_status
    ON command_center_items(space_id, status, priority DESC, updated_at DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_runs (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL DEFAULT 'local-user',
      command_id TEXT NOT NULL UNIQUE,
      parent_run_id TEXT REFERENCES command_center_runs(id),
      space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
      project_id TEXT,
      thread_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('agent', 'connector', 'automation')),
      state TEXT NOT NULL CHECK (
        state IN ('queued', 'running', 'waiting_approval', 'waiting', 'succeeded', 'failed', 'canceled')
      ),
      route_json TEXT NOT NULL,
      input_json TEXT NOT NULL,
      result_json TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_command_center_runs_space_state
    ON command_center_runs(space_id, state, started_at DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_automations (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL DEFAULT 'local-user',
      space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      commit_sha TEXT NOT NULL,
      definition_digest TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      last_loaded_at TEXT NOT NULL,
      UNIQUE(id, definition_digest)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_approvals (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL DEFAULT 'local-user',
      item_id TEXT REFERENCES command_center_items(id),
      run_id TEXT REFERENCES command_center_runs(id),
      action_kind TEXT NOT NULL,
      risk TEXT NOT NULL CHECK (risk IN ('low', 'reversible', 'approval-required', 'blocked')),
      payload_digest TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('requested', 'approved', 'declined', 'expired', 'canceled')),
      idempotency_key TEXT NOT NULL UNIQUE,
      requested_at TEXT NOT NULL,
      expires_at TEXT,
      decided_at TEXT,
      decision_note TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_command_center_approvals_status
    ON command_center_approvals(status, requested_at DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_artifacts (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL DEFAULT 'local-user',
      space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
      run_id TEXT REFERENCES command_center_runs(id),
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      uri TEXT,
      content_digest TEXT NOT NULL,
      provenance_json TEXT NOT NULL DEFAULT '{}',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_connections (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL DEFAULT 'local-user',
      space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
      kind TEXT NOT NULL,
      account_label TEXT NOT NULL,
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      health TEXT NOT NULL CHECK (health IN ('connected', 'degraded', 'disconnected')),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      checked_at TEXT,
      UNIQUE(space_id, kind, account_label)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_memories (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL DEFAULT 'local-user',
      space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
      repository_ref TEXT,
      scope TEXT NOT NULL CHECK (scope IN ('global', 'space', 'repository')),
      kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'decision', 'procedure', 'archive')),
      content TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('candidate', 'approved', 'rejected', 'expired', 'archive')),
      confidence REAL NOT NULL DEFAULT 1.0,
      provenance_json TEXT NOT NULL,
      contradiction_of TEXT REFERENCES command_center_memories(id),
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_command_center_memories_scope
    ON command_center_memories(space_id, repository_ref, status, updated_at DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_memory_candidates (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL DEFAULT 'local-user',
      space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
      repository_ref TEXT,
      proposed_kind TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL NOT NULL,
      provenance_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'promoted', 'rejected')),
      proposed_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_audit_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id TEXT NOT NULL DEFAULT 'local-user',
      event_id TEXT NOT NULL UNIQUE,
      previous_hash TEXT,
      event_hash TEXT NOT NULL UNIQUE,
      actor_kind TEXT NOT NULL,
      action TEXT NOT NULL,
      space_id TEXT REFERENCES command_center_spaces(id),
      run_id TEXT REFERENCES command_center_runs(id),
      payload_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS command_center_audit_events_no_update
    BEFORE UPDATE ON command_center_audit_events
    BEGIN
      SELECT RAISE(ABORT, 'command_center_audit_events is append-only');
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS command_center_audit_events_no_delete
    BEFORE DELETE ON command_center_audit_events
    BEGIN
      SELECT RAISE(ABORT, 'command_center_audit_events is append-only');
    END
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_command_receipts (
      command_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL DEFAULT 'local-user',
      request_digest TEXT NOT NULL,
      response_json TEXT NOT NULL,
      accepted_at TEXT NOT NULL
    )
  `;
});
