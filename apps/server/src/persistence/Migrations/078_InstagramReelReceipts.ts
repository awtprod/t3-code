import { CommandCenterError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** One receipt is also the immutable approval and one-time action. */
export const createInstagramReelTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE command_center_instagram_reels (
      id TEXT PRIMARY KEY,
      receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(receipt_json) <= 32768),
      state TEXT NOT NULL CHECK(state IN ('requested','approved','creating','processing','ready','publishing','published','uncertain','canceled','error')),
      due_ms INTEGER NOT NULL,
      lease_owner TEXT,
      lease_generation INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER NOT NULL DEFAULT 0,
      UNIQUE(id)
    )
  `;
  yield* sql`CREATE INDEX idx_instagram_reels_due ON command_center_instagram_reels(state, due_ms)`;
});

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The migrator is high-water-mark based. Never strand the reserved PR126 IDs.
  const reserved = yield* sql<{
    readonly id: number;
  }>`SELECT migration_id AS id FROM effect_sql_migrations WHERE migration_id BETWEEN 72 AND 77`;
  if (reserved.length !== 6) {
    return yield* new CommandCenterError({
      reason: "config",
      message:
        "Instagram migration 078 requires recorded migrations 072–077; do not deploy this release ahead of the reserved migration stack.",
    });
  }
  yield* createInstagramReelTable;
});
