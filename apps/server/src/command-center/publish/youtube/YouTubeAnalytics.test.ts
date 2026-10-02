import { assert, it } from "@effect/vitest";
import { CommandCenterYouTubeAnalyticsFetchInput } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../../persistence/NodeSqliteClient.ts";
import baseMigration from "../../../persistence/Migrations/033_CommandCenterCore.ts";
import observationMigration from "../../../persistence/Migrations/073_CommandCenterObservations.ts";
import { make as makeObservations, ObservationService } from "../../Observations.ts";
import { make as makeAnalytics, pacificDayEnd } from "./YouTubeAnalytics.ts";
import { YouTubeTokenStore } from "./YouTubeTokenStore.ts";

const spaceId = "youtube-analytics-test-space";
const channelId = "UC1234567890123456789012";
const videoId = "AbCdEf12345";
const period = { startDate: "2026-09-01", endDate: "2026-09-07" };
const decodeInput = Schema.decodeUnknownEffect(CommandCenterYouTubeAnalyticsFetchInput);

const manualSource = {
  id: "youtube-manual-source",
  spaceId,
  subjectId: "synthetic-video-subject-001",
  channelId,
  contentId: videoId,
  cohortId: "published-2026-08",
  contentKind: "short-form",
  source: { identity: "manual-video-source", revision: "1" },
  metric: {
    kind: "average-view-percentage",
    unit: "percent",
    definition: "Manually copied average view percentage.",
  },
  collectionMethod: "manual",
  data: {
    value: 55,
    observedAt: "2026-09-07T00:00:00.000Z",
    collectedAt: "2026-09-08T00:00:00.000Z",
    period: { start: "2026-09-01", end: "2026-09-07", timeZone: "America/Los_Angeles" },
    publishedAt: "2026-08-27T00:00:00.000Z",
    sampleCount: 100,
    denominator: { kind: "views", value: 100 },
    completeness: { status: "complete" },
    reportingLagMs: 86_400_000,
    freshThrough: "2026-09-07T00:00:00.000Z",
    metadata: {},
  },
};

const tokens = YouTubeTokenStore.of({
  summary: Effect.die("unused"),
  begin: Effect.die("unused"),
  disconnect: Effect.die("unused"),
  accessToken: Effect.die("unused"),
  analyticsAccessToken: Effect.succeed("test-access-token"),
  recordAnalyticsCheck: () => Effect.void,
  invalidateAccessToken: Effect.void,
  recordChannel: () => Effect.die("unused"),
});

