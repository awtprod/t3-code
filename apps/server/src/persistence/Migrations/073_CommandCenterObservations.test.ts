import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import baseMigration from "./033_CommandCenterCore.ts";
import observationMigration from "./073_CommandCenterObservations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const migrate = Effect.gen(function* () {
  yield* baseMigration;
  yield* observationMigration;
});

const addSpace = (sql: SqlClient.SqlClient, id: string) =>
  sql`
    INSERT INTO command_center_spaces (
      id, slug, name, kind, instructions, policy_json, model_defaults_json,
      connections_json, repositories_json, aliases_json, lifecycle, created_at, updated_at
    ) VALUES (
      ${id}, ${id}, ${id}, 'personal', '', '{}', '{}', '[]', '[]', '[]',
      'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    )
  `;

const addObservation = (sql: SqlClient.SqlClient, spaceId: string, id: string) =>
  sql`
    INSERT INTO command_center_observations (
      space_id, id, subject_id, content_kind, source_identity, source_revision,
      source_payload_digest, metric_kind, metric_unit, metric_definition,
      collection_method, created_at
    ) VALUES (
      ${spaceId}, ${id}, 'channel-a', 'channel', 'source-a', '1', 'digest-a',
      'channel-subscribers', 'count', 'Synthetic subscriber count', 'manual',
      '2026-01-01T00:00:00.000Z'
    )
  `;

layer("073_CommandCenterObservations", (it) => {
  it.effect("composes explicitly with the existing Command Center base migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrate;

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'command_center_observation%'
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map((row) => row.name),
        [
          "command_center_observation_mutations",
          "command_center_observation_revisions",
          "command_center_observations",
        ],
      );
    }),
  );

  it.effect("isolates source identities by Space and rejects reuse within one Space", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrate;
      yield* addSpace(sql, "space-a");
      yield* addSpace(sql, "space-b");
      yield* addObservation(sql, "space-a", "observation-a");
      yield* addObservation(sql, "space-b", "observation-b");

      const duplicate = yield* Effect.exit(addObservation(sql, "space-a", "observation-c"));
      assert.strictEqual(duplicate._tag, "Failure");
    }),
  );

  it.effect("makes revisions and source provenance immutable", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrate;
      yield* addSpace(sql, "space-immutable");
      yield* addObservation(sql, "space-immutable", "observation-immutable");
      yield* sql`
        INSERT INTO command_center_observation_revisions (
          revision_id, space_id, observation_id, version, revision_kind, revision_reason,
          actor_kind, actor_id, snapshot_json, revision_digest, revised_at, retired
        ) VALUES (
          'revision-immutable', 'space-immutable', 'observation-immutable', 1, 'created', NULL,
          'user', 'server-user', '{}', 'digest-a', '2026-01-01T00:00:00.000Z', 0
        )
      `;

      const revisionUpdate = yield* Effect.exit(sql`
        UPDATE command_center_observation_revisions
        SET snapshot_json = '{"changed":true}'
        WHERE revision_id = 'revision-immutable'
      `);
      const provenanceUpdate = yield* Effect.exit(sql`
        UPDATE command_center_observations
        SET source_revision = '2'
        WHERE space_id = 'space-immutable' AND id = 'observation-immutable'
      `);
      assert.strictEqual(revisionUpdate._tag, "Failure");
      assert.strictEqual(provenanceUpdate._tag, "Failure");
    }),
  );
});
