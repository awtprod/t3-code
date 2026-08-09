import * as Schema from "effect/Schema";

import {
  ConnectionId,
  NonNegativeInt,
  SpaceId,
  Timestamp,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./domain.ts";

const makeSalesId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const SalesProspectId = makeSalesId("CommandCenterSalesProspectId");
export type SalesProspectId = typeof SalesProspectId.Type;

export const SalesActivityId = makeSalesId("CommandCenterSalesActivityId");
export type SalesActivityId = typeof SalesActivityId.Type;

export const SalesDraftRequestId = makeSalesId("CommandCenterSalesDraftRequestId");
export type SalesDraftRequestId = typeof SalesDraftRequestId.Type;

export const SalesProspectStage = Schema.Literals([
  "researched",
  "qualified",
  "drafted",
  "contacted",
  "replied",
  "call_booked",
  "proposal_sent",
  "won",
  "nurture",
  "lost",
]);
export type SalesProspectStage = typeof SalesProspectStage.Type;

export const SALES_PROSPECT_STAGES: ReadonlyArray<SalesProspectStage> = [
  "researched",
  "qualified",
  "drafted",
  "contacted",
  "replied",
  "call_booked",
  "proposal_sent",
  "won",
  "nurture",
  "lost",
];

export const SalesContactProvenance = Schema.Struct({
  sourceUrl: TrimmedNonEmptyString,
  sourceLabel: Schema.optional(TrimmedNonEmptyString),
  isPublicBusinessContact: Schema.Boolean,
  capturedAt: Timestamp,
});
export type SalesContactProvenance = typeof SalesContactProvenance.Type;

export const SalesFitAnalysis = Schema.Struct({
  score: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  reasons: Schema.Array(TrimmedNonEmptyString).check(Schema.isNonEmpty()),
  thumbnailAudit: TrimmedNonEmptyString,
  monetizationEvidence: TrimmedNonEmptyString,
  publishingEvidence: TrimmedNonEmptyString,
});
export type SalesFitAnalysis = typeof SalesFitAnalysis.Type;

export const SalesDraftKind = Schema.Literals(["initial", "followup_1", "followup_2"]);
export type SalesDraftKind = typeof SalesDraftKind.Type;

export const SalesProspect = Schema.Struct({
  id: SalesProspectId,
  spaceId: SpaceId,
  stage: SalesProspectStage,
  channelId: Schema.optional(TrimmedNonEmptyString),
  channelName: TrimmedNonEmptyString,
  channelUrl: TrimmedNonEmptyString,
  contactName: Schema.optional(TrimmedNonEmptyString),
  contactEmail: Schema.optional(TrimmedNonEmptyString),
  contactProvenance: SalesContactProvenance,
  subscriberCount: Schema.optional(NonNegativeInt),
  language: TrimmedNonEmptyString,
  niche: TrimmedNonEmptyString,
  fit: SalesFitAnalysis,
  score: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  scoreVersion: TrimmedNonEmptyString,
  evaluatedAt: Schema.optional(Timestamp),
  sourceRecordId: Schema.optional(TrimmedNonEmptyString),
  sourceVersion: Schema.optional(TrimmedNonEmptyString),
  nextAction: Schema.optional(TrimmedString),
  nextActionAt: Schema.optional(Timestamp),
  opportunityCents: NonNegativeInt,
  gmailConnectionId: Schema.optional(ConnectionId),
  gmailDraftId: Schema.optional(TrimmedNonEmptyString),
  gmailThreadId: Schema.optional(TrimmedNonEmptyString),
  gmailMessageId: Schema.optional(TrimmedNonEmptyString),
  campaignVersion: Schema.optional(TrimmedNonEmptyString),
  sentAt: Schema.optional(Timestamp),
  repliedAt: Schema.optional(Timestamp),
  bouncedAt: Schema.optional(Timestamp),
  draftDeletedAt: Schema.optional(Timestamp),
  suppressedAt: Schema.optional(Timestamp),
  nextFollowUpAt: Schema.optional(Timestamp),
  day3SentAt: Schema.optional(Timestamp),
  provenanceKind: Schema.Literals(["user", "agent", "automation", "import"]),
  provenanceRef: Schema.optional(TrimmedNonEmptyString),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type SalesProspect = typeof SalesProspect.Type;

export const SalesActivityKind = Schema.Literals([
  "proposed",
  "updated",
  "stage_changed",
  "outreach_prepared",
  "draft_approved",
  "draft_declined",
  "gmail_draft_created",
  "gmail_draft_reconciled",
  "sent_reconciled",
  "reply_reconciled",
  "follow_up_prepared",
]);
export type SalesActivityKind = typeof SalesActivityKind.Type;

export const SalesActivity = Schema.Struct({
  id: SalesActivityId,
  prospectId: SalesProspectId,
  spaceId: SpaceId,
  kind: SalesActivityKind,
  actorKind: Schema.Literals(["user", "agent", "automation", "connector", "system"]),
  payload: Schema.Record(Schema.String, Schema.Json),
  occurredAt: Timestamp,
});
export type SalesActivity = typeof SalesActivity.Type;

export const SalesDraftRequestStatus = Schema.Literals([
  "requested",
  "approved",
  "declined",
  "creating",
  "created",
  "failed",
]);
export type SalesDraftRequestStatus = typeof SalesDraftRequestStatus.Type;

export const SalesDraftRequest = Schema.Struct({
  id: SalesDraftRequestId,
  prospectId: SalesProspectId,
  spaceId: SpaceId,
  connectionId: ConnectionId,
  recipient: TrimmedNonEmptyString,
  subject: TrimmedNonEmptyString,
  body: TrimmedNonEmptyString,
  payloadDigest: TrimmedNonEmptyString,
  status: SalesDraftRequestStatus,
  gmailDraftId: Schema.optional(TrimmedNonEmptyString),
  gmailMessageId: Schema.optional(TrimmedNonEmptyString),
  gmailThreadId: Schema.optional(TrimmedNonEmptyString),
  draftKind: SalesDraftKind,
  campaignVersion: TrimmedNonEmptyString,
  campaignStep: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
  idempotencyKey: Schema.optional(TrimmedNonEmptyString),
  evidenceReferences: Schema.Array(TrimmedNonEmptyString),
  requestedAt: Timestamp,
  decidedAt: Schema.optional(Timestamp),
  createdAt: Schema.optional(Timestamp),
  failure: Schema.optional(TrimmedString),
  sentAt: Schema.optional(Timestamp),
  deletedAt: Schema.optional(Timestamp),
});
export type SalesDraftRequest = typeof SalesDraftRequest.Type;

export const SALES_OPPORTUNITY_CENTS = 30_000;
