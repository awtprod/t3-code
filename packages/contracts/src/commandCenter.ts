import {
  Approval,
  ApprovalId,
  Artifact,
  ArtifactId,
  ArtifactKind,
  Automation,
  AutomationId,
  AutomationNodeId,
  CommandSubmission,
  Connection,
  ConnectionId,
  CapabilityName,
  Item,
  ItemId,
  ItemKind,
  ItemPriority,
  ItemStatus,
  Memory,
  MemoryId,
  MemoryKind,
  MemoryStatus,
  ProjectId,
  RepositoryId,
  RouteDecision,
  Run,
  RunId,
  RunStatus,
  Space,
  SpaceId,
  ThreadId,
  Timestamp,
  TrimmedNonEmptyString,
  TrimmedString,
} from "@command-center/core";
import * as Schema from "effect/Schema";

export const COMMAND_CENTER_WS_METHODS = {
  bootstrap: "cc.bootstrap",
  commandSubmit: "cc.command.submit",
  runStart: "cc.runs.start",
  eventsReplay: "cc.events.replay",
  eventsSubscribe: "cc.events.subscribe",
  timelineQuery: "cc.timeline.query",
  spacesQuery: "cc.spaces.query",
  spacesSync: "cc.spaces.sync",
  itemsQuery: "cc.items.query",
  runsQuery: "cc.runs.query",
  automationsQuery: "cc.automations.query",
  automationDefinitionGet: "cc.automations.definition.get",
  automationDefinitionCreate: "cc.automations.definition.create",
  automationDefinitionSave: "cc.automations.definition.save",
  automationScheduleInterpret: "cc.automations.schedule.interpret",
  approvalsQuery: "cc.approvals.query",
  artifactsQuery: "cc.artifacts.query",
  connectionsQuery: "cc.connections.query",
  connectionsRefresh: "cc.connections.refresh",
  memoryQuery: "cc.memory.query",
  memorySearch: "cc.memory.search",
  itemCreate: "cc.items.create",
  itemUpdate: "cc.items.update",
  memoryRemember: "cc.memory.remember",
  memoryPropose: "cc.memory.propose",
  memoryReview: "cc.memory.review",
  approvalDecide: "cc.approvals.decide",
  automationRunStart: "cc.automations.run.start",
  automationRunGet: "cc.automations.run.get",
  automationWebhookAdmit: "cc.automations.webhook.admit",
  googleRead: "cc.connections.google.read",
} as const;

