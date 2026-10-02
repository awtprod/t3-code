import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { migrationManifest, MigrationsLive, runMigrations } from "../Migrations.ts";
import migration from "./078_InstagramReelReceipts.ts";

const inspectHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    migration_id: number;
    name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`.withoutTransform;
  assert.deepStrictEqual(
    rows.map((r) => [r.migration_id, r.name]),
    migrationManifest.map(([id, name]) => [id, name]),
  );
  const tables = yield* sql<{
    name: string;
  }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'command_center_instagram_reels'`;
  assert.strictEqual(tables.length, 1);
});

it.layer(NodeSqliteClient.layerMemory())("default startup migration layer", (it) => {
  it.effect("fresh SQLite reaches 078 without any publishing flag or media config", () =>
    Effect.gen(function* () {
      // This is the unconditional layer on the server startup path.
      yield* Effect.scoped(Layer.build(MigrationsLive));
      yield* inspectHistory;
      assert.deepStrictEqual(yield* runMigrations(), []);
    }),
  );
});

for (const previous of [69, 71, 77]) {
  it.layer(NodeSqliteClient.layerMemory())(`upgrade ${previous} to 078`, (it) => {
    it.effect("executes actual dependency migrations and preserves receipts on rerun", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: previous });
        const executed = yield* runMigrations();
        assert.deepStrictEqual(
          executed,
          migrationManifest.filter(([id]) => id > previous),
        );
        yield* inspectHistory;
        yield* sql`INSERT INTO command_center_instagram_reels (id, receipt_json, state, due_ms) VALUES ('synthetic-receipt', '{}', 'requested', 1)`;
        assert.deepStrictEqual(yield* runMigrations(), []);
        const receipts = yield* sql`SELECT id FROM command_center_instagram_reels`;
        assert.strictEqual(receipts.length, 1);
      }),
    );
  });
}

for (const through of [69, 71, 76]) {
  it.layer(NodeSqliteClient.layerMemory())(`direct 078 after ${through}`, (it) => {
    it.effect("still refuses missing reserved migration history and creates no Reel table", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: through });
        const exit = yield* Effect.exit(migration);
        assert.ok(Exit.isFailure(exit));
        const error = yield* Effect.flip(migration);
        assert.include(error.message, "072–077");
        const tables =
          yield* sql`SELECT name FROM sqlite_master WHERE name = 'command_center_instagram_reels'`;
        assert.strictEqual(tables.length, 0);
        const history = yield* sql<{
          maximum: number;
        }>`SELECT MAX(migration_id) AS maximum FROM effect_sql_migrations`;
        assert.strictEqual(history[0]!.maximum, through);
      }),
    );
  });
}
