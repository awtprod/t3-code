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
  extractedEmail: Schema.NullOr(Schema.String),
  contactSource: Schema.NullOr(Schema.String),
  contactMethod: Schema.NullOr(Schema.String),
  contactConfidence: Schema.NullOr(Schema.String),
  contactUrl: Schema.NullOr(Schema.String),
  contactCheckedAt: Schema.NullOr(Schema.String),
  websiteUrl: Schema.NullOr(Schema.String),
  thumbnailTier: Schema.NullOr(Schema.Number),
  thumbnailNotes: Schema.String,
  outreachTier: Schema.NullOr(Schema.String),
  growthTrend: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
  previousOutreach: Schema.Number,
});
export type ProspectorRow = typeof ProspectorRow.Type;

const TableNameRow = Schema.Struct({ name: Schema.String });
const HistoricalRow = Schema.Struct({
  ...ProspectorRow.fields,
  sourceSendId: Schema.Number,
  gmailDraftId: Schema.NullOr(Schema.String),
  gmailMessageId: Schema.NullOr(Schema.String),
  sendRecipient: Schema.String,
  sendSubject: Schema.String,
  sendBody: Schema.String,
  sendStatus: Schema.String,
  sendCreatedAt: Schema.NullOr(Schema.String),
  sendSentAt: Schema.NullOr(Schema.String),
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(ProspectorRow));
const decodeHistoricalRows = Schema.decodeUnknownEffect(Schema.Array(HistoricalRow));
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
  manual: "Manually verified public business website",
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
    readonly offset?: number | undefined;
  }) => Effect.Effect<
    ReadonlyArray<CommandCenterSalesProspectProposeInput>,
    ExternalProspectorConnectorError
  >;
  readonly loadHistoricalDrafts: (input: {
    readonly spaceId: CommandCenterSalesProspectProposeInput["spaceId"];
  }) => Effect.Effect<
    ReadonlyArray<{
      readonly proposal: CommandCenterSalesProspectProposeInput;
      readonly sourceSendId: number;
      readonly gmailDraftId?: string | undefined;
      readonly gmailMessageId?: string | undefined;
      readonly recipient: string;
      readonly subject: string;
      readonly body: string;
      readonly status: string;
      readonly createdAt: string;
      readonly sentAt?: string | undefined;
    }>,
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

export const SCORE_VERSION = "sales-weighted-v1";
const SCORE_MAX = 161;
const TARGET_NICHES = [
  "finance",
  "real estate",
  "business",
  "tech",
  "health",
  "career",
  "productivity",
  "crypto",
];

