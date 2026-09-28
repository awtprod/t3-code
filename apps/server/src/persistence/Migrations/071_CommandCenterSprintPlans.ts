import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable, lossless sprint plans. Imports and history are append-only; the plan
 * row points at one immutable source snapshot while current_json evolves under
 * optimistic version checks.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_sprint_plans (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL DEFAULT 'local-user',
      space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
      version INTEGER NOT NULL CHECK (version >= 1),
      source_version INTEGER NOT NULL CHECK (source_version >= 1),
      current_import_id TEXT NOT NULL,
      current_json TEXT NOT NULL CHECK (json_valid(current_json) AND length(current_json) <= 1048576),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(id, space_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_sprint_plan_imports (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES command_center_sprint_plans(id),
      mutation_id TEXT NOT NULL UNIQUE,
      source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
      source_version INTEGER NOT NULL CHECK (source_version >= 1),
      source_updated_at TEXT NOT NULL,
      source_json TEXT NOT NULL CHECK (json_valid(source_json) AND length(source_json) <= 1048576),
      provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json) AND length(provenance_json) <= 65536),
      applied_plan_version INTEGER NOT NULL CHECK (applied_plan_version >= 1),
      imported_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_command_center_sprint_plan_imports_plan
    ON command_center_sprint_plan_imports(plan_id, applied_plan_version DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_sprint_plan_history (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      mutation_id TEXT NOT NULL UNIQUE,
      plan_id TEXT NOT NULL REFERENCES command_center_sprint_plans(id),
      space_id TEXT NOT NULL,
      plan_version INTEGER NOT NULL CHECK (plan_version >= 1),
      operation TEXT NOT NULL CHECK (operation IN ('import', 'task-patch', 'date-resolution')),
      task_id TEXT,
      field TEXT CHECK (field IS NULL OR field IN ('text', 'note', 'day', 'owner', 'done', 'dateResolution')),
      before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
      after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
      reason TEXT,
      actor_json TEXT NOT NULL CHECK (json_valid(actor_json)),
      provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
      request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
      occurred_at TEXT NOT NULL,
      UNIQUE(plan_id, plan_version)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_command_center_sprint_plan_history_page
    ON command_center_sprint_plan_history(plan_id, sequence DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_sprint_plan_mutation_receipts (
      mutation_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES command_center_sprint_plans(id),
      space_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('import', 'task-patch', 'date-resolution')),
      request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
      plan_version INTEGER NOT NULL CHECK (plan_version >= 1),
      occurred_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_sprint_plan_date_resolutions (
      plan_id TEXT NOT NULL REFERENCES command_center_sprint_plans(id),
      task_id TEXT NOT NULL,
      source_conflict_json TEXT NOT NULL CHECK (json_valid(source_conflict_json)),
      resolved_date TEXT NOT NULL,
      reason TEXT NOT NULL,
      actor_json TEXT NOT NULL CHECK (json_valid(actor_json)),
      provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
      plan_version INTEGER NOT NULL CHECK (plan_version >= 1),
      updated_at TEXT NOT NULL,
      PRIMARY KEY(plan_id, task_id)
    )
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS command_center_sprint_plan_imports_no_update
    BEFORE UPDATE ON command_center_sprint_plan_imports
    BEGIN
      SELECT RAISE(ABORT, 'command_center_sprint_plan_imports is append-only');
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS command_center_sprint_plan_imports_no_delete
    BEFORE DELETE ON command_center_sprint_plan_imports
    BEGIN
      SELECT RAISE(ABORT, 'command_center_sprint_plan_imports is append-only');
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS command_center_sprint_plan_history_no_update
    BEFORE UPDATE ON command_center_sprint_plan_history
    BEGIN
      SELECT RAISE(ABORT, 'command_center_sprint_plan_history is append-only');
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS command_center_sprint_plan_history_no_delete
    BEFORE DELETE ON command_center_sprint_plan_history
    BEGIN
      SELECT RAISE(ABORT, 'command_center_sprint_plan_history is append-only');
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS command_center_sprint_plan_mutation_receipts_no_update
    BEFORE UPDATE ON command_center_sprint_plan_mutation_receipts
    BEGIN
      SELECT RAISE(ABORT, 'command_center_sprint_plan_mutation_receipts is append-only');
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS command_center_sprint_plan_mutation_receipts_no_delete
    BEFORE DELETE ON command_center_sprint_plan_mutation_receipts
    BEGIN
      SELECT RAISE(ABORT, 'command_center_sprint_plan_mutation_receipts is append-only');
    END
  `;
});
