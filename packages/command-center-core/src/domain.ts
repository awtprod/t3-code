import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

export const TrimmedString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformOrFail({
      decode: (value) => Effect.succeed(value.trim()),
      encode: (value) => Effect.succeed(value.trim()),
    }),
  ),
);

export const TrimmedNonEmptyString = TrimmedString.check(Schema.isNonEmpty());
export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export const Confidence = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
export const Timestamp = TrimmedNonEmptyString;
export type Timestamp = typeof Timestamp.Type;

const makeEntityId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const SpaceId = makeEntityId("CommandCenterSpaceId");
export type SpaceId = typeof SpaceId.Type;
export const ItemId = makeEntityId("CommandCenterItemId");
export type ItemId = typeof ItemId.Type;
export const RunId = makeEntityId("CommandCenterRunId");
export type RunId = typeof RunId.Type;
export const AutomationId = makeEntityId("CommandCenterAutomationId");
export type AutomationId = typeof AutomationId.Type;
export const ApprovalId = makeEntityId("CommandCenterApprovalId");
export type ApprovalId = typeof ApprovalId.Type;
export const ArtifactId = makeEntityId("CommandCenterArtifactId");
export type ArtifactId = typeof ArtifactId.Type;
export const ConnectionId = makeEntityId("CommandCenterConnectionId");
export type ConnectionId = typeof ConnectionId.Type;
export const MemoryId = makeEntityId("CommandCenterMemoryId");
export type MemoryId = typeof MemoryId.Type;
export const RepositoryId = makeEntityId("CommandCenterRepositoryId");
export type RepositoryId = typeof RepositoryId.Type;
export const ProjectId = makeEntityId("CommandCenterProjectId");
export type ProjectId = typeof ProjectId.Type;
export const ThreadId = makeEntityId("CommandCenterThreadId");
export type ThreadId = typeof ThreadId.Type;
export const ProviderId = makeEntityId("CommandCenterProviderId");
export type ProviderId = typeof ProviderId.Type;
export const ModelId = makeEntityId("CommandCenterModelId");
export type ModelId = typeof ModelId.Type;
export const EfficiencyCandidateId = makeEntityId("EfficiencyCandidateId");
export type EfficiencyCandidateId = typeof EfficiencyCandidateId.Type;
export const CommandId = makeEntityId("CommandCenterCommandId");
export type CommandId = typeof CommandId.Type;
export const AutomationNodeId = makeEntityId("CommandCenterAutomationNodeId");
export type AutomationNodeId = typeof AutomationNodeId.Type;

export const CapabilityName = Schema.Literals([
  "cc.items.read",
  "cc.items.write",
  "cc.memory.read",
  "cc.memory.propose",
  "cc.automations.read",
  "cc.automations.write",
  "cc.automations.run",
  "cc.connections.google.read",
  "cc.connections.google.gmail.read",
  "cc.connections.google.gmail.drafts.create",
  "cc.connections.google.calendar.read",
  "cc.connections.google.drive.read",
  "cc.sales.read",
  "cc.sales.propose",
  "cc.sales.write",
  "cc.runs.start",
]);
export type CapabilityName = typeof CapabilityName.Type;

export const CAPABILITY_NAMES: ReadonlyArray<CapabilityName> = [
  "cc.items.read",
  "cc.items.write",
  "cc.memory.read",
  "cc.memory.propose",
  "cc.automations.read",
  "cc.automations.write",
  "cc.automations.run",
  "cc.connections.google.read",
  "cc.connections.google.gmail.read",
  "cc.connections.google.gmail.drafts.create",
  "cc.connections.google.calendar.read",
  "cc.connections.google.drive.read",
  "cc.sales.read",
  "cc.sales.propose",
  "cc.sales.write",
  "cc.runs.start",
];

/** Capabilities that may be issued for new routes and credentials. */
export const ACTIVE_CAPABILITY_NAMES: ReadonlyArray<CapabilityName> = CAPABILITY_NAMES.filter(
  (capability) =>
    capability !== "cc.connections.google.read" &&
    capability !== "cc.connections.google.gmail.drafts.create" &&
    capability !== "cc.sales.read" &&
    capability !== "cc.sales.propose" &&
    capability !== "cc.sales.write",
);

export const RiskLevel = Schema.Literals(["low", "reversible", "approval-required", "blocked"]);
export type RiskLevel = typeof RiskLevel.Type;

export const EfficiencyTier = Schema.Literals(["economy", "balanced", "quality"]);
export type EfficiencyTier = typeof EfficiencyTier.Type;

export const ActionKind = Schema.Literals([
  "read",
  "search",
  "retrieve",
  "preview",
  "item.mutate",
  "memory.remember",
  "automation.draft",
  "automation.run",
  "config.commit.local",
  "worktree.edit",
  "git.push",
  "pull-request.open",
  "pull-request.merge",
  "deploy",
  "publish",
  "communicate",
  "money.move",
  "share",
  "delete",
  "account.security",
  "secret.change",
  "google.write",
  "unsupported",
]);
export type ActionKind = typeof ActionKind.Type;

