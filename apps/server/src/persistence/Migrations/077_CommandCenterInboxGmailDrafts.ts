import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE command_center_inbox_gmail_drafts (
      mutation_id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES command_center_inbox_state(item_id) ON DELETE CASCADE,
      space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
      revision_id TEXT NOT NULL REFERENCES command_center_inbox_revisions(id),
      expected_version INTEGER NOT NULL,
      actor_subject TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      evidence_digest TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      account_alias TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('approved', 'creating', 'created', 'uncertain')),
      draft_id TEXT,
      message_id TEXT,
      thread_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(item_id, revision_id),
      CHECK ((status = 'created' AND draft_id IS NOT NULL) OR
        (status != 'created' AND draft_id IS NULL))
    )
  `;
  yield* sql`
    CREATE TRIGGER command_center_inbox_gmail_drafts_no_revision_change_during_create
    BEFORE UPDATE OF current_revision_id ON command_center_inbox_state
    WHEN EXISTS (
      SELECT 1 FROM command_center_inbox_gmail_drafts draft
      WHERE draft.item_id = OLD.item_id AND draft.status = 'creating'
    )
    BEGIN SELECT RAISE(ABORT, 'Gmail draft creation is awaiting reconciliation'); END
  `;
  yield* sql`
    CREATE TRIGGER command_center_inbox_gmail_drafts_no_change_request_during_create
    BEFORE INSERT ON command_center_inbox_discussion
    WHEN NEW.kind = 'change-request' AND EXISTS (
      SELECT 1 FROM command_center_inbox_gmail_drafts draft
      WHERE draft.item_id = NEW.item_id AND draft.status = 'creating'
    )
    BEGIN SELECT RAISE(ABORT, 'Gmail draft creation is awaiting reconciliation'); END
  `;
  yield* sql`
    CREATE TRIGGER command_center_inbox_gmail_drafts_no_item_edit_during_create
    BEFORE UPDATE OF status, title, body, priority, due_at, source_json, links_json, metadata_json
    ON command_center_items
    WHEN EXISTS (
      SELECT 1 FROM command_center_inbox_gmail_drafts draft
      WHERE draft.item_id = OLD.id AND draft.status = 'creating'
    )
    BEGIN SELECT RAISE(ABORT, 'Gmail draft creation is awaiting reconciliation'); END
  `;
});
