import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("094_AuthSessionRenewalLineage", (it) => {
  it.effect("adds nullable lineage columns and allows one successor per session", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 93 });
      yield* runMigrations({ toMigrationInclusive: 94 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(auth_sessions)
      `;
      const renewedFrom = columns.find((column) => column.name === "renewed_from_session_id");
      const renewedAt = columns.find((column) => column.name === "renewed_at");
      assert.equal(renewedFrom?.notnull, 0);
      assert.equal(renewedAt?.notnull, 0);

      const insert = (sessionId: string, renewedFrom: string | null) => sql`
        INSERT INTO auth_sessions (
          session_id, subject, method, scopes, issued_at, expires_at,
          renewed_from_session_id
        )
        VALUES (
          ${sessionId}, 'subject', 'bearer-access-token', '[]',
          '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', ${renewedFrom}
        )
      `;
      yield* insert("original", null);
      yield* insert("unrelated", null);
      yield* insert("successor", "original");
      const duplicate = yield* insert("second-successor", "original").pipe(Effect.flip);
      assert.include(String((duplicate as { readonly cause?: unknown }).cause), "UniqueViolation");
      const successors = yield* sql<{ readonly sessionId: string }>`
        SELECT session_id AS "sessionId" FROM auth_sessions
        WHERE renewed_from_session_id = 'original'
      `;
      assert.deepEqual(
        successors.map((row) => row.sessionId),
        ["successor"],
      );
    }),
  );
});
