import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("082_CommandCenterSpaceAgentReplies", (it) => {
  it.effect("keeps wake ledger rows, accepts reply wakes, and dedupes replies by source", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 81 });
      yield* sql`
        INSERT INTO command_center_spaces (id, slug, name, kind, created_at, updated_at)
        VALUES ('acme', 'acme', 'Acme', 'business',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO command_center_space_agent_state (
          space_id, last_wake_reason, wakes_today, activity_cursor, paused, updated_at
        ) VALUES ('acme', 'event', 3, 7, 1, '2026-01-01T00:00:00.000Z')
      `;
      const before = yield* sql`
        UPDATE command_center_space_agent_state SET last_wake_reason = 'reply'
      `.pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(before));

      yield* runMigrations({ toMigrationInclusive: 82 });
      const rows = yield* sql<{
        readonly lastWakeReason: string;
        readonly wakesToday: number;
        readonly activityCursor: number;
        readonly paused: number;
      }>`
        SELECT last_wake_reason AS "lastWakeReason", wakes_today AS "wakesToday",
          activity_cursor AS "activityCursor", paused
        FROM command_center_space_agent_state
      `;
      assert.deepStrictEqual(rows, [
        { lastWakeReason: "event", wakesToday: 3, activityCursor: 7, paused: 1 },
      ]);
      yield* sql`UPDATE command_center_space_agent_state SET last_wake_reason = 'reply'`;
      const invalid = yield* sql`
        UPDATE command_center_space_agent_state SET last_wake_reason = 'other'
      `.pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(invalid));

      for (let attempt = 0; attempt < 2; attempt += 1) {
        yield* sql`
          INSERT INTO command_center_space_agent_replies (
            space_id, source_id, item_id, item_title, kind, body, occurred_at
          ) VALUES (
            'acme', 'source-1', 'item-1', 'Pick a vendor', 'comment', 'Example vendor.',
            '2026-01-02T00:00:00.000Z'
          )
          ON CONFLICT (source_id) DO NOTHING
        `;
      }
      const replies = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM command_center_space_agent_replies
      `;
      assert.strictEqual(replies[0]?.count, 1);
    }),
  );
});