it.layer(NodeSqliteClient.layerMemory())("YouTube Analytics ingestion", (it) => {
  it("maps freshness through the end of a Pacific reporting day", () => {
    assert.strictEqual(pacificDayEnd("2026-03-08"), "2026-03-09T06:59:59.999Z");
    assert.strictEqual(pacificDayEnd("2026-11-01"), "2026-11-02T07:59:59.999Z");
  });
  it.effect("ingests scoped connected revisions once and preserves the manual source", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(
        DateTime.toEpochMillis(DateTime.makeUnsafe("2026-09-28T00:00:00.000Z")),
      );
      const sql = yield* SqlClient.SqlClient;
      yield* baseMigration;
      yield* observationMigration;
      yield* sql`
        INSERT INTO command_center_spaces (
          id, slug, name, kind, instructions, policy_json, model_defaults_json,
          connections_json, repositories_json, aliases_json, lifecycle, created_at, updated_at
        ) VALUES (
          ${spaceId}, ${spaceId}, ${spaceId}, 'business', '', '{}', '{}', '[]', '[]', '[]',
          'active', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
        )
      `;
      const observations = yield* makeObservations;
      const seed = yield* observations.createManual(
        {
          mutationId: "manual-youtube-seed",
          expectedVersion: 0,
          observation: manualSource,
        },
        { kind: "user", id: "test" },
      );
      let fetches = 0;
      let reportRows: ReadonlyArray<ReadonlyArray<string | number>> = [["2026-09-07", 20, 16, 70]];
      const fetchImpl = async () => {
        fetches += 1;
        return Response.json({
          kind: "youtubeAnalytics#resultTable",
          columnHeaders: ["day", "views", "averageViewDuration", "averageViewPercentage"].map(
            (name) => ({ name }),
          ),
          rows: reportRows,
        });
      };
      const analytics = yield* makeAnalytics({ fetchImpl }).pipe(
        Effect.provideService(ObservationService, observations),
        Effect.provideService(YouTubeTokenStore, tokens),
      );
      const input = yield* decodeInput({
        spaceId,
        sourceObservationId: seed.observationId,
        expectedSourceRevisionId: seed.revisionId,
        channelId,
        videoId,
        ...period,
      });
      const first = yield* analytics.fetch(input);
      const replay = yield* analytics.fetch(input);
      assert.strictEqual(fetches, 2);
      assert.strictEqual(first.deduplicated, false);
      assert.strictEqual(replay.deduplicated, true);
      assert.deepStrictEqual(replay.observationIds, first.observationIds);
      assert.strictEqual(first.observationIds.length, 2);
      const connected = yield* observations.get({
        spaceId,
        observationId: first.observationIds[0],
      });
      assert.strictEqual(connected.observation.collectionMethod, "connected");
      assert.strictEqual(connected.observation.data.value, 70);
      assert.strictEqual(connected.observation.data.denominator.value, 20);
      assert.strictEqual(connected.observation.data.period.timeZone, "America/Los_Angeles");
      assert.strictEqual(
        (yield* observations.get({ spaceId, observationId: seed.observationId })).observation.data
          .value,
        55,
      );
      const wrongSpaceInput = yield* decodeInput({ ...input, spaceId: "another-space" });
      const wrongSpace = yield* analytics.fetch(wrongSpaceInput).pipe(Effect.flip);
      assert.strictEqual(wrongSpace.reason, "not_found");
      const wrongChannel = yield* analytics
        .fetch({ ...input, channelId: "UC0000000000000000000000" })
        .pipe(Effect.flip);
      assert.strictEqual(wrongChannel.reason, "validation");
      assert.strictEqual(fetches, 2);
      reportRows = [];
      const missing = yield* analytics.fetch({
        ...input,
        startDate: "2026-09-08",
        endDate: "2026-09-09",
      });
      assert.strictEqual(missing.status, "missing");
      assert.strictEqual(missing.views, null);
      const missingObservation = yield* observations.get({
        spaceId,
        observationId: missing.observationIds[0],
      });
      assert.strictEqual(missingObservation.observation.data.value, null);
      assert.strictEqual(missingObservation.observation.data.sampleCount, null);
      assert.strictEqual(missingObservation.observation.data.completeness.status, "missing");
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())(
  "YouTube Analytics source changes during a fetch",
  (it) => {
    it.effect("writes nothing when the source is corrected or retired mid-fetch", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe("2026-09-28T00:00:00.000Z")),
        );
        const sql = yield* SqlClient.SqlClient;
        yield* baseMigration;
        yield* observationMigration;
        yield* sql`
        INSERT INTO command_center_spaces (
          id, slug, name, kind, instructions, policy_json, model_defaults_json,
          connections_json, repositories_json, aliases_json, lifecycle, created_at, updated_at
        ) VALUES (
          ${spaceId}, ${spaceId}, ${spaceId}, 'business', '', '{}', '{}', '[]', '[]', '[]',
          'active', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
        )
      `;
        const observations = yield* makeObservations;
        const user = { kind: "user", id: "test" } as const;
        const seed = yield* observations.createManual(
          { mutationId: "manual-youtube-seed", expectedVersion: 0, observation: manualSource },
          user,
        );
        // The token store records the successful check after the report arrives and before any
        // observation is written, so a source change injected there lands mid-fetch.
        let duringFetch: Effect.Effect<void> = Effect.void;
        const fetchImpl = async () =>
          Response.json({
            kind: "youtubeAnalytics#resultTable",
            columnHeaders: ["day", "views", "averageViewDuration", "averageViewPercentage"].map(
              (name) => ({ name }),
            ),
            rows: [["2026-09-07", 20, 16, 70]],
          });
        const analytics = yield* makeAnalytics({ fetchImpl }).pipe(
          Effect.provideService(ObservationService, observations),
          Effect.provideService(
            YouTubeTokenStore,
            YouTubeTokenStore.of({ ...tokens, recordAnalyticsCheck: () => duringFetch }),
          ),
        );
        const countObservations = sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM command_center_observations
      `.pipe(Effect.map((rows) => rows[0]?.count));
        const fetchFrom = (revisionId: string) =>
          decodeInput({
            spaceId,
            sourceObservationId: seed.observationId,
            expectedSourceRevisionId: revisionId,
            channelId,
            videoId,
            ...period,
          }).pipe(Effect.orDie, Effect.flatMap(analytics.fetch), Effect.flip);

        duringFetch = observations
          .correct(
            {
              mutationId: "correct-during-fetch",
              spaceId,
              observationId: seed.observationId,
              expectedVersion: seed.version,
              reason: "The manual copy used the wrong period.",
              data: { ...manualSource.data, value: 56 },
            },
            user,
          )
          .pipe(Effect.asVoid, Effect.orDie);
        assert.strictEqual((yield* fetchFrom(seed.revisionId)).reason, "conflict");
        assert.strictEqual(yield* countObservations, 1);

        const corrected = yield* observations.get({ spaceId, observationId: seed.observationId });
        assert.strictEqual(corrected.observation.data.value, 56);
        duringFetch = observations
          .retire(
            {
              mutationId: "retire-during-fetch",
              spaceId,
              observationId: seed.observationId,
              expectedVersion: corrected.version,
              reason: "The manual source is no longer trusted.",
            },
            user,
          )
          .pipe(Effect.asVoid, Effect.orDie);
        assert.strictEqual((yield* fetchFrom(corrected.revisionId)).reason, "conflict");
        assert.strictEqual(yield* countObservations, 1);
        assert.isTrue(
          (yield* observations.get({ spaceId, observationId: seed.observationId })).retired,
        );
      }),
    );
  },
);
