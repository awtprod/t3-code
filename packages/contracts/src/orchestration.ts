import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Struct from "effect/Struct";
import { ProviderOptionSelections } from "./model.ts";
import { RepositoryIdentity, ThreadEnvMode } from "./environment.ts";
import {
  ApprovalRequestId,
  CheckpointRef,
  ClientSurface,
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
  TurnId,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { EfficiencyDecision, EfficiencyTier, ThreadRoutingMode } from "./efficiency.ts";
import {
  SandboxConfig,
  SandboxBranchProvenance,
  SandboxEvent,
  SandboxState,
  SandboxFailure,
  SandboxId,
  SandboxPauseReason,
  SandboxRuntime,
  SandboxSpawnWorkerInput,
} from "./sandbox.ts";

export const ORCHESTRATION_WS_METHODS = {
  dispatchCommand: "orchestration.dispatchCommand",
  getWorkflowScript: "orchestration.getWorkflowScript",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  searchThreads: "orchestration.searchThreads",
  getArchivedShellSnapshot: "orchestration.getArchivedShellSnapshot",
  subscribeShell: "orchestration.subscribeShell",
  subscribeThread: "orchestration.subscribeThread",
} as const;

export const ProviderApprovalPolicy = Schema.Literals([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);
export type ProviderApprovalPolicy = typeof ProviderApprovalPolicy.Type;
export const ProviderSandboxMode = Schema.Literals([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type ProviderSandboxMode = typeof ProviderSandboxMode.Type;

/**
 * `ModelSelection` — selection of a model on a configured provider instance.
 *
 * The routing key is `instanceId` (a user-defined slug identifying one
 * configured provider instance). Drivers, credentials, working-directory
 * bindings, and any other per-instance state are recovered from the
 * runtime registry via the instance id.
 *
 * Wire legacy: persisted selections produced before the driver/instance
 * split carried a `provider: <driver-id>` field instead. The schema absorbs
 * that shape via a pre-decoding transform — `{provider, model}` is promoted
 * to `{instanceId: defaultInstanceIdForDriver(provider), model}`. No
 * post-decode compatibility code lives in the runtime; the transform is the
 * only compat surface.
 */
const ModelSelectionWire = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
});

// Source shape for persisted legacy payloads. Fields are typed as
// `Schema.Unknown` so malformed drafts still make it into the transform and
// fail validation through the target schema (with proper error messages)
// rather than at the source-struct layer where the error is less actionable.
const ModelSelectionSource = Schema.Struct({
  provider: Schema.optional(Schema.Unknown),
  instanceId: Schema.optional(Schema.Unknown),
  model: Schema.Unknown,
  options: Schema.optional(Schema.Unknown),
});

export const ModelSelection = ModelSelectionSource.pipe(
  Schema.decodeTo(
    ModelSelectionWire,
    SchemaTransformation.transformOrFail({
      decode: (raw) => {
        // Resolve the routing key: prefer an explicit `instanceId`; fall
        // back to promoting the legacy `provider` slug (the canonical
        // `defaultInstanceIdForDriver` mapping) so persisted rollout-era
        // payloads decode without data loss. The target schema brands the
        // string as `ProviderInstanceId`.
        const instanceIdSource =
          raw.instanceId !== undefined
            ? raw.instanceId
            : typeof raw.provider === "string"
              ? raw.provider
              : undefined;
        const base: Record<string, unknown> = {
          instanceId: instanceIdSource,
          model: raw.model,
        };
        if (raw.options !== undefined) base.options = raw.options;
        return Effect.succeed(base as typeof ModelSelectionWire.Encoded);
      },
      encode: (value) => {
        const base: Record<string, unknown> = {
          model: value.model,
          instanceId: value.instanceId,
        };
        if (value.options !== undefined) base.options = value.options;
        return Effect.succeed(base as typeof ModelSelectionSource.Encoded);
      },
    }),
  ),
);
export type ModelSelection = typeof ModelSelection.Type;

export const RuntimeMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
export type RuntimeMode = typeof RuntimeMode.Type;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
export const ProviderInteractionMode = Schema.Literals(["default", "plan"]);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "default";
export const ProviderRequestKind = Schema.Literals([
  "command",
  "file-read",
  "file-change",
  "mcp-elicitation",
]);
export type ProviderRequestKind = typeof ProviderRequestKind.Type;
export const AssistantDeliveryMode = Schema.Literals(["buffered", "streaming"]);
export type AssistantDeliveryMode = typeof AssistantDeliveryMode.Type;
export const ProviderApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "acceptAlways",
  "decline",
  "cancel",
]);
export type ProviderApprovalDecision = typeof ProviderApprovalDecision.Type;
export const ProviderApprovalOption = Schema.Struct({
  decision: ProviderApprovalDecision,
  label: TrimmedNonEmptyString,
});
export type ProviderApprovalOption = typeof ProviderApprovalOption.Type;
export const ProviderUserInputAnswers = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;

export const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000;
export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const PROVIDER_SEND_TURN_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
const PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPE_SET = new Set<string>(
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
);

/** Whether a pasted or picked image mime type can be sent on a provider turn. */
export function isProviderSendTurnSupportedImageMimeType(mimeType: string): boolean {
  return PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPE_SET.has(mimeType.toLowerCase());
}
const PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS = 14_000_000;
const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;
// Correlation id is command id by design in this model.
export const CorrelationId = CommandId;
export type CorrelationId = typeof CorrelationId.Type;

const ChatAttachmentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHAT_ATTACHMENT_ID_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);
export type ChatAttachmentId = typeof ChatAttachmentId.Type;

export const ChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
});
export type ChatImageAttachment = typeof ChatImageAttachment.Type;

export const ChatFileAttachment = Schema.Struct({
  type: Schema.Literal("file"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES),
  ),
});
export type ChatFileAttachment = typeof ChatFileAttachment.Type;

/**
 * Catch-all for attachment types this build does not know. Attachments ride on
 * persisted events and thread streams, so a newer server or client must be able
 * to introduce a type without making older readers fail to decode the whole
 * message. Decoders keep the shared base fields; consumers skip these or render
 * them as unsupported. Mirrors how `OrchestrationThreadActivity` keeps `kind`
 * open. The known discriminators are excluded so a malformed image or file
 * attachment fails its own schema instead of sliding through here with its
 * size and mime constraints unchecked.
 */
export const ChatUnknownAttachment = Schema.Struct({
  type: TrimmedNonEmptyString.check(
    Schema.isMaxLength(50),
    Schema.isPattern(/^(?!(?:image|file)$)/),
  ),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt,
});
export type ChatUnknownAttachment = typeof ChatUnknownAttachment.Type;

const UploadChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS),
  ),
});
export type UploadChatImageAttachment = typeof UploadChatImageAttachment.Type;

export const ChatAttachment = Schema.Union([
  ChatImageAttachment,
  ChatFileAttachment,
  ChatUnknownAttachment,
]);
export type ChatAttachment = typeof ChatAttachment.Type;
const UploadChatAttachment = Schema.Union([UploadChatImageAttachment]);
export type UploadChatAttachment = typeof UploadChatAttachment.Type;

export const ProjectScriptIcon = Schema.Literals([
  "play",
  "test",
  "lint",
  "configure",
  "build",
  "debug",
]);
export type ProjectScriptIcon = typeof ProjectScriptIcon.Type;

export const ProjectScript = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  icon: ProjectScriptIcon,
  runOnWorktreeCreate: Schema.Boolean,
  /**
   * URL to open in the in-app browser preview when this script runs (or
   * when the user explicitly requests a preview). Optional; only honored on
   * the desktop build.
   */
  previewUrl: Schema.optional(TrimmedNonEmptyString),
  /**
   * When true, automatically open the preview panel pointed at `previewUrl`
   * the moment this script starts. Ignored without `previewUrl` or on web.
   */
  autoOpenPreview: Schema.optional(Schema.Boolean),
});
export type ProjectScript = typeof ProjectScript.Type;

export const ProjectFaviconPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(1024),
  Schema.isPattern(/\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/i),
);
export type ProjectFaviconPath = typeof ProjectFaviconPath.Type;