export class CommandCenterError extends Schema.TaggedErrorClass<CommandCenterError>()(
  "CommandCenterError",
  {
    reason: Schema.Literals([
      "config",
      "persistence",
      "routing",
      "not_found",
      "conflict",
      "connector",
      "validation",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class CommandCenterMcpCapabilityUnavailableError extends Schema.TaggedErrorClass<CommandCenterMcpCapabilityUnavailableError>()(
  "CommandCenterMcpCapabilityUnavailableError",
  {
    capability: CapabilityName,
    threadId: TrimmedNonEmptyString,
    providerSessionId: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `MCP credential does not grant the ${this.capability} capability.`;
  }
}

export const CommandCenterConfigHealth = Schema.Struct({
  status: Schema.Literals(["loaded", "missing", "invalid"]),
  configDirectory: Schema.String,
  message: Schema.optional(Schema.String),
});
export type CommandCenterConfigHealth = typeof CommandCenterConfigHealth.Type;

export const CommandCenterAutomationAuthoringHealth = Schema.Struct({
  status: Schema.Literals(["available", "unavailable"]),
  message: Schema.optional(TrimmedNonEmptyString),
});
export type CommandCenterAutomationAuthoringHealth =
  typeof CommandCenterAutomationAuthoringHealth.Type;

export const CommandCenterBootstrap = Schema.Struct({
  timezone: Schema.NullOr(TrimmedNonEmptyString),
  spaces: Schema.Array(Space),
  items: Schema.Array(Item),
  needsYou: Schema.Array(Item),
  runs: Schema.Array(Run),
  approvals: Schema.Array(Approval),
  automations: Schema.Array(Automation),
  connections: Schema.Array(Connection),
  memories: Schema.Array(Memory),
  configHealth: CommandCenterConfigHealth,
  authoringHealth: Schema.optional(CommandCenterAutomationAuthoringHealth),
});
export type CommandCenterBootstrap = typeof CommandCenterBootstrap.Type;

export const CommandCenterCommandSubmitInput = CommandSubmission;
export type CommandCenterCommandSubmitInput = typeof CommandCenterCommandSubmitInput.Type;

export const CommandCenterCommandSubmitResult = Schema.Struct({
  run: Run,
  route: RouteDecision,
  duplicate: Schema.Boolean,
});
export type CommandCenterCommandSubmitResult = typeof CommandCenterCommandSubmitResult.Type;

/**
 * Client acknowledgement sent only after the route receipt has been rendered.
 * Admission alone never authorizes execution. Once acknowledged, the durable
 * authorization lets restart recovery cover a crash before dispatch completes.
 */
export const CommandCenterRunStartInput = Schema.Struct({ runId: RunId });
export type CommandCenterRunStartInput = typeof CommandCenterRunStartInput.Type;

export const CommandCenterRunStartResult = Schema.Struct({
  runId: RunId,
  projectId: ProjectId,
  threadId: ThreadId,
  status: Schema.Literal("running"),
  duplicate: Schema.Boolean,
});
export type CommandCenterRunStartResult = typeof CommandCenterRunStartResult.Type;

const QueryLimit = Schema.optional(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
);

export const CommandCenterSpacesQueryInput = Schema.Struct({
  spaceId: Schema.optional(SpaceId),
});
export type CommandCenterSpacesQueryInput = typeof CommandCenterSpacesQueryInput.Type;

export const CommandCenterSpacesSyncInput = Schema.Struct({});
export type CommandCenterSpacesSyncInput = typeof CommandCenterSpacesSyncInput.Type;

export const CommandCenterItemsQueryInput = Schema.Struct({
  spaceId: Schema.optional(SpaceId),
  statuses: Schema.optional(Schema.Array(ItemStatus)),
  limit: QueryLimit,
});
export type CommandCenterItemsQueryInput = typeof CommandCenterItemsQueryInput.Type;

export const CommandCenterRunsQueryInput = Schema.Struct({
  spaceId: Schema.optional(SpaceId),
  statuses: Schema.optional(Schema.Array(RunStatus)),
  limit: QueryLimit,
});
export type CommandCenterRunsQueryInput = typeof CommandCenterRunsQueryInput.Type;

export const CommandCenterAutomationsQueryInput = Schema.Struct({
  spaceId: Schema.optional(SpaceId),
  enabled: Schema.optional(Schema.Boolean),
  limit: QueryLimit,
});
export type CommandCenterAutomationsQueryInput = typeof CommandCenterAutomationsQueryInput.Type;

const CommandCenterAutomationJsonObject = Schema.Record(Schema.String, Schema.Json);
export const COMMAND_CENTER_WEBHOOK_MAX_PAYLOAD_BYTES = 1024 * 1024;
export const COMMAND_CENTER_WEBHOOK_MAX_DELIVERY_ID_CHARS = 200;
const COMMAND_CENTER_WEBHOOK_ROUTE_PATTERN = /^\/[A-Za-z0-9][A-Za-z0-9/_-]{0,126}$/u;

export function normalizeCommandCenterWebhookRoute(route: string): string | undefined {
  const normalized = route
    .trim()
    .replace(/\/{2,}/gu, "/")
    .replace(/\/$/u, "");
  if (
    normalized.includes("..") ||
    normalized.includes("?") ||
    normalized.includes("#") ||
    !COMMAND_CENTER_WEBHOOK_ROUTE_PATTERN.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

/** Canonical local route accepted by both paired clients and the HMAC adapter. */
export const CommandCenterWebhookRoute = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.makeFilter(
    (route) =>
      normalizeCommandCenterWebhookRoute(route) === route ||
      "Webhook route must be a normalized local path without traversal, query, or fragment syntax.",
  ),
);
export type CommandCenterWebhookRoute = typeof CommandCenterWebhookRoute.Type;

export const CommandCenterWebhookDeliveryId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(COMMAND_CENTER_WEBHOOK_MAX_DELIVERY_ID_CHARS),
  Schema.isPattern(/^[\x21-\x7e]+$/u),
);
export type CommandCenterWebhookDeliveryId = typeof CommandCenterWebhookDeliveryId.Type;

const CommandCenterWebhookPayload = Schema.Json.check(
  Schema.makeFilter((payload) => {
    const encoded = new TextEncoder().encode(JSON.stringify(payload));
    return (
      encoded.byteLength <= COMMAND_CENTER_WEBHOOK_MAX_PAYLOAD_BYTES ||
      `Webhook payload must be at most ${COMMAND_CENTER_WEBHOOK_MAX_PAYLOAD_BYTES} encoded bytes.`
    );
  }),
);
const CommandCenterAutomationDefinitionDigest = TrimmedNonEmptyString.check(
  Schema.isPattern(/^sha256:[a-f0-9]{64}$/u),
);
const CommandCenterConfigCommitSha = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-f0-9]{40,64}$/u),
);

export const CommandCenterAutomationSourceTrigger = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("manual") }),
  Schema.Struct({
    kind: Schema.Literal("schedule"),
    expression: TrimmedNonEmptyString,
    timezone: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("webhook"),
    route: CommandCenterWebhookRoute,
  }),
]);

