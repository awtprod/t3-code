import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("036_CommandCenterMigrationImports", (it) => {
  it.effect("creates durable idempotency receipts for selective imports", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 36 });

      yield* sql`
        INSERT INTO command_center_import_receipts (
          plan_id, manifest_sha256, archive_artifact_count, untrusted_memory_count,
          disabled_automation_count, target_backup_sha256, applied_at
        ) VALUES (
          'migration_example', 'manifest-hash', 2, 3, 1, 'backup-hash',
          '2026-01-01T00:00:00Z'
        )
      `;

      const receipts = yield* sql<{
        readonly planId: string;
        readonly archiveCount: number;
      }>`
        SELECT plan_id AS "planId", archive_artifact_count AS "archiveCount"
        FROM command_center_import_receipts
      `;
      assert.deepStrictEqual(receipts, [{ planId: "migration_example", archiveCount: 2 }]);
    }),
  );
});
