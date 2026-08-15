import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_ProjectionPendingTurnStartModelSelection", (it) => {
  it.effect("adds a nullable model_selection column to projection_turns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 44 });

      // A pending start written without a model selection (the thread-default
      // case, and every pre-migration row) resolves to NULL — the sentinel the
      // resume path reads as "no steer override, fall back to the binding".
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json
        ) VALUES (
          'thread-a', NULL, 'message-a', 'pending', '2026-01-01T00:00:00.000Z', '[]'
        )
      `;
      const defaulted = yield* sql<{ readonly modelSelection: string | null }>`
        SELECT model_selection AS "modelSelection"
        FROM projection_turns WHERE thread_id = 'thread-a'
      `;
      assert.deepStrictEqual(defaulted, [{ modelSelection: null }]);

      // A pending steer carrying its own model selection round-trips the JSON
      // text verbatim, so the resume can prefer it over the stale binding model.
      // (Literal JSON, not JSON.stringify — the column stores opaque text and the
      // repository layer owns encode/decode via Schema.fromJsonString.)
      const modelSelectionJson = '{"instanceId":"codex_max","model":"gpt-5-codex-max"}';
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at,
          checkpoint_files_json, model_selection
        ) VALUES (
          'thread-b', NULL, 'message-b', 'pending', '2026-01-01T00:00:01.000Z',
          '[]', ${modelSelectionJson}
        )
      `;
      const explicit = yield* sql<{ readonly modelSelection: string | null }>`
        SELECT model_selection AS "modelSelection"
        FROM projection_turns WHERE thread_id = 'thread-b'
      `;
      assert.deepStrictEqual(explicit, [{ modelSelection: modelSelectionJson }]);
    }),
  );
});