export const OrchestrationProject = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  // Per-project override for where new threads start. Null/absent means
  // "no override": clients fall back to t3.json, then the global setting.
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  // Optional on the wire so cached snapshots from older servers still decode.
  faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationProject = typeof OrchestrationProject.Type;

export const OrchestrationMessageRole = Schema.Literals(["user", "assistant", "system"]);
export type OrchestrationMessageRole = typeof OrchestrationMessageRole.Type;

export const OrchestrationMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationMessage = typeof OrchestrationMessage.Type;

export const OrchestrationProposedPlanId = TrimmedNonEmptyString;
export type OrchestrationProposedPlanId = typeof OrchestrationProposedPlanId.Type;

export const OrchestrationProposedPlan = Schema.Struct({
  id: OrchestrationProposedPlanId,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: TrimmedNonEmptyString,
  implementedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  implementationThreadId: Schema.NullOr(ThreadId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProposedPlan = typeof OrchestrationProposedPlan.Type;

export const SourceProposedPlanReference = Schema.Struct({
  threadId: ThreadId,
  planId: OrchestrationProposedPlanId,
});
export type SourceProposedPlanReference = typeof SourceProposedPlanReference.Type;

export const OrchestrationSessionStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);
export type OrchestrationSessionStatus = typeof OrchestrationSessionStatus.Type;

export const OrchestrationSession = Schema.Struct({
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  // Per-runtime-start nonce recorded on session.started. Lets ingestion reject a
  // terminal event from a superseded runtime generation that reused this instance.
  sessionGeneration: Schema.optional(Schema.String),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
export type OrchestrationSession = typeof OrchestrationSession.Type;

export const OrchestrationCheckpointFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type OrchestrationCheckpointFile = typeof OrchestrationCheckpointFile.Type;

export const OrchestrationCheckpointStatus = Schema.Literals(["ready", "missing", "error"]);
export type OrchestrationCheckpointStatus = typeof OrchestrationCheckpointStatus.Type;

export const OrchestrationCheckpointSummary = Schema.Struct({
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type OrchestrationCheckpointSummary = typeof OrchestrationCheckpointSummary.Type;

export const OrchestrationThreadActivityTone = Schema.Literals([
  "info",
  "tool",
  "approval",
  "error",
]);
export type OrchestrationThreadActivityTone = typeof OrchestrationThreadActivityTone.Type;

export const OrchestrationThreadActivity = Schema.Struct({
  id: EventId,
  tone: OrchestrationThreadActivityTone,
  kind: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  payload: Schema.Unknown,
  turnId: Schema.NullOr(TurnId),
  correlatedMessageId: Schema.optional(MessageId),
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type OrchestrationThreadActivity = typeof OrchestrationThreadActivity.Type;

const OrchestrationLatestTurnState = Schema.Literals([
  "running",
  "interrupted",
  "completed",
  "error",
]);
export type OrchestrationLatestTurnState = typeof OrchestrationLatestTurnState.Type;

export const OrchestrationLatestTurn = Schema.Struct({
  turnId: TurnId,
  state: OrchestrationLatestTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
});
export type OrchestrationLatestTurn = typeof OrchestrationLatestTurn.Type;

export const ThreadTitleRegeneration = Schema.Struct({
  requestId: CommandId,
  startedAt: IsoDateTime,
});
export type ThreadTitleRegeneration = typeof ThreadTitleRegeneration.Type;

export const ThreadLinkedPullRequest = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
});
export type ThreadLinkedPullRequest = typeof ThreadLinkedPullRequest.Type;

export const OrchestrationThread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  routingMode: Schema.optional(ThreadRoutingMode),
  efficiencyTier: Schema.optional(EfficiencyTier),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  sandboxConfig: Schema.optional(SandboxConfig),
  sandboxBranch: Schema.optional(SandboxState.fields.branch),
  sandbox: Schema.optional(Schema.NullOr(SandboxState)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  settledAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // When the thread last re-entered the active list (any thread.unsettled).
  // Anchors the active-list sort so an unsettled thread surfaces at the top
  // instead of sinking back to its creation-order slot. Cleared on settle.
  // Optional so payloads from pre-stamp servers still decode.
  unsettledAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  // Snooze is an overlay on the active lifecycle, not a fourth destination:
  // a snoozed thread stays "active" in the model and is only suppressed from
  // the inbox until snoozedUntil passes (or the thread raises its hand).
  // Optional so payloads from pre-snooze servers still decode.
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  // Active pinned threads render in the pinned block. Settled and snoozed
  // threads remain in their respective shelves even when pinned.
  // Optional so payloads from pre-pinning servers still decode.
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  // Fractional index for user-arranged pinned order. Keyed threads sort by
  // string comparison ahead of keyless ones (which keep creation order), so
  // servers never need each other's threads to agree on the merged list.
  // Optional so payloads from pre-reorder servers still decode.
  pinOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // Pending-only state. Optional so older servers remain compatible.
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  deletedAt: Schema.NullOr(IsoDateTime),
  messages: Schema.Array(OrchestrationMessage),
  proposedPlans: Schema.Array(OrchestrationProposedPlan).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  activities: Schema.Array(OrchestrationThreadActivity),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  session: Schema.NullOr(OrchestrationSession),
});
export type OrchestrationThread = typeof OrchestrationThread.Type;

export const OrchestrationReadModel = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProject),
  threads: Schema.Array(OrchestrationThread),
  updatedAt: IsoDateTime,
});
export type OrchestrationReadModel = typeof OrchestrationReadModel.Type;

export const OrchestrationProjectShell = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  // Optional on the wire so cached snapshots from older servers still decode.
  faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProjectShell = typeof OrchestrationProjectShell.Type;

export const OrchestrationThreadShell = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  routingMode: Schema.optional(ThreadRoutingMode),
  efficiencyTier: Schema.optional(EfficiencyTier),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  sandboxConfig: Schema.optional(SandboxConfig),
  sandboxBranch: Schema.optional(SandboxState.fields.branch),
  sandbox: Schema.optional(Schema.NullOr(SandboxState)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  settledAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // See OrchestrationThread.unsettledAt: last re-entry into the active list.
  unsettledAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  pinOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  session: Schema.NullOr(OrchestrationSession),
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  hasActionableProposedPlan: Schema.Boolean,
  /**
   * Native background work alive after the turn settles: "working" while
   * subagents/workflows run, "monitoring" when watch loops are the only
   * live work. Optional so old servers/clients interop; absent = none.
   */
  backgroundLiveness: Schema.optional(Schema.NullOr(Schema.Literals(["working", "monitoring"]))),
  /**
   * Current plan step while a turn runs, for the Working indicators
   * (sidebar row, in-chat working line). Cleared when the turn settles —
   * never persists as stale UI. Optional so old servers/clients interop.
   */
  planProgress: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        step: TrimmedNonEmptyString,
        completedSteps: NonNegativeInt,
        totalSteps: NonNegativeInt,
      }),
    ),
  ),
});
export type OrchestrationThreadShell = typeof OrchestrationThreadShell.Type;

export const OrchestrationShellSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProjectShell),
  threads: Schema.Array(OrchestrationThreadShell),
  updatedAt: IsoDateTime,
});
export type OrchestrationShellSnapshot = typeof OrchestrationShellSnapshot.Type;

export const OrchestrationShellStreamEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project-upserted"),
    sequence: NonNegativeInt,
    project: OrchestrationProjectShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-removed"),
    sequence: NonNegativeInt,
    projectId: ProjectId,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-upserted"),
    sequence: NonNegativeInt,
    thread: OrchestrationThreadShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-removed"),
    sequence: NonNegativeInt,
    threadId: ThreadId,
  }),
]);
export type OrchestrationShellStreamEvent = typeof OrchestrationShellStreamEvent.Type;

export const OrchestrationShellStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("synchronized"),
  }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationShellSnapshot,
  }),
  OrchestrationShellStreamEvent,
]);
export type OrchestrationShellStreamItem = typeof OrchestrationShellStreamItem.Type;

