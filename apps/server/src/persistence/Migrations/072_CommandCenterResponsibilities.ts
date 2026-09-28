import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable operational state for Responsibilities. Automation definitions stay
 * in the committed configuration projection; these tables contain only live
 * controls and observations derived from running those definitions.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE command_center_automation_executions
    ADD COLUMN work_identity TEXT
  `;

  yield* sql`
    UPDATE command_center_automation_executions
    SET work_identity = 'responsibility:v1:' || space_id || ':' || automation_id
    WHERE work_identity IS NULL
  `;

  yield* sql`
    CREATE TABLE command_center_responsibility_controls (
      space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
      automation_id TEXT NOT NULL REFERENCES command_center_automations(id) ON DELETE CASCADE,
      paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
      actor TEXT NOT NULL,
      reason TEXT,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      changed_at TEXT NOT NULL,
      PRIMARY KEY(space_id, automation_id)
    )
  `;

  yield* sql`
    CREATE TABLE command_center_responsibility_active_slots (
      automation_id TEXT PRIMARY KEY
        REFERENCES command_center_automations(id) ON DELETE CASCADE,
      space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
      work_identity TEXT NOT NULL,
      execution_id TEXT NOT NULL UNIQUE
        REFERENCES command_center_automation_executions(id) ON DELETE CASCADE,
      claimed_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE command_center_responsibility_admissions (
      idempotency_key TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL
        REFERENCES command_center_automation_executions(id) ON DELETE CASCADE,
      automation_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      config_commit_sha TEXT NOT NULL,
      definition_digest TEXT NOT NULL,
      input_json TEXT NOT NULL,
      accepted_at TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO command_center_responsibility_admissions (
      idempotency_key, execution_id, automation_id, space_id, config_commit_sha,
      definition_digest, input_json, accepted_at
    )
    SELECT idempotency_key, id, automation_id, space_id, config_commit_sha,
      definition_digest, input_json, created_at
    FROM command_center_automation_executions
  `;

  // Preserve one recoverable pre-migration execution per Responsibility. Any
  // older duplicate remains visible in history but cannot create another slot.
  yield* sql`
    INSERT INTO command_center_responsibility_active_slots (
      automation_id, space_id, work_identity, execution_id, claimed_at
    )
    SELECT execution.automation_id, execution.space_id, execution.work_identity,
      execution.id, execution.created_at
    FROM command_center_automation_executions execution
    WHERE execution.state NOT IN ('succeeded', 'failed', 'canceled')
      AND NOT EXISTS (
        SELECT 1
        FROM command_center_automation_executions newer
        WHERE newer.automation_id = execution.automation_id
          AND newer.state NOT IN ('succeeded', 'failed', 'canceled')
          AND (newer.created_at > execution.created_at
            OR (newer.created_at = execution.created_at AND newer.id > execution.id))
      )
  `;

  yield* sql`
    CREATE TABLE command_center_responsibility_status (
      space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
      automation_id TEXT NOT NULL REFERENCES command_center_automations(id) ON DELETE CASCADE,
      last_admission_attempt_at TEXT,
      last_admission_status TEXT CHECK (
        last_admission_status IN ('admitted', 'paused', 'blocked')
      ),
      last_checked_at TEXT,
      last_check_status TEXT CHECK (
        last_check_status IN ('ok', 'transient-error', 'blocked', 'paused')
      ),
      last_successful_at TEXT,
      last_attempted_execution_id TEXT
        REFERENCES command_center_automation_executions(id) ON DELETE SET NULL,
      current_execution_id TEXT
        REFERENCES command_center_automation_executions(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(space_id, automation_id)
    )
  `;

  yield* sql`
    CREATE INDEX idx_command_center_responsibility_status_health
    ON command_center_responsibility_status(space_id, last_check_status, updated_at DESC)
  `;

  yield* sql`
    CREATE TABLE command_center_responsibility_incidents (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
      automation_id TEXT NOT NULL REFERENCES command_center_automations(id) ON DELETE CASCADE,
      canonical_code TEXT NOT NULL,
      resource TEXT NOT NULL,
      subject TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('transient', 'blocked', 'resolved')),
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
      latest_execution_id TEXT
        REFERENCES command_center_automation_executions(id) ON DELETE SET NULL,
      retry_at TEXT,
      recovery_instruction TEXT NOT NULL,
      display_error TEXT NOT NULL,
      resolved_at TEXT,
      UNIQUE(space_id, automation_id, canonical_code, resource, subject)
    )
  `;

  yield* sql`
    CREATE INDEX idx_command_center_responsibility_incidents_open
    ON command_center_responsibility_incidents(
      space_id, automation_id, state, last_seen_at DESC
    )
  `;
});