export const CommandCenterAutomationSourceNodeKind = Schema.Literals([
  "agent.run",
  "connector.read",
  "connector.write",
  "item.mutate",
  "condition",
  "transform",
  "foreach",
  "delay",
  "approval",
  "shell.scoped",
]);

/** Exact editable shape stored in the private configuration checkout. */
export const CommandCenterAutomationSourceDefinition = Schema.Struct({
  $schema: Schema.optional(TrimmedNonEmptyString),
  schemaVersion: Schema.Literal(1),
  id: AutomationId,
  name: TrimmedNonEmptyString,
  spaceId: SpaceId,
  enabled: Schema.Boolean,
  trigger: CommandCenterAutomationSourceTrigger,
  nodes: Schema.Array(
    Schema.Struct({
      id: AutomationNodeId,
      kind: CommandCenterAutomationSourceNodeKind,
      config: CommandCenterAutomationJsonObject,
    }),
  ),
  edges: Schema.Array(
    Schema.Struct({
      from: AutomationNodeId,
      to: AutomationNodeId,
    }),
  ),
  layout: CommandCenterAutomationJsonObject,
  policy: CommandCenterAutomationJsonObject,
});
export type CommandCenterAutomationSourceDefinition =
  typeof CommandCenterAutomationSourceDefinition.Type;

const CommandCenterAutomationAuthoringRequestId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u),
);

/**
 * New definitions never accept a caller-owned path, policy, schema URL, or
 * Space embedded inside the draft. Those fields are bound by the server.
 */
export const CommandCenterAutomationDefinitionCreateInput = Schema.Struct({
  requestId: CommandCenterAutomationAuthoringRequestId,
  spaceId: SpaceId,
  preferredAutomationId: Schema.optional(AutomationId),
  name: TrimmedNonEmptyString,
  enabled: Schema.Literal(false),
  trigger: CommandCenterAutomationSourceTrigger,
  nodes: CommandCenterAutomationSourceDefinition.fields.nodes,
  edges: CommandCenterAutomationSourceDefinition.fields.edges,
  layout: CommandCenterAutomationJsonObject,
});
export type CommandCenterAutomationDefinitionCreateInput =
  typeof CommandCenterAutomationDefinitionCreateInput.Type;

export const CommandCenterAutomationDefinitionGetInput = Schema.Struct({
  automationId: AutomationId,
  spaceId: SpaceId,
});
export type CommandCenterAutomationDefinitionGetInput =
  typeof CommandCenterAutomationDefinitionGetInput.Type;

