import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { MemorySearchIndex, layer as memorySearchIndexLayer } from "./MemorySearchIndex.ts";

const fixtureNow = 1_784_548_800_000;
const createdAt = "2026-01-01T00:00:00.000Z";

interface MemoryFixture {
  readonly id: string;
  readonly spaceId: string;
  readonly scope?: "global" | "space" | "repository";
  readonly repositoryRef?: string | undefined;
  readonly kind?: "fact" | "preference" | "decision" | "procedure" | "archive";
  readonly status?: "candidate" | "approved" | "rejected" | "expired" | "archive";
  readonly content?: string;
  readonly expiresAt?: string | undefined;
  readonly updatedAt?: string | undefined;
}

const testLayer = memorySearchIndexLayer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const insertSpace = Effect.fn("MemorySearchIndexTest.insertSpace")(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO command_center_spaces (id, slug, name, kind, created_at, updated_at)
    VALUES (${id}, ${id}, ${`Space ${id}`}, 'business', ${createdAt}, ${createdAt})
  `;
});

const resetFixtures = Effect.fn("MemorySearchIndexTest.resetFixtures")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM command_center_memory_search_fts`;
  yield* sql`DELETE FROM command_center_memory_search_embeddings`;
  yield* sql`DELETE FROM command_center_memory_search_documents`;
  yield* sql`DELETE FROM command_center_memories`;
  yield* sql`DELETE FROM command_center_spaces`;
  yield* sql`
    UPDATE command_center_memory_search_state
    SET generation = 0, rebuilt_at = NULL, document_count = 0,
      trusted_count = 0, archive_count = 0, source_generation = 0,
      indexed_source_generation = 0
    WHERE singleton = 1
  `;
});

