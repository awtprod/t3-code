import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("070_CommandCenterInbox", (it) => {
  it.effect("backfills legacy items and enrolls later items without changing their lifecycle", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 69 });
      yield* sql`
        INSERT INTO command_center_spaces (
          id, slug, name, kind, created_at, updated_at
        ) VALUES (
          'space-a', 'a', 'A', 'business',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO command_center_items (
          id, space_id, kind, status, title, created_at, updated_at
        ) VALUES (
          'legacy-item', 'space-a', 'decision', 'review', 'Legacy',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 70 });
      yield* sql`
        INSERT INTO command_center_items (
          id, space_id, kind, status, title, created_at, updated_at
        ) VALUES (
          'later-item', 'space-a', 'task', 'captured', 'Later',
          '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'
        )
      `;

      const states = yield* sql<{
        readonly itemId: string;
        readonly subjectKind: string;
        readonly subjectId: string;
        readonly lifecycle: string;
        readonly version: number;
      }>`
        SELECT item_id AS "itemId", subject_kind AS "subjectKind",
          subject_id AS "subjectId", lifecycle, version
        FROM command_center_inbox_state
        ORDER BY item_id
      `;
      const items = yield* sql<{ readonly id: string; readonly status: string }>`
        SELECT id, status FROM command_center_items ORDER BY id
      `;

      assert.deepStrictEqual(states, [
        {
          itemId: "later-item",
          subjectKind: "command-center-item",
          subjectId: "later-item",
          lifecycle: "open",
          version: 0,
        },
        {
          itemId: "legacy-item",
          subjectKind: "command-center-item",
          subjectId: "legacy-item",
          lifecycle: "open",
          version: 0,
        },
      ]);
      assert.deepStrictEqual(items, [
        { id: "later-item", status: "captured" },
        { id: "legacy-item", status: "review" },
      ]);

      yield* sql`
        UPDATE command_center_items
        SET title = 'Legacy updated', updated_at = '2026-01-03T00:00:00.000Z'
        WHERE id = 'legacy-item'
      `;
      const updatedState = yield* sql<{ readonly version: number; readonly updatedAt: string }>`
        SELECT version, updated_at AS "updatedAt"
        FROM command_center_inbox_state
        WHERE item_id = 'legacy-item'
      `;
      assert.deepStrictEqual(updatedState, [{ version: 1, updatedAt: "2026-01-03T00:00:00.000Z" }]);
    }),
  );

  it.effect("enforces snooze and single-current-revision invariants", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 70 });
      yield* sql`
        INSERT INTO command_center_spaces (
          id, slug, name, kind, created_at, updated_at
        ) VALUES (
          'space-b', 'b', 'B', 'business',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO command_center_items (
          id, space_id, kind, status, title, created_at, updated_at
        ) VALUES (
          'item-b', 'space-b', 'decision', 'review', 'B',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;

      const invalidSnooze = yield* Effect.exit(sql`
        UPDATE command_center_inbox_state
        SET lifecycle = 'snoozed', snoozed_until = NULL
        WHERE item_id = 'item-b'
      `);
      assert.ok(Exit.isFailure(invalidSnooze));

      const insertRevision = (id: string, revision: number) => sql`
        INSERT INTO command_center_inbox_revisions (
          id, item_id, revision, status, source, payload_json, preview_json,
          evidence_json, actor_subject, created_at, accepted_at, accepted_by_subject
        ) VALUES (
          ${id}, 'item-b', ${revision}, 'current', 'direct',
          '{"kind":"prepared-action","actionKind":"fixture","target":{"kind":"item","id":"item-b"},"parameters":{}}',
          '{"summary":"Fixture"}',
          '{"source":"fixture","subjectId":"item-b","version":"1"}',
          'test-user', '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z', 'test-user'
        )
      `;
      yield* insertRevision("revision-1", 1);
      assert.ok(Exit.isFailure(yield* Effect.exit(insertRevision("revision-2", 2))));
    }),
  );
});