export const OrchestrationSubscribeShellInput = Schema.Struct({
  /**
   * When provided, the server skips the initial full shell snapshot and instead
   * replays shell events after this sequence before streaming live events.
   * Clients that already hold a cached (or HTTP-loaded) shell snapshot pass its
   * sequence here so the subscription resumes without re-sending the entire
   * projects/threads list (overlapping events are deduped by sequence on the
   * client).
   */
  afterSequence: Schema.optionalKey(NonNegativeInt),
  /**
   * Requests an explicit marker after the subscription has emitted its initial
   * snapshot or catch-up replay and before it begins emitting live events.
   */
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationSubscribeShellInput = typeof OrchestrationSubscribeShellInput.Type;

export const OrchestrationSubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
  /**
   * When provided, the server skips the initial snapshot frame and instead
   * replays events after this sequence before streaming live events. Clients
   * that load the snapshot over HTTP pass the snapshot's sequence here so the
   * live subscription resumes without a gap (overlapping events are deduped by
   * sequence on the client).
   */
  afterSequence: Schema.optionalKey(NonNegativeInt),
  /**
   * Requests an explicit marker after the subscription has emitted its initial
   * snapshot or catch-up replay and before it begins emitting live events.
   */
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
  /**
   * When provided, the fallback snapshot frame (sent when `afterSequence` is
   * missing or the catch-up gap is too large) is windowed to the last
   * `turnLimit` user-anchored turns and carries `page` metadata. Absent means
   * the fallback snapshot is the full thread, preserving pre-pagination client
   * behavior. Live events are unaffected either way.
   */
  turnLimit: Schema.optionalKey(PositiveInt),
});
export type OrchestrationSubscribeThreadInput = typeof OrchestrationSubscribeThreadInput.Type;

/**
 * Bounds a thread detail read to a window of recent turns. `turnLimit` counts
 * turns with a user pending message (subagent/fan-out turns between them ride
 * along), so the window always contains the last N user prompts. `beforeCursor`
 * requests the disjoint page of older turns strictly before a previously
 * returned cursor. Requests without a window get the full thread; pagination is
 * strictly opt-in so older clients keep today's behavior on both HTTP and the
 * WebSocket fallback snapshot.
 */
export const OrchestrationThreadDetailWindow = Schema.Struct({
  turnLimit: Schema.optionalKey(PositiveInt),
  beforeCursor: Schema.optionalKey(TrimmedNonEmptyString),
});
export type OrchestrationThreadDetailWindow = typeof OrchestrationThreadDetailWindow.Type;

/**
 * Page metadata for a windowed thread detail read. `beforeCursor` is opaque and
 * exclusive: passing it back returns the adjacent disjoint slice of older
 * turns. `null` means the thread is fully loaded below this page. The
 * `snapshotSequence` mirrors the top-level snapshot sequence so history pages
 * can be sequence-checked against live state before merging.
 */
export const OrchestrationThreadDetailPage = Schema.Struct({
  beforeCursor: Schema.NullOr(TrimmedNonEmptyString),
  hasMore: Schema.Boolean,
  snapshotSequence: NonNegativeInt,
  /**
   * Highest event sequence applied to THIS thread at page read time. The
   * global `snapshotSequence` advances with every thread's events, so a
   * client cannot wait for it via its per-thread subscription; this
   * thread-scoped watermark is reachable. A client merging an older page
   * must first have applied live events up to it — otherwise a streaming
   * turn outside the loaded window could have deltas replayed on top of
   * page content that already includes them, duplicating text.
   */
  threadSequence: Schema.optionalKey(NonNegativeInt),
});
export type OrchestrationThreadDetailPage = typeof OrchestrationThreadDetailPage.Type;

export const OrchestrationThreadDetailSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  thread: OrchestrationThread,
  // Present only on windowed responses. Absent on full snapshots (and from
  // pre-pagination servers), which clients treat as fully loaded.
  page: Schema.optional(OrchestrationThreadDetailPage),
});
export type OrchestrationThreadDetailSnapshot = typeof OrchestrationThreadDetailSnapshot.Type;

export const ProjectCreateCommand = Schema.Struct({
  type: Schema.Literal("project.create"),
  commandId: CommandId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  createWorkspaceRootIfMissing: Schema.optional(Schema.Boolean),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  createdAt: IsoDateTime,
});

const ProjectMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.meta.update"),
  commandId: CommandId,
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  // Absent = leave unchanged; null = clear the override.
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
});

const ProjectDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.delete"),
  commandId: CommandId,
  projectId: ProjectId,
  force: Schema.optional(Schema.Boolean),
});

const ThreadCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  routingMode: Schema.optional(ThreadRoutingMode),
  efficiencyTier: Schema.optional(EfficiencyTier),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  sandboxConfig: Schema.optional(SandboxConfig),
  sandboxBranch: Schema.optional(SandboxState.fields.branch),
  sandbox: Schema.optional(Schema.NullOr(SandboxState)),
  createdAt: IsoDateTime,
});

const ThreadDeleteCommand = Schema.Struct({
  type: Schema.Literal("thread.delete"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadArchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.archive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.unarchive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadSettleCommand = Schema.Struct({
  type: Schema.Literal("thread.settle"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadAutoSettleCommand = Schema.Struct({
  type: Schema.Literal("thread.auto-settle"),
  commandId: CommandId,
  threadId: ThreadId,
  snapshotSequence: NonNegativeInt,
});

const ThreadUnsettleCommand = Schema.Struct({
  type: Schema.Literal("thread.unsettle"),
  commandId: CommandId,
  threadId: ThreadId,
  // Commands only carry "user": activity un-settles are decided server-side
  // (the decider emits thread.unsettled(reason: "activity") events directly,
  // never through this command), so a client cannot forge the neutral reset.
  reason: Schema.Literal("user"),
});

const ThreadSnoozeCommand = Schema.Struct({
  type: Schema.Literal("thread.snooze"),
  commandId: CommandId,
  threadId: ThreadId,
  // The wake time. Event-based wake conditions (PR merged, review posted)
  // will arrive as an optional condition field alongside this; time-based
  // snooze is just the first kind of condition.
  snoozedUntil: IsoDateTime,
});

const ThreadUnsnoozeCommand = Schema.Struct({
  type: Schema.Literal("thread.unsnooze"),
  commandId: CommandId,
  threadId: ThreadId,
  // Commands only carry "user": activity wakes are decided server-side (the
  // decider emits thread.unsnoozed(reason: "activity") directly), and timer
  // wakes need no event at all — clients derive visibility from snoozedUntil,
  // so a passed wake time simply stops classifying as snoozed.
  reason: Schema.Literal("user"),
});

const ThreadPinCommand = Schema.Struct({
  type: Schema.Literal("thread.pin"),
  commandId: CommandId,
  threadId: ThreadId,
  // Initial slot in the user-arranged pinned order (see ThreadPinReorderCommand).
  // Optional: clients on pre-reorder servers omit it, and the pinned block
  // falls back to creation order for keyless threads.
  orderKey: Schema.optional(TrimmedNonEmptyString),
});

const ThreadUnpinCommand = Schema.Struct({
  type: Schema.Literal("thread.unpin"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadPinReorderCommand = Schema.Struct({
  type: Schema.Literal("thread.pin.reorder"),
  commandId: CommandId,
  threadId: ThreadId,
  // Fractional index key: pinned threads sort by plain string comparison of
  // these keys, so a drag writes one key to one thread — neighbors (possibly
  // on other servers) are never touched. Clients compute a key that sorts
  // between the dropped position's neighbors.
  orderKey: TrimmedNonEmptyString,
});

const ThreadMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.meta.update"),
  commandId: CommandId,
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  regenerateTitle: Schema.optional(Schema.Literal(true)),
  modelSelection: Schema.optional(ModelSelection),
  routingMode: Schema.optional(ThreadRoutingMode),
  efficiencyTier: Schema.optional(EfficiencyTier),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  expectedBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
}).check(
  Schema.makeFilter(
    (input) =>
      !(input.title !== undefined && input.regenerateTitle === true) ||
      "title and regenerateTitle cannot be specified together",
  ),
);

const ThreadRuntimeModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
});

const ThreadInteractionModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.interaction-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});

const ThreadTurnStartBootstrapCreateThread = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  routingMode: Schema.optional(ThreadRoutingMode),
  efficiencyTier: Schema.optional(EfficiencyTier),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  sandboxConfig: Schema.optional(SandboxConfig),
  sandboxBranch: Schema.optional(SandboxState.fields.branch),
  sandbox: Schema.optional(Schema.NullOr(SandboxState)),
  createdAt: IsoDateTime,
});

const ThreadTurnStartBootstrapPrepareWorktree = Schema.Struct({
  projectCwd: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  branch: Schema.optional(TrimmedNonEmptyString),
  startFromOrigin: Schema.optional(Schema.Boolean),
});

const ThreadTurnStartBootstrap = Schema.Struct({
  createThread: Schema.optional(ThreadTurnStartBootstrapCreateThread),
  prepareWorktree: Schema.optional(ThreadTurnStartBootstrapPrepareWorktree),
  runSetupScript: Schema.optional(Schema.Boolean),
});

export type ThreadTurnStartBootstrap = typeof ThreadTurnStartBootstrap.Type;

export const ThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
  }),
  modelSelection: Schema.optional(ModelSelection),
  routingMode: Schema.optional(ThreadRoutingMode),
  efficiencyTier: Schema.optional(EfficiencyTier),
  efficiencyDecision: Schema.optional(EfficiencyDecision),
  retryOfTurnId: Schema.optional(TurnId),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

const ClientThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(Schema.Union([UploadChatAttachment, ChatAttachment])),
  }),
  modelSelection: Schema.optional(ModelSelection),
  routingMode: Schema.optional(ThreadRoutingMode),
  efficiencyTier: Schema.optional(EfficiencyTier),
  retryOfTurnId: Schema.optional(TurnId),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

const ThreadTurnInterruptCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.interrupt"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

// Server-internal only: re-issues an interrupted turn for an existing user message
// (no duplicate `thread.message-sent`) after a provider session exits mid-turn.
export const ThreadTurnResumeCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.resume"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  // The interrupted turn's effective model selection, carried so the restarted
  // session resolves to the same provider instance/model (and thus recovers the
  // persisted resume cursor). Omitted when the interrupted turn used the thread
  // default, in which case the reactor falls back to `thread.modelSelection`.
  modelSelection: Schema.optional(ModelSelection),
  // The interrupted turn's source proposed-plan reference, carried so a resumed
  // plan-implementation turn re-associates with (and can mark implemented) its
  // originating plan. When the superseded pending start belonged to a plan
  // implementation, dropping this here leaves the plan permanently unmarked
  // because the resume replaces the pending row and the reactor skips the
  // original `thread.turn-start-requested`.
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  reason: Schema.optional(Schema.String),
  createdAt: IsoDateTime,
});

const ThreadApprovalRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.approval.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

