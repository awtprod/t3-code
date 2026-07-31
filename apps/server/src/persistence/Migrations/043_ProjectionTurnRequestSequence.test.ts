import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("043_ProjectionTurnRequestSequence", (it) => {
  it.effect("adds request_sequence to projection_turns defaulting to 0", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 43 });

      // Row written before the column existed (simulated via NULL-eligible insert)
      // still resolves to the 0 default, which is strictly below any real event
      // sequence and therefore never spuriously supersedes a live turn-start.
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json
        ) VALUES (
          'thread-a', NULL, 'message-a', 'pending', '2026-01-01T00:00:00.000Z', '[]'
        )
      `;
      const defaulted = yield* sql<{ readonly requestSequence: number }>`
        SELECT request_sequence AS "requestSequence"
        FROM projection_turns WHERE thread_id = 'thread-a'
      `;
      assert.deepStrictEqual(defaulted, [{ requestSequence: 0 }]);

      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at,
          request_sequence, checkpoint_files_json
        ) VALUES (
          'thread-b', NULL, 'message-b', 'pending', '2026-01-01T00:00:01.000Z', 7, '[]'
        )
      `;
      const explicit = yield* sql<{ readonly requestSequence: number }>`
        SELECT request_sequence AS "requestSequence"
        FROM projection_turns WHERE thread_id = 'thread-b'
      `;
      assert.deepStrictEqual(explicit, [{ requestSequence: 7 }]);
    }),
  );
});
