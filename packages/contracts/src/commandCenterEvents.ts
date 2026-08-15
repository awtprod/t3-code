import {
  ApprovalId,
  ApprovalStatus,
  Artifact,
  AutomationId,
  CommandId,
  ItemId,
  ItemKind,
  ItemStatus,
  MemoryId,
  MemoryKind,
  MemoryStatus,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RepositoryId,
  RouteDecision,
  RunId,
  RunStatus,
  SpaceId,
  ThreadId,
  Timestamp,
  TrimmedNonEmptyString,
  TrimmedString,
} from "@command-center/core";
import * as Schema from "effect/Schema";

const ReplayLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }));
const PollIntervalMs = Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 30_000 }));

export const COMMAND_CENTER_EVENT_ACTIONS = {
  routeSelected: "cc.command.submit",
  runStateChanged: "cc.runs.state",
  approvalChanged: "cc.approvals.changed",
  artifactChanged: "cc.artifacts.changed",
  itemChanged: "cc.items.changed",
  memoryChanged: "cc.memory.changed",
  configChanged: "cc.config.changed",
  failureRecorded: "cc.failures.recorded",
  automationRunChanged: "cc.automations.run.changed",
} as const;

export const CommandCenterEventReplayInput = Schema.Struct({
  afterSequence: NonNegativeInt,
  spaceId: Schema.optional(SpaceId),
  limit: Schema.optional(ReplayLimit),
});
export type CommandCenterEventReplayInput = typeof CommandCenterEventReplayInput.Type;

export const CommandCenterEventSubscribeInput = Schema.Struct({
  afterSequence: NonNegativeInt,
  spaceId: Schema.optional(SpaceId),
  batchSize: Schema.optional(ReplayLimit),
  pollIntervalMs: Schema.optional(PollIntervalMs),
});
export type CommandCenterEventSubscribeInput = typeof CommandCenterEventSubscribeInput.Type;

export const CommandCenterRouteSelectedPayload = Schema.Struct({
  commandId: CommandId,
  route: RouteDecision,
  state: RunStatus,
});
export type CommandCenterRouteSelectedPayload = typeof CommandCenterRouteSelectedPayload.Type;

export const CommandCenterRunStateChangedPayload = Schema.Struct({
  status: RunStatus,
  previousStatus: Schema.optional(RunStatus),
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
  error: Schema.optional(TrimmedString),
});
export type CommandCenterRunStateChangedPayload = typeof CommandCenterRunStateChangedPayload.Type;

export const CommandCenterApprovalChangedPayload = Schema.Struct({
  approvalId: ApprovalId,
  status: ApprovalStatus,
  payloadDigest: TrimmedNonEmptyString,
});
export type CommandCenterApprovalChangedPayload = typeof CommandCenterApprovalChangedPayload.Type;

export const CommandCenterArtifactChangedPayload = Schema.Struct({
  change: Schema.Literals(["created", "updated", "deleted"]),
  artifact: Artifact,
});
export type CommandCenterArtifactChangedPayload = typeof CommandCenterArtifactChangedPayload.Type;

export const CommandCenterItemChangedPayload = Schema.Struct({
  itemId: ItemId,
  change: Schema.Literals(["created", "updated", "deleted"]),
  kind: Schema.optional(ItemKind),
  status: Schema.optional(ItemStatus),
});
export type CommandCenterItemChangedPayload = typeof CommandCenterItemChangedPayload.Type;

export const CommandCenterMemoryChangedPayload = Schema.Struct({
  memoryId: MemoryId,
  change: Schema.Literals(["remembered", "proposed", "updated", "deleted"]),
  kind: MemoryKind,
  status: MemoryStatus,
});
export type CommandCenterMemoryChangedPayload = typeof CommandCenterMemoryChangedPayload.Type;

export const CommandCenterFailurePayload = Schema.Struct({
  scope: Schema.Literals(["command", "run", "automation", "connector", "system"]),
  reason: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  retryable: Schema.Boolean,
});
export type CommandCenterFailurePayload = typeof CommandCenterFailurePayload.Type;