const ThreadCheckpointRevertCommand = Schema.Struct({
  type: Schema.Literal("thread.checkpoint.revert"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadSessionStopCommand = Schema.Struct({
  type: Schema.Literal("thread.session.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  /**
   * Highest request sequence this stop is allowed to cancel.
   *
   * Absent for a stop the user pressed, which cancels everything queued at the
   * moment it is accepted and therefore needs no cutoff beyond its own position
   * in the log. Present only when the stop is an ESCALATION of an earlier,
   * narrower cancellation — an interrupt whose delivery failed and had to be
   * widened to the session — in which case it carries that interrupt's sequence
   * so the widening does not also swallow work the user submitted in between.
   *
   * Without it the escalation dates itself to when it gave up rather than to
   * what the user actually stopped: a message typed during the interrupt's
   * retry delay sits at a LOWER sequence than the escalated stop and is
   * retroactively canceled by it, silently, having been submitted after the
   * user's stop and therefore explicitly wanted.
   *
   * SERVER-ONLY. Absent from `ClientThreadSessionStopCommand`, which is what
   * the client union admits, so a remote caller cannot choose the cutoff of a
   * stop it requests. See that schema for what a client-chosen value would buy.
   */
  canceledThroughSequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
  // Settle-cleanup stops are conditional: the decider drops the stop if the
  // thread was re-engaged (unsettled, session starting/running, or a queued
  // turn start) between the settle and this command. Guarding in the decider
  // closes the race a post-settle snapshot read cannot: commands are decided
  // serially against the authoritative read model.
  onlyIfSettled: Schema.optional(Schema.Boolean),
});

/**
 * The stop a client may ask for: everything queued as of the moment the server
 * accepts it.
 *
 * `canceledThroughSequence` is omitted rather than optional, and the omission
 * is a security boundary, not tidiness. The field is only ever correct when the
 * reactor derives it from an interrupt it is escalating; a value that arrived
 * over the wire has no such provenance, and both directions of a wrong one are
 * durable:
 *
 * - A cutoff BELOW the stop's own sequence under-cancels. Requests already
 *   queued pass both the durable barrier and the event-log guard, and a
 *   turn-start that survives a stop resurrects the session it was stopping —
 *   `sendTurn` to a stopped session resolves with `allowRecovery: true`.
 *   Sending `0` turns any stop into a no-op while the UI reports it as done.
 * - A cutoff ABOVE it poisons the thread. The barrier raise is monotonic by
 *   design (an out-of-order interrupt must not un-cancel earlier work), so a
 *   large value cannot be lowered by anything: every later request is refused
 *   at the claim until the thread's own sequence climbs past it. The event-log
 *   guard, which scans only events after a request, never sees that old stop
 *   for those later requests — so the two gates disagree, one silently
 *   refusing what the other allows.
 *
 * A stop the user pressed needs no cutoff: its position in the log already says
 * when it happened, and `processSessionStopRequested` falls back to
 * `event.sequence` for exactly that reason. So nothing is lost by withholding
 * the field, and the escalation path — the only caller that legitimately sets
 * it — builds `ThreadSessionStopCommand` inside the server and never crosses
 * this boundary.
 */
const ClientThreadSessionStopCommand = Schema.Struct({
  type: Schema.Literal("thread.session.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  // Settle-cleanup stops are conditional: the decider drops the stop if the
  // thread was re-engaged (unsettled, session starting/running, or a queued
  // turn start) between the settle and this command. Guarding in the decider
  // closes the race a post-settle snapshot read cannot: commands are decided
  // serially against the authoritative read model.
  onlyIfSettled: Schema.optional(Schema.Boolean),
});

const SandboxProvisionCommand = Schema.Struct({
  type: Schema.Literal("sandbox.provision"),
  commandId: CommandId,
  threadId: ThreadId,
  config: Schema.optional(SandboxConfig),
  branch: Schema.optional(SandboxBranchProvenance),
  /**
   * SERVER-ONLY. Absent from `ClientSandboxProvisionCommand`.
   *
   * The decider has two provision paths and they are not interchangeable.
   * `provisionsInline` takes the thread straight to `provisioning`; only a
   * caller that goes on to provision may ask for it, because the event it emits
   * (`sandbox.provisioning-started`) is read by the projector and nobody else.
   * Everyone else gets `sandbox.provision-requested`, which is what
   * `SandboxLifecycleReactor` listens for.
   *
   * It cannot be inferred from `branch`: `ProviderCommandReactor` provisions
   * inline and deliberately omits the branch when re-provisioning, while the UI
   * omits it always. Inferring left every client re-provision emitting an event
   * no reactor consumes -- the thread sat in `provisioning` with no container
   * and no error.
   */
  provisionsInline: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
});

/** The provision a client may ask for: no inline-provisioning claim. */
const ClientSandboxProvisionCommand = Schema.Struct({
  type: Schema.Literal("sandbox.provision"),
  commandId: CommandId,
  threadId: ThreadId,
  config: Schema.optional(SandboxConfig),
  createdAt: IsoDateTime,
});
const SandboxPauseCommand = Schema.Struct({
  type: Schema.Literal("sandbox.pause"),
  commandId: CommandId,
  threadId: ThreadId,
  reason: SandboxPauseReason,
  createdAt: IsoDateTime,
});
const SandboxTakeoverCommand = Schema.Struct({
  type: Schema.Literal("sandbox.takeover"),
  commandId: CommandId,
  threadId: ThreadId,
  sessionId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
const SandboxResumeCommand = Schema.Struct({
  type: Schema.Literal("sandbox.resume"),
  commandId: CommandId,
  threadId: ThreadId,
  leaseId: Schema.optional(TrimmedNonEmptyString),
  takeoverSummary: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});
const SandboxStopCommand = Schema.Struct({
  type: Schema.Literal("sandbox.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  /**
   * Stop the sandbox even while a human holds the desktop takeover lease,
   * revoking it.
   *
   * SERVER-ONLY. Absent from `ClientSandboxStopCommand`, which is what the
   * client union admits, so a remote caller cannot pull the desktop out from
   * under whoever is using it.
   *
   * An ordinary stop is refused under a lease on purpose: a takeover means a
   * person is at the keyboard, and their session must not be closed by a
   * background reactor or another client. Thread deletion is the one caller
   * that cannot honour that. The thread is gone; nothing will ever resume it,
   * nothing will ever release the lease, and reconcile still counts the
   * deleted thread as expected, so orphan removal skips its container too --
   * the sandbox runs forever. Deletion therefore sends this variant, which
   * takes the same `stopping` transition and clears the controller.
   */
  force: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
});

/** The stop a client may ask for: never one that revokes a takeover lease. */
const ClientSandboxStopCommand = Schema.Struct({
  type: Schema.Literal("sandbox.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});
const SandboxBranchExportCommand = Schema.Struct({
  type: Schema.Literal("sandbox.branch-export"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});
const SandboxWorkerSpawnCommand = Schema.Struct({
  type: Schema.Literal("sandbox.worker.spawn"),
  commandId: CommandId,
  ...SandboxSpawnWorkerInput.fields,
  childThreadId: ThreadId,
  branchName: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
const SandboxWorkerStatusCommand = Schema.Struct({
  type: Schema.Literal("sandbox.worker.status"),
  commandId: CommandId,
  parentThreadId: ThreadId,
  childThreadId: ThreadId,
  createdAt: IsoDateTime,
});
const SandboxWorkerMessageCommand = Schema.Struct({
  type: Schema.Literal("sandbox.worker.message"),
  commandId: CommandId,
  parentThreadId: ThreadId,
  childThreadId: ThreadId,
  message: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
const SandboxWorkerStopCommand = Schema.Struct({
  type: Schema.Literal("sandbox.worker.stop"),
  commandId: CommandId,
  parentThreadId: ThreadId,
  childThreadId: ThreadId,
  reason: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

const DispatchableClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadPinCommand,
  ThreadUnpinCommand,
  ThreadPinReorderCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadSessionStopCommand,
  SandboxProvisionCommand,
  SandboxPauseCommand,
  SandboxTakeoverCommand,
  SandboxResumeCommand,
  SandboxStopCommand,
  SandboxBranchExportCommand,
  SandboxWorkerSpawnCommand,
  SandboxWorkerStatusCommand,
  SandboxWorkerMessageCommand,
  SandboxWorkerStopCommand,
]);
export type DispatchableClientOrchestrationCommand =
  typeof DispatchableClientOrchestrationCommand.Type;

export const ClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadPinCommand,
  ThreadUnpinCommand,
  ThreadPinReorderCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ClientThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ClientThreadSessionStopCommand,
  ClientSandboxProvisionCommand,
  SandboxPauseCommand,
  SandboxTakeoverCommand,
  SandboxResumeCommand,
  ClientSandboxStopCommand,
  SandboxBranchExportCommand,
  SandboxWorkerSpawnCommand,
  SandboxWorkerStatusCommand,
  SandboxWorkerMessageCommand,
  SandboxWorkerStopCommand,
]);
export type ClientOrchestrationCommand = typeof ClientOrchestrationCommand.Type;

export const ThreadSessionPendingTurnStartAdoption = Schema.Literals([
  "none",
  "exact",
  "oldest-pending",
]);
export type ThreadSessionPendingTurnStartAdoption =
  typeof ThreadSessionPendingTurnStartAdoption.Type;

export const ThreadSessionTerminalTurnTransition = Schema.Struct({
  turnId: TurnId,
  state: Schema.Literals(["completed", "interrupted", "error"]),
});
export type ThreadSessionTerminalTurnTransition = typeof ThreadSessionTerminalTurnTransition.Type;

const ThreadSessionSetCommand = Schema.Struct({
  type: Schema.Literal("thread.session.set"),
  commandId: CommandId,
  threadId: ThreadId,
  session: OrchestrationSession,
  createdAt: IsoDateTime,
  /**
   * Explicitly identifies whether this transition may adopt a pending turn-start
   * placeholder. The decider always persists a value on new events; optionality
   * exists only so older commands remain decodable while upgrading.
   */
  pendingTurnStartAdoption: Schema.optional(ThreadSessionPendingTurnStartAdoption),
  /**
   * Set only when this session-set is driven by a provider `turn.started`, and
   * carries the sequence of the `thread.turn-start-requested` that turn was
   * started for.
   *
   * It rides the command rather than `OrchestrationSession` on purpose: the
   * session struct is durable state that outlives the turn, while this is a
   * fact about ONE transition — which request the arriving turn answers. The
   * projector consumes it to adopt the matching pending placeholder instead of
   * the oldest one, which is what keeps two out-of-order starts from swapping
   * each other's message, model, source plan, and interrupt flag.
   */
  turnRequestSequence: Schema.optional(NonNegativeInt),
  /**
   * Set only when this session-set closes a specific turn — a provider
   * `turn.completed`, or the stall watchdog failing the turn it timed out —
   * and names that turn.
   *
   * This exists because "the session went quiet" is not evidence that any
   * particular turn finished. Several writers produce a session-set with no
   * active turn for reasons that settle nothing: a concurrent turn-start
   * failure, a session rebind, the stop's own teardown. The escalated-stop
   * re-drive must distinguish "this spared request's turn ran to its end"
   * (do not re-send the prompt) from all of those (do re-send it), and the
   * only way to do that without guessing from status strings is for the one
   * writer that actually knows a turn ended to say which turn. Absent means
   * "this write settles no turn", never "unknown".
   */
  settledTurnId: Schema.optional(TurnId),
  /**
   * Exact turn lifecycle transition represented by this session update. Unlike
   * `settledTurnId`, this also covers crash/exit/orphan cleanup, which must
   * terminalize the known turn without claiming it settled successfully.
   */
  terminalTurnTransition: Schema.optional(ThreadSessionTerminalTurnTransition),
  /**
   * Exact turn lifecycle transitions that must be applied atomically with this
   * session update. The singular field remains for historical events and
   * existing producers; this array is required when one session transition
   * terminalizes more than one turn.
   */
  terminalTurnTransitions: Schema.optional(Schema.Array(ThreadSessionTerminalTurnTransition)),
});

/**
 * Records that a `thread.turn-start-requested` reached the provider but was
 * folded into an already-running turn (a "steer") instead of opening a new one.
 *
 * Non-Codex adapters deliberately emit no `turn.started` for a steer — the work
 * continues as the same turn — and `turn.started` is the only thing that
 * consumes a pending turn-start placeholder. Without this command the steer's
 * placeholder survives indefinitely, and every consumer that reads "a surviving
 * pending row means this message was never sent" draws the opposite of the
 * truth: auto-resume re-issues a prompt the provider already has, the
 * committed-side-effect gate is bypassed on that false premise, and
 * reconciliation reports the turn as never started.
 *
 * It is a distinct command rather than a synthetic `turn.started` because a
 * steer is NOT a turn boundary. A fake start would capture a pre-turn git
 * baseline, re-transition the command-center run to `running`, and settle turns
 * that are still legitimately running.
 */
const ThreadTurnStartFoldCommand = Schema.Struct({
  type: Schema.Literal("thread.turn-start.fold"),
  commandId: CommandId,
  threadId: ThreadId,
  /** Sequence of the `thread.turn-start-requested` this send answered. */
  turnRequestSequence: NonNegativeInt,
  /** The already-running turn the steered message was folded into. */
  turnId: TurnId,
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantDeltaCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.delta"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  delta: Schema.String,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadProposedPlanUpsertCommand = Schema.Struct({
  type: Schema.Literal("thread.proposed-plan.upsert"),
  commandId: CommandId,
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
  createdAt: IsoDateTime,
});

const ThreadTurnDiffCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.diff.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  completedAt: IsoDateTime,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.optional(MessageId),
  checkpointTurnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadActivityAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.activity.append"),
  commandId: CommandId,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  createdAt: IsoDateTime,
});

const ThreadRevertCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.revert.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadTitleRegenerationCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.title.regeneration.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: CommandId,
  title: Schema.optional(TrimmedNonEmptyString),
});

const SandboxProvisionReadyCommand = Schema.Struct({
  type: Schema.Literal("sandbox.provision.ready"),
  commandId: CommandId,
  threadId: ThreadId,
  sandboxId: SandboxId,
  runtime: SandboxRuntime,
  runtimeRef: TrimmedNonEmptyString,
  /**
   * The streamed desktop the runtime actually started. Absent on headless
   * deployments (`T3_SANDBOX_DESKTOP=disabled`), which provision a sandbox with
   * no desktop at all -- the readiness the projection reports has to follow, or
   * clients offer a viewer that the desktop routes answer with 409.
   */
  desktopSessionId: Schema.optionalKey(TrimmedNonEmptyString),
  desktopStreamPath: Schema.optionalKey(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});
const SandboxOperationFailCommand = Schema.Struct({
  type: Schema.Literal("sandbox.operation.fail"),
  commandId: CommandId,
  threadId: ThreadId,
  failure: SandboxFailure,
  createdAt: IsoDateTime,
});
const SandboxExpireCommand = Schema.Struct({
  type: Schema.Literal("sandbox.expire"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});
const SandboxStopCompleteCommand = Schema.Struct({
  type: Schema.Literal("sandbox.stop.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  expired: Schema.Boolean,
  createdAt: IsoDateTime,
});
const SandboxTakeoverCompleteCommand = Schema.Struct({
  type: Schema.Literal("sandbox.takeover.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  sessionId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
const SandboxReconcileResultCommand = Schema.Struct({
  type: Schema.Literal("sandbox.reconcile.result"),
  commandId: CommandId,
  threadId: ThreadId,
  disposition: Schema.Literals(["matched", "missing", "adopted", "orphan-removed"]),
  sandbox: SandboxState,
  createdAt: IsoDateTime,
});
const SandboxBranchExportResultCommand = Schema.Struct({
  type: Schema.Literal("sandbox.branch-export.result"),
  commandId: CommandId,
  threadId: ThreadId,
  branchName: TrimmedNonEmptyString,
  headCommit: TrimmedNonEmptyString,
  artifactId: TrimmedNonEmptyString.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  bundleSha256: TrimmedNonEmptyString.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  /**
   * Digest of the provider conversation store archived alongside the bundle.
   *
   * Optional because a store is best-effort: an export skips it when the store
   * is absent, oversized, or fails to archive, and the branch export still has
   * to go through -- the commits are the part that cannot be lost.
   */
  storeSha256: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  /**
   * Commit the export pinned its working-tree snapshot at, when the tree was
   * dirty. Restore requires the bundle's snapshot ref to resolve to exactly
   * this commit before unpacking that tree over the user's checkout.
   */
  snapshotCommit: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isPattern(/^[0-9a-f]{40,64}$/i)),
  ),
  createdAt: IsoDateTime,
});

const InternalOrchestrationCommand = Schema.Union([
  ThreadTurnResumeCommand,
  ThreadAutoSettleCommand,
  ThreadSessionSetCommand,
  ThreadTurnStartFoldCommand,
  ThreadMessageAssistantDeltaCommand,
  ThreadMessageAssistantCompleteCommand,
  ThreadProposedPlanUpsertCommand,
  ThreadTurnDiffCompleteCommand,
  ThreadActivityAppendCommand,
  ThreadRevertCompleteCommand,
  ThreadTitleRegenerationCompleteCommand,
  SandboxProvisionReadyCommand,
  SandboxOperationFailCommand,
  SandboxExpireCommand,
  SandboxStopCompleteCommand,
  SandboxTakeoverCompleteCommand,
  SandboxReconcileResultCommand,
  SandboxBranchExportResultCommand,
]);
export type InternalOrchestrationCommand = typeof InternalOrchestrationCommand.Type;

export const OrchestrationCommand = Schema.Union([
  DispatchableClientOrchestrationCommand,
  InternalOrchestrationCommand,
]);
export type OrchestrationCommand = typeof OrchestrationCommand.Type;

export const OrchestrationEventType = Schema.Literals([
  "project.created",
  "project.meta-updated",
  "project.deleted",
  "thread.created",
  "thread.deleted",
  "thread.archived",
  "thread.unarchived",
  "thread.settled",
  "thread.unsettled",
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.pinned",
  "thread.unpinned",
  "thread.pin-reordered",
  "thread.meta-updated",
  "thread.runtime-mode-set",
  "thread.interaction-mode-set",
  "thread.message-sent",
  "thread.turn-start-requested",
  "thread.turn-interrupt-requested",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.checkpoint-revert-requested",
  "thread.reverted",
  "thread.session-stop-requested",
  "thread.session-set",
  "thread.turn-start-folded",
  "thread.proposed-plan-upserted",
  "thread.turn-diff-completed",
  "thread.activity-appended",
  "sandbox.provisioning-started",
  "sandbox.provision-requested",
  "sandbox.ready",
  "sandbox.failed",
  "sandbox.paused",
  "sandbox.takeover-requested",
  "sandbox.takeover-acquired",
  "sandbox.resumed",
  "sandbox.stopping",
  "sandbox.expired",
  "sandbox.stopped",
  "sandbox.reconciled",
  "sandbox.branch-exported",
  "sandbox.branch-export-requested",
  "sandbox.worker-spawn-requested",
  "sandbox.worker-status-requested",
  "sandbox.worker-message-requested",
  "sandbox.worker-stop-requested",
]);
export type OrchestrationEventType = typeof OrchestrationEventType.Type;

export const OrchestrationAggregateKind = Schema.Literals(["project", "thread"]);
export type OrchestrationAggregateKind = typeof OrchestrationAggregateKind.Type;
export const OrchestrationActorKind = Schema.Literals(["client", "server", "provider"]);

export const ProjectCreatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  // Optional so persisted events from older servers still decode.
  faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ProjectMetaUpdatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  updatedAt: IsoDateTime,
});

export const ProjectDeletedPayload = Schema.Struct({
  projectId: ProjectId,
  deletedAt: IsoDateTime,
});

export const ThreadCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  routingMode: Schema.optional(ThreadRoutingMode),
  efficiencyTier: Schema.optional(EfficiencyTier),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  sandboxConfig: Schema.optional(SandboxConfig),
  sandboxBranch: Schema.optional(SandboxState.fields.branch),
  sandbox: Schema.optional(Schema.NullOr(SandboxState)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadDeletedPayload = Schema.Struct({
  threadId: ThreadId,
  deletedAt: IsoDateTime,
});

export const ThreadArchivedPayload = Schema.Struct({
  threadId: ThreadId,
  archivedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnarchivedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});

export const ThreadSettledPayload = Schema.Struct({
  threadId: ThreadId,
  settledAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnsettledPayload = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.Literals(["user", "activity"]),
  updatedAt: IsoDateTime,
});

export const ThreadSnoozedPayload = Schema.Struct({
  threadId: ThreadId,
  snoozedUntil: IsoDateTime,
  snoozedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnsnoozedPayload = Schema.Struct({
  threadId: ThreadId,
  // user: explicit "wake now". activity: real work arrived (user message /
  // session coming alive) and the decider cleared the snooze — mirrors
  // thread.unsettled's activity resets. Timer wakes emit no event: clients
  // derive them from snoozedUntil passing.
  reason: Schema.Literals(["user", "activity"]),
  updatedAt: IsoDateTime,
});

export const ThreadPinnedPayload = Schema.Struct({
  threadId: ThreadId,
  pinnedAt: IsoDateTime,
  // Absent on re-pins of an already-pinned thread (the existing key wins)
  // and on pins from clients that predate reordering.
  pinOrderKey: Schema.optional(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});

export const ThreadUnpinnedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});

export const ThreadPinReorderedPayload = Schema.Struct({
  threadId: ThreadId,
  orderKey: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});

export const ThreadMetaUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  /** Intent marker consumed by the title-generation reactor. Keeping this on
      the existing event lets older clients safely ignore the new field. */
  regenerateTitle: Schema.optional(Schema.Literal(true)),
  /** Title at request time, used to avoid overwriting a later manual rename. */
  previousTitle: Schema.optional(TrimmedNonEmptyString),
  /** Pending state shared with clients. Null clears a matching request. */
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  modelSelection: Schema.optional(ModelSelection),
  routingMode: Schema.optional(ThreadRoutingMode),
  efficiencyTier: Schema.optional(EfficiencyTier),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  updatedAt: IsoDateTime,
});

export const ThreadRuntimeModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  updatedAt: IsoDateTime,
});

export const ThreadInteractionModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  updatedAt: IsoDateTime,
});

export const ThreadMessageSentPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadTurnStartRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  modelSelection: Schema.optional(ModelSelection),
  routingMode: Schema.optional(ThreadRoutingMode),
  efficiencyTier: Schema.optional(EfficiencyTier),
  efficiencyDecision: Schema.optional(EfficiencyDecision),
  retryOfTurnId: Schema.optional(TurnId),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

export const ThreadTurnInterruptRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

export const ThreadApprovalResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

export const ThreadCheckpointRevertRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadRevertedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
});

export const ThreadSessionStopRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  /** See `ThreadSessionStopCommand.canceledThroughSequence`. */
  canceledThroughSequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});

export const ThreadSessionSetPayload = Schema.Struct({
  threadId: ThreadId,
  session: OrchestrationSession,
  /**
   * See `ThreadSessionSetCommand.pendingTurnStartAdoption`. Absent only on
   * historical events, whose pre-discriminator adoption behavior is preserved
   * during rebuild.
   */
  pendingTurnStartAdoption: Schema.optional(ThreadSessionPendingTurnStartAdoption),
  /** See `ThreadSessionSetCommand.turnRequestSequence`. */
  turnRequestSequence: Schema.optional(NonNegativeInt),
  /** See `ThreadSessionSetCommand.settledTurnId`. */
  settledTurnId: Schema.optional(TurnId),
  /** See `ThreadSessionSetCommand.terminalTurnTransition`. */
  terminalTurnTransition: Schema.optional(ThreadSessionTerminalTurnTransition),
  /** See `ThreadSessionSetCommand.terminalTurnTransitions`. */
  terminalTurnTransitions: Schema.optional(Schema.Array(ThreadSessionTerminalTurnTransition)),
});

/** See `ThreadTurnStartFoldCommand`. */
export const ThreadTurnStartFoldedPayload = Schema.Struct({
  threadId: ThreadId,
  turnRequestSequence: NonNegativeInt,
  turnId: TurnId,
  createdAt: IsoDateTime,
});

export const ThreadProposedPlanUpsertedPayload = Schema.Struct({
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
});

export const ThreadTurnDiffCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});

export const ThreadActivityAppendedPayload = Schema.Struct({
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
});

/** A durable sandbox transition plus its fully materialized resulting state. */
export const ThreadSandboxLifecyclePayload = Schema.Struct({
  threadId: ThreadId,
  event: SandboxEvent,
  sandbox: SandboxState,
});

export const SandboxBranchExportRequestedPayload = Schema.Struct({ threadId: ThreadId });
export const SandboxProvisionRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  config: Schema.optional(SandboxConfig),
});
export const SandboxWorkerSpawnRequestedPayload = Schema.Struct({
  parentThreadId: ThreadId,
  childThreadId: ThreadId,
  task: TrimmedNonEmptyString,
  inheritedCommit: TrimmedNonEmptyString,
  inheritedPatch: SandboxSpawnWorkerInput.fields.inheritedPatch,
  config: SandboxSpawnWorkerInput.fields.config,
  branchName: TrimmedNonEmptyString,
});
export const SandboxWorkerOperationRequestedPayload = Schema.Struct({
  parentThreadId: ThreadId,
  childThreadId: ThreadId,
  message: Schema.optional(TrimmedNonEmptyString),
  reason: Schema.optional(TrimmedNonEmptyString),
});

