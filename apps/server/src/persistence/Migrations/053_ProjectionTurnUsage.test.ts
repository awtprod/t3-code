import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("053_ProjectionTurnUsage", (it) => {
  it.effect("backfills partial context usage and deletes usage with threads and projects", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at
        ) VALUES (
          'project-usage', 'Usage project', '/tmp/usage-project', NULL, '[]',
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, pending_approval_count,
          pending_user_input_count, has_actionable_proposed_plan
        ) VALUES (
          'thread-usage', 'project-usage', 'Usage thread',
          '{"instanceId":"kimi-main","model":"kimi-code/k3"}', 'full-access',
          'default', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 0, 0, 0
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, provider_instance_id, runtime_mode, updated_at
        ) VALUES (
          'thread-usage', 'ready', 'kimi', 'kimi-main', 'full-access',
          '2026-07-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
        ) VALUES (
          'activity-context', 'thread-usage', 'turn-1', 'info', 'context-window.updated',
          'Context usage', '{"usedTokens":123,"maxTokens":1000,"durationMs":20}',
          '2026-07-01T00:01:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 53 });
      const backfill = yield* sql<{
        readonly quality: string;
        readonly contextUsed: number | null;
        readonly cacheRead: number | null;
        readonly costKind: string;
      }>`
        SELECT quality, context_used_tokens AS "contextUsed",
          cache_read_input_tokens AS "cacheRead", cost_kind AS "costKind"
        FROM projection_turn_usage WHERE thread_id = 'thread-usage'
      `;
      assert.deepStrictEqual(backfill, [
        { quality: "partial", contextUsed: 123, cacheRead: null, costKind: "unavailable" },
      ]);

      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'thread-usage'`;
      const afterThreadDelete = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_turn_usage WHERE thread_id = 'thread-usage'
      `;
      assert.deepStrictEqual(afterThreadDelete, [{ count: 0 }]);

      yield* sql`
        INSERT INTO projection_turn_usage (
          thread_id, turn_id, project_id, provider_instance_id, provider_driver,
          workload, component_kind, component_id, quality, cost_kind, completed_at
        ) VALUES (
          'thread-detached', 'turn-2', 'project-usage', 'kimi-main', 'kimi',
          'automation', 'main', 'main', 'partial', 'unavailable',
          '2026-07-01T00:02:00.000Z'
        )
      `;
      yield* sql`DELETE FROM projection_projects WHERE project_id = 'project-usage'`;
      const afterProjectDelete = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_turn_usage WHERE project_id = 'project-usage'
      `;
      assert.deepStrictEqual(afterProjectDelete, [{ count: 0 }]);
    }),
  );
});
