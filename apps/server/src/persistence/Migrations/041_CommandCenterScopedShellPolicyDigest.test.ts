import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_CommandCenterScopedShellPolicyDigest", (it) => {
  it.effect("adds an initially empty, digest-constrained checkpoint pin", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`
        INSERT INTO command_center_spaces (
          id, slug, name, kind, created_at, updated_at
        ) VALUES (
          'space-example', 'space-example', 'Example', 'system',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO command_center_automations (
          id, space_id, name, enabled, commit_sha, definition_digest,
          definition_json, last_loaded_at
        ) VALUES (
          'automation-example', 'space-example', 'Example', 1,
          '1234567890abcdef1234567890abcdef12345678',
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          '{}', '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO command_center_automation_executions (
          id, automation_id, idempotency_key, space_id, config_commit_sha,
          definition_digest, definition_json, input_json, state, created_at, updated_at
        ) VALUES (
          'execution-example', 'automation-example', 'idempotency-example', 'space-example',
          '1234567890abcdef1234567890abcdef12345678',
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          '{}', '{}', 'queued', '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO command_center_automation_node_checkpoints (
          execution_id, node_id, node_kind, state, max_attempts, updated_at
        ) VALUES (
          'execution-example', 'shell-example', 'shell.scoped', 'pending', 1,
          '2026-01-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 41 });
      const before = yield* sql<{ readonly digest: string | null }>`
        SELECT scoped_shell_policy_digest AS digest
        FROM command_center_automation_node_checkpoints
      `;
      assert.deepStrictEqual(before, [{ digest: null }]);

      const digest = `sha256:${"a".repeat(64)}`;
      yield* sql`
        UPDATE command_center_automation_node_checkpoints
        SET scoped_shell_policy_digest = ${digest}
        WHERE execution_id = 'execution-example' AND node_id = 'shell-example'
      `;
      const after = yield* sql<{ readonly digest: string | null }>`
        SELECT scoped_shell_policy_digest AS digest
        FROM command_center_automation_node_checkpoints
      `;
      assert.deepStrictEqual(after, [{ digest }]);
    }),
  );
});