export const CommandCenterAutomationDefinitionSnapshot = Schema.Struct({
  automationId: AutomationId,
  spaceId: SpaceId,
  definition: CommandCenterAutomationSourceDefinition,
  definitionDigest: CommandCenterAutomationDefinitionDigest,
  configCommitSha: CommandCenterConfigCommitSha,
  authoringHealth: Schema.optional(CommandCenterAutomationAuthoringHealth),
});
export type CommandCenterAutomationDefinitionSnapshot =
  typeof CommandCenterAutomationDefinitionSnapshot.Type;

export const CommandCenterAutomationDefinitionSaveInput = Schema.Struct({
  automationId: AutomationId,
  spaceId: SpaceId,
  expectedDefinitionDigest: CommandCenterAutomationDefinitionDigest,
  definition: CommandCenterAutomationSourceDefinition,
});
export type CommandCenterAutomationDefinitionSaveInput =
  typeof CommandCenterAutomationDefinitionSaveInput.Type;

export const CommandCenterAutomationScheduleInterpretInput = Schema.Struct({
  spaceId: SpaceId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  timezone: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type CommandCenterAutomationScheduleInterpretInput =
  typeof CommandCenterAutomationScheduleInterpretInput.Type;

export const CommandCenterAutomationScheduleInterpretResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("interpreted"),
    trigger: Schema.Struct({
      kind: Schema.Literal("schedule"),
      expression: TrimmedNonEmptyString,
      timezone: TrimmedNonEmptyString,
    }),
    summary: TrimmedNonEmptyString,
    nextOccurrences: Schema.Array(Timestamp),
  }),
  Schema.Struct({
    status: Schema.Literal("needs_clarification"),
    message: TrimmedNonEmptyString,
  }),
]);
export type CommandCenterAutomationScheduleInterpretResult =
  typeof CommandCenterAutomationScheduleInterpretResult.Type;

export const CommandCenterApprovalsQueryInput = Schema.Struct({
  spaceId: Schema.optional(SpaceId),
  statuses: Schema.optional(Schema.Array(Approval.fields.status)),
  limit: QueryLimit,
});
export type CommandCenterApprovalsQueryInput = typeof CommandCenterApprovalsQueryInput.Type;

export const CommandCenterArtifactsQueryInput = Schema.Struct({
  spaceId: SpaceId,
  runId: Schema.optional(RunId),
  kinds: Schema.optional(Schema.Array(ArtifactKind)),
  limit: QueryLimit,
});
export type CommandCenterArtifactsQueryInput = typeof CommandCenterArtifactsQueryInput.Type;

export const CommandCenterConnectionsQueryInput = Schema.Struct({
  spaceId: Schema.optional(SpaceId),
  healthyOnly: Schema.optional(Schema.Boolean),
  limit: QueryLimit,
});
export type CommandCenterConnectionsQueryInput = typeof CommandCenterConnectionsQueryInput.Type;

export const CommandCenterConnectionRefreshInput = Schema.Struct({
  spaceId: SpaceId,
  connectionId: ConnectionId,
});
export type CommandCenterConnectionRefreshInput = typeof CommandCenterConnectionRefreshInput.Type;

export const CommandCenterMemoryQueryInput = Schema.Struct({
  spaceId: Schema.optional(SpaceId),
  repositoryId: Schema.optional(RepositoryId),
  statuses: Schema.optional(Schema.Array(MemoryStatus)),
  limit: QueryLimit,
});
export type CommandCenterMemoryQueryInput = typeof CommandCenterMemoryQueryInput.Type;

export const CommandCenterSpacesQueryResult = Schema.Struct({ spaces: Schema.Array(Space) });
export const CommandCenterItemsQueryResult = Schema.Struct({ items: Schema.Array(Item) });
export const CommandCenterRunsQueryResult = Schema.Struct({ runs: Schema.Array(Run) });
export const CommandCenterAutomationsQueryResult = Schema.Struct({
  automations: Schema.Array(Automation),
});
export const CommandCenterApprovalsQueryResult = Schema.Struct({
  approvals: Schema.Array(Approval),
});
export const CommandCenterArtifactsQueryResult = Schema.Struct({
  artifacts: Schema.Array(Artifact),
});
export const CommandCenterConnectionsQueryResult = Schema.Struct({
  connections: Schema.Array(Connection),
});
export const CommandCenterMemoryQueryResult = Schema.Struct({ memories: Schema.Array(Memory) });

