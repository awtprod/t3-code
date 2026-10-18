import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import {
  MIGRATIONS_TABLE,
  assertNoSkippedMigrations,
  findMigrationSequenceViolations,
  findSkippedMigrationIds,
  migrationEntries,
  migrationManifest,
  runMigrations,
} from "./Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const seedApplied = (ids: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE IF NOT EXISTS ${sql(MIGRATIONS_TABLE)} (
      migration_id integer PRIMARY KEY NOT NULL,
      created_at datetime NOT NULL DEFAULT current_timestamp,
      name VARCHAR(255) NOT NULL
    )`;
    for (const id of ids) {
      yield* sql`INSERT INTO ${sql(MIGRATIONS_TABLE)} (migration_id, name) VALUES (${id}, ${`m${id}`})`;
    }
  });

describe("findMigrationSequenceViolations", () => {
  const prefix = (last: number) =>
    Array.from({ length: last }, (_, index) => index + 1).filter((id) => id < 57 || id > 60);

  it("accepts the registered migrations: 1.., strictly increasing, gaps only at retired IDs", () => {
    assert.deepStrictEqual(findMigrationSequenceViolations(migrationEntries.map(([id]) => id)), []);
  });

  it("allows the retired 57-60 gap", () => {
    assert.deepStrictEqual(findMigrationSequenceViolations(prefix(62)), []);
  });

  it("rejects a migration registered before a lower-numbered one has landed", () => {
    assert.deepStrictEqual(findMigrationSequenceViolations([...prefix(71), 73, 74]), [
      "migration 72 is missing before 73",
    ]);
    assert.deepStrictEqual(findMigrationSequenceViolations([...prefix(73), 77]), [
      "migrations 74-76 are missing before 77",
    ]);
  });

  it("reports out-of-order entries once, not as missing", () => {
    assert.deepStrictEqual(findMigrationSequenceViolations([...prefix(71), 73, 72]), [
      "migration 72 is registered after 73",
    ]);
    assert.deepStrictEqual(findMigrationSequenceViolations([...prefix(71), 71]), [
      "migration 71 is registered after 71",
    ]);
  });

  it("rejects retired, missing-start, non-integer and huge typo'd IDs without hanging", () => {
    assert.deepStrictEqual(findMigrationSequenceViolations([...prefix(56), 58, 61]), [
      "migration 58 reuses a retired ID",
    ]);
    assert.deepStrictEqual(findMigrationSequenceViolations([2, 3]), [
      "migration 1 is missing before 2",
    ]);
    assert.deepStrictEqual(findMigrationSequenceViolations([1, Number.NaN]), [
      "migration ID NaN is not a positive integer",
    ]);
    assert.deepStrictEqual(findMigrationSequenceViolations([...prefix(77), 20_261_002]), [
      "migrations 78-20261001 are missing before 20261002",
    ]);
  });

  it("reports gaps up to the largest safe integer immediately, around retired IDs", () => {
    const started = performance.now();
    assert.deepStrictEqual(findMigrationSequenceViolations([1, 1_000_000_000_000]), [
      "migrations 2-56 are missing before 1000000000000",
      "migrations 61-999999999999 are missing before 1000000000000",
    ]);
    assert.deepStrictEqual(
      findMigrationSequenceViolations([...prefix(77), Number.MAX_SAFE_INTEGER]),
      [
        `migrations 78-${Number.MAX_SAFE_INTEGER - 1} are missing before ${Number.MAX_SAFE_INTEGER}`,
      ],
    );
    // A gap containing several retired IDs, including adjacent ones.
    assert.deepStrictEqual(findMigrationSequenceViolations([1, 70], [57, 58, 60, 61]), [
      "migrations 2-56 are missing before 70",
      "migration 59 is missing before 70",
      "migrations 62-69 are missing before 70",
    ]);
    assert.isBelow(performance.now() - started, 1_000);
  });
});

describe("findSkippedMigrationIds", () => {
  it("passes a fresh database", () => {
    assert.deepStrictEqual(findSkippedMigrationIds([1, 2, 3], []), []);
  });

  it("passes a normal forward upgrade", () => {
    assert.deepStrictEqual(findSkippedMigrationIds([1, 2, 3, 4], [1, 2]), []);
  });

  it("ignores gaps in the registry and unregistered applied IDs", () => {
    assert.deepStrictEqual(
      findSkippedMigrationIds([55, 56, 61, 62, 70], [55, 56, 57, 58, 59, 60, 61, 62]),
      [],
    );
    assert.deepStrictEqual(findSkippedMigrationIds([55, 56, 61, 62], [55, 56, 61]), []);
  });

  it("reports registered-but-unapplied IDs below the max applied ID", () => {
    assert.deepStrictEqual(findSkippedMigrationIds([71, 72, 73, 74, 75], [71, 74]), [72, 73]);
  });
});

it.layer(NodeSqliteClient.layerMemory())("assertNoSkippedMigrations on a fresh database", (it) => {
  it.effect("passes when the migrations table does not exist", () =>
    assertNoSkippedMigrations([1, 2, 3]),
  );
});

it.layer(NodeSqliteClient.layerMemory())("assertNoSkippedMigrations with a registry gap", (it) => {
  it.effect("passes when unregistered IDs were applied and gaps are not registered", () =>
    Effect.gen(function* () {
      yield* seedApplied([55, 56, 57, 58, 59, 60, 61]);
      yield* assertNoSkippedMigrations([55, 56, 61, 62]);
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("assertNoSkippedMigrations out of order", (it) => {
  it.effect("fails naming the skipped IDs when a higher migration is already applied", () =>
    Effect.gen(function* () {
      yield* seedApplied([71, 73]);
      const exit = yield* Effect.exit(assertNoSkippedMigrations([71, 72, 73, 74]));
      assert.ok(Exit.isFailure(exit));
      const error = yield* Effect.flip(assertNoSkippedMigrations([71, 72, 73, 74]));
      assert.strictEqual(error._tag, "MigrationError");
      assert.strictEqual(error.kind, "BadState");
      assert.include(error.message, "72");
      assert.include(error.message, "migration 73");
      assert.notInclude(error.message, "74");
    }),
  );
});

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("runMigrations guard", (it) => {
  it.effect("runs forward normally, then refuses once a registered ID is missing below max", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const ids = migrationEntries.map(([id]) => id);
      const partial = ids[ids.length - 3]!;
      yield* runMigrations({ toMigrationInclusive: partial });
      yield* runMigrations();
      const applied = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM ${sql(MIGRATIONS_TABLE)} ORDER BY migration_id
      `.withoutTransform;
      assert.deepStrictEqual(
        applied.map((row) => row.migration_id),
        ids,
      );

      // Simulate a lower-numbered migration landing after a higher one was applied.
      const victim = ids[ids.length - 2]!;
      yield* sql`DELETE FROM ${sql(MIGRATIONS_TABLE)} WHERE migration_id = ${victim}`;
      const error = yield* Effect.flip(runMigrations());
      assert.strictEqual(error._tag, "MigrationError");
      assert.include(error.message, String(victim));
    }),
  );
});

