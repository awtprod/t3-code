import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("065_ProviderRestartRecovery", (it) => {
  it.effect("creates a bounded durable restart-recovery ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 64 });
      yield* runMigrations({ toMigrationInclusive: 65 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(provider_restart_recoveries)
      `;
      assert.deepStrictEqual(
        columns.map((column) => column.name),
        [
          "recovery_id",
          "thread_id",
          "message_id",
          "original_request_sequence",
          "root_request_sequence",
          "attempt",
          "command_id",
          "reserved_at",
          "replacement_request_sequence",
          "dispatched_at",
        ],
      );

      yield* sql`
        INSERT INTO provider_restart_recoveries (
          thread_id, message_id, original_request_sequence, root_request_sequence,
          attempt, command_id, reserved_at
        ) VALUES ('thread', 'message', 1, 1, 1, 'command', '2026-01-01T00:00:00.000Z')
      `;
      const invalidAttempt = yield* Effect.exit(sql`
        INSERT INTO provider_restart_recoveries (
          thread_id, message_id, original_request_sequence, root_request_sequence,
          attempt, command_id, reserved_at
        ) VALUES ('thread', 'message', 2, 1, 3, 'command-2', '2026-01-01T00:00:00.000Z')
      `);

      assert.strictEqual(invalidAttempt._tag, "Failure");
    }),
  );
});
