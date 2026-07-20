import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("039_CommandCenterRunExecutionAuthorization", (it) => {
  it.effect("keeps pre-existing and newly admitted Runs unauthorized", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 38 });
      yield* sql`
        INSERT INTO command_center_spaces (
          id, slug, name, kind, created_at, updated_at
        ) VALUES (
          'space-example', 'space-example', 'Example', 'system',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO command_center_runs (
          id, command_id, space_id, kind, state, route_json, input_json, started_at
        ) VALUES (
          'run-before-migration', 'command-before-migration', 'space-example', 'agent', 'queued',
          '{}', '{}', '2026-01-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 39 });
      yield* sql`
        INSERT INTO command_center_runs (
          id, command_id, space_id, kind, state, route_json, input_json, started_at
        ) VALUES (
          'run-after-migration', 'command-after-migration', 'space-example', 'agent', 'queued',
          '{}', '{}', '2026-01-01T00:00:01.000Z'
        )
      `;

      const rows = yield* sql<{
        readonly id: string;
        readonly executionAuthorizedAt: string | null;
      }>`
        SELECT id, execution_authorized_at AS "executionAuthorizedAt"
        FROM command_center_runs
        ORDER BY id
      `;
      assert.deepStrictEqual(rows, [
        { id: "run-after-migration", executionAuthorizedAt: null },
        { id: "run-before-migration", executionAuthorizedAt: null },
      ]);
    }),
  );
});