export const CommandCenterSpacesSyncResult = Schema.Struct({
  timezone: Schema.NullOr(TrimmedNonEmptyString),
  spaces: Schema.Array(Space),
  automations: Schema.Array(Automation),
  connections: Schema.Array(Connection),
  configHealth: CommandCenterConfigHealth,
});
export type CommandCenterSpacesSyncResult = typeof CommandCenterSpacesSyncResult.Type;

export const CommandCenterConnectionRefreshResult = Schema.Struct({
  connection: Connection,
  verified: Schema.Boolean,
  message: Schema.optional(TrimmedNonEmptyString),
});
export type CommandCenterConnectionRefreshResult = typeof CommandCenterConnectionRefreshResult.Type;

export const CommandCenterMemorySearchInput = Schema.Struct({
  query: TrimmedNonEmptyString,
  spaceId: SpaceId,
  repositoryId: Schema.optional(RepositoryId),
  includeArchives: Schema.optional(Schema.Boolean),
  limit: QueryLimit,
});
export type CommandCenterMemorySearchInput = typeof CommandCenterMemorySearchInput.Type;

export const CommandCenterMemorySearchResult = Schema.Struct({
  memoryId: TrimmedNonEmptyString,
  spaceId: SpaceId,
  repositoryId: Schema.optional(RepositoryId),
  scope: Schema.Literals(["global", "space", "repository"]),
  kind: TrimmedNonEmptyString,
  content: TrimmedNonEmptyString,
  confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  trust: Schema.Literals(["trusted", "untrusted-archive"]),
  readOnly: Schema.Boolean,
  provenance: Schema.Unknown,
  sourceCreatedAt: TrimmedNonEmptyString,
  sourceUpdatedAt: TrimmedNonEmptyString,
  rank: Schema.Number,
});
export const CommandCenterMemorySearchResults = Schema.Struct({
  results: Schema.Array(CommandCenterMemorySearchResult),
});

export const CommandCenterAutomationExecutionState = Schema.Literals([
  "queued",
  "running",
  "waiting_retry",
  "waiting_delay",
  "waiting_external",
  "waiting_approval",
  "succeeded",
  "failed",
  "canceled",
]);

export const CommandCenterAutomationCheckpointState = Schema.Literals([
  "pending",
  "running",
  "waiting_retry",
  "waiting_delay",
  "waiting_external",
  "waiting_approval",
  "succeeded",
  "failed",
  "skipped",
]);

export const CommandCenterAutomationExecution = Schema.Struct({
  id: TrimmedNonEmptyString,
  automationId: AutomationId,
  idempotencyKey: TrimmedNonEmptyString,
  spaceId: SpaceId,
  configCommitSha: TrimmedNonEmptyString,
  definitionDigest: TrimmedNonEmptyString,
  state: CommandCenterAutomationExecutionState,
  input: Schema.Record(Schema.String, Schema.Json),
  lease: Schema.NullOr(
    Schema.Struct({
      owner: TrimmedNonEmptyString,
      generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      expiresAt: TrimmedNonEmptyString,
    }),
  ),
  checkpoints: Schema.Array(
    Schema.Struct({
      nodeId: TrimmedNonEmptyString,
      nodeKind: TrimmedNonEmptyString,
      state: CommandCenterAutomationCheckpointState,
      attemptCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      maxAttempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
      executorIdempotencyKey: Schema.NullOr(Schema.String),
      scopedShellPolicyDigest: Schema.NullOr(Schema.String),
      waitingUntil: Schema.NullOr(Schema.String),
      resumeKey: Schema.NullOr(Schema.String),
      resolutionKey: Schema.NullOr(Schema.String),
      output: Schema.NullOr(Schema.Json),
      error: Schema.NullOr(Schema.String),
      startedAt: Schema.NullOr(Schema.String),
      finishedAt: Schema.NullOr(Schema.String),
      updatedAt: TrimmedNonEmptyString,
    }),
  ),
  output: Schema.NullOr(Schema.Json),
  error: Schema.NullOr(Schema.String),
  createdAt: TrimmedNonEmptyString,
  updatedAt: TrimmedNonEmptyString,
  finishedAt: Schema.NullOr(Schema.String),
});
export type CommandCenterAutomationExecution = typeof CommandCenterAutomationExecution.Type;

