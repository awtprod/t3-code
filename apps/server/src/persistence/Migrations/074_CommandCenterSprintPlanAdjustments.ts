import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** An immutable receipt for a separately approved, atomic Inbox-to-plan adjustment. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE command_center_inbox_revisions
    ADD COLUMN proposal_fingerprint TEXT
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_command_center_inbox_revision_fingerprint
    ON command_center_inbox_revisions(item_id, proposal_fingerprint)
    WHERE proposal_fingerprint IS NOT NULL
  `;
  yield* sql`
    CREATE TABLE command_center_sprint_plan_adjustment_approvals (
      mutation_id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
      item_id TEXT NOT NULL REFERENCES command_center_inbox_state(item_id),
      revision_id TEXT NOT NULL REFERENCES command_center_inbox_revisions(id),
      plan_id TEXT NOT NULL REFERENCES command_center_sprint_plans(id),
      before_plan_version INTEGER NOT NULL,
      after_plan_version INTEGER NOT NULL,
      payload_digest TEXT NOT NULL,
      evidence_revision_id TEXT NOT NULL,
      evidence_digest TEXT NOT NULL,
      policy_digest TEXT NOT NULL,
      proposal_fingerprint TEXT NOT NULL UNIQUE,
      approver_subject TEXT NOT NULL,
      diff_json TEXT NOT NULL CHECK (json_valid(diff_json)),
      approved_at TEXT NOT NULL,
      UNIQUE(item_id, revision_id)
    )
  `;
  yield* sql`
    CREATE INDEX idx_command_center_sprint_plan_adjustment_approvals_item
    ON command_center_sprint_plan_adjustment_approvals(item_id, approved_at DESC)
  `;
  yield* sql`
    CREATE TRIGGER command_center_sprint_plan_adjustment_approvals_no_update
    BEFORE UPDATE ON command_center_sprint_plan_adjustment_approvals
    BEGIN
      SELECT RAISE(ABORT, 'command_center_sprint_plan_adjustment_approvals is append-only');
    END
  `;
  yield* sql`
    CREATE TRIGGER command_center_sprint_plan_adjustment_approvals_no_delete
    BEFORE DELETE ON command_center_sprint_plan_adjustment_approvals
    BEGIN
      SELECT RAISE(ABORT, 'command_center_sprint_plan_adjustment_approvals is append-only');
    END
  `;
});
