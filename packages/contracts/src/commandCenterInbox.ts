import {
  Item,
  ItemId,
  NonNegativeInt,
  SpaceId,
  Timestamp,
  TrimmedNonEmptyString,
} from "@command-center/core";
import * as Schema from "effect/Schema";

export const COMMAND_CENTER_INBOX_MAX_COMMENT_CHARS = 20_000;
export const COMMAND_CENTER_INBOX_MAX_HISTORY_PAGE = 100;
export const COMMAND_CENTER_INBOX_MAX_LIST_PAGE = 100;
export const COMMAND_CENTER_INBOX_MAX_PROPOSAL_BYTES = 64 * 1024;

const ShortIdentity = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const MutationId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u),
);
const PositiveSequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const ExactMessage = Schema.String.check(
  Schema.isMaxLength(COMMAND_CENTER_INBOX_MAX_COMMENT_CHARS),
  Schema.makeFilter((value) => value.trim().length > 0 || "Message must not be blank."),
);
const HistoryLimit = Schema.optional(
  Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: COMMAND_CENTER_INBOX_MAX_HISTORY_PAGE }),
  ),
);

export const CommandCenterInboxSubjectIdentity = Schema.Struct({
  kind: ShortIdentity,
  id: ShortIdentity,
});
export type CommandCenterInboxSubjectIdentity = typeof CommandCenterInboxSubjectIdentity.Type;

export const CommandCenterInboxEvidenceIdentity = Schema.Struct({
  source: ShortIdentity,
  subjectId: ShortIdentity,
  version: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  observedAt: Schema.optional(Timestamp),
  digest: Schema.optional(TrimmedNonEmptyString.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u))),
});
export type CommandCenterInboxEvidenceIdentity = typeof CommandCenterInboxEvidenceIdentity.Type;

const ProposalTarget = Schema.Struct({
  kind: ShortIdentity,
  id: ShortIdentity,
});
const ProposalJsonObject = Schema.Record(Schema.String, Schema.Json);
const TaskPatchOperation = Schema.Struct({
  field: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  before: Schema.Json,
  after: Schema.Json,
});
const SprintPlanTaskPatchOperation = Schema.Struct({
  taskId: ShortIdentity,
  field: Schema.Literals(["text", "note", "day", "owner", "done"]),
  before: Schema.Union([Schema.String, Schema.Boolean]),
  after: Schema.Union([Schema.String, Schema.Boolean]),
});
const SprintPlanTaskPatch = Schema.Struct({
  kind: Schema.Literal("sprint-plan-task-patch"),
  target: Schema.Struct({ kind: Schema.Literal("sprint-plan"), id: ShortIdentity }),
  expectedPlanVersion: NonNegativeInt,
  operations: Schema.Array(SprintPlanTaskPatchOperation).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
    Schema.makeFilter((operations) => {
      const pairs = new Set(
        operations.map((operation) => `${operation.taskId}\u0000${operation.field}`),
      );
      return pairs.size === operations.length || "Task and field pairs must be unique.";
    }),
    Schema.makeFilter(
      (operations) =>
        operations.every(
          ({ field, before, after }) =>
            (field === "done"
              ? typeof before === "boolean" && typeof after === "boolean"
              : typeof before === "string" && typeof after === "string") && before !== after,
        ) || "Each task patch needs distinct, correctly typed before and after values.",
    ),
  ),
  reason: ExactMessage,
  expectedBenefit: ExactMessage,
  uncertainty: ExactMessage,
  reviewAt: Timestamp,
  preservedConstraints: Schema.Array(ExactMessage).check(Schema.isMaxLength(32)),
});

export const CommandCenterInboxProposalPayload = Schema.Union([
  SprintPlanTaskPatch,
  Schema.Struct({
    kind: Schema.Literal("task-patch"),
    target: ProposalTarget,
    operations: Schema.Array(TaskPatchOperation).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(100),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("prepared-action"),
    actionKind: ShortIdentity,
    target: ProposalTarget,
    parameters: ProposalJsonObject,
  }),
]).check(
  Schema.makeFilter((payload) => {
    const size = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    return (
      size <= COMMAND_CENTER_INBOX_MAX_PROPOSAL_BYTES ||
      `Proposal payload must be at most ${COMMAND_CENTER_INBOX_MAX_PROPOSAL_BYTES} encoded bytes.`
    );
  }),
);
export type CommandCenterInboxProposalPayload = typeof CommandCenterInboxProposalPayload.Type;

