import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Durable discussion and proposal state layered onto legacy Command Center items. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE command_center_inbox_state (
      item_id TEXT PRIMARY KEY REFERENCES command_center_items(id) ON DELETE CASCADE,
      space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      lifecycle TEXT NOT NULL DEFAULT 'open'
        CHECK (lifecycle IN ('open', 'snoozed', 'dismissed')),
      snoozed_until TEXT,
      version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
      current_revision_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(space_id, subject_kind, subject_id),
      CHECK (
        (lifecycle = 'snoozed' AND snoozed_until IS NOT NULL)
        OR (lifecycle != 'snoozed' AND snoozed_until IS NULL)
      )
    )
  `;

  yield* sql`
    INSERT INTO command_center_inbox_state (
      item_id, space_id, subject_kind, subject_id, lifecycle,
      version, created_at, updated_at
    )
    SELECT id, space_id, 'command-center-item', id, 'open', 0, created_at, updated_at
    FROM command_center_items
  `;

  yield* sql`
    CREATE TRIGGER command_center_inbox_state_after_item_insert
    AFTER INSERT ON command_center_items
    BEGIN
      INSERT INTO command_center_inbox_state (
        item_id, space_id, subject_kind, subject_id, lifecycle,
        version, created_at, updated_at
      ) VALUES (
        NEW.id, NEW.space_id, 'command-center-item', NEW.id, 'open',
        0, NEW.created_at, NEW.updated_at
      );
    END
  `;

  yield* sql`
    CREATE INDEX idx_command_center_inbox_state_space_updated
    ON command_center_inbox_state(space_id, updated_at DESC, item_id DESC)
  `;

  yield* sql`
    CREATE INDEX idx_command_center_inbox_state_updated
    ON command_center_inbox_state(updated_at DESC, item_id DESC)
  `;

  yield* sql`
    CREATE TRIGGER command_center_inbox_state_after_item_update
    AFTER UPDATE OF status, title, body, priority, due_at, source_json, links_json, metadata_json
    ON command_center_items
    WHEN OLD.status IS NOT NEW.status
      OR OLD.title IS NOT NEW.title
      OR OLD.body IS NOT NEW.body
      OR OLD.priority IS NOT NEW.priority
      OR OLD.due_at IS NOT NEW.due_at
      OR OLD.source_json IS NOT NEW.source_json
      OR OLD.links_json IS NOT NEW.links_json
      OR OLD.metadata_json IS NOT NEW.metadata_json
    BEGIN
      UPDATE command_center_inbox_state
      SET version = version + 1,
        updated_at = CASE
          WHEN NEW.updated_at > updated_at THEN NEW.updated_at
          ELSE updated_at
        END
      WHERE item_id = NEW.id;
    END
  `;

  yield* sql`
    CREATE TABLE command_center_inbox_discussion (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      item_id TEXT NOT NULL REFERENCES command_center_inbox_state(item_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('comment', 'change-request')),
      text TEXT NOT NULL CHECK (length(trim(text)) > 0),
      actor_subject TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by_subject TEXT,
      CHECK (
        (kind = 'comment' AND resolved_at IS NULL AND resolved_by_subject IS NULL)
        OR kind = 'change-request'
      ),
      CHECK (
        (resolved_at IS NULL AND resolved_by_subject IS NULL)
        OR (resolved_at IS NOT NULL AND resolved_by_subject IS NOT NULL)
      )
    )
  `;

  yield* sql`
    CREATE INDEX idx_command_center_inbox_discussion_item_sequence
    ON command_center_inbox_discussion(item_id, sequence DESC)
  `;

  yield* sql`
    CREATE TABLE command_center_inbox_revisions (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      item_id TEXT NOT NULL REFERENCES command_center_inbox_state(item_id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      predecessor_revision_id TEXT REFERENCES command_center_inbox_revisions(id),
      status TEXT NOT NULL CHECK (status IN ('candidate', 'current', 'superseded', 'discarded')),
      source TEXT NOT NULL CHECK (source IN ('agent', 'direct')),
      payload_json TEXT NOT NULL,
      preview_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      actor_subject TEXT NOT NULL,
      created_at TEXT NOT NULL,
      accepted_at TEXT,
      accepted_by_subject TEXT,
      discarded_at TEXT,
      discarded_by_subject TEXT,
      UNIQUE(item_id, revision),
      CHECK (
        (status IN ('current', 'superseded') AND accepted_at IS NOT NULL AND accepted_by_subject IS NOT NULL)
        OR status NOT IN ('current', 'superseded')
      ),
      CHECK (
        (status = 'discarded' AND discarded_at IS NOT NULL AND discarded_by_subject IS NOT NULL)
        OR status != 'discarded'
      )
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX idx_command_center_inbox_revisions_one_current
    ON command_center_inbox_revisions(item_id)
    WHERE status = 'current'
  `;

  yield* sql`
    CREATE INDEX idx_command_center_inbox_revisions_item_sequence
    ON command_center_inbox_revisions(item_id, sequence DESC)
  `;

  yield* sql`
    CREATE TABLE command_center_inbox_mutation_receipts (
      mutation_id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES command_center_inbox_state(item_id) ON DELETE CASCADE,
      space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
      command_kind TEXT NOT NULL,
      actor_subject TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      accepted_at TEXT NOT NULL
    )
  `;
});
