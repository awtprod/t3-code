import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("046_ProjectionThreadSessionGeneration", (it) => {
  it.effect("adds a nullable session_generation column to projection_thread_sessions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 46 });

      // A session row written without a generation (every pre-migration row, and
      // any non-Codex runtime that does not stamp the nonce) resolves to NULL —
      // the sentinel the ingestion guard reads as "no generation correlation".
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, runtime_mode, active_turn_id, updated_at
        ) VALUES (
          'thread-a', 'running', 'codex', 'full-access', 'turn-a', '2026-01-01T00:00:00.000Z'
        )
      `;
      const defaulted = yield* sql<{ readonly sessionGeneration: string | null }>`
        SELECT session_generation AS "sessionGeneration"
        FROM projection_thread_sessions WHERE thread_id = 'thread-a'
      `;
      assert.deepStrictEqual(defaulted, [{ sessionGeneration: null }]);

      // A session that recorded its runtime-start nonce round-trips the text
      // verbatim, so a stale terminal event of a different generation can be told
      // apart from the live runtime even when the provider instance id matches.
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, provider_instance_id,
          session_generation, runtime_mode, active_turn_id, updated_at
        ) VALUES (
          'thread-b', 'running', 'codex', 'codex',
          'gen-42', 'full-access', 'turn-b', '2026-01-01T00:00:01.000Z'
        )
      `;
      const explicit = yield* sql<{ readonly sessionGeneration: string | null }>`
        SELECT session_generation AS "sessionGeneration"
        FROM projection_thread_sessions WHERE thread_id = 'thread-b'
      `;
      assert.deepStrictEqual(explicit, [{ sessionGeneration: "gen-42" }]);
    }),
  );
});