/** Normalize the external weighted score to a stable 0-100 scale. */
export const fitScore = (row: ProspectorRow): number => {
  let raw = 0;
  const subscribers = row.subscriberCount ?? 0;
  if (subscribers >= 20_000 && subscribers <= 150_000) raw += 25;
  else if (subscribers > 0) raw += 9;
  const niche = row.niche.toLowerCase();
  if (TARGET_NICHES.some((target) => niche === target || niche.includes(target))) raw += 16;
  if ((row.videosLast30d ?? 0) >= 4) raw += 18;
  raw += Math.min(30, Math.max(0, row.monetizationScore ?? 0) * 6);
  raw +=
    row.thumbnailTier === 1 ? 8 : row.thumbnailTier === 2 ? 26 : row.thumbnailTier === 3 ? 14 : 0;
  raw += row.contactConfidence === "high" ? 16 : row.contactConfidence === "medium" ? 6 : 0;
  raw +=
    row.growthTrend === "rising_fast"
      ? 30
      : row.growthTrend === "rising"
        ? 18
        : row.growthTrend === "steady"
          ? 4
          : row.growthTrend === "declining"
            ? -20
            : 0;
  if (nonEmpty(row.thumbnailNotes) === undefined && nonEmpty(row.monetizationNotes) === undefined)
    raw -= 12;
  return Math.max(0, Math.min(100, Math.round((raw / SCORE_MAX) * 100)));
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
  const thumbnailAudit = nonEmpty(row.thumbnailNotes) ?? "Thumbnail qualification is incomplete.";
  const legacyManualPublicContact =
    contactSource === "manual" &&
    row.contactMethod === "email" &&
    row.contactConfidence === "high" &&
    nonEmpty(row.contactCheckedAt) !== undefined &&
    nonEmpty(row.websiteUrl) !== undefined;
  if (
    channelId === undefined ||
    channelName === undefined ||
    channelUrl === undefined ||
    niche === undefined
  ) {
    return undefined;
  }

  const publicContact =
    contactEmail !== undefined &&
    contactSource !== undefined &&
    (PUBLIC_CONTACT_SOURCES.has(contactSource) || legacyManualPublicContact);
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
    publicContact
      ? `Public business contact source: ${CONTACT_SOURCE_LABELS[contactSource!] ?? contactSource}.`
      : "No verified public business email is available yet.",
    ...(nonEmpty(row.growthTrend) === undefined
      ? []
      : [`Growth trend: ${nonEmpty(row.growthTrend)!.replaceAll("_", " ")}.`]),
  ];
  const sourceVersion = nonEmpty(row.updatedAt) ?? "ready";
  const provenanceRef = `external-prospector:${channelId}:${sourceVersion}`;
  const score = fitScore(row);
  const icpEligible =
    score >= 75 &&
    publicContact &&
    row.subscriberCount !== null &&
    row.subscriberCount >= 20_000 &&
    row.subscriberCount <= 150_000 &&
    TARGET_NICHES.some((target) => niche.toLowerCase().includes(target)) &&
    (row.videosLast30d ?? 0) >= 4 &&
    row.previousOutreach === 0;

  return {
    requestId: provenanceRef,
    spaceId,
    channelId,
    channelName,
    channelUrl,
    ...(contactEmail === undefined ? {} : { contactEmail }),
    contactProvenance: {
      sourceUrl,
      ...(contactSource === undefined
        ? {}
        : { sourceLabel: CONTACT_SOURCE_LABELS[contactSource] ?? contactSource }),
      isPublicBusinessContact: publicContact,
      capturedAt: normalizedTimestamp(row.contactCheckedAt ?? row.updatedAt, observedAt),
    },
    ...(row.subscriberCount === null
      ? {}
      : { subscriberCount: Math.max(0, Math.round(row.subscriberCount)) }),
    language: nonEmpty(row.language) ?? "en",
    niche,
    fit: {
      score,
      reasons,
      thumbnailAudit,
      monetizationEvidence,
      publishingEvidence,
    },
    initialStage: icpEligible ? "qualified" : "researched",
    scoreVersion: SCORE_VERSION,
    evaluatedAt: normalizedTimestamp(row.updatedAt, observedAt),
    sourceRecordId: channelId,
    sourceVersion,
    nextAction: icpEligible
      ? "Create a reviewed Gmail draft"
      : "Review incomplete Prospector evidence",
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
        SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('suppressions', 'sends')
      `;
      const decodedNames = yield* decodeTableNames(tableNames);
      const names = new Set(decodedNames.map((row) => row.name));
      const suppressionClause = !names.has("suppressions")
        ? ""
        : "AND lower(trim(c.extracted_email)) NOT IN (SELECT lower(trim(email)) FROM suppressions)";
      const previousOutreachExpression = names.has("sends")
        ? "CASE WHEN EXISTS (SELECT 1 FROM sends s WHERE s.channel_id = c.id) THEN 1 ELSE 0 END"
        : "0";
      return yield* sql.unsafe<Readonly<Record<string, unknown>>>(
        `SELECT
          c.channel_id AS "channelId", c.channel_name AS "channelName",
          c.channel_url AS "channelUrl", c.subscriber_count AS "subscriberCount",
          c.language, c.niche, c.upload_frequency AS "uploadFrequency",
          c.videos_last_30d AS "videosLast30d",
          c.monetization_notes AS "monetizationNotes",
          c.monetization_score AS "monetizationScore",
          c.extracted_email AS "extractedEmail", c.contact_source AS "contactSource",
          c.contact_method AS "contactMethod", c.contact_confidence AS "contactConfidence",
          c.contact_url AS "contactUrl", c.contact_checked_at AS "contactCheckedAt",
          c.website_url AS "websiteUrl", c.thumbnail_tier AS "thumbnailTier",
          c.thumbnail_notes AS "thumbnailNotes", c.outreach_tier AS "outreachTier",
          c.growth_trend AS "growthTrend", c.updated_at AS "updatedAt",
          ${previousOutreachExpression} AS "previousOutreach"
        FROM channels c
        WHERE c.pipeline_status IN ('ready', 'growth_checked', 'qualified', 'has_email', 'needs_email')
          AND c.channel_id IS NOT NULL AND trim(c.channel_id) <> ''
          AND c.channel_name IS NOT NULL AND trim(c.channel_name) <> ''
          AND c.channel_url IS NOT NULL AND trim(c.channel_url) <> ''
          AND lower(c.language) LIKE 'en%'
          AND c.thumbnail_notes IS NOT NULL AND trim(c.thumbnail_notes) <> ''
          ${suppressionClause}
        ORDER BY
          CASE c.outreach_tier WHEN 'hot' THEN 1 WHEN 'warm' THEN 2 WHEN 'cold' THEN 3 ELSE 4 END,
          CASE c.growth_trend WHEN 'rising_fast' THEN 1 WHEN 'rising' THEN 2 WHEN 'steady' THEN 3 ELSE 4 END,
          COALESCE(c.videos_last_30d, 0) DESC,
          COALESCE(c.subscriber_count, 0) DESC,
          c.channel_id ASC
        LIMIT ? OFFSET ?`,
        [input.limit, input.offset ?? 0],
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

  const loadHistoricalDrafts: ExternalProspectorConnectorShape["loadHistoricalDrafts"] = Effect.fn(
    "ExternalProspectorConnector.loadHistoricalDrafts",
  )(function* (input) {
    const configuredPath = resolveDatabasePath();
    if (configuredPath === undefined || !path.isAbsolute(configuredPath)) {
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
            message: "The configured Prospector database is unavailable.",
            cause,
          }),
      ),
    );
    const raw = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.unsafe<Readonly<Record<string, unknown>>>(`
        SELECT c.channel_id AS "channelId", c.channel_name AS "channelName",
          c.channel_url AS "channelUrl", c.subscriber_count AS "subscriberCount",
          c.language, c.niche, c.upload_frequency AS "uploadFrequency",
          c.videos_last_30d AS "videosLast30d", c.monetization_notes AS "monetizationNotes",
          c.monetization_score AS "monetizationScore", c.extracted_email AS "extractedEmail",
          c.contact_source AS "contactSource", c.contact_method AS "contactMethod",
          c.contact_confidence AS "contactConfidence", c.contact_url AS "contactUrl",
          c.contact_checked_at AS "contactCheckedAt", c.website_url AS "websiteUrl",
          c.thumbnail_tier AS "thumbnailTier", c.thumbnail_notes AS "thumbnailNotes",
          c.outreach_tier AS "outreachTier", c.growth_trend AS "growthTrend",
          c.updated_at AS "updatedAt", 1 AS "previousOutreach",
          s.id AS "sourceSendId", s.gmail_draft_id AS "gmailDraftId",
          s.gmail_message_id AS "gmailMessageId", s.to_email AS "sendRecipient",
          s.subject AS "sendSubject", s.body AS "sendBody", s.status AS "sendStatus",
          s.created_at AS "sendCreatedAt", s.sent_at AS "sendSentAt"
        FROM sends s JOIN channels c ON c.id = s.channel_id
        ORDER BY s.id ASC
      `);
    }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: canonicalPath, readonly: true })),
      Effect.scoped,
      Effect.mapError(
        (cause) =>
          new ExternalProspectorConnectorError({
            reason: "schema",
            message: "Historical Prospector drafts could not be read.",
            cause,
          }),
      ),
    );
    const rows = yield* decodeHistoricalRows(raw).pipe(
      Effect.mapError(
        (cause) =>
          new ExternalProspectorConnectorError({
            reason: "schema",
            message: "Historical Prospector drafts were malformed.",
            cause,
          }),
      ),
    );
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    return rows.flatMap((row) => {
      const proposal = proposalFromRow(row, input.spaceId, observedAt);
      if (proposal === undefined) return [];
      return [
        {
          proposal,
          sourceSendId: row.sourceSendId,
          ...(nonEmpty(row.gmailDraftId) === undefined
            ? {}
            : { gmailDraftId: nonEmpty(row.gmailDraftId)! }),
          ...(nonEmpty(row.gmailMessageId) === undefined
            ? {}
            : { gmailMessageId: nonEmpty(row.gmailMessageId)! }),
          recipient: row.sendRecipient,
          subject: row.sendSubject,
          body: row.sendBody,
          status: row.sendStatus,
          createdAt: normalizedTimestamp(row.sendCreatedAt, observedAt),
          ...(row.sendSentAt === null
            ? {}
            : { sentAt: normalizedTimestamp(row.sendSentAt, observedAt) }),
        },
      ];
    });
  });

  return ExternalProspectorConnector.of({ loadReady, loadHistoricalDrafts });
});

export const layer = Layer.effect(ExternalProspectorConnector, make());

export const importReadyProspects = Effect.fn("ExternalProspectorConnector.importReadyProspects")(
  function* (
    connector: ExternalProspectorConnectorShape,
    sales: SalesPipelineShape,
    input: CommandCenterSalesProspectorImportInput,
  ): Effect.fn.Return<CommandCenterSalesProspectorImportResult, CommandCenterError> {
    const target = input.limit ?? 10;
    const pageSize = target;
    let offset = 0;
    let inspected = 0;
    let proposed = 0;
    let duplicates = 0;
    while (proposed < target) {
      const proposals = yield* connector
        .loadReady({ spaceId: input.spaceId, limit: pageSize, offset })
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
      if (proposals.length === 0) break;
      offset += proposals.length;
      for (const proposal of proposals) {
        inspected += 1;
        const result = yield* sales.propose(proposal);
        if (result.duplicate) duplicates += 1;
        else proposed += 1;
        if (proposed === target) break;
      }
      if (proposals.length < pageSize) break;
    }
    return { inspected, proposed, duplicates };
  },
);
