import {
  CommandCenterError,
  type CommandCenterSalesProspectProposeInput,
  type CommandCenterSalesProspectorImportInput,
  type CommandCenterSalesProspectorImportResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import type { SalesPipelineShape } from "./SalesPipeline.ts";

export const EXTERNAL_PROSPECTOR_DB_ENV = "COMMAND_CENTER_SALES_PROSPECTOR_DB";

const ProspectorRow = Schema.Struct({
  channelId: Schema.String,
  channelName: Schema.String,
  channelUrl: Schema.String,
  subscriberCount: Schema.NullOr(Schema.Number),
  language: Schema.NullOr(Schema.String),
  niche: Schema.String,
  uploadFrequency: Schema.NullOr(Schema.String),
  videosLast30d: Schema.NullOr(Schema.Number),
  monetizationNotes: Schema.NullOr(Schema.String),
  monetizationScore: Schema.NullOr(Schema.Number),
  extractedEmail: Schema.String,
  contactSource: Schema.String,
  contactUrl: Schema.NullOr(Schema.String),
  contactCheckedAt: Schema.NullOr(Schema.String),
  websiteUrl: Schema.NullOr(Schema.String),
  thumbnailTier: Schema.NullOr(Schema.Number),
  thumbnailNotes: Schema.String,
  outreachTier: Schema.NullOr(Schema.String),
  growthTrend: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
});
type ProspectorRow = typeof ProspectorRow.Type;

const TableNameRow = Schema.Struct({ name: Schema.String });
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(ProspectorRow));
const decodeTableNames = Schema.decodeUnknownEffect(Schema.Array(TableNameRow));

const PUBLIC_CONTACT_SOURCES = new Set([
  "youtube_description",
  "website",
  "legal_page",
  "bio_link",
  "contact_form",
  "social",
]);

const CONTACT_SOURCE_LABELS: Readonly<Record<string, string>> = {
  youtube_description: "Public YouTube description",
  website: "Public business website",
  legal_page: "Public legal page",
  bio_link: "Public bio-link page",
  contact_form: "Public contact page",
  social: "Public business social profile",
};

