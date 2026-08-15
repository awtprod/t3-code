import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("045_ProjectionPendingTurnStartInterruptRequested", (it) => {
  it.effect("adds a pending_interrupt_requested column defaulting to 0", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 45 });

      // A pending start inserted without the column resolves to 0 — the sentinel
      // the projection reads as "no user interrupt landed on this pending turn".
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json
        ) VALUES (
          'thread-a', NULL, 'message-a', 'pending', '2026-01-01T00:00:00.000Z', '[]'
        )
      `;
      const defaulted = yield* sql<{ readonly interrupt: number }>`
        SELECT pending_interrupt_requested AS "interrupt"
        FROM projection_turns WHERE thread_id = 'thread-a'
      `;
      assert.deepStrictEqual(defaulted, [{ interrupt: 0 }]);

      // Flipping it to 1 (the id-less-interrupt path) round-trips as 1, so the
      // pending-start consumer can birth the turn `interrupted`.
      yield* sql`
        UPDATE projection_turns
        SET pending_interrupt_requested = 1
        WHERE thread_id = 'thread-a'
      `;
      const flagged = yield* sql<{ readonly interrupt: number }>`
        SELECT pending_interrupt_requested AS "interrupt"
        FROM projection_turns WHERE thread_id = 'thread-a'
      `;
      assert.deepStrictEqual(flagged, [{ interrupt: 1 }]);
    }),
  );
});
