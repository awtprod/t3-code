import {
  SALES_OPPORTUNITY_CENTS,
  SalesActivity,
  SalesDraftRequest,
  SalesProspect,
  type CapabilityName,
  type SalesActivity as SalesActivityType,
  type SalesProspect as SalesProspectType,
  type SalesProspectStage,
} from "@command-center/core";
import {
  CommandCenterError,
  type CommandCenterSalesDraftDecisionInput,
  type CommandCenterSalesDraftCreateInput,
  type CommandCenterSalesGmailDraftCreateInput,
  type CommandCenterSalesDraftRequestInput,
  type CommandCenterSalesDraftResult,
  type CommandCenterSalesProspectDetail,
  type CommandCenterSalesProspectProposeInput,
  type CommandCenterSalesProspectProposeResult,
  type CommandCenterSalesProspectsQueryInput,
  type CommandCenterSalesProspectsQueryResult,
  type CommandCenterSalesProspectUpdateInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

interface ProspectRow {
  readonly id: string;
  readonly spaceId: string;
  readonly stage: string;
  readonly channelId: string | null;
  readonly channelName: string;
  readonly channelUrl: string;
  readonly contactName: string | null;
  readonly contactEmail: string | null;
  readonly contactProvenanceJson: string;
  readonly subscriberCount: number | null;
  readonly language: string;
  readonly niche: string;
  readonly fitJson: string;
  readonly score: number;
  readonly scoreVersion: string;
  readonly evaluatedAt: string | null;
  readonly sourceRecordId: string | null;
  readonly sourceVersion: string | null;
  readonly nextAction: string | null;
  readonly nextActionAt: string | null;
  readonly opportunityCents: number;
  readonly gmailConnectionId: string | null;
  readonly gmailDraftId: string | null;
  readonly gmailThreadId: string | null;
  readonly gmailMessageId: string | null;
  readonly campaignVersion: string | null;
  readonly sentAt: string | null;
  readonly repliedAt: string | null;
  readonly bouncedAt: string | null;
  readonly draftDeletedAt: string | null;
  readonly suppressedAt: string | null;
  readonly nextFollowUpAt: string | null;
  readonly day3SentAt: string | null;
  readonly provenanceKind: string;
  readonly provenanceRef: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ActivityRow {
  readonly id: string;
  readonly prospectId: string;
  readonly spaceId: string;
  readonly kind: string;
  readonly actorKind: string;
  readonly payloadJson: string;
  readonly occurredAt: string;
}

interface DraftRow {
  readonly id: string;
  readonly prospectId: string;
  readonly spaceId: string;
  readonly connectionId: string;
  readonly recipient: string;
  readonly subject: string;
  readonly body: string;
  readonly payloadDigest: string;
  readonly status: string;
  readonly gmailDraftId: string | null;
  readonly gmailMessageId: string | null;
  readonly gmailThreadId: string | null;
  readonly draftKind: string;
  readonly campaignVersion: string;
  readonly campaignStep: number;
  readonly idempotencyKey: string | null;
  readonly evidenceJson: string;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly createdAt: string | null;
  readonly failure: string | null;
  readonly sentAt: string | null;
  readonly deletedAt: string | null;
}

interface SpaceGateRow {
  readonly featuresJson: string;
  readonly policyJson: string;
}

export interface SalesPipelineShape {
  readonly query: (
    input: CommandCenterSalesProspectsQueryInput,
  ) => Effect.Effect<CommandCenterSalesProspectsQueryResult, CommandCenterError>;
  readonly propose: (
    input: CommandCenterSalesProspectProposeInput,
  ) => Effect.Effect<CommandCenterSalesProspectProposeResult, CommandCenterError>;
  readonly update: (
    input: CommandCenterSalesProspectUpdateInput,
  ) => Effect.Effect<CommandCenterSalesProspectDetail, CommandCenterError>;
  readonly requestDraft: (
    input: CommandCenterSalesDraftRequestInput,
  ) => Effect.Effect<CommandCenterSalesDraftResult, CommandCenterError>;
  readonly decideDraft: (
    input: CommandCenterSalesDraftDecisionInput,
  ) => Effect.Effect<CommandCenterSalesDraftResult, CommandCenterError>;
  readonly getDraftRequest: (input: {
    readonly requestId: string;
    readonly spaceId: string;
  }) => Effect.Effect<CommandCenterSalesDraftResult, CommandCenterError>;
  readonly claimDraftCreate: (
    input: CommandCenterSalesDraftCreateInput,
  ) => Effect.Effect<CommandCenterSalesDraftResult, CommandCenterError>;
  readonly completeDraftCreate: (input: {
    readonly requestId: string;
    readonly spaceId: string;
    readonly payloadDigest: string;
    readonly draftId: string;
    readonly reconciled: boolean;
  }) => Effect.Effect<CommandCenterSalesDraftResult, CommandCenterError>;
  readonly failDraftCreate: (input: {
    readonly requestId: string;
    readonly spaceId: string;
    readonly payloadDigest: string;
    readonly message: string;
  }) => Effect.Effect<void, CommandCenterError>;
  readonly reconcileGmailEvidence: (input: {
    readonly prospectId: string;
    readonly spaceId: string;
    readonly sent: boolean;
    readonly replied: boolean;
    readonly bounced?: boolean | undefined;
    readonly deleted?: boolean | undefined;
    readonly draftRequestId?: string | undefined;
    readonly campaignStep?: number | undefined;
    readonly messageId?: string | undefined;
    readonly threadId?: string | undefined;
    readonly observedAt: string;
  }) => Effect.Effect<CommandCenterSalesProspectDetail, CommandCenterError>;
  readonly prepareAutomatedDraft: (
    input: CommandCenterSalesGmailDraftCreateInput & {
      readonly connectionId: string;
    },
  ) => Effect.Effect<CommandCenterSalesDraftResult, CommandCenterError>;
  readonly importHistoricalDraft: (input: {
    readonly proposal: CommandCenterSalesProspectProposeInput;
    readonly connectionId: string;
    readonly sourceSendId: number;
    readonly recipient: string;
    readonly subject: string;
    readonly body: string;
    readonly gmailDraftId?: string | undefined;
    readonly gmailMessageId?: string | undefined;
    readonly createdAt: string;
    readonly sentAt?: string | undefined;
    readonly state: "drafted" | "contacted" | "declined";
  }) => Effect.Effect<CommandCenterSalesDraftResult, CommandCenterError>;
}

export class SalesPipeline extends Context.Service<SalesPipeline, SalesPipelineShape>()(
  "@awtprod/command-center/command-center/SalesPipeline",
) {}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeProspect = Schema.decodeUnknownEffect(SalesProspect);
const decodeActivity = Schema.decodeUnknownEffect(SalesActivity);
const decodeDraft = Schema.decodeUnknownEffect(SalesDraftRequest);
const isCommandCenterError = Schema.is(CommandCenterError);
const stringify = (value: unknown): string => JSON.stringify(value);

const salesError = (reason: CommandCenterError["reason"], message: string, cause?: unknown) =>
  new CommandCenterError({
    reason,
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const persistenceError = (cause: unknown) =>
  salesError("persistence", "Could not update the sales pipeline.", cause);

const normalizeChannelKey = (input: {
  readonly channelId?: string | undefined;
  readonly channelUrl: string;
}): string => {
  if (input.channelId !== undefined) return `youtube:${input.channelId.trim().toLowerCase()}`;
  try {
    const url = new URL(input.channelUrl);
    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/u, "").toLowerCase()}`;
  } catch {
    return input.channelUrl.trim().replace(/\/+$/u, "").toLowerCase();
  }
};

const monotonicTimestamp = (current: string, observed: string): string =>
  observed > current
    ? observed
    : DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(current), { milliseconds: 1 }));

const ALLOWED_TRANSITIONS: Readonly<Record<SalesProspectStage, ReadonlyArray<SalesProspectStage>>> =
  {
    researched: ["qualified", "lost"],
    qualified: ["drafted", "nurture", "lost"],
    drafted: ["contacted", "qualified", "lost"],
    contacted: ["replied", "nurture", "lost"],
    replied: ["call_booked", "nurture", "lost"],
    call_booked: ["proposal_sent", "nurture", "lost"],
    proposal_sent: ["won", "nurture", "lost"],
    won: [],
    nurture: ["qualified", "contacted", "lost"],
    lost: [],
  };

const outreachFor = (prospect: SalesProspectType): { subject: string; body: string } => ({
  subject: `${prospect.channelName}: a focused thumbnail sprint idea`,
  body: [
    `Hi${prospect.contactName === undefined ? "" : ` ${prospect.contactName}`},`,
    "",
    `I took a look at ${prospect.channelName} and noticed ${prospect.fit.thumbnailAudit}`,
    "",
    "I run a full-service design agency for business creators. We offer a focused $300 thumbnail sprint to tighten the packaging around an upcoming long-form video and build a repeatable direction for future releases.",
    "",
    "This is a paid design engagement—not a promise of a specific CTR result, and I don't create free speculative concepts before we agree to work together.",
    "",
    "If improving the next video's packaging is timely, would a short call be useful?",
    "",
    "Best,",
    "Design team",
  ].join("\n"),
});

const followUpFor = (
  prospect: SalesProspectType,
  sequence: 1 | 2,
): { subject: string; body: string } => ({
  subject: `Following up: ${prospect.channelName} thumbnail sprint`,
  body: [
    `Hi${prospect.contactName === undefined ? "" : ` ${prospect.contactName}`},`,
    "",
    sequence === 1
      ? "I wanted to follow up in case my note about a focused thumbnail sprint got buried."
      : "One last follow-up on the thumbnail sprint, then I’ll close the loop.",
    "",
    `The specific thing that caught my attention was ${prospect.fit.thumbnailAudit}`,
    "",
    "We offer a paid $300 trial sprint for an upcoming long-form video. The goal is to explore a clearer, repeatable packaging direction with finished design work—not free speculative concepts or a promise about CTR.",
    "",
    sequence === 1
      ? "If that would be useful for something already on your calendar, would a short conversation make sense?"
      : "If this is not a priority right now, no problem—I’ll leave it here. If it is, would a short conversation be useful?",
    "",
    "Best,",
    "Design team",
  ].join("\n"),
});

const plainTextWordCount = (body: string): number =>
  body.trim().split(/\s+/u).filter(Boolean).length;

const newYorkDayBucket = (date: Date): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

const DAILY_DRAFT_LIMIT = 15;

const decodeProspectRow = Effect.fn("SalesPipeline.decodeProspect")(function* (row: ProspectRow) {
  return yield* decodeProspect({
    id: row.id,
    spaceId: row.spaceId,
    stage: row.stage,
    ...(row.channelId === null ? {} : { channelId: row.channelId }),
    channelName: row.channelName,
    channelUrl: row.channelUrl,
    ...(row.contactName === null ? {} : { contactName: row.contactName }),
    ...(row.contactEmail === null ? {} : { contactEmail: row.contactEmail }),
    contactProvenance: yield* decodeJson(row.contactProvenanceJson),
    ...(row.subscriberCount === null ? {} : { subscriberCount: row.subscriberCount }),
    language: row.language,
    niche: row.niche,
    fit: yield* decodeJson(row.fitJson),
    score: row.score,
    scoreVersion: row.scoreVersion,
    ...(row.evaluatedAt === null ? {} : { evaluatedAt: row.evaluatedAt }),
    ...(row.sourceRecordId === null ? {} : { sourceRecordId: row.sourceRecordId }),
    ...(row.sourceVersion === null ? {} : { sourceVersion: row.sourceVersion }),
    ...(row.nextAction === null ? {} : { nextAction: row.nextAction }),
    ...(row.nextActionAt === null ? {} : { nextActionAt: row.nextActionAt }),
    opportunityCents: row.opportunityCents,
    ...(row.gmailConnectionId === null ? {} : { gmailConnectionId: row.gmailConnectionId }),
    ...(row.gmailDraftId === null ? {} : { gmailDraftId: row.gmailDraftId }),
    ...(row.gmailThreadId === null ? {} : { gmailThreadId: row.gmailThreadId }),
    ...(row.gmailMessageId === null ? {} : { gmailMessageId: row.gmailMessageId }),
    ...(row.campaignVersion === null ? {} : { campaignVersion: row.campaignVersion }),
    ...(row.sentAt === null ? {} : { sentAt: row.sentAt }),
    ...(row.repliedAt === null ? {} : { repliedAt: row.repliedAt }),
    ...(row.bouncedAt === null ? {} : { bouncedAt: row.bouncedAt }),
    ...(row.draftDeletedAt === null ? {} : { draftDeletedAt: row.draftDeletedAt }),
    ...(row.suppressedAt === null ? {} : { suppressedAt: row.suppressedAt }),
    ...(row.nextFollowUpAt === null ? {} : { nextFollowUpAt: row.nextFollowUpAt }),
    ...(row.day3SentAt === null ? {} : { day3SentAt: row.day3SentAt }),
    provenanceKind: row.provenanceKind,
    ...(row.provenanceRef === null ? {} : { provenanceRef: row.provenanceRef }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }).pipe(Effect.mapError((cause) => persistenceError(cause)));
});

const decodeActivityRow = Effect.fn("SalesPipeline.decodeActivity")(function* (row: ActivityRow) {
  return yield* decodeActivity({
    id: row.id,
    prospectId: row.prospectId,
    spaceId: row.spaceId,
    kind: row.kind,
    actorKind: row.actorKind,
    payload: yield* decodeJson(row.payloadJson),
    occurredAt: row.occurredAt,
  }).pipe(Effect.mapError((cause) => persistenceError(cause)));
});

const decodeDraftRow = Effect.fn("SalesPipeline.decodeDraft")(function* (row: DraftRow) {
  return yield* decodeDraft({
    id: row.id,
    prospectId: row.prospectId,
    spaceId: row.spaceId,
    connectionId: row.connectionId,
    recipient: row.recipient,
    subject: row.subject,
    body: row.body,
    payloadDigest: row.payloadDigest,
    status: row.status,
    ...(row.gmailDraftId === null ? {} : { gmailDraftId: row.gmailDraftId }),
    ...(row.gmailMessageId === null ? {} : { gmailMessageId: row.gmailMessageId }),
    ...(row.gmailThreadId === null ? {} : { gmailThreadId: row.gmailThreadId }),
    draftKind: row.draftKind,
    campaignVersion: row.campaignVersion,
    campaignStep: row.campaignStep,
    ...(row.idempotencyKey === null ? {} : { idempotencyKey: row.idempotencyKey }),
    evidenceReferences: yield* decodeJson(row.evidenceJson),
    requestedAt: row.requestedAt,
    ...(row.decidedAt === null ? {} : { decidedAt: row.decidedAt }),
    ...(row.createdAt === null ? {} : { createdAt: row.createdAt }),
    ...(row.failure === null ? {} : { failure: row.failure }),
    ...(row.sentAt === null ? {} : { sentAt: row.sentAt }),
    ...(row.deletedAt === null ? {} : { deletedAt: row.deletedAt }),
  }).pipe(Effect.mapError((cause) => persistenceError(cause)));
});

const prospectSelect = `
  SELECT id, space_id AS "spaceId", stage, channel_id AS "channelId",
    channel_name AS "channelName", channel_url AS "channelUrl",
    contact_name AS "contactName", contact_email AS "contactEmail",
    contact_provenance_json AS "contactProvenanceJson",
    subscriber_count AS "subscriberCount", language, niche, fit_json AS "fitJson",
    score, score_version AS "scoreVersion", evaluated_at AS "evaluatedAt",
    source_record_id AS "sourceRecordId", source_version AS "sourceVersion",
    next_action AS "nextAction", next_action_at AS "nextActionAt",
    opportunity_cents AS "opportunityCents", gmail_connection_id AS "gmailConnectionId",
    gmail_draft_id AS "gmailDraftId", gmail_thread_id AS "gmailThreadId",
    gmail_message_id AS "gmailMessageId", provenance_kind AS "provenanceKind",
    campaign_version AS "campaignVersion", sent_at AS "sentAt", replied_at AS "repliedAt",
    bounced_at AS "bouncedAt", draft_deleted_at AS "draftDeletedAt",
    suppressed_at AS "suppressedAt", next_follow_up_at AS "nextFollowUpAt",
    day3_sent_at AS "day3SentAt",
    provenance_ref AS "provenanceRef", created_at AS "createdAt", updated_at AS "updatedAt"
  FROM command_center_sales_prospects
`;

const draftSelect = `
  SELECT id, prospect_id AS "prospectId", space_id AS "spaceId",
    connection_id AS "connectionId", recipient, subject, body,
    payload_digest AS "payloadDigest", status, gmail_draft_id AS "gmailDraftId",
    gmail_message_id AS "gmailMessageId", gmail_thread_id AS "gmailThreadId",
    draft_kind AS "draftKind", campaign_version AS "campaignVersion",
    campaign_step AS "campaignStep", idempotency_key AS "idempotencyKey",
    evidence_json AS "evidenceJson", requested_at AS "requestedAt",
    decided_at AS "decidedAt", created_at AS "createdAt", failure,
    sent_at AS "sentAt", deleted_at AS "deletedAt"
  FROM command_center_sales_draft_requests
`;

export const layer = Layer.effect(
  SalesPipeline,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const encoder = new TextEncoder();

    const uuid = crypto.randomUUIDv4.pipe(Effect.mapError(persistenceError));
    const digest = (value: unknown) =>
      crypto
        .digest("SHA-256", encoder.encode(stringify(value)))
        .pipe(Effect.map(Encoding.encodeHex), Effect.mapError(persistenceError));

    const requireSpace = Effect.fn("SalesPipeline.requireSpace")(
      function* (spaceId: string, capability: CapabilityName) {
        const rows = yield* sql<SpaceGateRow>`
        SELECT features_json AS "featuresJson", policy_json AS "policyJson"
        FROM command_center_spaces
        WHERE id = ${spaceId} AND lifecycle = 'active'
      `;
        const row = rows[0];
        if (row === undefined)
          return yield* salesError("not_found", "The selected Space was not found.");
        const features = (yield* decodeJson(row.featuresJson)) as {
          readonly salesPipeline?: boolean;
        };
        const policy = (yield* decodeJson(row.policyJson)) as {
          readonly allowedCapabilities?: ReadonlyArray<string>;
        };
        if (features.salesPipeline !== true) {
          return yield* salesError(
            "not_found",
            "The sales pipeline is not enabled for this Space.",
          );
        }
        if (!policy.allowedCapabilities?.includes(capability)) {
          return yield* salesError("validation", `The Space does not grant ${capability}.`);
        }
      },
      Effect.mapError((cause) => (isCommandCenterError(cause) ? cause : persistenceError(cause))),
    );

    const findProspect = Effect.fn("SalesPipeline.findProspect")(
      function* (prospectId: string, spaceId: string) {
        const rows = yield* sql.unsafe<ProspectRow>(
          `${prospectSelect} WHERE id = ? AND space_id = ?`,
          [prospectId, spaceId],
        );
        const row = rows[0];
        if (row === undefined) return yield* salesError("not_found", "The prospect was not found.");
        return yield* decodeProspectRow(row);
      },
      Effect.mapError((cause) => (isCommandCenterError(cause) ? cause : persistenceError(cause))),
    );

    const activitiesFor = Effect.fn("SalesPipeline.activitiesFor")(
      function* (prospectId: string, spaceId: string) {
        const rows = yield* sql<ActivityRow>`
        SELECT id, prospect_id AS "prospectId", space_id AS "spaceId", kind,
          actor_kind AS "actorKind", payload_json AS "payloadJson", occurred_at AS "occurredAt"
        FROM command_center_sales_activities
        WHERE prospect_id = ${prospectId} AND space_id = ${spaceId}
        ORDER BY sequence DESC
      `;
        return yield* Effect.forEach(rows, decodeActivityRow);
      },
      Effect.mapError((cause) => (isCommandCenterError(cause) ? cause : persistenceError(cause))),
    );

    const appendActivity = Effect.fn("SalesPipeline.appendActivity")(function* (input: {
      readonly prospectId: string;
      readonly spaceId: string;
      readonly kind: SalesActivityType["kind"];
      readonly actorKind: SalesActivityType["actorKind"];
      readonly payload: Readonly<Record<string, unknown>>;
      readonly occurredAt: string;
    }) {
      const id = yield* uuid;
      yield* sql`
        INSERT INTO command_center_sales_activities (
          id, prospect_id, space_id, kind, actor_kind, payload_json, occurred_at
        ) VALUES (
          ${id}, ${input.prospectId}, ${input.spaceId}, ${input.kind}, ${input.actorKind},
          ${stringify(input.payload)}, ${input.occurredAt}
        )
      `;
    });

    const query: SalesPipelineShape["query"] = Effect.fn("SalesPipeline.query")(
      function* (input) {
        yield* requireSpace(input.spaceId, "cc.sales.read");
        const conditions = ["p.space_id = ?"];
        const parameters: Array<string | number> = [input.spaceId];
        if (input.stages !== undefined && input.stages.length > 0) {
          conditions.push(`p.stage IN (${input.stages.map(() => "?").join(",")})`);
          parameters.push(...input.stages);
        }
        if (input.minimumScore !== undefined) {
          conditions.push("p.score >= ?");
          parameters.push(input.minimumScore);
        }
        if (input.withoutActiveDraft === true) {
          conditions.push(`NOT EXISTS (
            SELECT 1 FROM command_center_sales_draft_requests d
            WHERE d.prospect_id = p.id
              AND d.status IN ('requested', 'approved', 'creating', 'created')
              AND d.deleted_at IS NULL AND d.sent_at IS NULL
          )`);
        }
        const rows = yield* sql.unsafe<ProspectRow>(
          `${prospectSelect.replace("FROM command_center_sales_prospects", "FROM command_center_sales_prospects p")}
           WHERE ${conditions.join(" AND ")}
           ORDER BY p.score DESC, p.evaluated_at DESC, p.id ASC LIMIT ?`,
          [...parameters, input.limit ?? 500],
        );
        const prospects = yield* Effect.forEach(rows, decodeProspectRow);
        const draftRows = yield* sql.unsafe<DraftRow>(
          `${draftSelect} WHERE space_id = ? ORDER BY requested_at DESC`,
          [input.spaceId],
        );
        return { prospects, draftRequests: yield* Effect.forEach(draftRows, decodeDraftRow) };
      },
      Effect.mapError((cause) => (isCommandCenterError(cause) ? cause : persistenceError(cause))),
    );

    const propose: SalesPipelineShape["propose"] = Effect.fn("SalesPipeline.propose")(
      function* (input) {
        yield* requireSpace(input.spaceId, "cc.sales.propose");
        const normalized = normalizeChannelKey(input);
        const existing = yield* sql.unsafe<ProspectRow>(
          `${prospectSelect} WHERE space_id = ? AND normalized_channel_key = ?`,
          [input.spaceId, normalized],
        );
        if (existing[0] !== undefined) {
          const current = yield* decodeProspectRow(existing[0]);
          const shouldRefresh =
            input.sourceRecordId !== undefined &&
            input.sourceVersion !== undefined &&
            input.evaluatedAt !== undefined &&
            (current.evaluatedAt === undefined || input.evaluatedAt > current.evaluatedAt);
          if (!shouldRefresh) return { prospect: current, duplicate: true };

          const nextStage =
            current.stage === "researched" && input.initialStage === "qualified"
              ? "qualified"
              : current.stage;
          const nextAction =
            current.stage === "researched"
              ? (input.nextAction ?? null)
              : (current.nextAction ?? null);
          const nextActionAt =
            current.stage === "researched"
              ? (input.nextActionAt ?? null)
              : (current.nextActionAt ?? null);
          const now = monotonicTimestamp(
            current.updatedAt,
            DateTime.formatIso(yield* DateTime.now),
          );
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                UPDATE command_center_sales_prospects
                SET stage = ${nextStage}, channel_id = ${input.channelId ?? current.channelId ?? null},
                  channel_name = ${input.channelName}, channel_url = ${input.channelUrl},
                  contact_name = ${input.contactName ?? current.contactName ?? null},
                  contact_email = ${input.contactEmail ?? current.contactEmail ?? null},
                  contact_provenance_json = ${stringify(input.contactProvenance)},
                  subscriber_count = ${input.subscriberCount ?? current.subscriberCount ?? null},
                  language = ${input.language}, niche = ${input.niche}, fit_json = ${stringify(input.fit)},
                  score = ${input.fit.score}, score_version = ${input.scoreVersion ?? current.scoreVersion},
                  evaluated_at = ${input.evaluatedAt}, source_record_id = ${input.sourceRecordId},
                  source_version = ${input.sourceVersion}, next_action = ${nextAction},
                  next_action_at = ${nextActionAt}, provenance_kind = ${input.provenanceKind},
                  provenance_ref = ${input.provenanceRef ?? input.requestId}, updated_at = ${now}
                WHERE id = ${current.id} AND space_id = ${input.spaceId}
                  AND (evaluated_at IS NULL OR evaluated_at < ${input.evaluatedAt})
              `;
              yield* appendActivity({
                prospectId: current.id,
                spaceId: input.spaceId,
                kind: nextStage === current.stage ? "updated" : "stage_changed",
                actorKind: input.provenanceKind,
                payload: {
                  requestId: input.requestId,
                  sourceRecordId: input.sourceRecordId,
                  sourceVersion: input.sourceVersion,
                  from: current.stage,
                  to: nextStage,
                },
                occurredAt: now,
              });
            }),
          );
          return { prospect: yield* findProspect(current.id, input.spaceId), duplicate: true };
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        const prospectId = yield* uuid;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
            INSERT INTO command_center_sales_prospects (
              id, space_id, stage, channel_id, channel_name, channel_url, normalized_channel_key,
              contact_name, contact_email, contact_provenance_json, subscriber_count, language,
              niche, fit_json, score, score_version, evaluated_at, source_record_id, source_version,
              next_action, next_action_at, opportunity_cents,
              provenance_kind, provenance_ref, created_at, updated_at
            ) VALUES (
              ${prospectId}, ${input.spaceId}, ${input.initialStage ?? "researched"}, ${input.channelId ?? null},
              ${input.channelName}, ${input.channelUrl}, ${normalized}, ${input.contactName ?? null},
              ${input.contactEmail ?? null}, ${stringify(input.contactProvenance)},
              ${input.subscriberCount ?? null}, ${input.language}, ${input.niche},
              ${stringify(input.fit)}, ${input.fit.score}, ${input.scoreVersion ?? "manual-v1"},
              ${input.evaluatedAt ?? now}, ${input.sourceRecordId ?? null}, ${input.sourceVersion ?? null},
              ${input.nextAction ?? null}, ${input.nextActionAt ?? null},
              ${SALES_OPPORTUNITY_CENTS}, ${input.provenanceKind}, ${input.provenanceRef ?? input.requestId},
              ${now}, ${now}
            )
          `;
            yield* appendActivity({
              prospectId,
              spaceId: input.spaceId,
              kind: "proposed",
              actorKind: input.provenanceKind,
              payload: { requestId: input.requestId, normalizedChannelKey: normalized },
              occurredAt: now,
            });
          }),
        );
        return { prospect: yield* findProspect(prospectId, input.spaceId), duplicate: false };
      },
      Effect.mapError((cause) => (isCommandCenterError(cause) ? cause : persistenceError(cause))),
    );

    const update: SalesPipelineShape["update"] = Effect.fn("SalesPipeline.update")(
      function* (input) {
        yield* requireSpace(input.spaceId, "cc.sales.write");
        const current = yield* findProspect(input.prospectId, input.spaceId);
        if (current.updatedAt !== input.expectedUpdatedAt) {
          return yield* salesError("conflict", "The prospect changed since it was opened.");
        }
        if (
          input.stage !== undefined &&
          input.stage !== current.stage &&
          !ALLOWED_TRANSITIONS[current.stage].includes(input.stage)
        ) {
          return yield* salesError(
            "validation",
            `A prospect cannot move directly from ${current.stage} to ${input.stage}.`,
          );
        }
        const now = monotonicTimestamp(current.updatedAt, DateTime.formatIso(yield* DateTime.now));
        const nextStage = input.stage ?? current.stage;
        const nextAction =
          input.nextAction === undefined ? (current.nextAction ?? null) : input.nextAction;
        const nextActionAt =
          input.nextActionAt === undefined ? (current.nextActionAt ?? null) : input.nextActionAt;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
            UPDATE command_center_sales_prospects
            SET stage = ${nextStage}, next_action = ${nextAction}, next_action_at = ${nextActionAt},
              updated_at = ${now}
            WHERE id = ${input.prospectId} AND space_id = ${input.spaceId}
              AND updated_at = ${input.expectedUpdatedAt}
          `;
            yield* appendActivity({
              prospectId: input.prospectId,
              spaceId: input.spaceId,
              kind: nextStage === current.stage ? "updated" : "stage_changed",
              actorKind: "user",
              payload: { from: current.stage, to: nextStage, nextAction, nextActionAt },
              occurredAt: now,
            });
          }),
        );
        return {
          prospect: yield* findProspect(input.prospectId, input.spaceId),
          activities: yield* activitiesFor(input.prospectId, input.spaceId),
        };
      },
      Effect.mapError((cause) => (isCommandCenterError(cause) ? cause : persistenceError(cause))),
    );

    const requestDraft: SalesPipelineShape["requestDraft"] = Effect.fn(
      "SalesPipeline.requestDraft",
    )(
      function* (input) {
        yield* requireSpace(input.spaceId, "cc.sales.write");
        const prospect = yield* findProspect(input.prospectId, input.spaceId);
        if (prospect.updatedAt !== input.expectedUpdatedAt) {
          return yield* salesError(
            "conflict",
            "The prospect changed since the draft was prepared.",
          );
        }
        if (prospect.stage !== "qualified") {
          return yield* salesError(
            "validation",
            "Only a qualified prospect can enter draft review.",
          );
        }
        if (
          prospect.contactEmail === undefined ||
          !prospect.contactProvenance.isPublicBusinessContact
        ) {
          return yield* salesError(
            "validation",
            "A public business email with provenance is required.",
          );
        }
        const outreach = outreachFor(prospect);
        const payloadDigest = yield* digest({
          requestId: input.requestId,
          connectionId: input.connectionId,
          recipient: prospect.contactEmail,
          ...outreach,
        });
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const active = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM command_center_sales_draft_requests
              WHERE prospect_id = ${prospect.id}
                AND status IN ('requested','approved','creating','created')
                AND deleted_at IS NULL AND sent_at IS NULL
            `;
            if ((active[0]?.count ?? 0) > 0) {
              return yield* salesError(
                "conflict",
                "This prospect already has a pending Gmail draft.",
              );
            }
            yield* sql`
              INSERT INTO command_center_sales_draft_requests (
                id, prospect_id, space_id, connection_id, recipient, subject, body,
                payload_digest, status, requested_at
              ) VALUES (
                ${input.requestId}, ${prospect.id}, ${input.spaceId}, ${input.connectionId},
                ${prospect.contactEmail}, ${outreach.subject}, ${outreach.body}, ${payloadDigest},
                'requested', ${now}
              )
              ON CONFLICT(id) DO NOTHING
            `;
            yield* appendActivity({
              prospectId: prospect.id,
              spaceId: input.spaceId,
              kind: "outreach_prepared",
              actorKind: "user",
              payload: { requestId: input.requestId, payloadDigest },
              occurredAt: now,
            });
          }),
        );
        return yield* getDraftRequest({ requestId: input.requestId, spaceId: input.spaceId });
      },
      Effect.mapError((cause) => (isCommandCenterError(cause) ? cause : persistenceError(cause))),
    );

    const getDraftRequest: SalesPipelineShape["getDraftRequest"] = Effect.fn(
      "SalesPipeline.getDraftRequest",
    )(
      function* (input) {
        const rows = yield* sql.unsafe<DraftRow>(`${draftSelect} WHERE id = ? AND space_id = ?`, [
          input.requestId,
          input.spaceId,
        ]);
        const row = rows[0];
        if (row === undefined)
          return yield* salesError("not_found", "The draft request was not found.");
        const request = yield* decodeDraftRow(row);
        return { request, prospect: yield* findProspect(request.prospectId, input.spaceId) };
      },
      Effect.mapError((cause) => (isCommandCenterError(cause) ? cause : persistenceError(cause))),
    );

    const decideDraft: SalesPipelineShape["decideDraft"] = Effect.fn("SalesPipeline.decideDraft")(
      function* (input) {
        yield* requireSpace(input.spaceId, "cc.sales.write");
        const current = yield* getDraftRequest({
          requestId: input.requestId,
          spaceId: input.spaceId,
        });
        if (current.request.payloadDigest !== input.payloadDigest) {
          return yield* salesError(
            "conflict",
            "The displayed outreach no longer matches this approval.",
          );
        }
        if (current.request.status !== "requested") {
          if (current.request.status === input.decision) return current;
          return yield* salesError("conflict", "The draft request has already been decided.");
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              UPDATE command_center_sales_draft_requests
              SET status = ${input.decision}, decided_at = ${now}
              WHERE id = ${input.requestId} AND space_id = ${input.spaceId}
                AND status = 'requested' AND payload_digest = ${input.payloadDigest}
            `;
            yield* appendActivity({
              prospectId: current.prospect.id,
              spaceId: input.spaceId,
              kind: input.decision === "approved" ? "draft_approved" : "draft_declined",
              actorKind: "user",
              payload: { requestId: input.requestId, payloadDigest: input.payloadDigest },
              occurredAt: now,
            });
          }),
        );
        return yield* getDraftRequest({ requestId: input.requestId, spaceId: input.spaceId });
      },
      Effect.mapError((cause) => (isCommandCenterError(cause) ? cause : persistenceError(cause))),
    );

    const claimDraftCreate: SalesPipelineShape["claimDraftCreate"] = Effect.fn(
      "SalesPipeline.claimDraftCreate",
    )(
      function* (input) {
        yield* requireSpace(input.spaceId, "cc.connections.google.gmail.drafts.create");
        const current = yield* getDraftRequest({
          requestId: input.requestId,
          spaceId: input.spaceId,
        });
        if (current.request.payloadDigest !== input.payloadDigest) {
          return yield* salesError("conflict", "The approved outreach digest does not match.");
        }
        if (current.request.status === "created") return current;
        if (
          current.request.status !== "approved" &&
          current.request.status !== "failed" &&
          current.request.status !== "creating"
        ) {
          return yield* salesError(
            "validation",
            "The exact outreach must be approved before creating a Gmail draft.",
          );
        }
        yield* sql`
        UPDATE command_center_sales_draft_requests
        SET status = 'creating', failure = NULL
        WHERE id = ${input.requestId} AND space_id = ${input.spaceId}
          AND payload_digest = ${input.payloadDigest}
      `;
        return yield* getDraftRequest({ requestId: input.requestId, spaceId: input.spaceId });
      },
      Effect.mapError((cause) => (isCommandCenterError(cause) ? cause : persistenceError(cause))),
    );

    const completeDraftCreate: SalesPipelineShape["completeDraftCreate"] = Effect.fn(
      "SalesPipeline.completeDraftCreate",
    )(
      function* (input) {
        const current = yield* getDraftRequest({
          requestId: input.requestId,
          spaceId: input.spaceId,
        });
        if (current.request.payloadDigest !== input.payloadDigest) {
          return yield* salesError("conflict", "The approved outreach digest does not match.");
        }
        if (current.request.status === "created") return current;
        if (current.request.status !== "creating") {
          return yield* salesError("conflict", "The Gmail draft request is not being created.");
        }
        const observed = DateTime.formatIso(yield* DateTime.now);
        const prospectUpdatedAt = monotonicTimestamp(current.prospect.updatedAt, observed);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
            UPDATE command_center_sales_draft_requests
            SET status = 'created', gmail_draft_id = ${input.draftId}, created_at = ${observed},
              failure = NULL
            WHERE id = ${input.requestId} AND space_id = ${input.spaceId}
              AND status = 'creating' AND payload_digest = ${input.payloadDigest}
          `;
            yield* sql`
            UPDATE command_center_sales_prospects
            SET stage = 'drafted', gmail_connection_id = ${current.request.connectionId},
              gmail_draft_id = ${input.draftId}, updated_at = ${prospectUpdatedAt}
            WHERE id = ${current.prospect.id} AND space_id = ${input.spaceId}
              AND stage = 'qualified'
          `;
            yield* appendActivity({
              prospectId: current.prospect.id,
              spaceId: input.spaceId,
              kind: input.reconciled ? "gmail_draft_reconciled" : "gmail_draft_created",
              actorKind: "connector",
              payload: { requestId: input.requestId, gmailDraftId: input.draftId },
              occurredAt: observed,
            });
          }),
        );
        return yield* getDraftRequest({ requestId: input.requestId, spaceId: input.spaceId });
      },
      Effect.mapError((cause) => (isCommandCenterError(cause) ? cause : persistenceError(cause))),
    );

    const failDraftCreate: SalesPipelineShape["failDraftCreate"] = Effect.fn(
      "SalesPipeline.failDraftCreate",
    )(function* (input) {
      yield* sql`
        UPDATE command_center_sales_draft_requests
        SET status = 'failed', failure = ${input.message}
        WHERE id = ${input.requestId} AND space_id = ${input.spaceId}
          AND status = 'creating' AND payload_digest = ${input.payloadDigest}
      `;
    }, Effect.mapError(persistenceError));

    const prepareAutomatedDraft: SalesPipelineShape["prepareAutomatedDraft"] = Effect.fn(
      "SalesPipeline.prepareAutomatedDraft",
    )(
      function* (input) {
        yield* requireSpace(input.spaceId, "cc.sales.write");
        yield* requireSpace(input.spaceId, "cc.connections.google.gmail.drafts.create");
        const existing = yield* sql.unsafe<DraftRow>(
          `${draftSelect} WHERE space_id = ? AND idempotency_key = ?`,
          [input.spaceId, input.idempotencyKey],
        );
        if (existing[0] !== undefined) {
          const request = yield* decodeDraftRow(existing[0]);
          return { request, prospect: yield* findProspect(request.prospectId, input.spaceId) };
        }

        const prospect = yield* findProspect(input.prospectId, input.spaceId);
        const draftKind =
          input.campaignStep === 0
            ? "initial"
            : input.campaignStep === 1
              ? "followup_1"
              : "followup_2";
        if (
          prospect.contactEmail === undefined ||
          !prospect.contactProvenance.isPublicBusinessContact
        ) {
          return yield* salesError("validation", "A verified public business email is required.");
        }
        if (
          prospect.suppressedAt !== undefined ||
          prospect.bouncedAt !== undefined ||
          prospect.draftDeletedAt !== undefined
        ) {
          return yield* salesError("validation", "This contact is suppressed from outreach.");
        }
        if (input.campaignStep === 0 && (prospect.stage !== "qualified" || prospect.score < 75)) {
          return yield* salesError(
            "validation",
            "Initial drafts require a qualified score of at least 75.",
          );
        }
        if (input.campaignStep > 0 && prospect.stage !== "contacted") {
          return yield* salesError("validation", "Follow-up drafts require a contacted prospect.");
        }
        const words = plainTextWordCount(input.body);
        if (words < 80 || words > 120 || /<[^>]+>/u.test(input.body)) {
          return yield* salesError(
            "validation",
            "Sales drafts must be plain text and 80-120 words.",
          );
        }
        const evidence = new Set([
          prospect.fit.thumbnailAudit,
          prospect.fit.publishingEvidence,
          prospect.fit.monetizationEvidence,
          ...prospect.fit.reasons,
        ]);
        if (input.evidenceReferences.some((reference) => !evidence.has(reference))) {
          return yield* salesError(
            "validation",
            "Every draft evidence reference must match stored prospect evidence.",
          );
        }

        const now = DateTime.formatIso(yield* DateTime.now);
        const bucket = newYorkDayBucket(DateTime.toDate(DateTime.makeUnsafe(now)));
        const requestId = yield* uuid;
        const payloadDigest = yield* digest({
          prospectId: prospect.id,
          recipient: prospect.contactEmail,
          subject: input.subject,
          body: input.body,
          evidenceReferences: input.evidenceReferences,
          campaignStep: input.campaignStep,
          campaignVersion: input.campaignVersion,
          idempotencyKey: input.idempotencyKey,
        });
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const active = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM command_center_sales_draft_requests
              WHERE prospect_id = ${prospect.id} AND status IN ('requested','approved','creating','created')
                AND deleted_at IS NULL AND sent_at IS NULL
            `;
            if ((active[0]?.count ?? 0) > 0) {
              return yield* salesError(
                "conflict",
                "This prospect already has a pending Gmail draft.",
              );
            }
            const daily =
              input.campaignStep === 0
                ? yield* sql<{ readonly count: number }>`
                    SELECT COUNT(*) AS count FROM command_center_sales_draft_requests
                    WHERE space_id = ${input.spaceId} AND daily_bucket = ${bucket}
                      AND campaign_step = 0 AND status <> 'declined'
                  `
                : yield* sql<{ readonly count: number }>`
                    SELECT COUNT(*) AS count FROM command_center_sales_draft_requests
                    WHERE space_id = ${input.spaceId} AND daily_bucket = ${bucket}
                      AND campaign_step > 0 AND status <> 'declined'
                  `;
            if ((daily[0]?.count ?? 0) >= DAILY_DRAFT_LIMIT) {
              return yield* salesError(
                "validation",
                input.campaignStep === 0
                  ? "The 15-draft weekday initial allowance is exhausted."
                  : "The separate 15-draft follow-up allowance is exhausted.",
              );
            }
            yield* sql`
              INSERT INTO command_center_sales_draft_requests (
                id, prospect_id, space_id, connection_id, recipient, subject, body,
                payload_digest, status, draft_kind, campaign_version, campaign_step,
                idempotency_key, evidence_json, requested_at, decided_at, daily_bucket
              ) VALUES (
                ${requestId}, ${prospect.id}, ${input.spaceId}, ${input.connectionId},
                ${prospect.contactEmail}, ${input.subject}, ${input.body}, ${payloadDigest},
                'creating', ${draftKind}, ${input.campaignVersion}, ${input.campaignStep},
                ${input.idempotencyKey}, ${stringify(input.evidenceReferences)}, ${now}, ${now}, ${bucket}
              )
            `;
            yield* appendActivity({
              prospectId: prospect.id,
              spaceId: input.spaceId,
              kind: input.campaignStep === 0 ? "outreach_prepared" : "follow_up_prepared",
              actorKind: "automation",
              payload: {
                requestId,
                payloadDigest,
                draftKind,
                campaignVersion: input.campaignVersion,
              },
              occurredAt: now,
            });
          }),
        );
        return yield* getDraftRequest({ requestId, spaceId: input.spaceId });
      },
      Effect.mapError((cause) => (isCommandCenterError(cause) ? cause : persistenceError(cause))),
    );

    const importHistoricalDraft: SalesPipelineShape["importHistoricalDraft"] = Effect.fn(
      "SalesPipeline.importHistoricalDraft",
    )(
      function* (input) {
        const proposed = yield* propose(input.proposal);
        const requestId = `prospector-send-${input.sourceSendId}`;
        const existing = yield* sql.unsafe<DraftRow>(
          `${draftSelect} WHERE id = ? AND space_id = ?`,
          [requestId, input.proposal.spaceId],
        );
        if (existing[0] !== undefined) {
          return {
            request: yield* decodeDraftRow(existing[0]),
            prospect: yield* findProspect(proposed.prospect.id, input.proposal.spaceId),
          };
        }
        const payloadDigest = yield* digest({
          source: "prospector-sends",
          sourceSendId: input.sourceSendId,
          recipient: input.recipient,
          subject: input.subject,
          body: input.body,
        });
        const requestStatus = input.state === "declined" ? "declined" : "created";
        const stage =
          input.state === "contacted"
            ? "contacted"
            : input.state === "drafted"
              ? "drafted"
              : "researched";
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO command_center_sales_draft_requests (
                id, prospect_id, space_id, connection_id, recipient, subject, body,
                payload_digest, status, gmail_draft_id, gmail_message_id,
                draft_kind, campaign_version, campaign_step, idempotency_key,
                evidence_json, requested_at, decided_at, created_at, sent_at, deleted_at
              ) VALUES (
                ${requestId}, ${proposed.prospect.id}, ${input.proposal.spaceId}, ${input.connectionId},
                ${input.recipient}, ${input.subject}, ${input.body}, ${payloadDigest}, ${requestStatus},
                ${input.gmailDraftId ?? null}, ${input.gmailMessageId ?? null}, 'initial', 'historical-v1', 0,
                ${`historical:${input.sourceSendId}`}, '[]', ${input.createdAt}, ${input.createdAt},
                ${input.createdAt}, ${input.sentAt ?? null}, ${input.state === "declined" ? input.createdAt : null}
              )
            `;
            yield* sql`
              UPDATE command_center_sales_prospects
              SET stage = ${stage}, gmail_connection_id = ${input.connectionId},
                gmail_draft_id = ${input.gmailDraftId ?? null},
                gmail_message_id = ${input.gmailMessageId ?? null},
                sent_at = ${input.sentAt ?? null},
                draft_deleted_at = ${input.state === "declined" ? input.createdAt : null},
                updated_at = ${input.createdAt}
              WHERE id = ${proposed.prospect.id} AND space_id = ${input.proposal.spaceId}
            `;
            yield* appendActivity({
              prospectId: proposed.prospect.id,
              spaceId: input.proposal.spaceId,
              kind:
                input.state === "contacted"
                  ? "sent_reconciled"
                  : input.state === "drafted"
                    ? "gmail_draft_reconciled"
                    : "draft_declined",
              actorKind: "system",
              payload: { source: "prospector-sends", sourceSendId: input.sourceSendId },
              occurredAt: input.createdAt,
            });
          }),
        );
        return yield* getDraftRequest({ requestId, spaceId: input.proposal.spaceId });
      },
      Effect.mapError((cause) => (isCommandCenterError(cause) ? cause : persistenceError(cause))),
    );

    const reconcileGmailEvidence: SalesPipelineShape["reconcileGmailEvidence"] = Effect.fn(
      "SalesPipeline.reconcileGmailEvidence",
    )(
      function* (input) {
        yield* requireSpace(input.spaceId, "cc.sales.write");
        const current = yield* findProspect(input.prospectId, input.spaceId);
        let nextStage = current.stage;
        let nextAction = current.nextAction ?? null;
        let nextActionAt = current.nextActionAt ?? null;
        let activityKind: SalesActivityType["kind"] | undefined;

        if (input.bounced === true) {
          nextStage = "lost";
          nextAction = "Suppressed after Gmail bounce";
          nextActionAt = null;
          activityKind = "updated";
        } else if (input.deleted === true) {
          nextStage = current.stage === "drafted" ? "researched" : current.stage;
          nextAction = "Draft was deleted; do not recreate automatically";
          nextActionAt = null;
          activityKind = "draft_declined";
        } else if (
          input.replied &&
          (current.stage === "contacted" || current.stage === "drafted")
        ) {
          nextStage = "replied";
          nextAction = "Review the reply and propose a call";
          nextActionAt = null;
          activityKind = "reply_reconciled";
        } else if (input.sent && current.stage === "drafted") {
          nextStage = "contacted";
          nextAction = "Review the 3-day follow-up preview if there is no reply";
          nextActionAt = DateTime.formatIso(
            DateTime.add(DateTime.makeUnsafe(input.observedAt), { days: 3 }),
          );
          activityKind = "sent_reconciled";
        } else if (
          input.sent &&
          current.stage === "contacted" &&
          input.campaignStep === 1 &&
          current.day3SentAt === undefined
        ) {
          nextAction = "Wait for reply before the final follow-up";
          nextActionAt = DateTime.formatIso(
            DateTime.add(DateTime.makeUnsafe(input.observedAt), { days: 4 }),
          );
          activityKind = "sent_reconciled";
        } else if (input.sent && current.stage === "contacted" && input.campaignStep === 2) {
          nextAction = "Final follow-up sent; wait for reply";
          nextActionAt = null;
          activityKind = "sent_reconciled";
        }

        if (activityKind !== undefined) {
          const updatedAt = monotonicTimestamp(current.updatedAt, input.observedAt);
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
              UPDATE command_center_sales_prospects
              SET stage = ${nextStage}, next_action = ${nextAction}, next_action_at = ${nextActionAt},
                gmail_message_id = ${input.messageId ?? current.gmailMessageId ?? null},
                gmail_thread_id = ${input.threadId ?? current.gmailThreadId ?? null},
                sent_at = ${input.sent && current.sentAt === undefined ? input.observedAt : (current.sentAt ?? null)},
                replied_at = ${input.replied ? input.observedAt : (current.repliedAt ?? null)},
                bounced_at = ${input.bounced === true ? input.observedAt : (current.bouncedAt ?? null)},
                suppressed_at = ${input.bounced === true ? input.observedAt : (current.suppressedAt ?? null)},
                draft_deleted_at = ${input.deleted === true ? input.observedAt : (current.draftDeletedAt ?? null)},
                next_follow_up_at = ${nextActionAt},
                day3_sent_at = ${input.sent && input.campaignStep === 1 ? input.observedAt : (current.day3SentAt ?? null)},
                updated_at = ${updatedAt}
              WHERE id = ${input.prospectId} AND space_id = ${input.spaceId}
            `;
              yield* appendActivity({
                prospectId: input.prospectId,
                spaceId: input.spaceId,
                kind: activityKind,
                actorKind: "connector",
                payload: {
                  ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
                  ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                },
                occurredAt: input.observedAt,
              });
              if (input.replied || input.bounced === true) {
                yield* sql`
                  UPDATE command_center_sales_draft_requests
                  SET status = 'declined', failure = ${input.replied ? "Cancelled after inbound reply" : "Cancelled after bounce"}
                  WHERE prospect_id = ${input.prospectId} AND space_id = ${input.spaceId}
                    AND campaign_step > 0 AND sent_at IS NULL
                    AND status IN ('requested','approved','creating','created')
                `;
              }
            }),
          );
          if (input.draftRequestId !== undefined && (input.sent || input.deleted === true)) {
            yield* sql`
              UPDATE command_center_sales_draft_requests
              SET sent_at = ${input.sent ? input.observedAt : null},
                deleted_at = ${input.deleted === true ? input.observedAt : null},
                status = ${input.deleted === true ? "declined" : "created"},
                gmail_message_id = ${input.messageId ?? null}, gmail_thread_id = ${input.threadId ?? null}
              WHERE id = ${input.draftRequestId} AND space_id = ${input.spaceId}
            `;
          } else if (input.sent || input.deleted === true) {
            yield* sql`
              UPDATE command_center_sales_draft_requests
              SET sent_at = ${input.sent ? input.observedAt : null},
                deleted_at = ${input.deleted === true ? input.observedAt : null},
                status = ${input.deleted === true ? "declined" : "created"},
                gmail_message_id = ${input.messageId ?? null}, gmail_thread_id = ${input.threadId ?? null}
              WHERE id = (
                SELECT id FROM command_center_sales_draft_requests
                WHERE prospect_id = ${input.prospectId} AND space_id = ${input.spaceId}
                  AND sent_at IS NULL AND deleted_at IS NULL
                  AND status = 'created'
                ORDER BY requested_at DESC LIMIT 1
              )
            `;
          }
        }

        const refreshed = yield* findProspect(input.prospectId, input.spaceId);
        if (
          !input.replied &&
          refreshed.stage === "contacted" &&
          refreshed.nextActionAt !== undefined &&
          refreshed.nextActionAt <= input.observedAt &&
          refreshed.contactEmail !== undefined
        ) {
          const pending = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM command_center_sales_draft_requests
            WHERE prospect_id = ${input.prospectId} AND campaign_step > 0
              AND sent_at IS NULL AND deleted_at IS NULL
              AND status IN ('requested','approved','creating','created')
          `;
          const sentFollowUps = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM command_center_sales_draft_requests
            WHERE prospect_id = ${input.prospectId} AND campaign_step > 0 AND sent_at IS NOT NULL
          `;
          const count = sentFollowUps[0]?.count ?? 0;
          if ((pending[0]?.count ?? 0) === 0 && count < 2) {
            const priorDrafts = yield* sql.unsafe<DraftRow>(
              `${draftSelect} WHERE prospect_id = ? AND space_id = ? ORDER BY requested_at DESC`,
              [input.prospectId, input.spaceId],
            );
            const connectionId = priorDrafts[0]?.connectionId;
            if (connectionId !== undefined) {
              const sequence = (count + 1) as 1 | 2;
              const followUp = followUpFor(refreshed, sequence);
              const requestId = yield* uuid;
              const payloadDigest = yield* digest({
                requestId,
                connectionId,
                recipient: refreshed.contactEmail,
                ...followUp,
              });
              const updatedAt = monotonicTimestamp(refreshed.updatedAt, input.observedAt);
              yield* sql.withTransaction(
                Effect.gen(function* () {
                  const bucket = newYorkDayBucket(
                    DateTime.toDate(DateTime.makeUnsafe(input.observedAt)),
                  );
                  const daily = yield* sql<{ readonly count: number }>`
                    SELECT COUNT(*) AS count FROM command_center_sales_draft_requests
                    WHERE space_id = ${input.spaceId} AND daily_bucket = ${bucket}
                      AND campaign_step > 0 AND status <> 'declined'
                  `;
                  if ((daily[0]?.count ?? 0) >= DAILY_DRAFT_LIMIT) return;
                  yield* sql`
                  INSERT INTO command_center_sales_draft_requests (
                    id, prospect_id, space_id, connection_id, recipient, subject, body,
                    payload_digest, status, gmail_message_id, gmail_thread_id,
                    draft_kind, campaign_version, campaign_step,
                    idempotency_key, evidence_json, requested_at, daily_bucket
                  ) VALUES (
                    ${requestId}, ${input.prospectId}, ${input.spaceId}, ${connectionId},
                    ${refreshed.contactEmail}, ${followUp.subject}, ${followUp.body},
                    ${payloadDigest}, 'creating', ${refreshed.gmailMessageId ?? null},
                    ${refreshed.gmailThreadId ?? null}, ${sequence === 1 ? "followup_1" : "followup_2"},
                    'sales-followups-v1', ${sequence},
                    ${`followup:${input.prospectId}:${sequence}`},
                    ${stringify([refreshed.fit.thumbnailAudit])}, ${input.observedAt}, ${bucket}
                  )
                `;
                  yield* sql`
                  UPDATE command_center_sales_prospects
                  SET next_action = ${sequence === 1 ? "Review the 3-day follow-up preview" : "Review the 7-day follow-up preview"},
                    next_action_at = NULL, updated_at = ${updatedAt}
                  WHERE id = ${input.prospectId} AND space_id = ${input.spaceId}
                `;
                  yield* appendActivity({
                    prospectId: input.prospectId,
                    spaceId: input.spaceId,
                    kind: "follow_up_prepared",
                    actorKind: "system",
                    payload: { requestId, sequence, payloadDigest },
                    occurredAt: input.observedAt,
                  });
                }),
              );
            }
          }
        }

        return {
          prospect: yield* findProspect(input.prospectId, input.spaceId),
          activities: yield* activitiesFor(input.prospectId, input.spaceId),
        };
      },
      Effect.mapError((cause) => (isCommandCenterError(cause) ? cause : persistenceError(cause))),
    );

    return SalesPipeline.of({
      query,
      propose,
      update,
      requestDraft,
      decideDraft,
      getDraftRequest,
      claimDraftCreate,
      completeDraftCreate,
      failDraftCreate,
      prepareAutomatedDraft,
      importHistoricalDraft,
      reconcileGmailEvidence,
    });
  }),
);
