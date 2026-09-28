import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Direct Web Push subscriptions for this environment's PWA clients.
 *
 * A push service hands each browser one opaque endpoint URL plus the RFC 8291
 * client keys; the endpoint is the natural primary key because the push service
 * addresses delivery by it and a 404/410 response identifies exactly the row to
 * delete. A device may re-subscribe and receive a fresh endpoint, so `device_id`
 * is unique and upserts key on it: the client's own device identity is stable
 * while its endpoint rotates.
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