export const IntentKind = Schema.Literals([
  "conversation",
  "item",
  "repository",
  "automation",
  "google",
]);
export type IntentKind = typeof IntentKind.Type;

export const ModelSelection = Schema.Struct({
  providerId: ProviderId,
  modelId: ModelId,
});
export type ModelSelection = typeof ModelSelection.Type;

export const RepositoryBinding = Schema.Struct({
  id: RepositoryId,
  displayName: TrimmedNonEmptyString,
  aliases: Schema.Array(TrimmedNonEmptyString),
  remoteRef: Schema.optional(TrimmedNonEmptyString),
  projectId: Schema.optional(ProjectId),
});
export type RepositoryBinding = typeof RepositoryBinding.Type;

export const SpaceKind = Schema.Literals(["personal", "business", "system"]);
export type SpaceKind = typeof SpaceKind.Type;
export const SpaceLifecycle = Schema.Literals(["active", "archived"]);
export type SpaceLifecycle = typeof SpaceLifecycle.Type;

export const SpacePolicy = Schema.Struct({
  allowedCapabilities: Schema.Array(CapabilityName),
  autoRunRiskLevels: Schema.Array(Schema.Literals(["low", "reversible"])),
  route: Schema.optional(ModelSelection),
});
export type SpacePolicy = typeof SpacePolicy.Type;

export const SpaceFeatures = Schema.Struct({
  salesPipeline: Schema.optional(Schema.Boolean),
});
export type SpaceFeatures = typeof SpaceFeatures.Type;

