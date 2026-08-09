import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { SpaceId } from "@command-center/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  EXTERNAL_PROSPECTOR_DB_ENV,
  importReadyProspects,
  make,
} from "./ExternalProspectorConnector.ts";
import type { SalesPipelineShape } from "./SalesPipeline.ts";

const createProspectorFixture = (filename: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE channels (
        channel_id TEXT, channel_name TEXT, channel_url TEXT, subscriber_count INTEGER,
        language TEXT, niche TEXT, upload_frequency TEXT, videos_last_30d INTEGER,
        monetization_notes TEXT, monetization_score INTEGER, extracted_email TEXT,
        contact_source TEXT, contact_method TEXT, contact_confidence TEXT,
        contact_url TEXT, contact_checked_at TEXT, website_url TEXT,
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
          'website', NULL, NULL, 'https://ready.example/contact', '2026-07-05 20:54:33',
          'https://ready.example', 1, 'Strong ideas but inconsistent type scale.', 'hot',
          'rising_fast', '2026-07-05 20:54:33', 'ready'
        ),
        (
          'UC-ready-warm', 'Ready Warm', 'https://youtube.com/channel/UC-ready-warm', 24000,
          'en', 'Consulting', 'Every other week', 2,
          NULL, 1, 'team-warm@example.com',
          'youtube_description', NULL, NULL, NULL, NULL, NULL, 2,
          'Color treatment changes between otherwise related videos.', 'warm', 'steady',
          '2026-07-04 10:00:00', 'ready'
        ),
        (
          'UC-suppressed', 'Suppressed', 'https://youtube.com/channel/UC-suppressed', 30000,
          'en', 'Finance', 'Weekly', 4, 'Course', 2, 'STOP@example.com',
          'website', NULL, NULL, 'https://suppressed.example/contact', NULL, NULL, 1,
          'Inconsistent framing.', 'hot', 'rising', '2026-07-03 10:00:00', 'ready'
        ),
        (
          'UC-private-source', 'Private Source', 'https://youtube.com/channel/UC-private-source',
          30000, 'en', 'Finance', 'Weekly', 4, 'Course', 2, 'private@example.com',
          'youtube_reveal', 'email', 'high',
          'https://youtube.com/channel/UC-private-source/about', NULL, NULL, 1,
          'Inconsistent framing.', 'hot', 'rising', '2026-07-03 10:00:00', 'ready'
        ),
        (
          'UC-not-ready', 'Not Ready', 'https://youtube.com/channel/UC-not-ready', 30000,
          'en', 'Finance', 'Weekly', 4, 'Course', 2, 'later@example.com',
          'website', NULL, NULL, 'https://later.example', NULL, NULL, 1,
          'Inconsistent framing.', 'hot', 'rising', '2026-07-03 10:00:00', 'qualified'
        ),
        (
          'UC-not-english', 'Not English', 'https://youtube.com/channel/UC-not-english', 30000,
          'fr', 'Finance', 'Weekly', 4, 'Course', 2, 'bonjour@example.com',
          'website', NULL, NULL, 'https://bonjour.example', NULL, NULL, 1,
          'Inconsistent framing.', 'hot', 'rising', '2026-07-03 10:00:00', 'ready'
        ),
        (
          'UC-verified-manual', 'Verified Manual',
          'https://youtube.com/channel/UC-verified-manual', 18000,
          'en', 'Marketing', 'Weekly', 3, 'Consulting business', 2,
          'verified@example.com', 'manual', 'email', 'high', NULL,
          '2026-07-02 09:00:00', 'https://verified.example', 2,
          'Readable concepts with inconsistent visual hierarchy.', 'cold', 'steady',
          '2026-07-02 09:00:00', 'ready'
        ),
        (
          'UC-unverified-manual', 'Unverified Manual',
          'https://youtube.com/channel/UC-unverified-manual', 18000,
          'en', 'Marketing', 'Weekly', 3, 'Consulting business', 2,
          'unverified@example.com', 'manual', 'email', 'high', NULL,
          NULL, 'https://unverified.example', 2,
          'Readable concepts with inconsistent visual hierarchy.', 'cold', 'steady',
          '2026-07-01 09:00:00', 'ready'
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

    expect(proposals).toHaveLength(6);
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
        score: 71,
        thumbnailAudit: "Strong ideas but inconsistent type scale.",
      },
    });
    expect(proposals.some((proposal) => proposal.channelId === "UC-ready-warm")).toBe(true);
    expect(proposals.find((proposal) => proposal.channelId === "UC-verified-manual")).toMatchObject(
      {
        channelId: "UC-verified-manual",
        contactProvenance: {
          sourceUrl: "https://verified.example",
          sourceLabel: "Manually verified public business website",
          isPublicBusinessContact: true,
          capturedAt: "2026-07-02T09:00:00.000Z",
        },
      },
    );
    expect(proposals.some((proposal) => proposal.channelId === "UC-suppressed")).toBe(false);
    expect(proposals.find((proposal) => proposal.channelId === "UC-private-source")).toMatchObject({
      initialStage: "researched",
      contactProvenance: { isPublicBusinessContact: false },
    });
    expect(proposals.some((proposal) => proposal.channelId === "UC-not-ready")).toBe(true);
    expect(proposals.some((proposal) => proposal.channelId === "UC-not-english")).toBe(false);
    expect(
      proposals.find((proposal) => proposal.channelId === "UC-unverified-manual"),
    ).toMatchObject({
      initialStage: "researched",
      contactProvenance: { isPublicBusinessContact: false },
    });

    const verification = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM channels`;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename, readonly: true })), Effect.scoped);
    expect(verification[0]?.count).toBe(8);
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

it.effect(
  "pages past existing prospects until it imports the requested number of new records",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filename = yield* fs.makeTempFileScoped({ suffix: ".sqlite" });
      yield* createProspectorFixture(filename);
      const connector = yield* make({ resolveDatabasePath: () => filename });
      const existing = new Set(["UC-ready-hot", "UC-ready-warm"]);
      const sales = {
        propose: (proposal: { readonly channelId?: string | undefined }) => {
          const duplicate = proposal.channelId !== undefined && existing.has(proposal.channelId);
          if (proposal.channelId !== undefined) existing.add(proposal.channelId);
          return Effect.succeed({ duplicate, prospect: proposal });
        },
      } as unknown as SalesPipelineShape;

      const result = yield* importReadyProspects(connector, sales, {
        spaceId: SpaceId.make("sales-space"),
        limit: 1,
      });

      expect(result).toEqual({ inspected: 2, proposed: 1, duplicates: 1 });
      expect(existing.size).toBe(3);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
