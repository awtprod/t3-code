import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Version the audit-event digest format without rewriting historical events.
 * Existing rows retain version 1, whose digest intentionally excludes the
 * event ID. New writers use version 2, which binds both the event ID and the
 * version marker into the digest.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE command_center_audit_events
    ADD COLUMN hash_version INTEGER NOT NULL DEFAULT 1
      CHECK (hash_version IN (1, 2))
  `;
});
