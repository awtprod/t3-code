import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("057_CommandCenterSalesPipeline", (it) => {
  it.effect(
    "upgrades realistic existing Command Center data without changing its legacy projection",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 56 });
        yield* sql`
        INSERT INTO command_center_spaces (
          id, slug, name, kind, instructions, policy_json, model_defaults_json,
          connections_json, repositories_json, aliases_json, lifecycle, created_at, updated_at
        ) VALUES (
          'existing-space', 'existing-space', 'Existing Space', 'business', 'Existing instructions',
          '{"allowedCapabilities":["cc.items.read"],"autoRunRiskLevels":[]}', '{}', '[]', '[]',
          '[]', 'active', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
        )
      `;
        yield* sql`
        INSERT INTO command_center_items (
          id, space_id, kind, status, title, priority, source_json, links_json,
          metadata_json, created_at, updated_at
        ) VALUES (
          'existing-item', 'existing-space', 'task', 'ready', 'Existing work', 'normal', '{}',
          '[]', '{}', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
        )
      `;

        yield* runMigrations({ toMigrationInclusive: 57 });

        const legacySpace = yield* sql<{
          readonly id: string;
          readonly name: string;
          readonly policyJson: string;
          readonly connectionsJson: string;
        }>`
        SELECT id, name, policy_json AS "policyJson", connections_json AS "connectionsJson"
        FROM command_center_spaces WHERE id = 'existing-space'
      `;
        const item = yield* sql<{ readonly title: string; readonly status: string }>`
        SELECT title, status FROM command_center_items WHERE id = 'existing-item'
      `;
        const features = yield* sql<{ readonly featuresJson: string }>`
        SELECT features_json AS "featuresJson" FROM command_center_spaces WHERE id = 'existing-space'
      `;

        assert.deepStrictEqual(legacySpace, [
          {
            id: "existing-space",
            name: "Existing Space",
            policyJson: '{"allowedCapabilities":["cc.items.read"],"autoRunRiskLevels":[]}',
            connectionsJson: "[]",
          },
        ]);
        assert.deepStrictEqual(item, [{ title: "Existing work", status: "ready" }]);
        assert.deepStrictEqual(features, [{ featuresJson: "{}" }]);
      }),
  );

  it.effect("keeps sales activity immutable", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });
      yield* sql`
        INSERT INTO command_center_spaces (
          id, slug, name, kind, policy_json, model_defaults_json, features_json,
          connections_json, repositories_json, aliases_json, lifecycle, created_at, updated_at
        ) VALUES (
          'sales-space', 'sales-space', 'Sales', 'business', '{}', '{}',
          '{"salesPipeline":true}', '[]', '[]', '[]', 'active',
          '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO command_center_sales_prospects (
          id, space_id, stage, channel_name, channel_url, normalized_channel_key,
          contact_provenance_json, language, niche, fit_json, provenance_kind,
          created_at, updated_at
        ) VALUES (
          'prospect-1', 'sales-space', 'researched', 'Example', 'https://example.com', 'example',
          '{"sourceUrl":"https://example.com","isPublicBusinessContact":true,"capturedAt":"2026-08-01T00:00:00.000Z"}',
          'English', 'Business',
          '{"score":80,"reasons":["fit"],"thumbnailAudit":"audit","monetizationEvidence":"paid product","publishingEvidence":"weekly"}',
          'user', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO command_center_sales_activities (
          id, prospect_id, space_id, kind, actor_kind, payload_json, occurred_at
        ) VALUES (
          'activity-1', 'prospect-1', 'sales-space', 'proposed', 'user', '{}',
          '2026-08-01T00:00:00.000Z'
        )
      `;

      const updateExit = yield* Effect.exit(
        sql`UPDATE command_center_sales_activities SET payload_json = '{"changed":true}' WHERE id = 'activity-1'`,
      );
      const deleteExit = yield* Effect.exit(
        sql`DELETE FROM command_center_sales_activities WHERE id = 'activity-1'`,
      );
      assert.equal(updateExit._tag, "Failure");
      assert.equal(deleteExit._tag, "Failure");
    }),
  );
});