export const Space = Schema.Struct({
  id: SpaceId,
  slug: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  kind: SpaceKind,
  instructions: TrimmedString,
  policy: SpacePolicy,
  features: Schema.optional(SpaceFeatures),
  modelDefaults: Schema.optional(ModelSelection),
  connectionIds: Schema.Array(ConnectionId),
  repositories: Schema.Array(RepositoryBinding),
  aliases: Schema.Array(TrimmedNonEmptyString),
  lifecycle: SpaceLifecycle,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Space = typeof Space.Type;

export const ProvenanceKind = Schema.Literals([
  "user",
  "agent",
  "automation",
  "connector",
  "import",
]);
export type ProvenanceKind = typeof ProvenanceKind.Type;

export const Provenance = Schema.Struct({
  kind: ProvenanceKind,
  sourceRef: Schema.optional(TrimmedNonEmptyString),
  originalLabel: Schema.optional(TrimmedNonEmptyString),
  capturedAt: Timestamp,
});
export type Provenance = typeof Provenance.Type;

export const ItemKind = Schema.Literals(["idea", "task", "decision", "alert", "approval"]);
export type ItemKind = typeof ItemKind.Type;
export const ItemStatus = Schema.Literals([
  "captured",
  "ready",
  "in_progress",
  "waiting",
  "review",
  "done",
  "canceled",
]);
export type ItemStatus = typeof ItemStatus.Type;
export const ItemPriority = Schema.Literals(["low", "normal", "high", "urgent"]);
export type ItemPriority = typeof ItemPriority.Type;

export const Item = Schema.Struct({
  id: ItemId,
  spaceId: SpaceId,
  kind: ItemKind,
  status: ItemStatus,
  priority: ItemPriority,
  title: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedString),
  dueAt: Schema.optional(Timestamp),
  artifactIds: Schema.Array(ArtifactId),
  provenance: Provenance,
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Item = typeof Item.Type;

export const RunKind = Schema.Literals(["agent", "automation", "connector"]);
export type RunKind = typeof RunKind.Type;
export const RunStatus = Schema.Literals([
  "queued",
  "running",
  "waiting_approval",
  "waiting",
  "succeeded",
  "failed",
  "canceled",
]);
export type RunStatus = typeof RunStatus.Type;

export const Run = Schema.Struct({
  id: RunId,
  spaceId: SpaceId,
  kind: RunKind,
  status: RunStatus,
  commandId: Schema.optional(CommandId),
  parentRunId: Schema.optional(RunId),
  automationId: Schema.optional(AutomationId),
  repositoryId: Schema.optional(RepositoryId),
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
  providerId: Schema.optional(ProviderId),
  modelId: Schema.optional(ModelId),
  artifactIds: Schema.Array(ArtifactId),
  createdAt: Timestamp,
  startedAt: Schema.optional(Timestamp),
  finishedAt: Schema.optional(Timestamp),
});
export type Run = typeof Run.Type;

export const AutomationTrigger = Schema.Union([
  Schema.Struct({ type: Schema.Literal("manual") }),
  Schema.Struct({
    type: Schema.Literal("schedule"),
    expression: TrimmedNonEmptyString,
    timezone: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("webhook"),
    route: TrimmedNonEmptyString,
  }),
]);
export type AutomationTrigger = typeof AutomationTrigger.Type;

export const AutomationNodeKind = Schema.Literals([
  "agent",
  "connector.read",
  "connector.write",
  "item.mutate",
  "condition",
  "transform",
  "foreach",
  "delay",
  "approval",
  "shell.scoped",
  "sales.action",
]);
export type AutomationNodeKind = typeof AutomationNodeKind.Type;

export const AutomationNode = Schema.Struct({
  id: AutomationNodeId,
  kind: AutomationNodeKind,
  config: Schema.Record(Schema.String, Schema.Unknown),
  position: Schema.Struct({ x: Schema.Number, y: Schema.Number }),
});
export type AutomationNode = typeof AutomationNode.Type;

export const AutomationEdge = Schema.Struct({
  sourceNodeId: AutomationNodeId,
  targetNodeId: AutomationNodeId,
  sourceHandle: Schema.optional(TrimmedNonEmptyString),
  targetHandle: Schema.optional(TrimmedNonEmptyString),
});
export type AutomationEdge = typeof AutomationEdge.Type;

export const Automation = Schema.Struct({
  id: AutomationId,
  spaceId: SpaceId,
  name: TrimmedNonEmptyString,
  version: PositiveInt,
  enabled: Schema.Boolean,
  trigger: AutomationTrigger,
  nodes: Schema.Array(AutomationNode),
  edges: Schema.Array(AutomationEdge),
  definitionDigest: TrimmedNonEmptyString,
  configCommit: Schema.optional(TrimmedNonEmptyString),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Automation = typeof Automation.Type;

export const ApprovalStatus = Schema.Literals([
  "requested",
  "approved",
  "declined",
  "expired",
  "canceled",
]);
export type ApprovalStatus = typeof ApprovalStatus.Type;

export const Approval = Schema.Struct({
  id: ApprovalId,
  spaceId: SpaceId,
  runId: RunId,
  status: ApprovalStatus,
  actionKind: ActionKind,
  risk: RiskLevel,
  summary: TrimmedNonEmptyString,
  proposal: TrimmedNonEmptyString,
  payloadDigest: TrimmedNonEmptyString,
  idempotencyKey: TrimmedNonEmptyString,
  requestedAt: Timestamp,
  expiresAt: Schema.optional(Timestamp),
  decidedAt: Schema.optional(Timestamp),
});
export type Approval = typeof Approval.Type;

export const ArtifactKind = Schema.Literals([
  "plan",
  "report",
  "diff",
  "export",
  "file",
  "archive",
]);
export type ArtifactKind = typeof ArtifactKind.Type;

export const Artifact = Schema.Struct({
  id: ArtifactId,
  spaceId: SpaceId,
  runId: Schema.optional(RunId),
  kind: ArtifactKind,
  name: TrimmedNonEmptyString,
  locator: TrimmedNonEmptyString,
  mimeType: Schema.optional(TrimmedNonEmptyString),
  contentDigest: TrimmedNonEmptyString,
  provenance: Provenance,
  createdAt: Timestamp,
});
export type Artifact = typeof Artifact.Type;

export const ConnectionKind = Schema.Literals(["google", "repository", "generic"]);
export type ConnectionKind = typeof ConnectionKind.Type;
export const ConnectionHealth = Schema.Literals(["connected", "degraded", "disconnected"]);
export type ConnectionHealth = typeof ConnectionHealth.Type;

export const Connection = Schema.Struct({
  id: ConnectionId,
  spaceId: SpaceId,
  kind: ConnectionKind,
  label: TrimmedNonEmptyString,
  capabilities: Schema.Array(CapabilityName),
  health: ConnectionHealth,
  lastCheckedAt: Schema.optional(Timestamp),
});
export type Connection = typeof Connection.Type;

export const MemoryKind = Schema.Literals([
  "fact",
  "preference",
  "procedure",
  "decision",
  "archive",
]);
export type MemoryKind = typeof MemoryKind.Type;
export const MemoryStatus = Schema.Literals([
  "candidate",
  "approved",
  "rejected",
  "expired",
  "archive",
]);
export type MemoryStatus = typeof MemoryStatus.Type;

export const Memory = Schema.Struct({
  id: MemoryId,
  spaceId: SpaceId,
  repositoryId: Schema.optional(RepositoryId),
  kind: MemoryKind,
  status: MemoryStatus,
  content: TrimmedNonEmptyString,
  confidence: Confidence,
  provenance: Provenance,
  expiresAt: Schema.optional(Timestamp),
  contradictionOf: Schema.optional(MemoryId),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Memory = typeof Memory.Type;

export const CommandAttachment = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  mimeType: TrimmedNonEmptyString,
  reference: TrimmedNonEmptyString,
});
export type CommandAttachment = typeof CommandAttachment.Type;

export const CommandSubmission = Schema.Struct({
  commandId: CommandId,
  text: TrimmedNonEmptyString,
  attachments: Schema.optional(Schema.Array(CommandAttachment)),
  spaceId: Schema.optional(SpaceId),
  repositoryId: Schema.optional(RepositoryId),
  projectId: Schema.optional(ProjectId),
  providerId: Schema.optional(ProviderId),
  modelId: Schema.optional(ModelId),
});
export type CommandSubmission = typeof CommandSubmission.Type;
