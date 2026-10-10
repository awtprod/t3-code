import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("069_WebPushSubscriptions", (it) => {
  it.effect("creates the web push subscriptions table with the expected columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 68 });
      yield* runMigrations({ toMigrationInclusive: 69 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(web_push_subscriptions)
      `;
      assert.deepStrictEqual(
        columns.map((column) => column.name),
        ["endpoint", "device_id", "p256dh", "auth", "preferences_json", "created_at", "updated_at"],
      );
    }),
  );

  it.effect("enforces the device_id uniqueness constraint", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 69 });

      yield* sql`
        INSERT INTO web_push_subscriptions (
          endpoint, device_id, p256dh, auth, preferences_json, created_at, updated_at
        ) VALUES (
          'https://fcm.googleapis.com/a', 'device', 'p', 'a', '{}',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
      const duplicateDevice = yield* Effect.exit(sql`
        INSERT INTO web_push_subscriptions (
          endpoint, device_id, p256dh, auth, preferences_json, created_at, updated_at
        ) VALUES (
          'https://fcm.googleapis.com/b', 'device', 'p', 'a', '{}',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `);

      assert.strictEqual(duplicateDevice._tag, "Failure");
    }),
  );
});
