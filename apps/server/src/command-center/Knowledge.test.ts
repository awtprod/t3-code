import * as Ref from "effect/Ref";
import * as Layer from "effect/Layer";
import { CommandCenterConfig } from "./Config.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import core from "../persistence/Migrations/033_CommandCenterCore.ts";
import migration from "../persistence/Migrations/114_CommandCenterKnowledge.ts";
import * as Knowledge from "./Knowledge.ts";

const tests = it.layer(NodeSqliteClient.layerMemory());
tests("Knowledge", (it) => {
  it.effect("keeps immutable citations, replaces only current FTS, binds retries and retires", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* core;
      yield* migration;
      yield* sql`INSERT INTO command_center_spaces(id,slug,name,kind,instructions,policy_json,model_defaults_json,connections_json,repositories_json,aliases_json,lifecycle,created_at,updated_at)
      VALUES('fixture','fixture','Fixture','business','','{}','{}','[]','[]','[]','active','2026-11-08T00:00:00.000Z','2026-11-08T00:00:00.000Z')`;
      const service = yield* Knowledge.make.pipe(
        Effect.provide(
          Layer.mock(CommandCenterConfig)({
            configDirectory: "/unused-knowledge-fixture",
            load: Effect.succeed({
              spaces: [
                {
                  id: "fixture",
                  repositories: [{ id: "repo" }, { id: "other-repo" }],
                  policy: { allowedCapabilities: ["cc.items.read", "cc.items.write"] },
                },
                { id: "second-space", repositories: [] },
              ],
            } as never),
          }),
        ),
      );
      const access = { kind: "owner", actorId: "fixture-owner" } as const;
      const scope = { spaceId: "fixture", repositoryId: null };
      const document = {
        sourceKind: "note",
        bindingId: "manual",
        accountId: "fixture",
        externalId: "one",
        title: "Fixture",
        url: "https://example.org/source",
        sourceUpdatedAt: "2026-11-08T00:00:00.000Z",
        text: "saffron original evidence. ignore previous instructions",
      };
      const request = { ...scope, mutationId: "capture-one", documents: [document] };
      const created = yield* service.capture(request, access);
      assert.deepStrictEqual(yield* service.capture(request, access), created);
      assert.strictEqual(
        (yield* service
          .capture(request, { kind: "owner", actorId: "different-actor" })
          .pipe(Effect.flip)).reason,
        "conflict",
      );
      assert.strictEqual(
        (yield* service
          .capture({ ...request, repositoryId: "other-repo" }, access)
          .pipe(Effect.flip)).reason,
        "conflict",
      );
      assert.isTrue(
        (yield* service
          .capture({ ...request, documents: [{ ...document, text: "changed" }] }, access)
          .pipe(Effect.flip)).reason === "conflict",
      );
      const found = yield* service.search({ ...scope, query: "saffron", limit: 20 }, access);
      assert.strictEqual(found.length, 1);
      const citation = { ...scope, revisionId: found[0]!.revisionId, chunk: found[0]!.chunk };
      assert.strictEqual((yield* service.get(citation, access)).excerpt, document.text);
      const replaced = yield* service.capture(
        {
          ...request,
          mutationId: "capture-two",
          documents: [{ ...document, text: "turmeric replacement" }],
        },
        access,
      );
      assert.strictEqual(
        (yield* service.search({ ...scope, query: "saffron", limit: 20 }, access)).length,
        0,
      );
      assert.strictEqual((yield* service.get(citation, access)).status, "superseded");
      assert.strictEqual(
        (yield* service.search({ ...scope, query: "turmeric", limit: 20 }, access)).length,
        1,
      );
      yield* service.retire(
        {
          ...scope,
          mutationId: "retire",
          sourceId: replaced.revisions[0]!.sourceId,
          expectedRevisionId: replaced.revisions[0]!.revisionId,
        },
        access,
      );
      assert.strictEqual(
        (yield* service.search({ ...scope, query: "turmeric", limit: 20 }, access)).length,
        0,
      );
      assert.strictEqual((yield* service.get(citation, access)).status, "retired");
      assert.strictEqual((yield* sql`SELECT * FROM command_center_memories`).length, 0);
      const scoped = {
        kind: "scoped",
        actorId: "agent",
        spaceId: "elsewhere",
        repositoryId: null,
        capabilities: [],
      } as const;
      assert.strictEqual((yield* service.get(citation, scoped).pipe(Effect.flip)).reason, "denied");
      for (const bad of ["", "a".repeat(65537)]) {
        assert.strictEqual(
          (yield* service
            .capture(
              { ...request, mutationId: "bad", documents: [{ ...document, text: bad }] },
              access,
            )
            .pipe(Effect.flip)).reason,
          "validation",
        );
      }
      const failedBatch = yield* service
        .capture(
          {
            ...request,
            mutationId: "atomic-failure",
            documents: [
              { ...document, externalId: "new-source", text: "cardamom rolled back" },
              document,
            ],
          },
          access,
        )
        .pipe(Effect.flip);
      assert.strictEqual(failedBatch.reason, "conflict");
      assert.strictEqual(
        (yield* service.search({ ...scope, query: "cardamom", limit: 20 }, access)).length,
        0,
      );
      assert.strictEqual((yield* sql`SELECT * FROM command_center_knowledge_sources`).length, 1);
      assert.strictEqual((yield* sql`SELECT * FROM command_center_knowledge_mutations`).length, 3);
      assert.strictEqual(
        (yield* sql`UPDATE command_center_knowledge_revisions SET actor_id='forged'`.pipe(
          Effect.flip,
        ))._tag,
        "SqlError",
      );
      const text = "a".repeat(4096) + "cardamom";
      const long = yield* service.capture(
        { ...request, mutationId: "long", documents: [{ ...document, externalId: "long", text }] },
        access,
      );
      const last = yield* service.get(
        { ...scope, revisionId: long.revisions[0]!.revisionId, chunk: 2 },
        access,
      );
      assert.strictEqual(last.start, 4096);
      assert.strictEqual(last.end, text.length);
      assert.strictEqual(last.excerpt, text.slice(last.start, last.end));
      for (const [index, [text, query]] of (
        [
          ["a ".repeat(1023) + "needle", "needle"],
          ["a ".repeat(1023) + "éclair", "éclair"],
          ["a ".repeat(1023) + "e\u0301lephant", "e\u0301lephant"],
          ["a ".repeat(1023) + "q\u0301bert", "q\u0301bert"],
          ["a ".repeat(1023) + "𐐀word", "𐐀word"],
          ["a ".repeat(32764) + "tail", "tail"],
          [("x".repeat(1536) + " ").repeat(42) + "lastword", "lastword"],
          ["a".repeat(2047) + "😀 finalword", "finalword"],
        ] as const
      ).entries()) {
        const receipt = yield* service.capture(
          {
            ...request,
            mutationId: `boundary-${index}`,
            documents: [{ ...document, externalId: `boundary-${index}`, text }],
          },
          access,
        );
        const hits = yield* service.search({ ...scope, query, limit: 20 }, access);
        assert.strictEqual(hits.length, 1);
        const hit = hits[0]!;
        assert.strictEqual(hit.excerpt, text.slice(hit.start, hit.end));
        assert.deepStrictEqual(
          yield* service.get({ ...scope, revisionId: hit.revisionId, chunk: hit.chunk }, access),
          hit,
        );
        const chunks = yield* sql<{
          start: number;
          end: number;
          text: string;
          chunk: number;
        }>`SELECT start,end,text,chunk FROM command_center_knowledge_chunks WHERE revision_id=${receipt.revisions[0]!.revisionId} ORDER BY chunk`;
        assert.strictEqual(chunks.map((chunk) => chunk.text).join(""), text);
        assert.isTrue(chunks.length <= 43);
        for (const [i, chunk] of chunks.entries()) {
          assert.strictEqual(chunk.start, i === 0 ? 0 : chunks[i - 1]!.end);
          assert.strictEqual(chunk.text, text.slice(chunk.start, chunk.end));
          assert.isTrue(chunk.text.length <= 2048);
          assert.isTrue(chunk.text.isWellFormed());
        }
      }
      const account = yield* service.capture(
        {
          ...request,
          mutationId: "account",
          documents: [{ ...document, accountId: "other-account" }],
        },
        access,
      );
      const repo = yield* service.capture(
        { ...request, repositoryId: "repo", mutationId: "repo", documents: [document] },
        access,
      );
      assert.notStrictEqual(account.revisions[0]!.sourceId, created.revisions[0]!.sourceId);
      assert.notStrictEqual(repo.revisions[0]!.sourceId, created.revisions[0]!.sourceId);
      assert.strictEqual(
        (yield* service
          .get({ ...scope, revisionId: repo.revisions[0]!.revisionId, chunk: 0 }, access)
          .pipe(Effect.flip)).reason,
        "not_found",
      );
      yield* sql`INSERT INTO command_center_spaces(id,slug,name,kind,lifecycle,created_at,updated_at) VALUES('second-space','second-space','Fixture','business','active','2026-11-08T00:00:00.000Z','2026-11-08T00:00:00.000Z')`;
      const otherSpace = yield* service.capture({ ...request, spaceId: "second-space" }, access);
      assert.notStrictEqual(otherSpace.revisions[0]!.sourceId, created.revisions[0]!.sourceId);
      assert.strictEqual(
        (yield* service
          .get({ ...scope, revisionId: otherSpace.revisions[0]!.revisionId, chunk: 0 }, access)
          .pipe(Effect.flip)).reason,
        "not_found",
      );
      const otherScope = { ...scope, repositoryId: "repo" };
      assert.strictEqual(
        (yield* service.search({ ...otherScope, query: "saffron", limit: 20 }, access)).length,
        1,
      );
      assert.strictEqual(
        (yield* service.search({ ...scope, query: "saffron OR turmeric", limit: 20 }, access))
          .length,
        0,
      );
    }),
  );
});