export class ExternalProspectorConnectorError extends Schema.TaggedErrorClass<ExternalProspectorConnectorError>()(
  "ExternalProspectorConnectorError",
  {
    reason: Schema.Literals(["configuration", "database", "schema"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ExternalProspectorConnectorShape {
  readonly loadReady: (input: {
    readonly spaceId: CommandCenterSalesProspectProposeInput["spaceId"];
    readonly limit: number;
  }) => Effect.Effect<
    ReadonlyArray<CommandCenterSalesProspectProposeInput>,
    ExternalProspectorConnectorError
  >;
}

export class ExternalProspectorConnector extends Context.Service<
  ExternalProspectorConnector,
  ExternalProspectorConnectorShape
>()("@awtprod/command-center/command-center/ExternalProspectorConnector") {}

export interface ExternalProspectorConnectorOptions {
  readonly resolveDatabasePath?: (() => string | undefined) | undefined;
}

const nonEmpty = (value: string | null): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

const normalizedTimestamp = (value: string | null, fallback: string): string => {
  const trimmed = nonEmpty(value);
  if (trimmed === undefined) return fallback;
  const candidate = trimmed.includes("T") ? trimmed : `${trimmed.replace(" ", "T")}Z`;
  return Option.match(DateTime.make(candidate), {
    onNone: () => fallback,
    onSome: DateTime.formatIso,
  });
};

const fitScore = (row: ProspectorRow): number => {
  const outreachBase = row.outreachTier === "hot" ? 80 : row.outreachTier === "warm" ? 72 : 64;
  const monetization = Math.min(10, Math.max(0, row.monetizationScore ?? 0) * 2);
  const publishing = (row.videosLast30d ?? 0) >= 4 ? 5 : (row.videosLast30d ?? 0) >= 1 ? 2 : 0;
  const thumbnails = row.thumbnailTier === 1 ? 5 : row.thumbnailTier === 2 ? 2 : 0;
  const growth = row.growthTrend === "rising_fast" ? 5 : row.growthTrend === "rising" ? 3 : 0;
  return Math.min(100, Math.round(outreachBase + monetization + publishing + thumbnails + growth));
};

const proposalFromRow = (
  row: ProspectorRow,
  spaceId: CommandCenterSalesProspectProposeInput["spaceId"],
  observedAt: string,
): CommandCenterSalesProspectProposeInput | undefined => {
  const channelId = nonEmpty(row.channelId);
  const channelName = nonEmpty(row.channelName);
  const channelUrl = nonEmpty(row.channelUrl);
  const contactEmail = nonEmpty(row.extractedEmail);
  const contactSource = nonEmpty(row.contactSource);
  const niche = nonEmpty(row.niche);
  const thumbnailAudit = nonEmpty(row.thumbnailNotes);
  if (
    channelId === undefined ||
    channelName === undefined ||
    channelUrl === undefined ||
    contactEmail === undefined ||
    contactSource === undefined ||
    niche === undefined ||
    thumbnailAudit === undefined ||
    !PUBLIC_CONTACT_SOURCES.has(contactSource)
  ) {
    return undefined;
  }

  const sourceUrl = nonEmpty(row.contactUrl) ?? nonEmpty(row.websiteUrl) ?? channelUrl;
  const publishingEvidence =
    nonEmpty(row.uploadFrequency) ??
    (row.videosLast30d === null
      ? "Publishing cadence was vetted in the external prospecting source."
      : `${row.videosLast30d} recent long-form uploads were recorded in the last 30 days.`);
  const monetizationEvidence =
    nonEmpty(row.monetizationNotes) ??
    `The external prospecting source recorded a monetization score of ${row.monetizationScore ?? 0}/5.`;
  const reasons = [
    `External prospecting source outreach tier: ${nonEmpty(row.outreachTier) ?? "unranked"}.`,
    row.subscriberCount === null
      ? "Subscriber count was not public."
      : `${Math.round(row.subscriberCount).toLocaleString("en-US")} subscribers.`,
    publishingEvidence,
    monetizationEvidence,
    `Public business contact source: ${CONTACT_SOURCE_LABELS[contactSource] ?? contactSource}.`,
    ...(nonEmpty(row.growthTrend) === undefined
      ? []
      : [`Growth trend: ${nonEmpty(row.growthTrend)!.replaceAll("_", " ")}.`]),
  ];
  const sourceVersion = nonEmpty(row.updatedAt) ?? "ready";
  const provenanceRef = `external-prospector:${channelId}:${sourceVersion}`;

  return {
    requestId: provenanceRef,
    spaceId,
    channelId,
    channelName,
    channelUrl,
    contactEmail,
    contactProvenance: {
      sourceUrl,
      sourceLabel: CONTACT_SOURCE_LABELS[contactSource] ?? contactSource,
      isPublicBusinessContact: true,
      capturedAt: normalizedTimestamp(row.contactCheckedAt ?? row.updatedAt, observedAt),
    },
    ...(row.subscriberCount === null
      ? {}
      : { subscriberCount: Math.max(0, Math.round(row.subscriberCount)) }),
    language: nonEmpty(row.language) ?? "en",
    niche,
    fit: {
      score: fitScore(row),
      reasons,
      thumbnailAudit,
      monetizationEvidence,
      publishingEvidence,
    },
    nextAction: "Review Prospector evidence and qualify manually",
    provenanceKind: "automation",
    provenanceRef,
  };
};

export const make = Effect.fn("ExternalProspectorConnector.make")(function* (
  options: ExternalProspectorConnectorOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolveDatabasePath =
    options.resolveDatabasePath ?? (() => process.env[EXTERNAL_PROSPECTOR_DB_ENV]);

  const loadReady: ExternalProspectorConnectorShape["loadReady"] = Effect.fn(
    "ExternalProspectorConnector.loadReady",
  )(function* (input) {
    const configuredPath = resolveDatabasePath();
    if (configuredPath === undefined || configuredPath.trim().length === 0) {
      return yield* new ExternalProspectorConnectorError({
        reason: "configuration",
        message: `Set ${EXTERNAL_PROSPECTOR_DB_ENV} to the external prospecting source SQLite file.`,
      });
    }
    if (!path.isAbsolute(configuredPath) || path.resolve(configuredPath) !== configuredPath) {
      return yield* new ExternalProspectorConnectorError({
        reason: "configuration",
        message: `${EXTERNAL_PROSPECTOR_DB_ENV} must be an exact absolute file path.`,
      });
    }
    const canonicalPath = yield* fs.realPath(configuredPath).pipe(
      Effect.mapError(
        (cause) =>
          new ExternalProspectorConnectorError({
            reason: "configuration",
            message: "The configured external prospecting source database is unavailable.",
            cause,
          }),
      ),
    );
    const info = yield* fs.stat(canonicalPath).pipe(
      Effect.mapError(
        (cause) =>
          new ExternalProspectorConnectorError({
            reason: "configuration",
            message: "The configured external prospecting source database cannot be inspected.",
            cause,
          }),
      ),
    );
    if (info.type !== "File") {
      return yield* new ExternalProspectorConnectorError({
        reason: "configuration",
        message: `${EXTERNAL_PROSPECTOR_DB_ENV} must identify a SQLite file.`,
      });
    }

    const rawRows = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tableNames = yield* sql<Readonly<Record<string, unknown>>>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'suppressions'
      `;
      const decodedNames = yield* decodeTableNames(tableNames);
      const suppressionClause =
        decodedNames.length === 0
          ? ""
          : "AND lower(trim(c.extracted_email)) NOT IN (SELECT lower(trim(email)) FROM suppressions)";
      return yield* sql.unsafe<Readonly<Record<string, unknown>>>(
        `SELECT
          c.channel_id AS "channelId", c.channel_name AS "channelName",
          c.channel_url AS "channelUrl", c.subscriber_count AS "subscriberCount",
          c.language, c.niche, c.upload_frequency AS "uploadFrequency",
          c.videos_last_30d AS "videosLast30d",
          c.monetization_notes AS "monetizationNotes",
          c.monetization_score AS "monetizationScore",
          c.extracted_email AS "extractedEmail", c.contact_source AS "contactSource",
          c.contact_url AS "contactUrl", c.contact_checked_at AS "contactCheckedAt",
          c.website_url AS "websiteUrl", c.thumbnail_tier AS "thumbnailTier",
          c.thumbnail_notes AS "thumbnailNotes", c.outreach_tier AS "outreachTier",
          c.growth_trend AS "growthTrend", c.updated_at AS "updatedAt"
        FROM channels c
        WHERE c.pipeline_status = 'ready'
          AND c.channel_id IS NOT NULL AND trim(c.channel_id) <> ''
          AND c.channel_name IS NOT NULL AND trim(c.channel_name) <> ''
          AND c.channel_url IS NOT NULL AND trim(c.channel_url) <> ''
          AND c.extracted_email IS NOT NULL AND trim(c.extracted_email) <> ''
          AND c.contact_source IN (
            'youtube_description', 'website', 'legal_page', 'bio_link', 'contact_form', 'social'
          )
          AND lower(c.language) LIKE 'en%'
          AND c.thumbnail_notes IS NOT NULL AND trim(c.thumbnail_notes) <> ''
          ${suppressionClause}
        ORDER BY
          CASE c.outreach_tier WHEN 'hot' THEN 1 WHEN 'warm' THEN 2 WHEN 'cold' THEN 3 ELSE 4 END,
          CASE c.growth_trend WHEN 'rising_fast' THEN 1 WHEN 'rising' THEN 2 WHEN 'steady' THEN 3 ELSE 4 END,
          COALESCE(c.videos_last_30d, 0) DESC,
          COALESCE(c.subscriber_count, 0) DESC,
          c.channel_id ASC
        LIMIT ?`,
        [input.limit],
      );
    }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: canonicalPath, readonly: true })),
      Effect.scoped,
      Effect.mapError(
        (cause) =>
          new ExternalProspectorConnectorError({
            reason: "schema",
            message:
              "The external prospecting source database does not match the supported schema.",
            cause,
          }),
      ),
    );
    const rows = yield* decodeRows(rawRows).pipe(
      Effect.mapError(
        (cause) =>
          new ExternalProspectorConnectorError({
            reason: "schema",
            message: "The external prospecting source returned malformed candidate data.",
            cause,
          }),
      ),
    );
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    return rows.flatMap((row) => {
      const proposal = proposalFromRow(row, input.spaceId, observedAt);
      return proposal === undefined ? [] : [proposal];
    });
  });

  return ExternalProspectorConnector.of({ loadReady });
});

export const layer = Layer.effect(ExternalProspectorConnector, make());

export const importReadyProspects = Effect.fn("ExternalProspectorConnector.importReadyProspects")(
  function* (
    connector: ExternalProspectorConnectorShape,
    sales: SalesPipelineShape,
    input: CommandCenterSalesProspectorImportInput,
  ): Effect.fn.Return<CommandCenterSalesProspectorImportResult, CommandCenterError> {
    const proposals = yield* connector
      .loadReady({ spaceId: input.spaceId, limit: input.limit ?? 10 })
      .pipe(
        Effect.mapError(
          (cause) =>
            new CommandCenterError({
              reason: cause.reason === "configuration" ? "config" : "connector",
              message: cause.message,
              cause,
            }),
        ),
      );
    let proposed = 0;
    let duplicates = 0;
    for (const proposal of proposals) {
      const result = yield* sales.propose(proposal);
      if (result.duplicate) duplicates += 1;
      else proposed += 1;
    }
    return { inspected: proposals.length, proposed, duplicates };
  },
);