export const CommandCenterAutomationRunStartInput = Schema.Struct({
  automationId: AutomationId,
  spaceId: SpaceId,
  idempotencyKey: TrimmedNonEmptyString,
  expectedConfigCommitSha: TrimmedNonEmptyString,
  expectedDefinitionDigest: TrimmedNonEmptyString,
  input: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
});
export type CommandCenterAutomationRunStartInput = typeof CommandCenterAutomationRunStartInput.Type;

export const CommandCenterAutomationRunGetInput = Schema.Struct({
  executionId: TrimmedNonEmptyString,
  spaceId: SpaceId,
});
export type CommandCenterAutomationRunGetInput = typeof CommandCenterAutomationRunGetInput.Type;

export const CommandCenterAutomationWebhookAdmitInput = Schema.Struct({
  spaceId: SpaceId,
  route: CommandCenterWebhookRoute,
  deliveryId: CommandCenterWebhookDeliveryId,
  payload: Schema.optional(CommandCenterWebhookPayload),
});
export type CommandCenterAutomationWebhookAdmitInput =
  typeof CommandCenterAutomationWebhookAdmitInput.Type;

export const CommandCenterItemCreateInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  spaceId: SpaceId,
  kind: ItemKind,
  priority: ItemPriority,
  title: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedString),
  dueAt: Schema.optional(TrimmedNonEmptyString),
});
export type CommandCenterItemCreateInput = typeof CommandCenterItemCreateInput.Type;

export const CommandCenterItemUpdatePatch = Schema.Struct({
  status: Schema.optional(ItemStatus),
  priority: Schema.optional(ItemPriority),
  title: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(Schema.NullOr(TrimmedString)),
  dueAt: Schema.optional(Schema.NullOr(Timestamp)),
}).check(
  Schema.makeFilter(
    (patch) =>
      Object.keys(patch).length > 0 || "An Item update must include at least one allowed field.",
  ),
);
export type CommandCenterItemUpdatePatch = typeof CommandCenterItemUpdatePatch.Type;

export const CommandCenterItemUpdateInput = Schema.Struct({
  itemId: ItemId,
  spaceId: SpaceId,
  expectedUpdatedAt: Timestamp,
  patch: CommandCenterItemUpdatePatch,
});
export type CommandCenterItemUpdateInput = typeof CommandCenterItemUpdateInput.Type;

export const CommandCenterItemUpdateResult = Schema.Struct({
  item: Item,
  duplicate: Schema.Boolean,
});
export type CommandCenterItemUpdateResult = typeof CommandCenterItemUpdateResult.Type;

export const CommandCenterMemoryRememberInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  spaceId: SpaceId,
  repositoryId: Schema.optional(RepositoryId),
  kind: MemoryKind,
  content: TrimmedNonEmptyString,
  sourceRef: Schema.optional(TrimmedNonEmptyString),
});
export type CommandCenterMemoryRememberInput = typeof CommandCenterMemoryRememberInput.Type;

export const CommandCenterMemoryProposeInput = Schema.Struct({
  ...CommandCenterMemoryRememberInput.fields,
  confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});
export type CommandCenterMemoryProposeInput = typeof CommandCenterMemoryProposeInput.Type;

export const CommandCenterMemoryReviewInput = Schema.Struct({
  memoryId: MemoryId,
  spaceId: SpaceId,
  repositoryId: Schema.optional(RepositoryId),
  decision: Schema.Literals(["approve", "reject"]),
});
export type CommandCenterMemoryReviewInput = typeof CommandCenterMemoryReviewInput.Type;