const insertMemory = Effect.fn("MemorySearchIndexTest.insertMemory")(function* (
  fixture: MemoryFixture,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO command_center_memories (
      id, space_id, repository_ref, scope, kind, content, status, confidence,
      provenance_json, expires_at, created_at, updated_at
    ) VALUES (
      ${fixture.id}, ${fixture.spaceId}, ${fixture.repositoryRef ?? null},
      ${fixture.scope ?? "space"}, ${fixture.kind ?? "fact"},
      ${fixture.content ?? "orbital memory"}, ${fixture.status ?? "approved"}, 0.9,
      ${fixture.kind === "archive" ? '{"source":"legacy-import"}' : '{"source":"user"}'},
      ${fixture.expiresAt ?? null}, ${createdAt}, ${fixture.updatedAt ?? createdAt}
    )
  `;
});

const layer = it.layer(testLayer);

layer("MemorySearchIndex", (it) => {
  it.effect(
    "filters Space and repository scope without promoting candidates, while marking archives untrusted",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(fixtureNow);
        yield* resetFixtures();
        yield* insertSpace("alpha-space");
        yield* insertSpace("beta-space");

        yield* Effect.forEach(
          [
            { id: "alpha-global", spaceId: "alpha-space", scope: "global" },
            { id: "alpha-space", spaceId: "alpha-space" },
            {
              id: "alpha-repo-a",
              spaceId: "alpha-space",
              scope: "repository",
              repositoryRef: "example/repository-a",
            },
            {
              id: "alpha-repo-b",
              spaceId: "alpha-space",
              scope: "repository",
              repositoryRef: "example/repository-b",
            },
            {
              id: "alpha-archive",
              spaceId: "alpha-space",
              kind: "archive",
              status: "archive",
            },
            { id: "alpha-candidate", spaceId: "alpha-space", status: "candidate" },
            { id: "alpha-rejected", spaceId: "alpha-space", status: "rejected" },
            { id: "alpha-expired", spaceId: "alpha-space", status: "expired" },
            {
              id: "alpha-past-expiry",
              spaceId: "alpha-space",
              expiresAt: "2026-07-19T00:00:00.000Z",
            },
            { id: "beta-space-memory", spaceId: "beta-space" },
          ] satisfies ReadonlyArray<MemoryFixture>,
          insertMemory,
        );

        const index = yield* MemorySearchIndex;
        const rebuilt = yield* index.rebuild();
        assert.deepStrictEqual(
          {
            documentCount: rebuilt.documentCount,
            trustedCount: rebuilt.trustedCount,
            archiveCount: rebuilt.archiveCount,
          },
          { documentCount: 6, trustedCount: 5, archiveCount: 1 },
        );

        const withoutRepository = yield* index.search({
          query: "orbital",
          spaceId: "alpha-space",
        });
        assert.deepStrictEqual(withoutRepository.map((result) => result.memoryId).sort(), [
          "alpha-archive",
          "alpha-global",
          "alpha-space",
        ]);
        const archive = withoutRepository.find((result) => result.memoryId === "alpha-archive");
        assert.strictEqual(archive?.trust, "untrusted-archive");
        assert.strictEqual(archive?.readOnly, true);
        assert.ok(
          withoutRepository
            .filter((result) => result.memoryId !== "alpha-archive")
            .every((result) => result.trust === "trusted" && result.readOnly === false),
        );

        const repositoryA = yield* index.search({
          query: "orbital",
          spaceId: "alpha-space",
          repositoryRef: "example/repository-a",
        });
        assert.deepStrictEqual(repositoryA.map((result) => result.memoryId).sort(), [
          "alpha-archive",
          "alpha-global",
          "alpha-repo-a",
          "alpha-space",
        ]);
        const trustedOnly = yield* index.search({
          query: "orbital",
          spaceId: "alpha-space",
          repositoryRef: "example/repository-a",
          includeArchives: false,
        });
        assert.deepStrictEqual(trustedOnly.map((result) => result.memoryId).sort(), [
          "alpha-global",
          "alpha-repo-a",
          "alpha-space",
        ]);

        const betaResults = yield* index.search({
          query: "orbital",
          spaceId: "beta-space",
        });
        assert.deepStrictEqual(
          betaResults.map((result) => result.memoryId),
          ["beta-space-memory"],
        );

        const sql = yield* SqlClient.SqlClient;
        const candidate = yield* sql<{ readonly status: string }>`
          SELECT status FROM command_center_memories WHERE id = 'alpha-candidate'
        `;
        const indexedCandidate = yield* sql<{ readonly memoryId: string }>`
          SELECT memory_id AS "memoryId"
          FROM command_center_memory_search_documents
          WHERE memory_id = 'alpha-candidate'
        `;
        assert.deepStrictEqual(candidate, [{ status: "candidate" }]);
        assert.strictEqual(indexedCandidate.length, 0);
        const stateAfterReads = yield* sql<{ readonly generation: number }>`
          SELECT generation FROM command_center_memory_search_state WHERE singleton = 1
        `;
        assert.deepStrictEqual(stateAfterReads, [{ generation: 1 }]);
      }),
  );

  it.effect("replaces stale documents and optional embeddings on every rebuild", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(fixtureNow);
      yield* resetFixtures();
      yield* insertSpace("sample-space");
      yield* insertMemory({
        id: "changing-memory",
        spaceId: "sample-space",
        content: "cedar original",
      });

      const index = yield* MemorySearchIndex;
      const first = yield* index.rebuild();
      assert.strictEqual(first.generation, 1);
      assert.strictEqual(first.documentCount, 1);
      assert.strictEqual(
        (yield* index.search({ query: "cedar", spaceId: "sample-space" })).length,
        1,
      );

      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO command_center_memory_search_embeddings (
          memory_id, provider, model, dimensions, vector_format, vector_data,
          source_content_digest, embedded_at
        )
        SELECT memory_id, 'sample-provider', 'sample-model', 1, 'float32-le', X'00000000',
          content_digest, ${createdAt}
        FROM command_center_memory_search_documents
        WHERE memory_id = 'changing-memory'
      `;
      yield* sql`
        UPDATE command_center_memories
        SET content = 'maple revised', updated_at = '2026-07-20T13:00:00.000Z'
        WHERE id = 'changing-memory'
      `;

      const concurrent = yield* Effect.all(
        Array.from({ length: 4 }, () => index.search({ query: "maple", spaceId: "sample-space" })),
        { concurrency: "unbounded" },
      );
      assert.ok(concurrent.every((results) => results.length === 1));
      const stateAfterMutation = yield* sql<{ readonly generation: number }>`
        SELECT generation FROM command_center_memory_search_state WHERE singleton = 1
      `;
      assert.deepStrictEqual(stateAfterMutation, [{ generation: 2 }]);
      assert.strictEqual(
        (yield* index.search({ query: "cedar", spaceId: "sample-space" })).length,
        0,
      );
      assert.strictEqual(
        (yield* index.search({ query: "maple", spaceId: "sample-space" })).length,
        1,
      );
      const projectionCounts = yield* sql<{
        readonly documents: number;
        readonly embeddings: number;
        readonly ftsRows: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM command_center_memory_search_documents) AS documents,
          (SELECT COUNT(*) FROM command_center_memory_search_embeddings) AS embeddings,
          (SELECT COUNT(*) FROM command_center_memory_search_fts) AS "ftsRows"
      `;
      assert.deepStrictEqual(projectionCounts, [{ documents: 1, embeddings: 0, ftsRows: 1 }]);

      yield* sql`DELETE FROM command_center_memories WHERE id = 'changing-memory'`;
      assert.strictEqual(
        (yield* index.search({ query: "maple", spaceId: "sample-space" })).length,
        0,
      );
      const finalState = yield* sql<{ readonly generation: number }>`
        SELECT generation FROM command_center_memory_search_state WHERE singleton = 1
      `;
      assert.deepStrictEqual(finalState, [{ generation: 3 }]);
    }),
  );

  it.effect("removes archived-Space documents from rebuilds and search results", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(fixtureNow);
      yield* resetFixtures();
      yield* insertSpace("retired-space");
      yield* insertMemory({
        id: "retired-memory",
        spaceId: "retired-space",
        content: "retired marker",
      });
      const index = yield* MemorySearchIndex;
      assert.strictEqual((yield* index.rebuild()).documentCount, 1);

      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE command_center_spaces SET lifecycle = 'archived' WHERE id = 'retired-space'
      `;
      assert.strictEqual((yield* index.rebuild()).documentCount, 0);
      assert.deepStrictEqual(
        yield* index.search({ query: "retired", spaceId: "retired-space" }),
        [],
      );
    }),
  );
});
