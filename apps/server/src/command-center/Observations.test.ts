import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import baseMigration from "../persistence/Migrations/033_CommandCenterCore.ts";
import observationMigration from "../persistence/Migrations/073_CommandCenterObservations.ts";
import { make, type ObservationServiceShape } from "./Observations.ts";

const tests = it.layer(NodeSqliteClient.layerMemory());
tests("Observations", (it) => {
  const actor = { kind: "user", id: "server-user" } as const;
  const connector = { kind: "connector", id: "server-youtube" } as const;
  const at = "2026-09-21T12:01:00.000Z";

  const draft = (
    spaceId: string,
    id: string,
    method: "manual" | "imported" | "connected" = "manual",
  ) => ({
    id,
    spaceId,
    subjectId: "channel-a",
    channelId: "channel-a",
    contentKind: "channel",
    source: { identity: `${method}-${id}`, revision: "1" },
    metric: {
      kind: "channel-subscribers",
      unit: "count",
      definition: "Channel subscribers at the observation date.",
    },
    collectionMethod: method,
    data: {
      value: 10,
      observedAt: "2026-09-21T12:00:00.000Z",
      collectedAt: at,
      period: { start: "2026-09-21", end: "2026-09-21", timeZone: "UTC" },
      sampleCount: 1,
      denominator: { kind: "not-applicable", value: null },
      completeness: { status: "complete" },
      reportingLagMs: 60_000,
      freshThrough: "2026-09-21T12:00:00.000Z",
      metadata: {},
    },
  });

  const setup = Effect.fn("ObservationsTest.setup")(function* (spaceId: string) {
    const sql = yield* SqlClient.SqlClient;
    yield* baseMigration;
    yield* observationMigration;
    yield* sql`
    INSERT INTO command_center_spaces (
      id, slug, name, kind, instructions, policy_json, model_defaults_json,
      connections_json, repositories_json, aliases_json, lifecycle, created_at, updated_at
    ) VALUES (
      ${spaceId}, ${spaceId}, ${spaceId}, 'business', '', '{}', '{}', '[]', '[]', '[]',
      'active', ${at}, ${at}
    )
  `;
    return yield* make;
  });

  const create = (service: ObservationServiceShape, spaceId: string, id: string) =>
    service.createManual(
      { mutationId: `mutation-${id}`, expectedVersion: 0, observation: draft(spaceId, id) },
      actor,
    );

  it.effect(
    "stores an immutable correction and retirement while keeping missing distinct from zero",
    () =>
      Effect.gen(function* () {
        const service = yield* setup("space-revisions");
        const created = yield* create(service, "space-revisions", "observation-revisions");
        assert.strictEqual(created.version, 1);
        const initial = yield* service.get({
          spaceId: "space-revisions",
          observationId: created.observationId,
        });
        assert.strictEqual(initial.observation.data.value, 10);
        const corrected = yield* service.correct(
          {
            mutationId: "mutation-correction",
            spaceId: "space-revisions",
            observationId: created.observationId,
            expectedVersion: 1,
            reason: "Correct the transcribed count.",
            data: { ...initial.observation.data, value: 0 },
          },
          actor,
        );
        assert.strictEqual(corrected.version, 2);
        const current = yield* service.get({
          spaceId: "space-revisions",
          observationId: created.observationId,
        });
        assert.strictEqual(current.observation.data.value, 0);
        assert.notStrictEqual(current.revisionDigest, initial.revisionDigest);
        const missing = yield* service.correct(
          {
            mutationId: "mutation-missing",
            spaceId: "space-revisions",
            observationId: created.observationId,
            expectedVersion: 2,
            reason: "Source withdrew the count.",
            data: {
              ...initial.observation.data,
              value: null,
              missingReason: "Source withdrew the count.",
            },
          },
          actor,
        );
        assert.strictEqual(missing.version, 3);
        const history = yield* service.history({
          spaceId: "space-revisions",
          observationId: created.observationId,
          limit: 10,
        });
        assert.deepStrictEqual(
          history.map((entry) => entry.observation.data.value),
          [null, 0, 10],
        );
        assert.deepStrictEqual(
          history.map((entry) => entry.observation.source),
          [initial.observation.source, initial.observation.source, initial.observation.source],
        );
        const retired = yield* service.retire(
          {
            mutationId: "mutation-retire",
            spaceId: "space-revisions",
            observationId: created.observationId,
            expectedVersion: 3,
            reason: "Source is no longer authoritative.",
          },
          actor,
        );
        assert.strictEqual(retired.version, 4);
        const retiredCurrent = yield* service.get({
          spaceId: "space-revisions",
          observationId: created.observationId,
        });
        assert.strictEqual(retiredCurrent.retired, true);
        assert.notStrictEqual(retiredCurrent.revisionId, missing.revisionId);
        const stale = yield* service
          .correct(
            {
              mutationId: "mutation-stale",
              spaceId: "space-revisions",
              observationId: created.observationId,
              expectedVersion: 1,
              reason: "Should be rejected.",
              data: initial.observation.data,
            },
            actor,
          )
          .pipe(Effect.flip);
        assert.strictEqual(stale.reason, "conflict");
      }),
  );

  it.effect(
    "deduplicates exact mutation and source replay but rejects conflicting source reuse",
    () =>
      Effect.gen(function* () {
        const service = yield* setup("space-replay");
        const observation = draft("space-replay", "observation-replay");
        const first = yield* service.createManual(
          { mutationId: "replay-a", expectedVersion: 0, observation },
          actor,
        );
        const sameMutation = yield* service.createManual(
          { mutationId: "replay-a", expectedVersion: 0, observation },
          actor,
        );
        const sameSource = yield* service.createManual(
          { mutationId: "replay-b", expectedVersion: 0, observation },
          actor,
        );
        assert.strictEqual(first.deduplicated, false);
        assert.strictEqual(sameMutation.deduplicated, true);
        assert.strictEqual(sameSource.deduplicated, true);
        assert.strictEqual(sameSource.revisionId, first.revisionId);
        const differentActor = yield* service
          .createManual(
            { mutationId: "replay-a", expectedVersion: 0, observation },
            { kind: "user", id: "another-server-user" },
          )
          .pipe(Effect.flip);
        assert.strictEqual(differentActor.reason, "conflict");
        const reusedMutation = yield* service
          .createManual(
            {
              mutationId: "replay-a",
              expectedVersion: 0,
              observation: { ...observation, source: { identity: "different", revision: "1" } },
            },
            actor,
          )
          .pipe(Effect.flip);
        assert.strictEqual(reusedMutation.reason, "conflict");
        const conflictingSource = yield* service
          .createManual(
            {
              mutationId: "replay-c",
              expectedVersion: 0,
              observation: {
                ...observation,
                id: "observation-other",
                data: { ...observation.data, value: 11 },
              },
            },
            actor,
          )
          .pipe(Effect.flip);
        assert.strictEqual(conflictingSource.reason, "conflict");
      }),
  );

  it.effect("rolls back a batch with a conflicting source and rejects cross-Space reads", () =>
    Effect.gen(function* () {
      const service = yield* setup("space-batch");
      yield* create(service, "space-batch", "observation-existing");
      const importedA = draft("space-batch", "observation-import-a", "imported");
      const importedB = draft("space-batch", "observation-import-b", "imported");
      const failed = yield* service
        .importBatch(
          "space-batch",
          {
            mutationId: "batch-failed",
            observations: [
              importedA,
              { ...importedB, source: importedA.source, data: { ...importedB.data, value: 11 } },
            ],
          },
          actor,
        )
        .pipe(Effect.flip);
      assert.strictEqual(failed.reason, "conflict");
      const empty = yield* service.list({ spaceId: "space-batch", limit: 10 });
      assert.deepStrictEqual(
        empty.observations.map((item) => item.observation.id),
        ["observation-existing"],
      );
      const succeeded = yield* service.importBatch(
        "space-batch",
        {
          mutationId: "batch-ok",
          observations: [importedA, importedB],
        },
        actor,
      );
      assert.strictEqual(succeeded.observations.length, 2);
      const wrongSpace = yield* service
        .get({ spaceId: "space-not-present", observationId: "observation-import-a" })
        .pipe(Effect.flip);
      assert.strictEqual(wrongSpace.reason, "not-found");
    }),
  );

  it.effect("keeps connected input internal and shows a manual/connected collection conflict", () =>
    Effect.gen(function* () {
      const service = yield* setup("space-methods");
      yield* create(service, "space-methods", "observation-manual");
      const forbidden = yield* service
        .createManual(
          {
            mutationId: "forged-connected",
            expectedVersion: 0,
            observation: draft("space-methods", "observation-forged", "connected"),
          },
          actor,
        )
        .pipe(Effect.flip);
      assert.strictEqual(forbidden.reason, "validation");
      const connected = yield* service.ingestConnected(
        draft("space-methods", "observation-connected", "connected"),
        "connected-revision-1",
        connector,
      );
      assert.strictEqual(connected.version, 1);
      const manual = yield* service.get({
        spaceId: "space-methods",
        observationId: "observation-manual",
      });
      const live = yield* service.get({
        spaceId: "space-methods",
        observationId: "observation-connected",
      });
      assert.strictEqual(manual.observation.collectionMethod, "manual");
      assert.strictEqual(live.observation.collectionMethod, "connected");
      assert.strictEqual(manual.hasCollectionConflict, true);
      assert.strictEqual(live.hasCollectionConflict, true);
      const page = yield* service.list({ spaceId: "space-methods", limit: 1 });
      assert.strictEqual(page.observations.length, 1);
      assert.notStrictEqual(page.nextCursor, null);
    }),
  );
});
