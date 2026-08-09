import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Dedicated, feature-gated sales storage. Generic Command Center Items remain unchanged. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE command_center_spaces ADD COLUMN features_json TEXT NOT NULL DEFAULT '{}'`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_sales_prospects (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL DEFAULT 'local-user',
      space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
      stage TEXT NOT NULL CHECK (stage IN (
        'researched', 'qualified', 'drafted', 'contacted', 'replied',
        'call_booked', 'proposal_sent', 'won', 'nurture', 'lost'
      )),
      channel_id TEXT,
      channel_name TEXT NOT NULL,
      channel_url TEXT NOT NULL,
      normalized_channel_key TEXT NOT NULL,
      contact_name TEXT,
      contact_email TEXT,
      contact_provenance_json TEXT NOT NULL,
      subscriber_count INTEGER CHECK (subscriber_count IS NULL OR subscriber_count >= 0),
      language TEXT NOT NULL,
      niche TEXT NOT NULL,
      fit_json TEXT NOT NULL,
      next_action TEXT,
      next_action_at TEXT,
      opportunity_cents INTEGER NOT NULL DEFAULT 30000 CHECK (opportunity_cents >= 0),
      gmail_connection_id TEXT,
      gmail_draft_id TEXT,
      gmail_thread_id TEXT,
      gmail_message_id TEXT,
      provenance_kind TEXT NOT NULL CHECK (provenance_kind IN ('user', 'agent', 'automation', 'import')),
      provenance_ref TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(space_id, normalized_channel_key)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_command_center_sales_prospects_space_stage
    ON command_center_sales_prospects(space_id, stage, updated_at DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_command_center_sales_prospects_next_action
    ON command_center_sales_prospects(space_id, next_action_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_sales_activities (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      prospect_id TEXT NOT NULL REFERENCES command_center_sales_prospects(id),
      space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
      kind TEXT NOT NULL CHECK (kind IN (
        'proposed', 'updated', 'stage_changed', 'outreach_prepared',
        'draft_approved', 'draft_declined', 'gmail_draft_created',
        'gmail_draft_reconciled', 'sent_reconciled', 'reply_reconciled',
        'follow_up_prepared'
      )),
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'agent', 'automation', 'connector', 'system')),
      payload_json TEXT NOT NULL DEFAULT '{}',
      occurred_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_command_center_sales_activities_prospect
    ON command_center_sales_activities(prospect_id, sequence DESC)
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS command_center_sales_activities_no_update
    BEFORE UPDATE ON command_center_sales_activities
    BEGIN
      SELECT RAISE(ABORT, 'command_center_sales_activities is append-only');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS command_center_sales_activities_no_delete
    BEFORE DELETE ON command_center_sales_activities
    BEGIN
      SELECT RAISE(ABORT, 'command_center_sales_activities is append-only');
    END
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_sales_draft_requests (
      id TEXT PRIMARY KEY,
      prospect_id TEXT NOT NULL REFERENCES command_center_sales_prospects(id),
      space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
      connection_id TEXT NOT NULL,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('requested', 'approved', 'declined', 'creating', 'created', 'failed')),
      gmail_draft_id TEXT,
      requested_at TEXT NOT NULL,
      decided_at TEXT,
      created_at TEXT,
      failure TEXT,
      UNIQUE(space_id, payload_digest)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_command_center_sales_draft_requests_status
    ON command_center_sales_draft_requests(space_id, status, requested_at DESC)
  `;
});