const sandboxLifecyclePayload = <Type extends (typeof SandboxEvent.Type)["type"]>(type: Type) =>
  ThreadSandboxLifecyclePayload.check(
    Schema.makeFilter(
      (payload) => payload.event.type === type || `sandbox event must be '${type}'`,
    ),
  );

/**
 * Which client connection dispatched the command that produced an event.
 * Stamped by the orchestration engine on client-dispatched commands; absent on
 * provider/server-originated events and on commands from clients too old to
 * report it.
 */
export const OrchestrationClientOrigin = Schema.Struct({
  surface: Schema.optional(ClientSurface),
  appVersion: Schema.optional(TrimmedNonEmptyString),
});
export type OrchestrationClientOrigin = typeof OrchestrationClientOrigin.Type;

export const OrchestrationEventMetadata = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(ProviderItemId),
  adapterKey: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(ApprovalRequestId),
  ingestedAt: Schema.optional(IsoDateTime),
  origin: Schema.optional(OrchestrationClientOrigin),
});
export type OrchestrationEventMetadata = typeof OrchestrationEventMetadata.Type;

const EventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: OrchestrationEventMetadata,
} as const;

export const OrchestrationEvent = Schema.Union([
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.created"),
    payload: ProjectCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.meta-updated"),
    payload: ProjectMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.deleted"),
    payload: ProjectDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.created"),
    payload: ThreadCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.deleted"),
    payload: ThreadDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.archived"),
    payload: ThreadArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unarchived"),
    payload: ThreadUnarchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.settled"),
    payload: ThreadSettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unsettled"),
    payload: ThreadUnsettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.snoozed"),
    payload: ThreadSnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unsnoozed"),
    payload: ThreadUnsnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pinned"),
    payload: ThreadPinnedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unpinned"),
    payload: ThreadUnpinnedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pin-reordered"),
    payload: ThreadPinReorderedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.meta-updated"),
    payload: ThreadMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-mode-set"),
    payload: ThreadRuntimeModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.interaction-mode-set"),
    payload: ThreadInteractionModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-sent"),
    payload: ThreadMessageSentPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-start-requested"),
    payload: ThreadTurnStartRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-interrupt-requested"),
    payload: ThreadTurnInterruptRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.approval-response-requested"),
    payload: ThreadApprovalResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.user-input-response-requested"),
    payload: ThreadUserInputResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.checkpoint-revert-requested"),
    payload: ThreadCheckpointRevertRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.reverted"),
    payload: ThreadRevertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-stop-requested"),
    payload: ThreadSessionStopRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-set"),
    payload: ThreadSessionSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-start-folded"),
    payload: ThreadTurnStartFoldedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.proposed-plan-upserted"),
    payload: ThreadProposedPlanUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-diff-completed"),
    payload: ThreadTurnDiffCompletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.activity-appended"),
    payload: ThreadActivityAppendedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sandbox.provision-requested"),
    payload: SandboxProvisionRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sandbox.provisioning-started"),
    payload: sandboxLifecyclePayload("sandbox.provisioning-started"),
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sandbox.ready"),
    payload: sandboxLifecyclePayload("sandbox.ready"),
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sandbox.failed"),
    payload: sandboxLifecyclePayload("sandbox.failed"),
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sandbox.paused"),
    payload: sandboxLifecyclePayload("sandbox.paused"),
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sandbox.takeover-requested"),
    payload: sandboxLifecyclePayload("sandbox.takeover-requested"),
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sandbox.takeover-acquired"),
    payload: sandboxLifecyclePayload("sandbox.takeover-acquired"),
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sandbox.resumed"),
    payload: sandboxLifecyclePayload("sandbox.resumed"),
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sandbox.stopping"),
    payload: sandboxLifecyclePayload("sandbox.stopping"),
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sandbox.expired"),
    payload: sandboxLifecyclePayload("sandbox.expired"),
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sandbox.stopped"),
    payload: sandboxLifecyclePayload("sandbox.stopped"),
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sandbox.reconciled"),
    payload: sandboxLifecyclePayload("sandbox.reconciled"),
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sandbox.branch-exported"),
    payload: sandboxLifecyclePayload("sandbox.branch-exported"),
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sandbox.branch-export-requested"),
    payload: SandboxBranchExportRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sandbox.worker-spawn-requested"),
    payload: SandboxWorkerSpawnRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sandbox.worker-status-requested"),
    payload: SandboxWorkerOperationRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sandbox.worker-message-requested"),
    payload: SandboxWorkerOperationRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sandbox.worker-stop-requested"),
    payload: SandboxWorkerOperationRequestedPayload,
  }),
]);
export type OrchestrationEvent = typeof OrchestrationEvent.Type;

