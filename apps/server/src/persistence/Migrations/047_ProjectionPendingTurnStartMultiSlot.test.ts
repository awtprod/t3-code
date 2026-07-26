import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("047_ProjectionPendingTurnStartMultiSlot", (it) => {
  it.effect("allows several pending placeholders per thread, one per request sequence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });

      // Two queued messages, each with its own request sequence. Before this
      // migration the write path could only keep one of these; the index must
      // now permit both to coexist so the second is not lost when the first is
      // consumed.
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at,
          request_sequence, checkpoint_files_json
        ) VALUES (
          'thread-a', NULL, 'msg-1', 'pending', '2026-01-01T00:00:00.000Z', 10, '[]'
        )
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at,
          request_sequence, checkpoint_files_json
        ) VALUES (
          'thread-a', NULL, 'msg-2', 'pending', '2026-01-01T00:00:01.000Z', 11, '[]'
        )
      `;

      const pending = yield* sql<{ readonly messageId: string }>`
        SELECT pending_message_id AS "messageId"
        FROM projection_turns
        WHERE thread_id = 'thread-a' AND turn_id IS NULL
        ORDER BY request_sequence ASC
      `;
      assert.deepStrictEqual(pending, [{ messageId: "msg-1" }, { messageId: "msg-2" }]);
    }),
  );

  it.effect("rejects a duplicate placeholder for the same request sequence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });

      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at,
          request_sequence, checkpoint_files_json
        ) VALUES (
          'thread-b', NULL, 'msg-1', 'pending', '2026-01-01T00:00:00.000Z', 10, '[]'
        )
      `;

      // Replaying the SAME turn-start-requested event must not create a second
      // placeholder for it: the sequence is the placeholder's identity, and the
      // projector relies on that to make its write idempotent under replay.
      const duplicate = yield* Effect.exit(sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at,
          request_sequence, checkpoint_files_json
        ) VALUES (
          'thread-b', NULL, 'msg-1-again', 'pending', '2026-01-01T00:00:02.000Z', 10, '[]'
        )
      `);
      assert.ok(Exit.isFailure(duplicate));
    }),
  );

  it.effect("leaves concrete turn rows unconstrained", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });

      // Concrete turns all carry request_sequence 0 (the column default), so a
      // non-partial index would have collided here on the second turn.
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, request_sequence, checkpoint_files_json
        ) VALUES ('thread-c', 'turn-1', 'running', '2026-01-01T00:00:00.000Z', 0, '[]')
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, request_sequence, checkpoint_files_json
        ) VALUES ('thread-c', 'turn-2', 'running', '2026-01-01T00:00:01.000Z', 0, '[]')
      `;

      const turns = yield* sql<{ readonly turnId: string }>`
        SELECT turn_id AS "turnId" FROM projection_turns
        WHERE thread_id = 'thread-c' AND turn_id IS NOT NULL
        ORDER BY turn_id ASC
      `;
      assert.deepStrictEqual(turns, [{ turnId: "turn-1" }, { turnId: "turn-2" }]);
    }),
  );
});
