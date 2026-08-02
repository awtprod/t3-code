import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { SpaceId } from "@command-center/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { EXTERNAL_PROSPECTOR_DB_ENV, make } from "./ExternalProspectorConnector.ts";

const createProspectorFixture = (filename: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE channels (
        channel_id TEXT, channel_name TEXT, channel_url TEXT, subscriber_count INTEGER,
        language TEXT, niche TEXT, upload_frequency TEXT, videos_last_30d INTEGER,
        monetization_notes TEXT, monetization_score INTEGER, extracted_email TEXT,
        contact_source TEXT, contact_url TEXT, contact_checked_at TEXT, website_url TEXT,
        thumbnail_tier INTEGER, thumbnail_notes TEXT, outreach_tier TEXT, growth_trend TEXT,
        updated_at TEXT, pipeline_status TEXT
      )
    `;
    yield* sql`CREATE TABLE suppressions (email TEXT PRIMARY KEY)`;
    yield* sql`
      INSERT INTO channels VALUES
        (
          'UC-ready-hot', 'Ready Hot', 'https://youtube.com/channel/UC-ready-hot', 42000,
          'en', 'Business education', 'Weekly', 5,
          'Paid cohort and sponsorships', 3, 'hello-ready@example.com',
          'website', 'https://ready.example/contact', '2026-07-05 20:54:33',
          'https://ready.example', 1, 'Strong ideas but inconsistent type scale.', 'hot',
          'rising_fast', '2026-07-05 20:54:33', 'ready'
        ),
        (
          'UC-ready-warm', 'Ready Warm', 'https://youtube.com/channel/UC-ready-warm', 24000,
          'en', 'Consulting', 'Every other week', 2,
          NULL, 1, 'team-warm@example.com',
          'youtube_description', NULL, NULL, NULL, 2,
          'Color treatment changes between otherwise related videos.', 'warm', 'steady',
          '2026-07-04 10:00:00', 'ready'
        ),
        (
          'UC-suppressed', 'Suppressed', 'https://youtube.com/channel/UC-suppressed', 30000,
          'en', 'Finance', 'Weekly', 4, 'Course', 2, 'STOP@example.com',
          'website', 'https://suppressed.example/contact', NULL, NULL, 1,
          'Inconsistent framing.', 'hot', 'rising', '2026-07-03 10:00:00', 'ready'
        ),
        (
          'UC-private-source', 'Private Source', 'https://youtube.com/channel/UC-private-source',
          30000, 'en', 'Finance', 'Weekly', 4, 'Course', 2, 'private@example.com',
          'youtube_reveal', 'https://youtube.com/channel/UC-private-source/about', NULL, NULL, 1,
          'Inconsistent framing.', 'hot', 'rising', '2026-07-03 10:00:00', 'ready'
        ),
        (
          'UC-not-ready', 'Not Ready', 'https://youtube.com/channel/UC-not-ready', 30000,
          'en', 'Finance', 'Weekly', 4, 'Course', 2, 'later@example.com',
          'website', 'https://later.example', NULL, NULL, 1,
          'Inconsistent framing.', 'hot', 'rising', '2026-07-03 10:00:00', 'qualified'
        ),
        (
          'UC-not-english', 'Not English', 'https://youtube.com/channel/UC-not-english', 30000,
          'fr', 'Finance', 'Weekly', 4, 'Course', 2, 'bonjour@example.com',
          'website', 'https://bonjour.example', NULL, NULL, 1,
          'Inconsistent framing.', 'hot', 'rising', '2026-07-03 10:00:00', 'ready'
        )
    `;
    yield* sql`INSERT INTO suppressions(email) VALUES ('stop@example.com')`;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })), Effect.scoped);

it.effect("imports only ready public unsuppressed prospects without modifying Prospector", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const filename = yield* fs.makeTempFileScoped({ suffix: ".sqlite" });
    yield* createProspectorFixture(filename);
    const connector = yield* make({ resolveDatabasePath: () => filename });

    const proposals = yield* connector.loadReady({
      spaceId: SpaceId.make("sales-space"),
      limit: 10,
    });

    expect(proposals).toHaveLength(2);
    expect(proposals[0]).toMatchObject({
      channelId: "UC-ready-hot",
      contactEmail: "hello-ready@example.com",
      provenanceKind: "automation",
      contactProvenance: {
        sourceUrl: "https://ready.example/contact",
        sourceLabel: "Public business website",
        isPublicBusinessContact: true,
        capturedAt: "2026-07-05T20:54:33.000Z",
      },
      fit: {
        score: 100,
        thumbnailAudit: "Strong ideas but inconsistent type scale.",
      },
    });
    expect(proposals[1]?.channelId).toBe("UC-ready-warm");
    expect(proposals.some((proposal) => proposal.channelId === "UC-suppressed")).toBe(false);
    expect(proposals.some((proposal) => proposal.channelId === "UC-private-source")).toBe(false);
    expect(proposals.some((proposal) => proposal.channelId === "UC-not-ready")).toBe(false);
    expect(proposals.some((proposal) => proposal.channelId === "UC-not-english")).toBe(false);

    const verification = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM channels`;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename, readonly: true })), Effect.scoped);
    expect(verification[0]?.count).toBe(6);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("fails closed when the host-only database path is not configured", () =>
  Effect.gen(function* () {
    const connector = yield* make({ resolveDatabasePath: () => undefined });
    const failure = yield* connector
      .loadReady({ spaceId: SpaceId.make("sales-space"), limit: 10 })
      .pipe(Effect.flip);

    expect(failure.reason).toBe("configuration");
    expect(failure.message).toContain(EXTERNAL_PROSPECTOR_DB_ENV);
  }).pipe(Effect.provide(NodeServices.layer)),
);