export const OrchestrationThreadStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("synchronized"),
  }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationThreadDetailSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("event"),
    event: OrchestrationEvent,
  }),
]);
export type OrchestrationThreadStreamItem = typeof OrchestrationThreadStreamItem.Type;

export const OrchestrationCommandReceiptStatus = Schema.Literals(["accepted", "rejected"]);
export type OrchestrationCommandReceiptStatus = typeof OrchestrationCommandReceiptStatus.Type;

export const TurnCountRange = Schema.Struct({
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (input) =>
      input.fromTurnCount <= input.toTurnCount ||
      new SchemaIssue.InvalidValue({
        message: "fromTurnCount must be less than or equal to toTurnCount",
      }),
    { identifier: "OrchestrationTurnDiffRange" },
  ),
);

export const ThreadTurnDiff = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    diff: Schema.String,
  }),
  { unsafePreserveChecks: true },
);

export const ProviderSessionRuntimeStatus = Schema.Literals([
  "starting",
  "running",
  "stopped",
  "error",
]);
export type ProviderSessionRuntimeStatus = typeof ProviderSessionRuntimeStatus.Type;

const ProjectionThreadTurnStatus = Schema.Literals([
  "running",
  "completed",
  "interrupted",
  "error",
]);
export type ProjectionThreadTurnStatus = typeof ProjectionThreadTurnStatus.Type;