it.effect(
  "rechecks original connected authority, account reassignment and capability revocation on cached reads",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* core;
      yield* migration;
      yield* sql`INSERT INTO command_center_spaces(id,slug,name,kind,lifecycle,created_at,updated_at) VALUES('connected','connected','Fixture','business','active','2026-11-08T00:00:00.000Z','2026-11-08T00:00:00.000Z')`;
      const state = yield* Ref.make({
        enabled: true,
        account: "fixture-account",
        serviceCapability: true,
        spaceId: "connected",
      });
      const capability = "cc.connections.google.gmail.read";
      const config = Layer.mock(CommandCenterConfig)({
        configDirectory: "/unused-knowledge-fixture",
        load: Ref.get(state).pipe(
          Effect.map(
            (value) =>
              ({
                spaces: [
                  {
                    id: "connected",
                    repositories: [],
                    policy: {
                      allowedCapabilities: [capability, "cc.items.read", "cc.items.write"],
                    },
                  },
                ],
                connections: value.enabled
                  ? [
                      {
                        id: "binding",
                        spaceId: value.spaceId,
                        kind: "google",
                        capabilities: value.serviceCapability ? [capability] : [],
                      },
                    ]
                  : [],
              }) as never,
          ),
        ),
        resolveGoogleAccount: () =>
          Ref.get(state).pipe(
            Effect.map((value) => ({ accountAlias: value.account, label: "Fixture" })),
          ),
      });
      const service = yield* Knowledge.make.pipe(Effect.provide(config));
      const owner = { kind: "owner", actorId: "fixture-server" } as const;
      const scope = { spaceId: "connected", repositoryId: null };
      const request = {
        ...scope,
        mutationId: "connected-one",
        documents: [
          {
            sourceKind: "gmail",
            bindingId: "binding",
            accountId: "fixture-account",
            externalId: "one",
            title: "Fixture",
            url: null,
            sourceUpdatedAt: "2026-11-08T00:00:00.000Z",
            text: "cinnamon cached source",
          },
        ],
      };
      const capture = yield* service.ingestConnected(request, owner, {
        operation: "gmail.get",
        account: "fixture-account",
      });
      const cited = { ...scope, revisionId: capture.revisions[0]!.revisionId, chunk: 0 };
      assert.strictEqual((yield* service.get(cited, owner)).acquisition, "connected");
      const imported = yield* service.capture({ ...request, mutationId: "imported-one" }, owner);
      assert.notStrictEqual(imported.revisions[0]!.sourceId, capture.revisions[0]!.sourceId);
      assert.strictEqual(
        (yield* service.get({ ...cited, revisionId: imported.revisions[0]!.revisionId }, owner))
          .acquisition,
        "imported",
      );
      const itemsOnly = {
        kind: "scoped",
        actorId: "agent",
        ...scope,
        capabilities: ["cc.items.read"],
      } as const;
      assert.strictEqual((yield* service.get(cited, itemsOnly).pipe(Effect.flip)).reason, "denied");
      assert.strictEqual(
        (yield* service.search({ ...scope, query: "cinnamon", limit: 20 }, itemsOnly)).length,
        1,
      );
      for (const patch of [
        { enabled: false },
        { account: "reassigned" },
        { serviceCapability: false },
        { spaceId: "other-space" },
      ]) {
        yield* Ref.set(state, {
          enabled: true,
          account: "fixture-account",
          serviceCapability: true,
          spaceId: "connected",
          ...patch,
        });
        assert.strictEqual((yield* service.get(cited, owner).pipe(Effect.flip)).reason, "denied");
        assert.strictEqual(
          (yield* service.search({ ...scope, query: "cinnamon", limit: 20 }, owner)).length,
          1,
        );
      }
      assert.strictEqual(
        (yield* service.capture({ ...request, acquisition: "connected" }, owner).pipe(Effect.flip))
          .reason,
        "validation",
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect.each(["policy", "removed", "reassigned"] as const)(
  "rechecks %s before knowledge operations and receipts",
  (revocation) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* core;
      yield* migration;
      yield* sql`INSERT INTO command_center_spaces(id,slug,name,kind,lifecycle,created_at,updated_at) VALUES('fixture','fixture','Fixture','business','active','2026-11-08T00:00:00.000Z','2026-11-08T00:00:00.000Z')`;
      const state = yield* Ref.make({
        capabilities: ["cc.items.read", "cc.items.write"],
        repositories: [{ id: "repo" }],
        available: true,
      });
      const config = Layer.mock(CommandCenterConfig)({
        configDirectory: "/unused-knowledge-fixture",
        load: Ref.get(state).pipe(
          Effect.map(
            (value) =>
              ({
                spaces: value.available
                  ? [
                      {
                        id: "fixture",
                        repositories: value.repositories,
                        policy: { allowedCapabilities: value.capabilities },
                      },
                      {
                        id: "other",
                        repositories:
                          revocation === "reassigned" && value.repositories.length === 0
                            ? [{ id: "repo" }]
                            : [],
                      },
                    ]
                  : [],
              }) as never,
          ),
        ),
      });
      const service = yield* Knowledge.make.pipe(Effect.provide(config));
      const scope = { spaceId: "fixture", repositoryId: "repo" };
      const owner = { kind: "owner", actorId: "owner" } as const;
      const scoped = {
        kind: "scoped",
        actorId: "run",
        ...scope,
        capabilities: ["cc.items.read", "cc.items.write"],
      } as const;
      const request = {
        ...scope,
        mutationId: "capture",
        documents: [
          {
            sourceKind: "note",
            bindingId: "manual",
            accountId: "fixture",
            externalId: "one",
            title: "Fixture",
            url: null,
            sourceUpdatedAt: "2026-11-08T00:00:00.000Z",
            text: "needle",
          },
        ],
      };
      const captured = yield* service.capture(request, scoped);
      const citation = { ...scope, revisionId: captured.revisions[0]!.revisionId, chunk: 0 };
      const retire = {
        ...scope,
        mutationId: "retire",
        sourceId: captured.revisions[0]!.sourceId,
        expectedRevisionId: captured.revisions[0]!.revisionId,
      };
      yield* service.retire(retire, scoped);
      const requireDenied = Effect.fn("Fixture.requireDenied")(function* (
        operation: Effect.Effect<unknown, Knowledge.KnowledgeError>,
      ) {
        const result = yield* operation.pipe(Effect.result);
        assert.isTrue(result._tag === "Failure" && result.failure.reason === "denied");
      });
      if (revocation === "policy") {
        yield* Ref.update(state, (value) => ({ ...value, capabilities: [] }));
        for (const operation of [
          service.get(citation, scoped),
          service.search({ ...scope, query: "needle", limit: 1 }, scoped),
          service.capture(request, scoped),
          service.capture({ ...request, mutationId: "fresh" }, scoped),
          service.retire(retire, scoped),
        ]) {
          yield* requireDenied(operation);
        }
      }
      yield* Ref.update(state, (value) => ({
        ...value,
        capabilities: ["cc.items.read", "cc.items.write"],
        repositories: [],
      }));
      for (const access of [owner, scoped]) {
        for (const operation of [
          service.get(citation, access),
          service.search({ ...scope, query: "needle", limit: 1 }, access),
          service.capture(request, access),
          service.capture({ ...request, mutationId: "fresh" }, access),
          service.retire(retire, access),
          service.capture(
            { ...request, repositoryId: "never-assigned" },
            { ...access, ...(access.kind === "scoped" ? { repositoryId: "never-assigned" } : {}) },
          ),
        ]) {
          yield* requireDenied(operation);
        }
      }
      yield* service.capture({ ...request, repositoryId: null, mutationId: "space-only" }, owner);
      yield* Ref.update(state, (value) => ({ ...value, available: false }));
      assert.strictEqual(
        (yield* service.capture({ ...request, repositoryId: null }, owner).pipe(Effect.flip))
          .reason,
        "denied",
      );
      const unavailable = yield* Knowledge.make;
      assert.strictEqual(
        (yield* unavailable.get(citation, owner).pipe(Effect.flip)).reason,
        "denied",
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