export const CommandCenterInboxProposalPreview = Schema.Struct({
  summary: ExactMessage,
  before: Schema.optional(Schema.String.check(Schema.isMaxLength(20_000))),
  after: Schema.optional(Schema.String.check(Schema.isMaxLength(20_000))),
});
export type CommandCenterInboxProposalPreview = typeof CommandCenterInboxProposalPreview.Type;

export const CommandCenterInboxActor = Schema.Struct({
  kind: Schema.Literal("authenticated-user"),
  subject: Schema.String.check(Schema.isNonEmpty()),
});
export type CommandCenterInboxActor = typeof CommandCenterInboxActor.Type;

export const CommandCenterInboxLifecycle = Schema.Literals(["open", "snoozed", "dismissed"]);
export type CommandCenterInboxLifecycle = typeof CommandCenterInboxLifecycle.Type;

export const CommandCenterInboxView = Schema.Literals(["actionable", "recent", "snoozed"]);
export type CommandCenterInboxView = typeof CommandCenterInboxView.Type;

export const CommandCenterInboxDiscussionEntry = Schema.Struct({
  sequence: PositiveSequence,
  id: TrimmedNonEmptyString,
  itemId: ItemId,
  kind: Schema.Literals(["comment", "change-request"]),
  text: ExactMessage,
  actor: CommandCenterInboxActor,
  createdAt: Timestamp,
  resolvedAt: Schema.optional(Timestamp),
  resolvedBy: Schema.optional(CommandCenterInboxActor),
});
export type CommandCenterInboxDiscussionEntry = typeof CommandCenterInboxDiscussionEntry.Type;

export const CommandCenterInboxRevision = Schema.Struct({
  sequence: PositiveSequence,
  id: TrimmedNonEmptyString,
  itemId: ItemId,
  revision: PositiveSequence,
  predecessorRevisionId: Schema.optional(TrimmedNonEmptyString),
  status: Schema.Literals(["candidate", "current", "superseded", "discarded"]),
  source: Schema.Literals(["agent", "direct"]),
  payload: CommandCenterInboxProposalPayload,
  preview: CommandCenterInboxProposalPreview,
  evidence: CommandCenterInboxEvidenceIdentity,
  actor: CommandCenterInboxActor,
  createdAt: Timestamp,
  acceptedAt: Schema.optional(Timestamp),
  acceptedBy: Schema.optional(CommandCenterInboxActor),
  discardedAt: Schema.optional(Timestamp),
  discardedBy: Schema.optional(CommandCenterInboxActor),
});
export type CommandCenterInboxRevision = typeof CommandCenterInboxRevision.Type;

export const CommandCenterInboxApprovalState = Schema.Struct({
  supported: Schema.Boolean,
  eligible: Schema.Boolean,
  reason: Schema.Literals([
    "phase-a-no-executor",
    "no-current-proposal",
    "changes-requested",
    "candidate-pending",
    "unsupported-proposal",
    "already-applied",
    "policy-not-configured",
    "evidence-ineligible",
    "evidence-stale",
    "plan-stale",
    "ready",
  ]),
});
export type CommandCenterInboxApprovalState = typeof CommandCenterInboxApprovalState.Type;

export const CommandCenterInboxState = Schema.Struct({
  itemId: ItemId,
  spaceId: SpaceId,
  subject: CommandCenterInboxSubjectIdentity,
  lifecycle: CommandCenterInboxLifecycle,
  snoozedUntil: Schema.optional(Timestamp),
  version: NonNegativeInt,
  currentRevisionId: Schema.optional(TrimmedNonEmptyString),
  unresolvedChangeRequestCount: NonNegativeInt,
  candidateCount: NonNegativeInt,
  approval: CommandCenterInboxApprovalState,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type CommandCenterInboxState = typeof CommandCenterInboxState.Type;

export const CommandCenterInboxSummary = Schema.Struct({
  item: Item,
  state: CommandCenterInboxState,
  currentRevision: Schema.optional(CommandCenterInboxRevision),
});
export type CommandCenterInboxSummary = typeof CommandCenterInboxSummary.Type;

export const CommandCenterInboxDetail = Schema.Struct({
  item: Item,
  state: CommandCenterInboxState,
  currentRevision: Schema.optional(CommandCenterInboxRevision),
  discussion: Schema.Array(CommandCenterInboxDiscussionEntry),
  revisions: Schema.Array(CommandCenterInboxRevision),
  nextDiscussionBeforeSequence: Schema.optional(PositiveSequence),
  nextRevisionBeforeSequence: Schema.optional(PositiveSequence),
});
export type CommandCenterInboxDetail = typeof CommandCenterInboxDetail.Type;

export const CommandCenterInboxCursor = Schema.Struct({
  updatedAt: Timestamp,
  itemId: ItemId,
});
export type CommandCenterInboxCursor = typeof CommandCenterInboxCursor.Type;

export const CommandCenterInboxQueryInput = Schema.Struct({
  spaceId: Schema.optional(SpaceId),
  view: Schema.optional(CommandCenterInboxView),
  lifecycles: Schema.optional(
    Schema.Array(CommandCenterInboxLifecycle).check(Schema.isMaxLength(3)),
  ),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: COMMAND_CENTER_INBOX_MAX_LIST_PAGE })),
  ),
  cursor: Schema.optional(CommandCenterInboxCursor),
});
export type CommandCenterInboxQueryInput = typeof CommandCenterInboxQueryInput.Type;