const ProjectionCheckpointRow = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type ProjectionCheckpointRow = typeof ProjectionCheckpointRow.Type;

export const ProjectionPendingApprovalStatus = Schema.Literals(["pending", "resolved"]);
export type ProjectionPendingApprovalStatus = typeof ProjectionPendingApprovalStatus.Type;

export const ProjectionPendingApprovalDecision = Schema.NullOr(ProviderApprovalDecision);
export type ProjectionPendingApprovalDecision = typeof ProjectionPendingApprovalDecision.Type;

export const DispatchResult = Schema.Struct({
  sequence: NonNegativeInt,
});
export type DispatchResult = typeof DispatchResult.Type;

export const OrchestrationGetTurnDiffInput = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
  }),
  { unsafePreserveChecks: true },
);
export type OrchestrationGetTurnDiffInput = typeof OrchestrationGetTurnDiffInput.Type;

export const OrchestrationGetTurnDiffResult = ThreadTurnDiff;
export type OrchestrationGetTurnDiffResult = typeof OrchestrationGetTurnDiffResult.Type;

export const OrchestrationGetFullThreadDiffInput = Schema.Struct({
  threadId: ThreadId,
  toTurnCount: NonNegativeInt,
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationGetFullThreadDiffInput = typeof OrchestrationGetFullThreadDiffInput.Type;

export const OrchestrationGetFullThreadDiffResult = ThreadTurnDiff;
export type OrchestrationGetFullThreadDiffResult = typeof OrchestrationGetFullThreadDiffResult.Type;

export const OrchestrationThreadSearchSource = Schema.Literals(["user", "assistant"]);
export type OrchestrationThreadSearchSource = typeof OrchestrationThreadSearchSource.Type;

// The server's SQLite client is synchronous and single-connection. Bound both
// scan input and response size so a search cannot monopolize that connection.
export const OrchestrationSearchThreadsInput = Schema.Struct({
  query: TrimmedString.check(Schema.isMinLength(2), Schema.isMaxLength(200)),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type OrchestrationSearchThreadsInput = typeof OrchestrationSearchThreadsInput.Type;

export const OrchestrationThreadSearchMatch = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  snippet: Schema.String.check(Schema.isMaxLength(240)),
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationThreadSearchMatch = typeof OrchestrationThreadSearchMatch.Type;

export const OrchestrationSearchThreadsResult = Schema.Struct({
  matches: Schema.Array(OrchestrationThreadSearchMatch),
});
export type OrchestrationSearchThreadsResult = typeof OrchestrationSearchThreadsResult.Type;

export const OrchestrationGetWorkflowScriptInput = Schema.Struct({
  threadId: ThreadId,
  /** Absolute path from the workflow's runHandles.scriptPath. The server
   * re-derives containment; the client value is a hint, never trusted. */
  scriptPath: TrimmedNonEmptyString,
});
export type OrchestrationGetWorkflowScriptInput = typeof OrchestrationGetWorkflowScriptInput.Type;

export const OrchestrationGetWorkflowScriptResult = Schema.Struct({
  scriptPath: TrimmedNonEmptyString,
  contents: Schema.String,
  truncated: Schema.Boolean,
});
export type OrchestrationGetWorkflowScriptResult = typeof OrchestrationGetWorkflowScriptResult.Type;

const WORKFLOW_SCRIPT_ERROR_MESSAGES = {
  "invalid-path": "Workflow scripts must be absolute .js paths.",
  "root-unavailable": "Script root unavailable.",
  "not-found": "Script not found.",
  "outside-root": "Script path is outside the workflow scripts root.",
  "not-js": "Resolved script is not a .js file.",
  "not-regular-file": "Script is not a regular file.",
  "changed-during-read": "Script changed between resolution and open.",
  "read-failed": "Script read failed.",
} as const;

export class OrchestrationGetWorkflowScriptError extends Schema.TaggedErrorClass<OrchestrationGetWorkflowScriptError>()(
  "OrchestrationGetWorkflowScriptError",
  {
    reason: Schema.Literals([
      "invalid-path",
      "root-unavailable",
      "not-found",
      "outside-root",
      "not-js",
      "not-regular-file",
      "changed-during-read",
      "read-failed",
    ]),
    scriptPath: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return WORKFLOW_SCRIPT_ERROR_MESSAGES[this.reason];
  }
}

export const OrchestrationRpcSchemas = {
  dispatchCommand: {
    input: ClientOrchestrationCommand,
    output: DispatchResult,
  },
  getWorkflowScript: {
    input: OrchestrationGetWorkflowScriptInput,
    output: OrchestrationGetWorkflowScriptResult,
  },
  getTurnDiff: {
    input: OrchestrationGetTurnDiffInput,
    output: OrchestrationGetTurnDiffResult,
  },
  getFullThreadDiff: {
    input: OrchestrationGetFullThreadDiffInput,
    output: OrchestrationGetFullThreadDiffResult,
  },
  searchThreads: {
    input: OrchestrationSearchThreadsInput,
    output: OrchestrationSearchThreadsResult,
  },
  getArchivedShellSnapshot: {
    input: Schema.Struct({}),
    output: OrchestrationShellSnapshot,
  },
  subscribeThread: {
    input: OrchestrationSubscribeThreadInput,
    output: OrchestrationThreadStreamItem,
  },
  subscribeShell: {
    input: OrchestrationSubscribeShellInput,
    output: OrchestrationShellStreamItem,
  },
} as const;

export class OrchestrationGetSnapshotError extends Schema.TaggedErrorClass<OrchestrationGetSnapshotError>()(
  "OrchestrationGetSnapshotError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationDispatchCommandError extends Schema.TaggedErrorClass<OrchestrationDispatchCommandError>()(
  "OrchestrationDispatchCommandError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
    bootstrapThreadDisposition: Schema.optional(Schema.Literal("deleted")),
  },
) {}

export class OrchestrationGetTurnDiffError extends Schema.TaggedErrorClass<OrchestrationGetTurnDiffError>()(
  "OrchestrationGetTurnDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationGetFullThreadDiffError extends Schema.TaggedErrorClass<OrchestrationGetFullThreadDiffError>()(
  "OrchestrationGetFullThreadDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationSearchThreadsError extends Schema.TaggedErrorClass<OrchestrationSearchThreadsError>()(
  "OrchestrationSearchThreadsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
