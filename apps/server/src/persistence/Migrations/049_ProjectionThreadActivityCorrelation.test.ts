import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("049_ProjectionThreadActivityCorrelation", (it) => {
  it.effect("preserves legacy NULL rows and round-trips explicit message correlation", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 48 });

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        )
        VALUES (
          'activity-legacy',
          'thread-a',
          'turn-a',
          'tool',
          'tool.started',
          'legacy unattributed evidence',
          '{}',
          '2026-01-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 49 });

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          correlated_message_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        )
        VALUES (
          'activity-correlated',
          'thread-a',
          'turn-a',
          'message-a',
          'tool',
          'tool.completed',
          'correlated evidence',
          '{}',
          '2026-01-01T00:00:01.000Z'
        )
      `;

      const activities = yield* sql<{
        readonly activityId: string;
        readonly correlatedMessageId: string | null;
      }>`
        SELECT
          activity_id AS "activityId",
          correlated_message_id AS "correlatedMessageId"
        FROM projection_thread_activities
        ORDER BY activity_id
      `;
      assert.deepStrictEqual(activities, [
        {
          activityId: "activity-correlated",
          correlatedMessageId: "message-a",
        },
        {
          activityId: "activity-legacy",
          correlatedMessageId: null,
        },
      ]);

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM pragma_index_list('projection_thread_activities')
        WHERE name = 'idx_projection_thread_activities_thread_message_created'
      `;
      assert.deepStrictEqual(indexes, [
        { name: "idx_projection_thread_activities_thread_message_created" },
      ]);
    }),
  );
});