export const CommandCenterInboxQueryResult = Schema.Struct({
  items: Schema.Array(CommandCenterInboxSummary),
  nextCursor: Schema.optional(CommandCenterInboxCursor),
});
export type CommandCenterInboxQueryResult = typeof CommandCenterInboxQueryResult.Type;

export const CommandCenterInboxDetailInput = Schema.Struct({
  spaceId: SpaceId,
  itemId: ItemId,
  historyLimit: HistoryLimit,
  discussionBeforeSequence: Schema.optional(PositiveSequence),
  revisionBeforeSequence: Schema.optional(PositiveSequence),
});
export type CommandCenterInboxDetailInput = typeof CommandCenterInboxDetailInput.Type;

export const CommandCenterInboxMutationBase = Schema.Struct({
  spaceId: SpaceId,
  itemId: ItemId,
  mutationId: MutationId,
  expectedVersion: NonNegativeInt,
});

export const CommandCenterInboxCommentInput = Schema.Struct({
  ...CommandCenterInboxMutationBase.fields,
  text: ExactMessage,
});
export type CommandCenterInboxCommentInput = typeof CommandCenterInboxCommentInput.Type;

export const CommandCenterInboxRequestChangesInput = CommandCenterInboxCommentInput;
export type CommandCenterInboxRequestChangesInput =
  typeof CommandCenterInboxRequestChangesInput.Type;

export const CommandCenterInboxCandidateCreateInput = Schema.Struct({
  ...CommandCenterInboxMutationBase.fields,
  source: Schema.Literal("direct"),
  payload: CommandCenterInboxProposalPayload,
  preview: CommandCenterInboxProposalPreview,
  evidence: CommandCenterInboxEvidenceIdentity,
});
export type CommandCenterInboxCandidateCreateInput =
  typeof CommandCenterInboxCandidateCreateInput.Type;

export const CommandCenterInboxCandidateMutationInput = Schema.Struct({
  ...CommandCenterInboxMutationBase.fields,
  candidateRevisionId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export const CommandCenterInboxApproveAdjustmentInput = Schema.Struct({
  spaceId: SpaceId,
  itemId: ItemId,
  mutationId: MutationId,
  currentRevisionId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  expectedInboxVersion: NonNegativeInt,
  expectedPlanVersion: NonNegativeInt,
});
export type CommandCenterInboxApproveAdjustmentInput =
  typeof CommandCenterInboxApproveAdjustmentInput.Type;
export type CommandCenterInboxCandidateMutationInput =
  typeof CommandCenterInboxCandidateMutationInput.Type;

export const CommandCenterInboxResolveChangeRequestInput = Schema.Struct({
  ...CommandCenterInboxMutationBase.fields,
  changeRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type CommandCenterInboxResolveChangeRequestInput =
  typeof CommandCenterInboxResolveChangeRequestInput.Type;

export const CommandCenterInboxSnoozeInput = Schema.Struct({
  ...CommandCenterInboxMutationBase.fields,
  wakeAt: Timestamp,
});
export type CommandCenterInboxSnoozeInput = typeof CommandCenterInboxSnoozeInput.Type;

export const CommandCenterInboxSimpleMutationInput = CommandCenterInboxMutationBase;
export type CommandCenterInboxSimpleMutationInput =
  typeof CommandCenterInboxSimpleMutationInput.Type;

export const CommandCenterInboxMutationResult = Schema.Struct({
  detail: CommandCenterInboxDetail,
  duplicate: Schema.Boolean,
});
export type CommandCenterInboxMutationResult = typeof CommandCenterInboxMutationResult.Type;
