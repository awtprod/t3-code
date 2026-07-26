import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("047_ProjectionPendingTurnStartMultiSlot", (it) => {
  // Two queued messages, each with its own request sequence. Coexistence alone
  // proves nothing about THIS migration — at 046 there is no index at all, so
  // an insert-both-and-assert-both test passes identically with the migration
  // absent. What 047 actually establishes is that `request_sequence` becomes
  // the placeholder's identity, so the discriminating assertion is the pair:
  // distinct sequences coexist AND a duplicate sequence is rejected. Only the
  // second half fails at 046, which is why both live here.
  it.effect("allows several pending placeholders per thread, one per request sequence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });

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

  it.effect("upgrades a database already populated by the pre-047 write path", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Stop one short of 047 so the rows below are written exactly as the old
      // single-slot write path left them, then run 047 over that live data.
      // Creating a UNIQUE index is not an unconditional no-op: it fails outright
      // if the existing rows already violate it, which would abort startup on a
      // real user's database rather than on a fresh test one.
      yield* runMigrations({ toMigrationInclusive: 46 });

      // The old path kept at most one placeholder per thread but said nothing
      // about `request_sequence`, and rows written before migration 043 carry
      // the column default of 0. Two threads at 0 must not collide, since the
      // index keys on (thread_id, request_sequence).
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at,
          request_sequence, checkpoint_files_json
        ) VALUES (
          'thread-legacy-a', NULL, 'msg-legacy-a', 'pending', '2026-01-01T00:00:00.000Z', 0, '[]'
        )
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at,
          request_sequence, checkpoint_files_json
        ) VALUES (
          'thread-legacy-b', NULL, 'msg-legacy-b', 'pending', '2026-01-01T00:00:01.000Z', 0, '[]'
        )
      `;
      // A concrete turn in one of those threads, also at the default sequence:
      // the partial predicate must exclude it, or it would collide with that
      // thread's placeholder.
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, request_sequence, checkpoint_files_json
        ) VALUES ('thread-legacy-a', 'turn-legacy', 'running', '2026-01-01T00:00:02.000Z', 0, '[]')
      `;

      yield* runMigrations({ toMigrationInclusive: 47 });

      // Nothing was dropped by the upgrade, and the new index is live on the
      // upgraded database rather than only on freshly created ones.
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count" FROM projection_turns
        WHERE thread_id IN ('thread-legacy-a', 'thread-legacy-b')
      `;
      assert.deepStrictEqual(rows, [{ count: 3 }]);

      const duplicate = yield* Effect.exit(sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at,
          request_sequence, checkpoint_files_json
        ) VALUES (
          'thread-legacy-a', NULL, 'msg-legacy-dup', 'pending', '2026-01-01T00:00:03.000Z', 0, '[]'
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
