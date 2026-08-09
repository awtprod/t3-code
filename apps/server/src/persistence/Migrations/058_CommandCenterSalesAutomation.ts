import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Adds automation lifecycle fields without changing the generic sales foundation. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE command_center_sales_prospects ADD COLUMN score INTEGER NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100)`;
  yield* sql`ALTER TABLE command_center_sales_prospects ADD COLUMN score_version TEXT NOT NULL DEFAULT 'legacy-v1'`;
  yield* sql`ALTER TABLE command_center_sales_prospects ADD COLUMN evaluated_at TEXT`;
  yield* sql`ALTER TABLE command_center_sales_prospects ADD COLUMN source_record_id TEXT`;
  yield* sql`ALTER TABLE command_center_sales_prospects ADD COLUMN source_version TEXT`;
  yield* sql`ALTER TABLE command_center_sales_prospects ADD COLUMN campaign_version TEXT`;
  yield* sql`ALTER TABLE command_center_sales_prospects ADD COLUMN sent_at TEXT`;
  yield* sql`ALTER TABLE command_center_sales_prospects ADD COLUMN replied_at TEXT`;
  yield* sql`ALTER TABLE command_center_sales_prospects ADD COLUMN bounced_at TEXT`;
  yield* sql`ALTER TABLE command_center_sales_prospects ADD COLUMN draft_deleted_at TEXT`;
  yield* sql`ALTER TABLE command_center_sales_prospects ADD COLUMN suppressed_at TEXT`;
  yield* sql`ALTER TABLE command_center_sales_prospects ADD COLUMN next_follow_up_at TEXT`;
  yield* sql`ALTER TABLE command_center_sales_prospects ADD COLUMN day3_sent_at TEXT`;

  yield* sql`ALTER TABLE command_center_sales_draft_requests ADD COLUMN draft_kind TEXT NOT NULL DEFAULT 'initial' CHECK (draft_kind IN ('initial', 'followup_1', 'followup_2'))`;
  yield* sql`ALTER TABLE command_center_sales_draft_requests ADD COLUMN campaign_version TEXT NOT NULL DEFAULT 'legacy-v1'`;
  yield* sql`ALTER TABLE command_center_sales_draft_requests ADD COLUMN campaign_step INTEGER NOT NULL DEFAULT 0 CHECK (campaign_step BETWEEN 0 AND 2)`;
  yield* sql`ALTER TABLE command_center_sales_draft_requests ADD COLUMN idempotency_key TEXT`;
  yield* sql`ALTER TABLE command_center_sales_draft_requests ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '[]'`;
  yield* sql`ALTER TABLE command_center_sales_draft_requests ADD COLUMN gmail_message_id TEXT`;
  yield* sql`ALTER TABLE command_center_sales_draft_requests ADD COLUMN gmail_thread_id TEXT`;
  yield* sql`ALTER TABLE command_center_sales_draft_requests ADD COLUMN sent_at TEXT`;
  yield* sql`ALTER TABLE command_center_sales_draft_requests ADD COLUMN deleted_at TEXT`;
  yield* sql`ALTER TABLE command_center_sales_draft_requests ADD COLUMN daily_bucket TEXT`;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_sales_source_record
    ON command_center_sales_prospects(space_id, source_record_id, source_version)
    WHERE source_record_id IS NOT NULL AND source_version IS NOT NULL
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_sales_draft_idempotency
    ON command_center_sales_draft_requests(space_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_sales_one_active_draft
    ON command_center_sales_draft_requests(prospect_id)
    WHERE status IN ('requested', 'approved', 'creating', 'created')
      AND deleted_at IS NULL AND sent_at IS NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_cc_sales_ranked_eligible
    ON command_center_sales_prospects(space_id, stage, score DESC, evaluated_at DESC, id ASC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_cc_sales_follow_up_due
    ON command_center_sales_prospects(space_id, next_follow_up_at)
    WHERE next_follow_up_at IS NOT NULL
  `;
});