export const CommandCenterAutomationRunChangedPayload = Schema.Struct({
  executionId: TrimmedNonEmptyString,
  automationId: AutomationId,
  state: Schema.Literals([
    "queued",
    "running",
    "waiting_retry",
    "waiting_delay",
    "waiting_external",
    "waiting_approval",
    "succeeded",
    "failed",
    "canceled",
  ]),
  configCommitSha: TrimmedNonEmptyString,
  definitionDigest: TrimmedNonEmptyString,
  error: Schema.optional(TrimmedString),
});
export type CommandCenterAutomationRunChangedPayload =
  typeof CommandCenterAutomationRunChangedPayload.Type;

const EventMetadata = {
  sequence: PositiveInt,
  eventId: TrimmedNonEmptyString,
  previousHash: Schema.NullOr(TrimmedNonEmptyString),
  eventHash: TrimmedNonEmptyString,
  actorKind: TrimmedNonEmptyString,
  spaceId: Schema.NullOr(SpaceId),
  runId: Schema.NullOr(RunId),
  occurredAt: Timestamp,
};

export const CommandCenterEventEnvelope = Schema.Union([
  Schema.TaggedStruct("RouteSelected", {
    ...EventMetadata,
    payload: CommandCenterRouteSelectedPayload,
  }),
  Schema.TaggedStruct("RunStateChanged", {
    ...EventMetadata,
    payload: CommandCenterRunStateChangedPayload,
  }),
  Schema.TaggedStruct("ApprovalChanged", {
    ...EventMetadata,
    payload: CommandCenterApprovalChangedPayload,
  }),
  Schema.TaggedStruct("ArtifactChanged", {
    ...EventMetadata,
    payload: CommandCenterArtifactChangedPayload,
  }),
  Schema.TaggedStruct("ItemChanged", {
    ...EventMetadata,
    payload: CommandCenterItemChangedPayload,
  }),
  Schema.TaggedStruct("MemoryChanged", {
    ...EventMetadata,
    payload: CommandCenterMemoryChangedPayload,
  }),
  Schema.TaggedStruct("CommandCenterFailure", {
    ...EventMetadata,
    payload: CommandCenterFailurePayload,
  }),
  Schema.TaggedStruct("AutomationRunChanged", {
    ...EventMetadata,
    payload: CommandCenterAutomationRunChangedPayload,
  }),
  Schema.TaggedStruct("AuditRecorded", {
    ...EventMetadata,
    action: TrimmedNonEmptyString,
    payload: Schema.Unknown,
  }),
]);
export type CommandCenterEventEnvelope = typeof CommandCenterEventEnvelope.Type;

export const CommandCenterEventPage = Schema.Struct({
  events: Schema.Array(CommandCenterEventEnvelope),
  nextSequence: NonNegativeInt,
});
export type CommandCenterEventPage = typeof CommandCenterEventPage.Type;

export const CommandCenterTimelineQuery = Schema.Struct({
  afterSequence: Schema.optional(NonNegativeInt),
  spaceId: Schema.optional(SpaceId),
  limit: Schema.optional(ReplayLimit),
});
export type CommandCenterTimelineQuery = typeof CommandCenterTimelineQuery.Type;

export const CommandCenterTimelineEntry = Schema.Struct({
  sequence: PositiveInt,
  runId: RunId,
  commandId: CommandId,
  text: TrimmedNonEmptyString,
  spaceId: SpaceId,
  repositoryId: Schema.NullOr(RepositoryId),
  projectId: Schema.NullOr(ProjectId),
  threadId: Schema.NullOr(ThreadId),
  status: RunStatus,
  route: RouteDecision,
  response: Schema.NullOr(
    Schema.Struct({
      kind: Schema.Literals(["assistant", "failure"]),
      text: TrimmedNonEmptyString,
      createdAt: Timestamp,
    }),
  ),
  artifacts: Schema.Array(Artifact),
  startedAt: Timestamp,
  finishedAt: Schema.NullOr(Timestamp),
});
export type CommandCenterTimelineEntry = typeof CommandCenterTimelineEntry.Type;

export const CommandCenterTimelinePage = Schema.Struct({
  entries: Schema.Array(CommandCenterTimelineEntry),
  nextSequence: NonNegativeInt,
});
export type CommandCenterTimelinePage = typeof CommandCenterTimelinePage.Type;

export class CommandCenterEventStreamError extends Schema.TaggedErrorClass<CommandCenterEventStreamError>()(
  "CommandCenterEventStreamError",
  {
    reason: Schema.Literals(["query", "decode", "hash-chain", "hash-mismatch"]),
    message: Schema.String,
    sequence: Schema.optional(NonNegativeInt),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