describe("stacked Instagram migration manifest", () => {
  it("registers every reserved dependency before 078 exactly once", () => {
    const ids = migrationManifest.map(([id]) => id);
    assert.strictEqual(new Set(ids).size, ids.length);
    const at078 = ids.indexOf(78);
    assert.deepStrictEqual(migrationManifest.slice(at078 - 6, at078 + 2), [
      [72, "CommandCenterResponsibilities"],
      [73, "CommandCenterObservations"],
      [74, "CommandCenterSprintPlanAdjustments"],
      [75, "CommandCenterDigest"],
      [76, "CommandCenterRepositorySignals"],
      [77, "CommandCenterInboxGmailDrafts"],
      [78, "InstagramReelReceipts"],
      [79, "CommandCenterSpaceAgent"],
    ]);
  });

  it("registers the Space agent wake state and replies after the Space activity feed", () => {
    const at080 = migrationManifest.findIndex(([id]) => id === 80);
    assert.deepStrictEqual(migrationManifest.slice(at080, at080 + 3), [
      [80, "CommandCenterSpaceActivity"],
      [81, "CommandCenterSpaceAgentState"],
      [82, "CommandCenterSpaceAgentReplies"],
    ]);
  });
});

const v2Migrations = migrationManifest.filter(([id]) => id >= 95);
const newerMigrationId = Math.max(...migrationManifest.map(([id]) => id)) + 1;

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const v2TableCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
  `;
  return rows.length;
});

describe("runMigrations with orchestration V2 (upstream 055-062 renumbered 095-102)", () => {
  it.effect("migrates a fresh database through the whole manifest", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when another migration took a V2 id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 94 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (95, 'FutureMainMigration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 94 }), []);
      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "95_OrchestrationV2 (recorded: FutureMainMigration)");
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when a later id would skip V2 migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 94 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'FutureMainMigration')
      `;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      for (const [id, name] of v2Migrations) {
        assert.include(String(exit), `${id}_${name} (recorded: nothing)`);
      }
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a database at exactly 94 (the last fork migration before V2)", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 94 });
      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([30, 94])("still starts with a site-local migration at id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 94 });
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}
      `;

      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("only checks V2 migrations within the requested limit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 95 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (96, 'SiteLocalMigration'), (${newerMigrationId}, 'NewerV2Migration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 95 }), []);
      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: 96 }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        "96_RemoveRedundantProjectionIndexes (recorded: SiteLocalMigration)",
      );
      assert.notInclude(String(exit), "97_ScheduledTaskWebhooks");
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("still starts after a newer build recorded a later V2 migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'NewerV2Migration')
      `;

      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