export const CommandCenterApprovalDecisionInput = Schema.Struct({
  approvalId: ApprovalId,
  payloadDigest: TrimmedNonEmptyString,
  decision: Schema.Literals(["approved", "declined"]),
  note: Schema.optional(TrimmedString),
});
export type CommandCenterApprovalDecisionInput = typeof CommandCenterApprovalDecisionInput.Type;

const GoogleConnectionSelection = {
  spaceId: SpaceId,
  connectionId: ConnectionId,
};

export const GoogleReadRequest = Schema.Union([
  Schema.Struct({
    ...GoogleConnectionSelection,
    operation: Schema.Literal("gmail.search"),
    query: TrimmedNonEmptyString,
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
    page: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    ...GoogleConnectionSelection,
    operation: Schema.Literal("gmail.get"),
    messageId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...GoogleConnectionSelection,
    operation: Schema.Literal("gmail.thread.get"),
    threadId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...GoogleConnectionSelection,
    operation: Schema.Literal("calendar.events"),
    calendarId: Schema.optional(TrimmedNonEmptyString),
    from: TrimmedNonEmptyString,
    to: TrimmedNonEmptyString,
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  }),
  Schema.Struct({
    ...GoogleConnectionSelection,
    operation: Schema.Literal("calendar.freebusy"),
    calendarIds: Schema.Array(TrimmedNonEmptyString).check(Schema.isNonEmpty()),
    from: TrimmedNonEmptyString,
    to: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...GoogleConnectionSelection,
    operation: Schema.Literal("drive.search"),
    query: TrimmedNonEmptyString,
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  }),
  Schema.Struct({
    ...GoogleConnectionSelection,
    operation: Schema.Literal("drive.list"),
    parentId: Schema.optional(TrimmedNonEmptyString),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  }),
  Schema.Struct({
    ...GoogleConnectionSelection,
    operation: Schema.Literal("drive.get"),
    fileId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...GoogleConnectionSelection,
    operation: Schema.Literal("drive.export"),
    fileId: TrimmedNonEmptyString,
    format: Schema.Literals(["pdf", "csv", "xlsx", "pptx", "txt", "png", "docx", "md"]),
    runId: Schema.optional(RunId),
  }),
]);
export type GoogleReadRequest = typeof GoogleReadRequest.Type;

export const GoogleReadResult = Schema.Union([
  Schema.Struct({
    operation: Schema.Literals([
      "gmail.search",
      "gmail.get",
      "gmail.thread.get",
      "calendar.events",
      "calendar.freebusy",
      "drive.search",
      "drive.list",
      "drive.get",
    ]),
    contentTrust: Schema.Literal("untrusted-external"),
    data: Schema.Unknown,
  }),
  Schema.Struct({
    operation: Schema.Literal("drive.export"),
    contentTrust: Schema.Literal("untrusted-external"),
    artifact: Artifact,
    sizeBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
]);
export type GoogleReadResult = typeof GoogleReadResult.Type;

/** A Gmail draft is a write, but never an instruction to send email. */
export const GoogleDraftCreateRequest = Schema.Struct({
  ...GoogleConnectionSelection,
  operation: Schema.Literal("gmail.draft.create"),
  to: Schema.Array(TrimmedNonEmptyString),
  cc: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  bcc: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  subject: TrimmedNonEmptyString,
  body: Schema.optional(Schema.String),
  bodyHtml: Schema.optional(Schema.String),
  replyToMessageId: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(TrimmedNonEmptyString),
  attachmentArtifactIds: Schema.optional(Schema.Array(ArtifactId)),
}).check(
  Schema.makeFilter(
    (value) =>
      value.body !== undefined ||
      value.bodyHtml !== undefined ||
      "A Gmail draft requires a plain-text or HTML body.",
  ),
);
export type GoogleDraftCreateRequest = typeof GoogleDraftCreateRequest.Type;

export const GoogleDraftCreateResult = Schema.Struct({
  operation: Schema.Literal("gmail.draft.create"),
  draftId: TrimmedNonEmptyString,
  messageId: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(TrimmedNonEmptyString),
});
export type GoogleDraftCreateResult = typeof GoogleDraftCreateResult.Type;
