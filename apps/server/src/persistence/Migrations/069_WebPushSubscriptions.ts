import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Direct Web Push subscriptions for this environment's PWA clients. The push
 * service's opaque endpoint URL is the primary key (it addresses delivery, and a
 * 404/410 names the row to delete); `device_id` is unique and upserts key on it
 * because a device that re-subscribes gets a fresh endpoint.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS web_push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      device_id TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      preferences_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
