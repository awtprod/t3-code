import {
  Approval,
  type Approval as ApprovalType,
  Artifact,
  type Artifact as ArtifactType,
  Automation,
  Connection,
  type Item as ItemType,
  Item,
  itemNeedsYou,
  Memory,
  type Memory as MemoryType,
  type ProviderAvailability,
  RouteDecision,
  type RouteDecision as RouteDecisionType,
  type Run as RunType,
  Run,
  RunId,
  Space,
  type Space as SpaceType,
  normalizeSpaceAlias,
  resolveRoute,
} from "@command-center/core";
import {
  CommandCenterError,
  type CommandCenterApprovalDecisionInput,
  type CommandCenterApprovalsQueryInput,
  type CommandCenterArtifactsQueryInput,
  type CommandCenterAutomationsQueryInput,
  type CommandCenterBootstrap,
  CommandCenterCommandSubmitInput,
  CommandCenterCommandSubmitResult,
  type CommandCenterCommandSubmitResult as CommandCenterCommandSubmitResultType,
  type CommandCenterConnectionsQueryInput,
  type CommandCenterItemCreateInput,
  type CommandCenterItemUpdateInput,
  type CommandCenterItemUpdateResult as CommandCenterItemUpdateResultType,
  type CommandCenterItemsQueryInput,
  type CommandCenterMemoryQueryInput,
  type CommandCenterMemoryProposeInput,
  type CommandCenterMemoryRememberInput,
  type CommandCenterMemoryReviewInput,
  type CommandCenterRunsQueryInput,
  type CommandCenterSpaceAgentProposalResult,
  type CommandCenterSpaceBrief,
  type CommandCenterSpacesQueryInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ProcessRunner from "../processRunner.ts";
import { makeCommandCenterAuditLog } from "./AuditLog.ts";
import {
  CommandCenterConfig,
  type LoadedCommandCenterConfig,
  layer as commandCenterConfigLayer,
} from "./Config.ts";
import { ConnectionHealth, layer as connectionHealthLayer } from "./ConnectionHealth.ts";
import { configProjectionFingerprint, type ConfigSyncState } from "./ConfigProjection.ts";
import { CommandApprovalPayload, makeCommandApprovalPayload } from "./CommandApproval.ts";
import { spaceAgentRunAuthorizedEventId } from "./SpaceAgentIds.ts";
import { isSpaceAgentItemMetadata, recordSpaceAgentReply } from "./SpaceAgentReplies.ts";
import { loadSpaceBriefInput, renderSpaceBrief } from "./SpaceBrief.ts";

const decodeSpace = Schema.decodeUnknownEffect(Space);
const decodeItem = Schema.decodeUnknownEffect(Item);
const decodeRun = Schema.decodeUnknownEffect(Run);
const decodeApproval = Schema.decodeUnknownEffect(Approval);
const decodeArtifact = Schema.decodeUnknownEffect(Artifact);
const decodeAutomation = Schema.decodeUnknownEffect(Automation);
const decodeConnection = Schema.decodeUnknownEffect(Connection);
const decodeMemory = Schema.decodeUnknownEffect(Memory);
const decodeSubmitResult = Schema.decodeUnknownEffect(CommandCenterCommandSubmitResult);
const decodeCommandInput = Schema.decodeUnknownEffect(CommandCenterCommandSubmitInput);
const decodeRouteDecision = Schema.decodeUnknownEffect(RouteDecision);
const decodeCommandApprovalPayload = Schema.decodeUnknownEffect(CommandApprovalPayload);
const decodeUnknownJsonString = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const isCommandCenterError = Schema.is(CommandCenterError);

const persistenceError = (message: string, cause?: unknown) =>
  new CommandCenterError({
    reason: "persistence",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const routingError = (message: string, cause?: unknown) =>
  new CommandCenterError({
    reason: "routing",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const parseJson = (
  value: string,
  description: string,
): Effect.Effect<unknown, CommandCenterError> =>
  decodeUnknownJsonString(value).pipe(
    Effect.mapError((cause) => persistenceError(`Stored ${description} is not valid JSON.`, cause)),
  );

const stringify = (value: unknown): string => JSON.stringify(value);

const priorityRank = (priority: ItemType["priority"]): number =>
  priority === "urgent" ? 3 : priority === "high" ? 2 : priority === "normal" ? 1 : 0;

const ITEM_UPDATE_FIELDS = new Set(["status", "priority", "title", "description", "dueAt"]);

const itemMatchesPatch = (item: ItemType, patch: CommandCenterItemUpdateInput["patch"]): boolean =>
  (patch.status === undefined || item.status === patch.status) &&
  (patch.priority === undefined || item.priority === patch.priority) &&
  (patch.title === undefined || item.title === patch.title) &&
  (!Object.hasOwn(patch, "description") ||
    (patch.description === null
      ? item.description === undefined
      : item.description === patch.description)) &&
  (!Object.hasOwn(patch, "dueAt") ||
    (patch.dueAt === null ? item.dueAt === undefined : item.dueAt === patch.dueAt));

const applyItemPatch = (item: ItemType, patch: CommandCenterItemUpdateInput["patch"]): ItemType => {
  let updated: ItemType = {
    ...item,
    ...(patch.status === undefined ? {} : { status: patch.status }),
    ...(patch.priority === undefined ? {} : { priority: patch.priority }),
    ...(patch.title === undefined ? {} : { title: patch.title }),
  };
  if (Object.hasOwn(patch, "description")) {
    if (patch.description === null || patch.description === undefined) {
      const { description: _description, ...withoutDescription } = updated;
      updated = withoutDescription;
    } else {
      updated = { ...updated, description: patch.description };
    }
  }
  if (Object.hasOwn(patch, "dueAt")) {
    if (patch.dueAt === null || patch.dueAt === undefined) {
      const { dueAt: _dueAt, ...withoutDueAt } = updated;
      updated = withoutDueAt;
    } else {
      updated = { ...updated, dueAt: patch.dueAt };
    }
  }
  return updated;
};

const nextItemUpdatedAt = (current: string, observed: string): string => {
  if (observed > current) return observed;
  return Option.match(DateTime.make(current), {
    onNone: () => observed,
    onSome: (value) => DateTime.formatIso(DateTime.add(value, { milliseconds: 1 })),
  });
};

const APPROVAL_TTL_HOURS = 24;

export const canonicalAutomationRunState = (
  state:
    | "queued"
    | "running"
    | "waiting_retry"
    | "waiting_delay"
    | "waiting_external"
    | "waiting_approval"
    | "succeeded"
    | "failed"
    | "canceled",
): RunType["status"] => {
  switch (state) {
    case "waiting_retry":
    case "waiting_delay":
    case "waiting_external":
      return "waiting";
    default:
      return state;
  }
};

interface SpaceRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly kind: string;
  readonly instructions: string | null;
  readonly policyJson: string;
  readonly modelDefaultsJson: string;
  readonly agentJson: string | null;
  readonly connectionsJson: string;
  readonly repositoriesJson: string;
  readonly aliasesJson: string;
  readonly lifecycle: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ItemRow {
  readonly id: string;
  readonly spaceId: string;
  readonly kind: string;
  readonly status: string;
  readonly title: string;
  readonly body: string | null;
  readonly priority: string;
  readonly dueAt: string | null;
  readonly sourceJson: string;
  readonly linksJson: string;
  readonly metadataJson: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RunRow {
  readonly id: string;
  readonly commandId: string;
  readonly parentRunId: string | null;
  readonly spaceId: string;
  readonly projectId: string | null;
  readonly threadId: string | null;
  readonly kind: string;
  readonly state: string;
  readonly routeJson: string;
  readonly inputJson: string;
  readonly resultJson: string | null;
  readonly error: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

interface HydratedRunRow extends RunRow {
  readonly artifactIdsJson: string;
}

interface RunArtifactIdsRow {
  readonly runId: string;
  readonly spaceId: string;
  readonly artifactIdsJson: string;
}

interface ApprovalRow {
  readonly id: string;
  readonly itemId: string | null;
  readonly runId: string | null;
  readonly spaceId: string;
  readonly actionKind: string;
  readonly risk: string;
  readonly payloadDigest: string;
  readonly payloadJson: string;
  readonly status: string;
  readonly idempotencyKey: string;
  readonly requestedAt: string;
  readonly expiresAt: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
}

interface ConnectionRow {
  readonly id: string;
  readonly spaceId: string;
  readonly kind: string;
  readonly accountLabel: string;
  readonly capabilitiesJson: string;
  readonly health: string;
  readonly checkedAt: string | null;
}

interface ArtifactRow {
  readonly id: string;
  readonly spaceId: string;
  readonly runId: string | null;
  readonly kind: string;
  readonly title: string;
  readonly uri: string | null;
  readonly contentDigest: string;
  readonly provenanceJson: string;
  readonly metadataJson: string;
  readonly createdAt: string;
}

interface MemoryRow {
  readonly id: string;
  readonly spaceId: string;
  readonly repositoryRef: string | null;
  readonly kind: string;
  readonly status: string;
  readonly content: string;
  readonly confidence: number;
  readonly provenanceJson: string;
  readonly contradictionOf: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface AutomationRow {
  readonly id: string;
  readonly enabled: number;
  readonly commitSha: string;
  readonly definitionDigest: string;
  readonly definitionJson: string;
}

export interface AutomationApprovalBinding {
  readonly approvalId: string;
  readonly spaceId: string;
  readonly status: ApprovalType["status"];
  readonly executionId: string;
  readonly automationId: string;
  readonly nodeId: string;
  readonly approvalKey: string;
  readonly configCommitSha: string;
  readonly definitionDigest: string;
  readonly payloadDigest: string;
}

export interface EnsureAutomationApprovalInput {
  readonly executionId: string;
  readonly automationId: string;
  readonly spaceId: string;
  readonly nodeId: string;
  readonly nodeKind: string;
  readonly approvalKey: string;
  readonly configCommitSha: string;
  readonly definitionDigest: string;
}

const AutomationApprovalPayload = Schema.Struct({
  kind: Schema.Literal("automation-checkpoint"),
  summary: Schema.String,
  proposal: Schema.String,
  executionId: Schema.String,
  automationId: Schema.String,
  nodeId: Schema.String,
  nodeKind: Schema.String,
  approvalKey: Schema.String,
  configCommitSha: Schema.String,
  definitionDigest: Schema.String,
});

const decodeAutomationApprovalPayload = Schema.decodeUnknownEffect(AutomationApprovalPayload);

const decodeSpaceRow = Effect.fn("CommandCenter.decodeSpaceRow")(function* (row: SpaceRow) {
  return yield* decodeSpace({
    id: row.id,
    slug: row.slug,
    displayName: row.name,
    kind: row.kind,
    instructions: row.instructions ?? "",
    policy: yield* parseJson(row.policyJson, "Space policy"),
    modelDefaults:
      row.modelDefaultsJson === "{}"
        ? undefined
        : yield* parseJson(row.modelDefaultsJson, "Space model defaults"),
    agent: row.agentJson === null ? undefined : yield* parseJson(row.agentJson, "Space agent"),
    connectionIds: yield* parseJson(row.connectionsJson, "Space connections"),
    repositories: yield* parseJson(row.repositoriesJson, "Space repositories"),
    aliases: yield* parseJson(row.aliasesJson, "Space aliases"),
    lifecycle: row.lifecycle,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }).pipe(Effect.mapError((cause) => persistenceError("Stored Space is invalid.", cause)));
});

const decodeItemRow = Effect.fn("CommandCenter.decodeItemRow")(function* (row: ItemRow) {
  return yield* decodeItem({
    id: row.id,
    spaceId: row.spaceId,
    kind: row.kind,
    status: row.status,
    priority: row.priority,
    title: row.title,
    description: row.body ?? undefined,
    dueAt: row.dueAt ?? undefined,
    artifactIds: yield* parseJson(row.linksJson, "Item artifact links"),
    provenance: yield* parseJson(row.sourceJson, "Item provenance"),
    metadata: yield* parseJson(row.metadataJson, "Item metadata"),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }).pipe(Effect.mapError((cause) => persistenceError("Stored Item is invalid.", cause)));
});

const decodeRunRow = Effect.fn("CommandCenter.decodeRunRow")(function* (row: HydratedRunRow) {
  const route = (yield* parseJson(row.routeJson, "Run route")) as Partial<RouteDecisionType>;
  return yield* decodeRun({
    id: row.id,
    spaceId: row.spaceId,
    kind: row.kind,
    status: row.state,
    commandId: row.commandId,
    parentRunId: row.parentRunId ?? undefined,
    repositoryId: route.repositoryId ?? undefined,
    projectId: row.projectId ?? undefined,
    threadId: row.threadId ?? undefined,
    providerId: route.providerId ?? undefined,
    modelId: route.modelId ?? undefined,
    artifactIds: yield* parseJson(row.artifactIdsJson, "Run artifact ids"),
    createdAt: row.startedAt,
    startedAt: row.state === "queued" ? undefined : row.startedAt,
    finishedAt: row.finishedAt ?? undefined,
  }).pipe(Effect.mapError((cause) => persistenceError("Stored Run is invalid.", cause)));
});

const decodeApprovalRow = Effect.fn("CommandCenter.decodeApprovalRow")(function* (
  row: ApprovalRow,
) {
  if (row.runId === null) {
    return yield* persistenceError("Stored approval is missing its Run.");
  }
  const payload = (yield* parseJson(row.payloadJson, "Approval payload")) as {
    readonly summary?: unknown;
    readonly proposal?: unknown;
  };
  const summary = typeof payload.summary === "string" ? payload.summary : row.actionKind;
  return yield* decodeApproval({
    id: row.id,
    spaceId: row.spaceId,
    runId: row.runId,
    status: row.status,
    actionKind: row.actionKind,
    risk: row.risk,
    summary,
    proposal: typeof payload.proposal === "string" ? payload.proposal : summary,
    payloadDigest: row.payloadDigest,
    idempotencyKey: row.idempotencyKey,
    requestedAt: row.requestedAt,
    expiresAt: row.expiresAt ?? undefined,
    decidedAt: row.decidedAt ?? undefined,
  }).pipe(Effect.mapError((cause) => persistenceError("Stored Approval is invalid.", cause)));
});

const decodeConnectionRow = Effect.fn("CommandCenter.decodeConnectionRow")(function* (
  row: ConnectionRow,
) {
  return yield* decodeConnection({
    id: row.id,
    spaceId: row.spaceId,
    kind: row.kind,
    label: row.accountLabel,
    capabilities: yield* parseJson(row.capabilitiesJson, "Connection capabilities"),
    health: row.health,
    lastCheckedAt: row.checkedAt ?? undefined,
  }).pipe(Effect.mapError((cause) => persistenceError("Stored Connection is invalid.", cause)));
});

const decodeArtifactRow = Effect.fn("CommandCenter.decodeArtifactRow")(function* (
  row: ArtifactRow,
) {
  if (row.uri === null) {
    return yield* persistenceError("Stored Artifact is missing its safe locator.");
  }
  if (!row.uri.startsWith("cc-artifact://")) {
    return yield* persistenceError("Stored Artifact has an unsafe locator.");
  }
  const metadata = yield* parseJson(row.metadataJson, "Artifact metadata");
  const mimeType =
    typeof metadata === "object" &&
    metadata !== null &&
    "mimeType" in metadata &&
    typeof metadata.mimeType === "string"
      ? metadata.mimeType
      : undefined;
  return yield* decodeArtifact({
    id: row.id,
    spaceId: row.spaceId,
    runId: row.runId ?? undefined,
    kind: row.kind,
    name: row.title,
    locator: row.uri,
    mimeType,
    contentDigest: row.contentDigest,
    provenance: yield* parseJson(row.provenanceJson, "Artifact provenance"),
    createdAt: row.createdAt,
  }).pipe(Effect.mapError((cause) => persistenceError("Stored Artifact is invalid.", cause)));
});

const decodeMemoryRow = Effect.fn("CommandCenter.decodeMemoryRow")(function* (row: MemoryRow) {
  return yield* decodeMemory({
    id: row.id,
    spaceId: row.spaceId,
    repositoryId: row.repositoryRef ?? undefined,
    kind: row.kind,
    status: row.status,
    content: row.content,
    confidence: row.confidence,
    provenance: yield* parseJson(row.provenanceJson, "Memory provenance"),
    contradictionOf: row.contradictionOf ?? undefined,
    expiresAt: row.expiresAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }).pipe(Effect.mapError((cause) => persistenceError("Stored Memory is invalid.", cause)));
});

const LESSON_EVIDENCE_SOURCE_REF = /^observation\/([^/]+)\/version\/\d+\/revision\/([^/]+)$/u;

/** Returns the Observation revision a correction-backed lesson was proposed from, if any. */
const lessonEvidenceRef = (sourceRef: string | undefined) => {
  const [, observationId, revisionId] = LESSON_EVIDENCE_SOURCE_REF.exec(sourceRef ?? "") ?? [];
  if (observationId === undefined || revisionId === undefined) return undefined;
  try {
    return {
      observationId: decodeURIComponent(observationId),
      revisionId: decodeURIComponent(revisionId),
    };
  } catch {
    return undefined;
  }
};

/** A Space agent acting through the MCP Item tools. */
export interface CommandCenterItemActor {
  readonly kind: "space-agent";
  readonly threadId: string;
}

export interface CommandCenterServiceShape {
  readonly bootstrap: Effect.Effect<CommandCenterBootstrap, CommandCenterError>;
  readonly syncConfiguration: (input?: {
    readonly force?: boolean;
  }) => Effect.Effect<LoadedCommandCenterConfig, CommandCenterError>;
  readonly refreshInboxSpaceProjection: (
    spaceId?: string,
  ) => Effect.Effect<void, CommandCenterError>;
  readonly querySpaces: (
    input: CommandCenterSpacesQueryInput,
  ) => Effect.Effect<{ readonly spaces: ReadonlyArray<SpaceType> }, CommandCenterError>;
  readonly queryItems: (
    input: CommandCenterItemsQueryInput,
  ) => Effect.Effect<{ readonly items: ReadonlyArray<ItemType> }, CommandCenterError>;
  readonly queryRuns: (
    input: CommandCenterRunsQueryInput,
  ) => Effect.Effect<{ readonly runs: ReadonlyArray<RunType> }, CommandCenterError>;
  readonly queryAutomations: (
    input: CommandCenterAutomationsQueryInput,
  ) => Effect.Effect<
    { readonly automations: CommandCenterBootstrap["automations"] },
    CommandCenterError
  >;
  readonly queryApprovals: (
    input: CommandCenterApprovalsQueryInput,
  ) => Effect.Effect<{ readonly approvals: ReadonlyArray<ApprovalType> }, CommandCenterError>;
  readonly queryArtifacts: (
    input: CommandCenterArtifactsQueryInput,
  ) => Effect.Effect<{ readonly artifacts: ReadonlyArray<ArtifactType> }, CommandCenterError>;
  /**
   * Resolve specific Artifacts by id within one Space. Unlike `queryArtifacts`, this is not
   * bounded to the most recent page, so an older export stays addressable. Ids that do not exist
   * or belong to another Space are omitted rather than returned.
   */
  readonly getArtifactsByIds: (input: {
    readonly spaceId: CommandCenterArtifactsQueryInput["spaceId"];
    readonly artifactIds: ReadonlyArray<string>;
  }) => Effect.Effect<{ readonly artifacts: ReadonlyArray<ArtifactType> }, CommandCenterError>;
  readonly queryConnections: (
    input: CommandCenterConnectionsQueryInput,
  ) => Effect.Effect<
    { readonly connections: CommandCenterBootstrap["connections"] },
    CommandCenterError
  >;
  readonly queryMemories: (
    input: CommandCenterMemoryQueryInput,
  ) => Effect.Effect<{ readonly memories: ReadonlyArray<MemoryType> }, CommandCenterError>;
  readonly submitCommand: (
    input: CommandCenterCommandSubmitInput,
    providers: ReadonlyArray<ProviderAvailability>,
  ) => Effect.Effect<CommandCenterCommandSubmitResultType, CommandCenterError>;
  readonly authorizeRunExecution: (input: {
    readonly runId: RunType["id"];
    readonly actorKind: "user" | "agent" | "automation" | "system";
  }) => Effect.Effect<
    { readonly authorizedAt: string; readonly duplicate: boolean },
    CommandCenterError
  >;
  /**
   * Internal MCP boundary. Submission, authenticated parent linkage, and any
   * immediate execution authorization share one transaction. Callers never
   * provide a parent Run id.
   */
  readonly submitMcpChildCommand: (
    input: CommandCenterCommandSubmitInput,
    providers: ReadonlyArray<ProviderAvailability>,
    source: {
      readonly spaceId: string;
      readonly repositoryId?: string;
      readonly threadId: string;
      readonly providerSessionId: string;
      readonly providerInstanceId: string;
    },
  ) => Effect.Effect<CommandCenterCommandSubmitResultType, CommandCenterError>;
  /** Bounded brief of approved Memory and open Items for one configured Space. */
  readonly spaceBrief: (input: {
    readonly spaceId: string;
    readonly repositoryId?: string;
  }) => Effect.Effect<CommandCenterSpaceBrief, CommandCenterError>;
  /** The active, configured Space (cached config; fails when absent). */
  readonly getConfiguredSpace: (spaceId: string) => Effect.Effect<SpaceType, CommandCenterError>;
  /**
   * Internal MCP boundary for a Space agent thread, which has no parent Run.
   * `submitCommand` stays the only route/policy gate: the Run is kept and
   * authorized only when that gate leaves it queued and ready at a risk listed
   * in the Space's `autoRunRiskLevels`. Anything else is rolled back (no Run,
   * no approval) and recorded as a decision Item for the user instead.
   */
  readonly submitSpaceAgentCommand: (
    input: CommandCenterCommandSubmitInput,
    providers: ReadonlyArray<ProviderAvailability>,
    source: {
      readonly spaceId: string;
      readonly threadId: string;
      readonly providerSessionId: string;
      readonly providerInstanceId: string;
    },
  ) => Effect.Effect<
    CommandCenterCommandSubmitResultType | CommandCenterSpaceAgentProposalResult,
    CommandCenterError
  >;
  /** `actor` marks the Item as a Space agent's (agent provenance + `metadata.spaceAgent`). */
  readonly createItem: (
    input: CommandCenterItemCreateInput,
    actor?: CommandCenterItemActor,
  ) => Effect.Effect<ItemType, CommandCenterError>;
  /**
   * Without `actor` the change is the user's: a status change on a Space agent
   * Item is queued as a reply for the agent. With `actor` the audit event is the
   * agent's and no reply is queued.
   */
  readonly updateItem: (
    input: CommandCenterItemUpdateInput,
    actor?: CommandCenterItemActor,
  ) => Effect.Effect<CommandCenterItemUpdateResultType, CommandCenterError>;
  readonly recordArtifact: (input: {
    readonly artifact: ArtifactType;
    readonly sizeBytes?: number;
    readonly format?: string;
  }) => Effect.Effect<ArtifactType, CommandCenterError>;
  readonly remember: (
    input: CommandCenterMemoryRememberInput,
  ) => Effect.Effect<MemoryType, CommandCenterError>;
  /** Approved Memory written by a Space agent, attributed to its thread. */
  readonly rememberFromSpaceAgent: (
    input: CommandCenterMemoryRememberInput,
    source: { readonly threadId: string },
  ) => Effect.Effect<MemoryType, CommandCenterError>;
  readonly proposeMemory: (
    input: CommandCenterMemoryProposeInput,
  ) => Effect.Effect<MemoryType, CommandCenterError>;
  readonly reviewMemory: (
    input: CommandCenterMemoryReviewInput,
  ) => Effect.Effect<MemoryType, CommandCenterError>;
  readonly decideApproval: (
    input: CommandCenterApprovalDecisionInput,
  ) => Effect.Effect<ApprovalType, CommandCenterError>;
  readonly ensureAutomationApproval: (
    input: EnsureAutomationApprovalInput,
  ) => Effect.Effect<ApprovalType, CommandCenterError>;
  readonly getAutomationApprovalBinding: (
    approvalId: string,
  ) => Effect.Effect<AutomationApprovalBinding | null, CommandCenterError>;
  readonly recordAutomationEvent: (input: {
    readonly executionId: string;
    readonly automationId: string;
    readonly spaceId: string;
    readonly state:
      | "queued"
      | "running"
      | "waiting_retry"
      | "waiting_delay"
      | "waiting_external"
      | "waiting_approval"
      | "succeeded"
      | "failed"
      | "canceled";
    readonly configCommitSha: string;
    readonly definitionDigest: string;
    readonly input: Readonly<Record<string, Schema.Json>>;
    readonly output: Schema.Json | null;
    readonly createdAt: string;
    /**
     * The runtime execution row's durable updated_at for this snapshot (lease
     * changes also advance it). It is the audit event's occurredAt, so
     * recording the same persisted snapshot again (a retry or a restart) is an
     * exact, idempotent replay, and an older snapshot can be recognised.
     */
    readonly updatedAt: string;
    /**
     * Node progress at this transition. Together with updatedAt it identifies
     * the transition, so an execution can legitimately re-enter a state (e.g.
     * queued again after its approval resolves) as a new audit event.
     */
    readonly checkpoints: ReadonlyArray<{
      readonly nodeId: string;
      readonly state: string;
      readonly attemptCount: number;
      readonly resolutionKey: string | null;
    }>;
    readonly finishedAt: string | null;
    readonly error?: string;
  }) => Effect.Effect<
    { readonly projected: boolean },
    CommandCenterError
  > /* projected: false when the snapshot is no longer the current runtime row */;
  readonly recordAutomationDefinitionCommit: (input: {
    readonly operation: "created" | "updated";
    readonly requestId?: string;
    readonly automationId: string;
    readonly spaceId: string;
    readonly previousConfigCommitSha: string;
    readonly configCommitSha: string;
    readonly previousDefinitionDigest: string | null;
    readonly definitionDigest: string;
    readonly actor?: {
      readonly kind: "agent";
      readonly threadId: string;
      readonly providerSessionId: string;
      readonly providerInstanceId: string;
    };
  }) => Effect.Effect<void, CommandCenterError>;
}

export class CommandCenterService extends Context.Service<
  CommandCenterService,
  CommandCenterServiceShape
>()("@awtprod/command-center/command-center/Service/CommandCenterService") {}

/** Rolls back an out-of-policy Space agent submission inside its transaction. */
class SpaceAgentProposalRequired extends Data.TaggedError("SpaceAgentProposalRequired")<{
  readonly route: RouteDecisionType;
}> {}

const SPACE_AGENT_PROPOSAL_TEXT_CHARS = 4_000;

const clipProposalText = (value: string, maxChars: number): string => {
  const trimmed = value.trim();
  return trimmed.length <= maxChars
    ? trimmed
    : `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
};

function inferClassifier(text: string, spaceId: SpaceType["id"] | undefined) {
  const normalized = normalizeSpaceAlias(text);
  const highRiskActionKind =
    /\bgit push\b|\bpush\b.{0,32}\b(changes?|commits?|branches?|code|repository|remote)\b/u.test(
      normalized,
    )
      ? ("git.push" as const)
      : /\bmerge\b.{0,32}\b(pull request|pr|branch|changes?)\b|\bmerge (it|this|that)\b/u.test(
            normalized,
          )
        ? ("pull-request.merge" as const)
        : /\bdeploy\b|\bship\b.{0,16}\bproduction\b/u.test(normalized)
          ? ("deploy" as const)
          : /\bpublish\b|\brelease\b.{0,24}\b(public|production|store|registry)\b/u.test(normalized)
            ? ("publish" as const)
            : /\b(send|write)\b.{0,24}\b(email|message|reply)\b|\bnotify\b/u.test(normalized)
              ? ("communicate" as const)
              : /\bshare\b|\bgrant\b.{0,16}\baccess\b|\binvite\b/u.test(normalized)
                ? ("share" as const)
                : /\b(delete|erase|destroy|purge)\b/u.test(normalized)
                  ? ("delete" as const)
                  : /\b(change|reset|disable|enable|remove|update)\b.{0,32}\b(account|password|security|2fa|mfa|permissions?)\b/u.test(
                        normalized,
                      )
                    ? ("account.security" as const)
                    : /\b(change|rotate|replace|create|delete|update)\b.{0,32}\b(secret|token|api key|credential)\b/u.test(
                          normalized,
                        )
                      ? ("secret.change" as const)
                      : /\b(pay|purchase|buy|refund)\b|\b(transfer|send|move)\b.{0,24}\b(money|funds?|payment)\b/u.test(
                            normalized,
                          )
                        ? ("money.move" as const)
                        : undefined;
  if (highRiskActionKind !== undefined) {
    return {
      intent:
        highRiskActionKind === "git.push" ||
        highRiskActionKind === "pull-request.merge" ||
        highRiskActionKind === "deploy" ||
        highRiskActionKind === "publish"
          ? ("repository" as const)
          : ("conversation" as const),
      actionKind: highRiskActionKind,
      capabilities: ["cc.runs.start" as const],
      spaceId,
    };
  }
  if (/\b(email|gmail)\b/u.test(normalized)) {
    return {
      intent: "google" as const,
      actionKind: "read" as const,
      capabilities: ["cc.connections.google.gmail.read" as const],
      spaceId,
    };
  }
  if (/\b(calendar|schedule)\b/u.test(normalized)) {
    return {
      intent: "google" as const,
      actionKind: "read" as const,
      capabilities: ["cc.connections.google.calendar.read" as const],
      spaceId,
    };
  }
  if (/\b(drive|google docs?|google sheets?|google slides?)\b/u.test(normalized)) {
    return {
      intent: "google" as const,
      actionKind: "read" as const,
      capabilities: ["cc.connections.google.drive.read" as const],
      spaceId,
    };
  }
  if (/\bgoogle\b/u.test(normalized)) {
    return {
      intent: "google" as const,
      actionKind: "unsupported" as const,
      capabilities: [] as const,
      spaceId,
    };
  }
  if (/\b(automation|automate|recurring|weekly|daily)\b/u.test(normalized)) {
    const execute =
      /\b(run|start|execute|trigger)\b.{0,32}\b(automation|workflow)\b/u.test(normalized) ||
      /\b(automation|workflow)\b.{0,32}\b(run|start|execute|trigger)\b/u.test(normalized);
    return {
      intent: "automation" as const,
      actionKind: execute ? ("automation.run" as const) : ("automation.draft" as const),
      capabilities: execute
        ? (["cc.automations.read", "cc.automations.run"] as const)
        : (["cc.automations.read", "cc.automations.write"] as const),
      spaceId,
    };
  }
  if (/\b(remember|note that|keep this)\b/u.test(normalized)) {
    return {
      intent: "conversation" as const,
      actionKind: "memory.remember" as const,
      capabilities: ["cc.memory.propose" as const],
      spaceId,
    };
  }
  if (
    /\b(start work|work on|app|application|repo|repository|code|fix|build|test|branch|pull request|pr)\b/u.test(
      normalized,
    )
  ) {
    return {
      intent: "repository" as const,
      actionKind: "worktree.edit" as const,
      capabilities: ["cc.runs.start" as const],
      spaceId,
    };
  }
  if (/\b(task|item|needs me|todo|idea)\b/u.test(normalized)) {
    const mutate = /\b(create|add|capture|new)\b/u.test(normalized);
    return {
      intent: "item" as const,
      actionKind: mutate ? ("item.mutate" as const) : ("read" as const),
      capabilities: mutate
        ? (["cc.items.read", "cc.items.write"] as const)
        : (["cc.items.read"] as const),
      spaceId,
    };
  }
  return {
    intent: "conversation" as const,
    actionKind: "read" as const,
    capabilities: ["cc.runs.start" as const],
    spaceId,
  };
}

function inferRepository(text: string, space: SpaceType) {
  const normalizedText = ` ${normalizeSpaceAlias(text)} `;
  const matches = space.repositories.filter((repository) =>
    [repository.id, repository.displayName, ...repository.aliases].some((alias) => {
      const normalized = normalizeSpaceAlias(alias);
      return normalized.length > 0 && normalizedText.includes(` ${normalized} `);
    }),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function inferPrimaryRepository(text: string, space: SpaceType) {
  const explicit = inferRepository(text, space);
  if (explicit !== undefined) return explicit;
  if (space.repositories.length !== 1) return undefined;
  const normalized = normalizeSpaceAlias(text);
  return /\b(start work|work on|open|app|application|repo|repository|code|fix|build|test|branch|pull request|pr)\b/u.test(
    normalized,
  )
    ? space.repositories[0]
    : undefined;
}

function inferCapabilitySpace(
  classifier: ReturnType<typeof inferClassifier>,
  spaces: ReadonlyArray<SpaceType>,
): SpaceType | undefined {
  if (classifier.intent !== "google") return undefined;
  const compatible = spaces.filter((space) => space.connectionIds.length > 0);
  return compatible.length === 1 ? compatible[0] : undefined;
}

function inferSpace(text: string, spaces: ReadonlyArray<SpaceType>): SpaceType | undefined {
  const normalizedText = ` ${normalizeSpaceAlias(text)} `;
  const matches = spaces.filter((space) => {
    const aliases = [
      space.id,
      space.slug,
      space.displayName,
      ...space.aliases,
      ...space.repositories.flatMap((repository) => [
        repository.id,
        repository.displayName,
        ...repository.aliases,
      ]),
    ];
    return aliases.some((alias) => {
      const normalized = normalizeSpaceAlias(alias);
      return normalized.length > 0 && normalizedText.includes(` ${normalized} `);
    });
  });
  return matches.length === 1 ? matches[0] : undefined;
}

export const layer = Layer.effect(
  CommandCenterService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const config = yield* CommandCenterConfig;
    const connectionHealth = yield* ConnectionHealth;
    const textEncoder = new TextEncoder();

    const digest = Effect.fn("CommandCenter.digest")(function* (value: string) {
      return Encoding.encodeHex(yield* crypto.digest("SHA-256", textEncoder.encode(value)));
    });
    const auditLog = yield* makeCommandCenterAuditLog;
    const configSyncState = yield* Ref.make<ConfigSyncState | null>(null);
    const configSyncLock = yield* Semaphore.make(1);

    const reconcileConfig = Effect.fn("CommandCenter.reconcileConfig")(
      function* (loaded: LoadedCommandCenterConfig) {
        if (loaded.health.status !== "loaded") return loaded;
        const reconciledAt = DateTime.formatIso(yield* DateTime.now);

        // The private configuration is authoritative. Archive the current
        // projection first, then reactivate only Spaces present in a complete,
        // successfully loaded snapshot. Historical rows keep their foreign-key
        // targets and can become active again if the configuration recovers.
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              UPDATE command_center_spaces
              SET lifecycle = 'archived', updated_at = ${reconciledAt}
              WHERE lifecycle = 'active'
            `;
            for (const space of loaded.spaces) {
              yield* sql`
                INSERT INTO command_center_spaces (
                  id, slug, name, kind, instructions, policy_json, model_defaults_json,
                  agent_json, connections_json, repositories_json, aliases_json, lifecycle,
                  created_at, updated_at
                ) VALUES (
                  ${space.id}, ${space.slug}, ${space.displayName}, ${space.kind},
                  ${space.instructions}, ${stringify(space.policy)},
                  ${stringify(space.modelDefaults ?? {})},
                  ${space.agent === undefined ? null : stringify(space.agent)},
                  ${stringify(space.connectionIds)},
                  ${stringify(space.repositories)}, ${stringify(space.aliases)},
                  ${space.lifecycle}, ${space.createdAt}, ${space.updatedAt}
                )
                ON CONFLICT(id) DO UPDATE SET
                  slug = excluded.slug,
                  name = excluded.name,
                  kind = excluded.kind,
                  instructions = excluded.instructions,
                  policy_json = excluded.policy_json,
                  model_defaults_json = excluded.model_defaults_json,
                  agent_json = excluded.agent_json,
                  connections_json = excluded.connections_json,
                  repositories_json = excluded.repositories_json,
                  aliases_json = excluded.aliases_json,
                  lifecycle = excluded.lifecycle,
                  updated_at = excluded.updated_at
              `;
            }
          }),
        );
        yield* connectionHealth.syncConfigured(loaded.connections);
        const configLoadedAt = reconciledAt;
        for (const automation of loaded.automations) {
          if (automation.configCommit === undefined) {
            return yield* persistenceError(
              `Automation '${automation.id}' is missing its config commit.`,
            );
          }
          yield* sql`
          INSERT INTO command_center_automations (
            id, space_id, name, enabled, commit_sha, definition_digest,
            definition_json, last_loaded_at
          ) VALUES (
            ${automation.id}, ${automation.spaceId}, ${automation.name},
            ${automation.enabled ? 1 : 0}, ${automation.configCommit},
            ${automation.definitionDigest}, ${stringify(automation)},
            ${configLoadedAt}
          )
          ON CONFLICT(id) DO UPDATE SET
            space_id = excluded.space_id,
            name = excluded.name,
            enabled = excluded.enabled,
            commit_sha = excluded.commit_sha,
            definition_digest = excluded.definition_digest,
            definition_json = excluded.definition_json,
            last_loaded_at = excluded.last_loaded_at
        `;
        }
        const storedAutomations = yield* sql<{ readonly id: string }>`
        SELECT id FROM command_center_automations
      `;
        const configuredAutomationIds = new Set<string>(
          loaded.automations.map((automation) => automation.id),
        );
        for (const stored of storedAutomations) {
          if (!configuredAutomationIds.has(stored.id)) {
            yield* sql`DELETE FROM command_center_automations WHERE id = ${stored.id}`;
          }
        }
        return loaded;
      },
      Effect.mapError((cause) => persistenceError("Could not synchronize private config.", cause)),
    );

    const syncConfig = Effect.fn("CommandCenter.syncConfig")(
      function* (force: boolean) {
        const cached = yield* Ref.get(configSyncState);
        if (!force && cached !== null) return cached.observed;

        return yield* configSyncLock.withPermits(1)(
          Effect.gen(function* () {
            const lockedCached = yield* Ref.get(configSyncState);
            if (!force && lockedCached !== null) return lockedCached.observed;

            const loaded = yield* config.load;
            const fingerprint = configProjectionFingerprint(loaded);
            if (lockedCached?.fingerprint === fingerprint) return lockedCached.observed;

            if (loaded.health.status !== "loaded") {
              yield* Ref.set(configSyncState, {
                fingerprint,
                observed: loaded,
                projection: lockedCached?.projection ?? null,
              });
              return loaded;
            }

            yield* reconcileConfig(loaded);
            yield* Ref.set(configSyncState, {
              fingerprint,
              observed: loaded,
              projection: loaded,
            });

            if (lockedCached !== null) {
              const fingerprintDigest = yield* digest(fingerprint);
              const occurredAt = DateTime.formatIso(yield* DateTime.now);
              yield* Effect.forEach(
                loaded.spaces,
                (space) =>
                  auditLog.append({
                    actorKind: "system",
                    action: "cc.config.changed",
                    spaceId: space.id,
                    payload: {
                      configHealth: loaded.health.status,
                      fingerprint: fingerprintDigest,
                    },
                    occurredAt,
                  }),
                { discard: true },
              );
            }
            return loaded;
          }),
        );
      },
      Effect.mapError((cause) =>
        isCommandCenterError(cause)
          ? cause
          : persistenceError("Could not synchronize private config.", cause),
      ),
    );

    const requireConfiguredSpace = Effect.fn("CommandCenter.requireConfiguredSpace")(function* (
      spaceId: string,
    ) {
      const loaded = yield* syncConfig(false);
      if (loaded.health.status !== "loaded") {
        return yield* new CommandCenterError({
          reason: "config",
          message:
            "Private Command Center configuration is unavailable; scoped writes are disabled.",
        });
      }
      const space = loaded.spaces.find((candidate) => candidate.id === spaceId);
      if (space === undefined) {
        return yield* new CommandCenterError({
          reason: "not_found",
          message: `Space '${spaceId}' is not present in the active private configuration.`,
        });
      }
      return space;
    });

    const refreshInboxSpaceProjection = Effect.fn("CommandCenter.refreshInboxSpaceProjection")(
      function* (spaceId?: string) {
        const loaded = yield* syncConfig(true);
        if (loaded.health.status !== "loaded") {
          return yield* new CommandCenterError({
            reason: "config",
            message:
              "Private Command Center configuration is unavailable; Inbox access is disabled.",
          });
        }
        if (spaceId !== undefined && !loaded.spaces.some((space) => space.id === spaceId)) {
          return yield* new CommandCenterError({
            reason: "not_found",
            message: `Space '${spaceId}' is not present in the active private configuration.`,
          });
        }
      },
    );

    const listSpaces = Effect.fn("CommandCenter.listSpaces")(function* () {
      const rows = yield* sql<SpaceRow>`
        SELECT id, slug, name, kind, instructions,
          policy_json AS "policyJson", model_defaults_json AS "modelDefaultsJson",
          agent_json AS "agentJson",
          connections_json AS "connectionsJson", repositories_json AS "repositoriesJson",
          aliases_json AS "aliasesJson", lifecycle,
          created_at AS "createdAt", updated_at AS "updatedAt"
        FROM command_center_spaces
        WHERE lifecycle = 'active'
        ORDER BY name COLLATE NOCASE
      `;
      return yield* Effect.forEach(rows, decodeSpaceRow);
    });

    const listItems = Effect.fn("CommandCenter.listItems")(function* () {
      const rows = yield* sql<ItemRow>`
        SELECT i.id, i.space_id AS "spaceId", i.kind, i.status, i.title, i.body, i.priority,
          i.due_at AS "dueAt", i.source_json AS "sourceJson", i.links_json AS "linksJson",
          i.metadata_json AS "metadataJson", i.created_at AS "createdAt",
          i.updated_at AS "updatedAt"
        FROM command_center_items i
        JOIN command_center_spaces s ON s.id = i.space_id AND s.lifecycle = 'active'
        WHERE i.status NOT IN ('done', 'canceled')
        ORDER BY i.updated_at DESC
      `;
      return yield* Effect.forEach(rows, decodeItemRow);
    });

    const listAllItems = Effect.fn("CommandCenter.listAllItems")(function* () {
      const rows = yield* sql<ItemRow>`
        SELECT i.id, i.space_id AS "spaceId", i.kind, i.status, i.title, i.body, i.priority,
          i.due_at AS "dueAt", i.source_json AS "sourceJson", i.links_json AS "linksJson",
          i.metadata_json AS "metadataJson", i.created_at AS "createdAt",
          i.updated_at AS "updatedAt"
        FROM command_center_items i
        JOIN command_center_spaces s ON s.id = i.space_id AND s.lifecycle = 'active'
        ORDER BY i.updated_at DESC
        LIMIT 500
      `;
      return yield* Effect.forEach(rows, decodeItemRow);
    });

    const listRuns = Effect.fn("CommandCenter.listRuns")(function* () {
      const rows = yield* sql<RunRow>`
        SELECT r.id, r.command_id AS "commandId", r.parent_run_id AS "parentRunId",
          r.space_id AS "spaceId", r.project_id AS "projectId", r.thread_id AS "threadId",
          r.kind, r.state, r.route_json AS "routeJson", r.input_json AS "inputJson",
          r.result_json AS "resultJson", r.error, r.started_at AS "startedAt",
          r.finished_at AS "finishedAt"
        FROM command_center_runs r
        JOIN command_center_spaces s ON s.id = r.space_id AND s.lifecycle = 'active'
        ORDER BY r.started_at DESC
        LIMIT 100
      `;
      return yield* hydrateRunRows(rows);
    });

    const hydrateRunRows = Effect.fn("CommandCenter.hydrateRunRows")(function* (
      rows: ReadonlyArray<RunRow>,
    ) {
      if (rows.length === 0) return [];

      const artifactRows = yield* sql<RunArtifactIdsRow>`
        SELECT artifact.run_id AS "runId", artifact.space_id AS "spaceId",
          json_group_array(artifact.id) AS "artifactIdsJson"
        FROM (
          SELECT a.id, a.run_id, a.space_id
          FROM command_center_artifacts a
          WHERE ${sql.in(
            "a.run_id",
            rows.map((row) => row.id),
          )}
          ORDER BY a.run_id, a.space_id, a.created_at, a.id
        ) artifact
        GROUP BY artifact.run_id, artifact.space_id
      `;
      const artifactIdsByRunAndSpace = new Map<string, Map<string, string>>();
      for (const artifactRow of artifactRows) {
        const bySpace = artifactIdsByRunAndSpace.get(artifactRow.runId) ?? new Map();
        bySpace.set(artifactRow.spaceId, artifactRow.artifactIdsJson);
        artifactIdsByRunAndSpace.set(artifactRow.runId, bySpace);
      }

      return yield* Effect.forEach(rows, (row) =>
        decodeRunRow({
          ...row,
          artifactIdsJson: artifactIdsByRunAndSpace.get(row.id)?.get(row.spaceId) ?? "[]",
        }),
      );
    });

    const hydrateCommandReceiptRun = Effect.fn("CommandCenter.hydrateCommandReceiptRun")(function* (
      receipt: CommandCenterCommandSubmitResultType,
      commandId: string,
    ) {
      const rows = yield* sql<RunRow>`
          SELECT id, command_id AS "commandId", parent_run_id AS "parentRunId",
            space_id AS "spaceId", project_id AS "projectId", thread_id AS "threadId",
            kind, state, route_json AS "routeJson", input_json AS "inputJson",
            result_json AS "resultJson", error, started_at AS "startedAt",
            finished_at AS "finishedAt"
          FROM command_center_runs
          WHERE id = ${receipt.run.id}
          LIMIT 1
        `;
      const row = rows[0];
      if (row === undefined) {
        return yield* persistenceError("Stored command receipt is missing its canonical Run.");
      }

      const storedRoute = yield* parseJson(row.routeJson, "Run route").pipe(
        Effect.flatMap(decodeRouteDecision),
        Effect.mapError((cause) => persistenceError("Stored Run route is invalid.", cause)),
      );
      const run = (yield* hydrateRunRows([row]))[0];
      if (run === undefined) {
        return yield* persistenceError("Stored command receipt is missing its canonical Run.");
      }
      if (
        row.commandId !== commandId ||
        run.commandId !== receipt.run.commandId ||
        run.spaceId !== receipt.run.spaceId ||
        run.spaceId !== receipt.route.spaceId ||
        run.kind !== receipt.run.kind ||
        stringify(storedRoute) !== stringify(receipt.route)
      ) {
        return yield* persistenceError(
          "Stored command receipt is inconsistent with its canonical Run.",
        );
      }

      return run;
    });

    const listApprovals = Effect.fn("CommandCenter.listApprovals")(function* () {
      const rows = yield* sql<ApprovalRow>`
        SELECT a.id, a.item_id AS "itemId", a.run_id AS "runId", r.space_id AS "spaceId",
          a.action_kind AS "actionKind", a.risk, a.payload_digest AS "payloadDigest",
          a.payload_json AS "payloadJson", a.status, a.idempotency_key AS "idempotencyKey",
          a.requested_at AS "requestedAt", a.expires_at AS "expiresAt",
          a.decided_at AS "decidedAt", a.decision_note AS "decisionNote"
        FROM command_center_approvals a
        JOIN command_center_runs r ON r.id = a.run_id
        JOIN command_center_spaces s ON s.id = r.space_id AND s.lifecycle = 'active'
        ORDER BY a.requested_at DESC
      `;
      return yield* Effect.forEach(rows, decodeApprovalRow);
    });

    const listConnections = Effect.fn("CommandCenter.listConnections")(function* () {
      const rows = yield* sql<ConnectionRow>`
        SELECT c.id, c.space_id AS "spaceId", c.kind, c.account_label AS "accountLabel",
          c.capabilities_json AS "capabilitiesJson", c.health, c.checked_at AS "checkedAt"
        FROM command_center_connections c
        JOIN command_center_spaces s ON s.id = c.space_id AND s.lifecycle = 'active'
        ORDER BY c.account_label COLLATE NOCASE
      `;
      return yield* Effect.forEach(rows, decodeConnectionRow);
    });

    const listMemories = Effect.fn("CommandCenter.listMemories")(function* () {
      const rows = yield* sql<MemoryRow>`
        SELECT m.id, m.space_id AS "spaceId", m.repository_ref AS "repositoryRef", m.kind,
          m.status, m.content, m.confidence, m.provenance_json AS "provenanceJson",
          m.contradiction_of AS "contradictionOf", m.expires_at AS "expiresAt",
          m.created_at AS "createdAt", m.updated_at AS "updatedAt"
        FROM command_center_memories m
        JOIN command_center_spaces s ON s.id = m.space_id AND s.lifecycle = 'active'
        WHERE m.status IN ('approved', 'candidate', 'archive')
        ORDER BY m.updated_at DESC
        LIMIT 200
      `;
      return yield* Effect.forEach(rows, decodeMemoryRow);
    });

    const listAllMemories = Effect.fn("CommandCenter.listAllMemories")(function* (
      spaceId?: string,
    ) {
      const rows = yield* sql<MemoryRow>`
        SELECT m.id, m.space_id AS "spaceId", m.repository_ref AS "repositoryRef", m.kind,
          m.status, m.content, m.confidence, m.provenance_json AS "provenanceJson",
          m.contradiction_of AS "contradictionOf", m.expires_at AS "expiresAt",
          m.created_at AS "createdAt", m.updated_at AS "updatedAt"
        FROM command_center_memories m
        JOIN command_center_spaces s ON s.id = m.space_id AND s.lifecycle = 'active'
        WHERE ${spaceId ?? null} IS NULL OR m.space_id = ${spaceId ?? null}
        ORDER BY m.updated_at DESC
        LIMIT 500
      `;
      return yield* Effect.forEach(rows, decodeMemoryRow);
    });

    const listAutomations = Effect.fn("CommandCenter.listAutomations")(function* () {
      const rows = yield* sql<AutomationRow>`
        SELECT a.id, a.enabled, a.commit_sha AS "commitSha",
          a.definition_digest AS "definitionDigest", a.definition_json AS "definitionJson"
        FROM command_center_automations a
        JOIN command_center_spaces s ON s.id = a.space_id AND s.lifecycle = 'active'
        ORDER BY a.name COLLATE NOCASE
      `;
      return yield* Effect.forEach(rows, (row) =>
        parseJson(row.definitionJson, "Automation definition").pipe(
          Effect.flatMap((definition) =>
            decodeAutomation({
              ...(typeof definition === "object" && definition !== null ? definition : {}),
              id: row.id,
              enabled: row.enabled === 1,
              configCommit: row.commitSha,
              definitionDigest: row.definitionDigest,
            }),
          ),
          Effect.mapError((cause) => persistenceError("Stored Automation is invalid.", cause)),
        ),
      );
    });

    const appendAudit = auditLog.append;

    const recordAutomationDefinitionCommit = Effect.fn(
      "CommandCenter.recordAutomationDefinitionCommit",
    )(
      function* (input: {
        readonly operation: "created" | "updated";
        readonly requestId?: string;
        readonly automationId: string;
        readonly spaceId: string;
        readonly previousConfigCommitSha: string;
        readonly configCommitSha: string;
        readonly previousDefinitionDigest: string | null;
        readonly definitionDigest: string;
        readonly actor?: {
          readonly kind: "agent";
          readonly threadId: string;
          readonly providerSessionId: string;
          readonly providerInstanceId: string;
        };
      }) {
        yield* requireConfiguredSpace(input.spaceId);
        const actorRun =
          input.actor === undefined
            ? undefined
            : (yield* sql<{ readonly id: string }>`
                  SELECT id
                  FROM command_center_runs
                  WHERE thread_id = ${input.actor.threadId}
                    AND space_id = ${input.spaceId}
                    AND state = 'running'
                  LIMIT 1
                `)[0];
        if (input.actor !== undefined && actorRun === undefined) {
          return yield* new CommandCenterError({
            reason: "validation",
            message:
              "The automation authoring session is not bound to an active Run in this Space.",
          });
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql.withTransaction(
          appendAudit({
            eventId: `automation-definition:${input.configCommitSha}`,
            actorKind: input.actor?.kind ?? "user",
            action: "cc.automations.definition.committed",
            spaceId: input.spaceId,
            ...(actorRun === undefined ? {} : { runId: actorRun.id }),
            payload: {
              operation: input.operation,
              ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
              automationId: input.automationId,
              previousConfigCommitSha: input.previousConfigCommitSha,
              configCommitSha: input.configCommitSha,
              previousDefinitionDigest: input.previousDefinitionDigest,
              definitionDigest: input.definitionDigest,
              pushed: false,
              ...(input.actor === undefined
                ? {}
                : {
                    source: {
                      kind: "mcp",
                      threadId: input.actor.threadId,
                      providerSessionId: input.actor.providerSessionId,
                      providerInstanceId: input.actor.providerInstanceId,
                    },
                  }),
            },
            occurredAt: now,
          }),
        );
      },
      Effect.mapError((cause) =>
        isCommandCenterError(cause)
          ? cause
          : persistenceError("Could not audit the local automation config commit.", cause),
      ),
    );

    const expireApprovals = Effect.fn("CommandCenter.expireApprovals")(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const expired = yield* sql<ApprovalRow>`
        SELECT a.id, a.item_id AS "itemId", a.run_id AS "runId", r.space_id AS "spaceId",
          a.action_kind AS "actionKind", a.risk, a.payload_digest AS "payloadDigest",
          a.payload_json AS "payloadJson", a.status, a.idempotency_key AS "idempotencyKey",
          a.requested_at AS "requestedAt", a.expires_at AS "expiresAt",
          a.decided_at AS "decidedAt", a.decision_note AS "decisionNote"
        FROM command_center_approvals a
        JOIN command_center_runs r ON r.id = a.run_id
        JOIN command_center_spaces s ON s.id = r.space_id AND s.lifecycle = 'active'
        WHERE a.status = 'requested' AND a.expires_at IS NOT NULL AND a.expires_at <= ${now}
      `;
      for (const approval of expired) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const claimed = yield* sql<{ readonly id: string }>`
              UPDATE command_center_approvals
              SET status = 'expired', decided_at = ${now}
              WHERE id = ${approval.id} AND status = 'requested'
              RETURNING id
            `;
            // Another expiry (or a decision) already settled this approval;
            // its audit events exist and must not be written again.
            if (claimed.length === 0) return;
            if (approval.runId !== null) {
              yield* sql`
                UPDATE command_center_runs
                SET state = 'canceled', finished_at = ${now}
                WHERE id = ${approval.runId} AND state = 'waiting_approval'
              `;
            }
            if (approval.itemId !== null) {
              yield* sql`
                UPDATE command_center_items
                SET status = 'canceled', updated_at = ${now}
                WHERE id = ${approval.itemId} AND status = 'waiting'
              `;
            }
            yield* appendAudit({
              actorKind: "system",
              action: "cc.approvals.expire",
              spaceId: approval.spaceId,
              ...(approval.runId === null ? {} : { runId: approval.runId }),
              payload: {
                approvalId: approval.id,
                payloadDigest: approval.payloadDigest,
              },
              occurredAt: now,
            });
            if (approval.runId !== null) {
              yield* appendAudit({
                eventId: `approval:${approval.id}:run-expired`,
                actorKind: "system",
                action: "cc.runs.state",
                spaceId: approval.spaceId,
                runId: approval.runId,
                payload: {
                  status: "canceled",
                  previousStatus: "waiting_approval",
                },
                occurredAt: now,
              });
            }
            if (approval.itemId !== null) {
              yield* appendAudit({
                eventId: `approval:${approval.id}:item-expired`,
                actorKind: "system",
                action: "cc.items.changed",
                spaceId: approval.spaceId,
                ...(approval.runId === null ? {} : { runId: approval.runId }),
                payload: {
                  itemId: approval.itemId,
                  change: "updated",
                  kind: "approval",
                  status: "canceled",
                },
                occurredAt: now,
              });
            }
          }),
        );
      }
    });

    const bootstrap = Effect.gen(function* () {
      const loaded = yield* syncConfig(false);
      yield* expireApprovals();
      const [spaces, items, runs, approvals, automations, connections, memories] =
        yield* Effect.all(
          [
            listSpaces(),
            listItems(),
            listRuns(),
            listApprovals(),
            listAutomations(),
            listConnections(),
            listMemories(),
          ],
          { concurrency: 4 },
        );
      const needsYou = items
        .filter(itemNeedsYou)
        .sort(
          (left, right) =>
            priorityRank(right.priority) - priorityRank(left.priority) ||
            right.updatedAt.localeCompare(left.updatedAt),
        );
      return {
        timezone: loaded.timezone,
        spaces,
        items,
        needsYou,
        runs,
        approvals,
        automations,
        connections,
        memories,
        configHealth: loaded.health,
      } satisfies CommandCenterBootstrap;
    }).pipe(Effect.mapError((cause) => persistenceError("Could not load Command Center.", cause)));

    const takeLimit = <A>(values: ReadonlyArray<A>, limit: number | undefined) =>
      values.slice(0, limit ?? values.length);
    const isIncluded = <A>(value: A, values: ReadonlyArray<A> | undefined) =>
      values === undefined || values.includes(value);

    const querySpaces = Effect.fn("CommandCenter.querySpaces")(function* (
      input: CommandCenterSpacesQueryInput,
    ) {
      const snapshot = yield* bootstrap;
      return {
        spaces: snapshot.spaces.filter(
          (space) => input.spaceId === undefined || space.id === input.spaceId,
        ),
      };
    });

    const queryItems = Effect.fn("CommandCenter.queryItems")(
      function* (input: CommandCenterItemsQueryInput) {
        yield* bootstrap;
        const items = yield* listAllItems();
        return {
          items: takeLimit(
            items.filter(
              (item) =>
                (input.spaceId === undefined || item.spaceId === input.spaceId) &&
                isIncluded(item.status, input.statuses),
            ),
            input.limit,
          ),
        };
      },
      Effect.mapError((cause) =>
        isCommandCenterError(cause) ? cause : persistenceError("Could not query Items.", cause),
      ),
    );

    const queryRuns = Effect.fn("CommandCenter.queryRuns")(function* (
      input: CommandCenterRunsQueryInput,
    ) {
      const snapshot = yield* bootstrap;
      return {
        runs: takeLimit(
          snapshot.runs.filter(
            (run) =>
              (input.spaceId === undefined || run.spaceId === input.spaceId) &&
              isIncluded(run.status, input.statuses),
          ),
          input.limit,
        ),
      };
    });

    const queryAutomations = Effect.fn("CommandCenter.queryAutomations")(function* (
      input: CommandCenterAutomationsQueryInput,
    ) {
      const snapshot = yield* bootstrap;
      return {
        automations: takeLimit(
          snapshot.automations.filter(
            (automation) =>
              (input.spaceId === undefined || automation.spaceId === input.spaceId) &&
              (input.enabled === undefined || automation.enabled === input.enabled),
          ),
          input.limit,
        ),
      };
    });

    const queryApprovals = Effect.fn("CommandCenter.queryApprovals")(function* (
      input: CommandCenterApprovalsQueryInput,
    ) {
      const snapshot = yield* bootstrap;
      return {
        approvals: takeLimit(
          snapshot.approvals.filter(
            (approval) =>
              (input.spaceId === undefined || approval.spaceId === input.spaceId) &&
              isIncluded(approval.status, input.statuses),
          ),
          input.limit,
        ),
      };
    });

    const queryArtifacts = Effect.fn("CommandCenter.queryArtifacts")(
      function* (input: CommandCenterArtifactsQueryInput) {
        yield* syncConfig(false);
        const rows = yield* sql<ArtifactRow>`
          SELECT a.id, a.space_id AS "spaceId", a.run_id AS "runId", a.kind, a.title, a.uri,
            a.content_digest AS "contentDigest", a.provenance_json AS "provenanceJson",
            a.metadata_json AS "metadataJson", a.created_at AS "createdAt"
          FROM command_center_artifacts a
          JOIN command_center_spaces s ON s.id = a.space_id AND s.lifecycle = 'active'
          WHERE a.space_id = ${input.spaceId}
          ORDER BY a.created_at DESC
          LIMIT 500
        `;
        const artifacts = yield* Effect.forEach(rows, decodeArtifactRow);
        return {
          artifacts: takeLimit(
            artifacts.filter(
              (artifact) =>
                (input.runId === undefined || artifact.runId === input.runId) &&
                isIncluded(artifact.kind, input.kinds),
            ),
            input.limit,
          ),
        };
      },
      Effect.mapError((cause) =>
        isCommandCenterError(cause) ? cause : persistenceError("Could not query Artifacts.", cause),
      ),
    );

    const getArtifactsByIds = Effect.fn("CommandCenter.getArtifactsByIds")(
      function* (input: {
        readonly spaceId: CommandCenterArtifactsQueryInput["spaceId"];
        readonly artifactIds: ReadonlyArray<string>;
      }) {
        yield* syncConfig(false);
        const artifactIds = [...new Set(input.artifactIds)];
        if (artifactIds.length === 0) return { artifacts: [] };
        const rows = yield* sql<ArtifactRow>`
          SELECT a.id, a.space_id AS "spaceId", a.run_id AS "runId", a.kind, a.title, a.uri,
            a.content_digest AS "contentDigest", a.provenance_json AS "provenanceJson",
            a.metadata_json AS "metadataJson", a.created_at AS "createdAt"
          FROM command_center_artifacts a
          JOIN command_center_spaces s ON s.id = a.space_id AND s.lifecycle = 'active'
          WHERE a.space_id = ${input.spaceId}
            AND ${sql.in("a.id", artifactIds)}
        `;
        return { artifacts: yield* Effect.forEach(rows, decodeArtifactRow) };
      },
      Effect.mapError((cause) =>
        isCommandCenterError(cause) ? cause : persistenceError("Could not load Artifacts.", cause),
      ),
    );

    const queryConnections = Effect.fn("CommandCenter.queryConnections")(function* (
      input: CommandCenterConnectionsQueryInput,
    ) {
      const snapshot = yield* bootstrap;
      return {
        connections: takeLimit(
          snapshot.connections.filter(
            (connection) =>
              (input.spaceId === undefined || connection.spaceId === input.spaceId) &&
              (input.healthyOnly !== true || connection.health === "connected"),
          ),
          input.limit,
        ),
      };
    });

    const queryMemories = Effect.fn("CommandCenter.queryMemories")(
      function* (input: CommandCenterMemoryQueryInput) {
        yield* bootstrap;
        const memories = yield* listAllMemories(input.spaceId);
        const now = DateTime.formatIso(yield* DateTime.now);
        return {
          memories: takeLimit(
            memories.filter(
              (memory) =>
                (input.spaceId === undefined || memory.spaceId === input.spaceId) &&
                (input.repositoryId === undefined || memory.repositoryId === input.repositoryId) &&
                (input.statuses === undefined
                  ? memory.status === "approved" &&
                    (memory.expiresAt === undefined || memory.expiresAt > now)
                  : isIncluded(memory.status, input.statuses)),
            ),
            input.limit,
          ),
        };
      },
      Effect.mapError((cause) =>
        isCommandCenterError(cause) ? cause : persistenceError("Could not query Memory.", cause),
      ),
    );

    const getAutomationApprovalBinding = Effect.fn("CommandCenter.getAutomationApprovalBinding")(
      function* (approvalId: string) {
        yield* syncConfig(false);
        yield* expireApprovals();
        const rows = yield* sql<{
          readonly id: string;
          readonly spaceId: string;
          readonly status: ApprovalType["status"];
          readonly payloadDigest: string;
          readonly payloadJson: string;
        }>`
        SELECT a.id, r.space_id AS "spaceId", a.status,
          a.payload_digest AS "payloadDigest", a.payload_json AS "payloadJson"
        FROM command_center_approvals a
        JOIN command_center_runs r ON r.id = a.run_id
        JOIN command_center_spaces s ON s.id = r.space_id AND s.lifecycle = 'active'
        WHERE a.id = ${approvalId}
        LIMIT 1
        `;
        const row = rows[0];
        if (row === undefined) return null;
        if ((yield* digest(row.payloadJson)) !== row.payloadDigest) {
          return yield* new CommandCenterError({
            reason: "conflict",
            message: "The stored automation Approval payload no longer matches its digest.",
          });
        }
        const payload = yield* parseJson(row.payloadJson, "Approval payload");
        if (
          typeof payload !== "object" ||
          payload === null ||
          !("kind" in payload) ||
          payload.kind !== "automation-checkpoint"
        ) {
          return null;
        }
        const decoded = yield* decodeAutomationApprovalPayload(payload).pipe(
          Effect.mapError((cause) =>
            persistenceError("Stored automation Approval binding is invalid.", cause),
          ),
        );
        return {
          approvalId: row.id,
          spaceId: row.spaceId,
          status: row.status,
          executionId: decoded.executionId,
          automationId: decoded.automationId,
          nodeId: decoded.nodeId,
          approvalKey: decoded.approvalKey,
          configCommitSha: decoded.configCommitSha,
          definitionDigest: decoded.definitionDigest,
          payloadDigest: row.payloadDigest,
        } satisfies AutomationApprovalBinding;
      },
      Effect.mapError((cause) =>
        isCommandCenterError(cause)
          ? cause
          : persistenceError("Could not load the automation Approval binding.", cause),
      ),
    );

    const ensureAutomationApproval = Effect.fn("CommandCenter.ensureAutomationApproval")(
      function* (input: EnsureAutomationApprovalInput) {
        yield* requireConfiguredSpace(input.spaceId);
        const runRows = yield* sql<{
          readonly id: string;
          readonly spaceId: string;
          readonly state: string;
        }>`
          SELECT id, space_id AS "spaceId", state
          FROM command_center_runs
          WHERE id = ${input.executionId}
          LIMIT 1
        `;
        const run = runRows[0];
        if (run === undefined || run.spaceId !== input.spaceId) {
          return yield* persistenceError(
            "The automation Approval cannot be linked to its canonical Run.",
          );
        }
        if (run.state !== "waiting_approval") {
          return yield* new CommandCenterError({
            reason: "conflict",
            message: "The automation Run is no longer waiting for this Approval.",
          });
        }

        const nowDateTime = yield* DateTime.now;
        const now = DateTime.formatIso(nowDateTime);
        const expiresAt = DateTime.formatIso(
          DateTime.add(nowDateTime, { hours: APPROVAL_TTL_HOURS }),
        );
        const approvalId = `automation-approval:${input.executionId}:${input.nodeId}`;
        const itemId = `automation-approval-item:${input.executionId}:${input.nodeId}`;
        const idempotencyKey = [
          "automation-approval",
          input.executionId,
          input.nodeId,
          input.definitionDigest,
        ].join(":");
        const payload = {
          kind: "automation-checkpoint" as const,
          summary: `Approve automation '${input.automationId}' checkpoint '${input.nodeId}'`,
          proposal: [
            `Automation: ${input.automationId}`,
            `Execution: ${input.executionId}`,
            `Node: ${input.nodeId} (${input.nodeKind})`,
            `Config commit: ${input.configCommitSha}`,
            `Definition digest: ${input.definitionDigest}`,
            `Checkpoint key: ${input.approvalKey}`,
          ].join("\n"),
          executionId: input.executionId,
          automationId: input.automationId,
          nodeId: input.nodeId,
          nodeKind: input.nodeKind,
          approvalKey: input.approvalKey,
          configCommitSha: input.configCommitSha,
          definitionDigest: input.definitionDigest,
        };
        const payloadJson = stringify(payload);
        const payloadDigest = yield* digest(payloadJson);

        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO command_center_items (
                id, space_id, kind, status, title, body, priority,
                source_json, metadata_json, created_at, updated_at
              ) VALUES (
                ${itemId}, ${input.spaceId}, 'approval', 'waiting', ${payload.summary},
                ${payload.proposal}, 'urgent',
                ${stringify({ kind: "automation", sourceRef: input.executionId, capturedAt: now })},
                ${stringify({
                  type: "automation-checkpoint-approval",
                  executionId: input.executionId,
                  automationId: input.automationId,
                  nodeId: input.nodeId,
                  configCommitSha: input.configCommitSha,
                  definitionDigest: input.definitionDigest,
                })},
                ${now}, ${now}
              )
              ON CONFLICT(id) DO NOTHING
            `;
            yield* sql`
              INSERT INTO command_center_approvals (
                id, item_id, run_id, action_kind, risk, payload_digest, payload_json,
                status, idempotency_key, requested_at, expires_at
              ) VALUES (
                ${approvalId}, ${itemId}, ${input.executionId}, 'automation.run',
                'approval-required', ${payloadDigest}, ${payloadJson}, 'requested',
                ${idempotencyKey}, ${now}, ${expiresAt}
              )
              ON CONFLICT(idempotency_key) DO NOTHING
            `;
            // Re-projecting a waiting checkpoint (a retry or a restart) must
            // replay the original audit events exactly, so they carry the
            // durable times of the first projection rather than this call's.
            const projected = yield* sql<{
              readonly id: string;
              readonly runId: string | null;
              readonly payloadDigest: string;
              readonly payloadJson: string;
              readonly requestedAt: string;
              readonly itemCreatedAt: string;
            }>`
              SELECT a.id, a.run_id AS "runId", a.payload_digest AS "payloadDigest",
                a.payload_json AS "payloadJson", a.requested_at AS "requestedAt",
                i.created_at AS "itemCreatedAt"
              FROM command_center_approvals a
              JOIN command_center_items i ON i.id = ${itemId}
              WHERE a.idempotency_key = ${idempotencyKey}
              LIMIT 1
            `;
            const firstProjection = projected[0];
            if (firstProjection === undefined) {
              return yield* persistenceError("The automation Approval was not projected.");
            }
            // Check the binding before auditing: a key bound to different
            // work must not leave audit events behind.
            if (
              firstProjection.id !== approvalId ||
              firstProjection.runId !== input.executionId ||
              firstProjection.payloadDigest !== payloadDigest ||
              firstProjection.payloadJson !== payloadJson
            ) {
              return yield* new CommandCenterError({
                reason: "conflict",
                message: "The automation Approval key is already bound to different work.",
              });
            }
            yield* appendAudit({
              eventId: `approval:${approvalId}:requested`,
              actorKind: "automation",
              action: "cc.approvals.changed",
              spaceId: input.spaceId,
              runId: input.executionId,
              payload: { approvalId, status: "requested", payloadDigest },
              occurredAt: firstProjection.requestedAt,
            });
            yield* appendAudit({
              eventId: `approval-item:${itemId}:created`,
              actorKind: "automation",
              action: "cc.items.changed",
              spaceId: input.spaceId,
              runId: input.executionId,
              payload: { itemId, change: "created", kind: "approval" },
              occurredAt: firstProjection.itemCreatedAt,
            });
          }),
        );

        const rows = yield* sql<ApprovalRow>`
          SELECT a.id, a.item_id AS "itemId", a.run_id AS "runId", r.space_id AS "spaceId",
            a.action_kind AS "actionKind", a.risk, a.payload_digest AS "payloadDigest",
            a.payload_json AS "payloadJson", a.status, a.idempotency_key AS "idempotencyKey",
            a.requested_at AS "requestedAt", a.expires_at AS "expiresAt",
            a.decided_at AS "decidedAt", a.decision_note AS "decisionNote"
          FROM command_center_approvals a
          JOIN command_center_runs r ON r.id = a.run_id
          WHERE a.idempotency_key = ${idempotencyKey}
          LIMIT 1
        `;
        const row = rows[0];
        if (
          row === undefined ||
          row.id !== approvalId ||
          row.runId !== input.executionId ||
          row.payloadDigest !== payloadDigest ||
          row.payloadJson !== payloadJson
        ) {
          return yield* new CommandCenterError({
            reason: "conflict",
            message: "The automation Approval key is already bound to different work.",
          });
        }
        return yield* decodeApprovalRow(row);
      },
      Effect.mapError((cause) =>
        isCommandCenterError(cause)
          ? cause
          : persistenceError("Could not project the automation Approval.", cause),
      ),
    );

    const recordAutomationEvent = Effect.fn("CommandCenter.recordAutomationEvent")(
      function* (input: Parameters<CommandCenterServiceShape["recordAutomationEvent"]>[0]) {
        yield* requireConfiguredSpace(input.spaceId);
        const state = canonicalAutomationRunState(input.state);
        // One audit event per runtime transition. The key binds the durable
        // snapshot time, the terminal fields and every node's progress; the
        // payload repeats them, so a replay of this exact transition is
        // idempotent while any other content under the same key is still
        // rejected by the audit guard.
        const checkpoints = [...input.checkpoints].toSorted((left, right) =>
          left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0,
        );
        const transitionKey = yield* digest(
          stringify({
            updatedAt: input.updatedAt,
            finishedAt: input.finishedAt,
            error: input.error ?? null,
            checkpoints: checkpoints.map(({ nodeId, state, attemptCount, resolutionKey }) => [
              nodeId,
              state,
              attemptCount,
              resolutionKey,
            ]),
          }),
        );
        const route = {
          automationId: input.automationId,
          actionKind: "automation.run",
          configCommitSha: input.configCommitSha,
          definitionDigest: input.definitionDigest,
        };
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            // The canonical Run row must exist before its audit events (they
            // reference it). Creating it is never a regression; updating it
            // is guarded below.
            yield* sql`
              INSERT INTO command_center_runs (
                id, command_id, space_id, kind, state, route_json, input_json,
                result_json, error, started_at, finished_at
              ) VALUES (
                ${input.executionId}, ${`automation:${input.executionId}`}, ${input.spaceId},
                'automation', ${state}, ${stringify(route)}, ${stringify(input.input)},
                ${input.output === null ? null : stringify(input.output)}, ${input.error ?? null},
                ${input.createdAt}, ${input.finishedAt}
              )
              ON CONFLICT(id) DO NOTHING
            `;
            // Audit history is append-only and keyed per transition: every
            // observed transition is appended (an exact replay is a no-op).
            yield* appendAudit({
              eventId: `automation-execution:${input.executionId}:${input.state}:${transitionKey}`,
              actorKind: "automation",
              action: "cc.automations.run.changed",
              spaceId: input.spaceId,
              runId: input.executionId,
              payload: { ...input, checkpoints },
              occurredAt: input.updatedAt,
            });
            // The canonical Run projects only the current runtime row. A
            // snapshot taken before a newer write (a slow replay, a concurrent
            // resume, a status poll, even in the same millisecond) must not
            // move it backwards; whoever holds the current row records it.
            const runtimeRows = yield* sql<{
              readonly state: string;
              readonly updatedAt: string;
              readonly finishedAt: string | null;
              readonly error: string | null;
            }>`
              SELECT state, updated_at AS "updatedAt", finished_at AS "finishedAt", error
              FROM command_center_automation_executions
              WHERE id = ${input.executionId}
              LIMIT 1
            `;
            const current = runtimeRows[0];
            if (
              current !== undefined &&
              (current.state !== input.state ||
                current.updatedAt !== input.updatedAt ||
                current.finishedAt !== input.finishedAt ||
                current.error !== (input.error ?? null))
            ) {
              return { projected: false };
            }
            yield* sql`
              UPDATE command_center_runs
              SET state = ${state},
                result_json = ${input.output === null ? null : stringify(input.output)},
                error = ${input.error ?? null},
                finished_at = ${input.finishedAt}
              WHERE id = ${input.executionId}
            `;
            return { projected: true };
          }),
        );
      },
      Effect.mapError((cause) =>
        isCommandCenterError(cause)
          ? cause
          : persistenceError("Could not record automation execution event.", cause),
      ),
    );

    const submitCommand = Effect.fn("CommandCenter.submitCommand")(
      function* (
        input: CommandCenterCommandSubmitInput,
        providers: ReadonlyArray<ProviderAvailability>,
      ) {
        const loaded = yield* syncConfig(false);
        if (loaded.health.status !== "loaded") {
          return yield* new CommandCenterError({
            reason: "config",
            message: "Private Command Center configuration is unavailable; commands are disabled.",
          });
        }
        if (loaded.spaces.length === 0) {
          return yield* routingError("No Spaces are configured.");
        }
        const requestJson = stringify(input);
        const requestDigest = yield* digest(requestJson);
        const receipts = yield* sql<{
          readonly requestDigest: string;
          readonly responseJson: string;
        }>`
        SELECT request_digest AS "requestDigest", response_json AS "responseJson"
        FROM command_center_command_receipts
        WHERE command_id = ${input.commandId}
      `;
        const receipt = receipts[0];
        if (receipt !== undefined) {
          if (receipt.requestDigest !== requestDigest) {
            return yield* new CommandCenterError({
              reason: "conflict",
              message: "The command id was already used with different input.",
            });
          }
          const existing = yield* parseJson(receipt.responseJson, "command receipt").pipe(
            Effect.flatMap(decodeSubmitResult),
            Effect.mapError((cause) =>
              persistenceError("Stored command receipt is invalid.", cause),
            ),
          );
          if (!loaded.spaces.some((space) => space.id === existing.route.spaceId)) {
            return yield* new CommandCenterError({
              reason: "not_found",
              message: "The command receipt belongs to a Space that is no longer configured.",
            });
          }
          const currentRun = yield* hydrateCommandReceiptRun(existing, input.commandId);
          return { ...existing, run: currentRun, duplicate: true };
        }
        const inferredSpace = inferSpace(input.text, loaded.spaces);
        const capabilitySpace = inferCapabilitySpace(
          inferClassifier(input.text, undefined),
          loaded.spaces,
        );
        const defaultSpace =
          loaded.spaces.find((space) => space.kind === "system") ?? loaded.spaces[0];
        const selectedSpaceId =
          input.spaceId ?? inferredSpace?.id ?? capabilitySpace?.id ?? defaultSpace?.id;
        if (selectedSpaceId === undefined) {
          return yield* routingError("No Space could be selected.");
        }
        const selectedSpace = loaded.spaces.find((space) => space.id === selectedSpaceId);
        if (selectedSpace === undefined) {
          return yield* new CommandCenterError({
            reason: "not_found",
            message: `Space '${selectedSpaceId}' was not found.`,
          });
        }

        if (
          input.repositoryId !== undefined &&
          !selectedSpace.repositories.some((repository) => repository.id === input.repositoryId)
        ) {
          return yield* new CommandCenterError({
            reason: "validation",
            message: "The selected repository is not bound to the selected Space.",
          });
        }

        const inferredRepository = inferPrimaryRepository(input.text, selectedSpace);
        const classifier = {
          ...inferClassifier(input.text, selectedSpace.id),
          ...(inferredRepository === undefined ? {} : { repositoryId: inferredRepository.id }),
        };
        const resolvedRoute = resolveRoute({
          command: input,
          policy: selectedSpace.modelDefaults,
          classifier,
          providers,
        });
        const requiredGoogleCapability =
          classifier.intent === "google" && classifier.capabilities.length === 1
            ? classifier.capabilities[0]
            : undefined;
        const googleConnectionUnavailableReason =
          requiredGoogleCapability !== undefined
            ? yield* Effect.gen(function* () {
                const assignedConnectionIds = new Set(selectedSpace.connectionIds);
                const enabledConnections = loaded.connections.filter(
                  (connection) =>
                    connection.spaceId === selectedSpace.id &&
                    connection.kind === "google" &&
                    assignedConnectionIds.has(connection.id) &&
                    connection.capabilities.includes(requiredGoogleCapability),
                );
                if (enabledConnections.length === 0) {
                  return selectedSpace.connectionIds.length === 0
                    ? "No read-only Google connection is configured for the selected Space"
                    : "The selected Space's read-only Google connection is disabled";
                }

                const enabledIds = new Set(enabledConnections.map((connection) => connection.id));
                const runtimeConnections = yield* listConnections();
                const healthy = runtimeConnections.some(
                  (connection) =>
                    connection.spaceId === selectedSpace.id &&
                    connection.kind === "google" &&
                    enabledIds.has(connection.id) &&
                    connection.health === "connected" &&
                    connection.capabilities.includes(requiredGoogleCapability),
                );
                return healthy
                  ? undefined
                  : "The selected Space's read-only Google connection is unavailable";
              })
            : undefined;
        const disallowedCapabilities = resolvedRoute.capabilities.filter(
          (capability) => !selectedSpace.policy.allowedCapabilities.includes(capability),
        );
        const policyRequiresApproval =
          (resolvedRoute.risk === "low" || resolvedRoute.risk === "reversible") &&
          !selectedSpace.policy.autoRunRiskLevels.includes(resolvedRoute.risk);
        const protectedExecutorUnavailable =
          resolvedRoute.risk === "approval-required" && resolvedRoute.status !== "blocked";
        const route: RouteDecisionType =
          classifier.intent === "google" && requiredGoogleCapability === undefined
            ? {
                ...resolvedRoute,
                status: "blocked",
                approvalRequired: false,
                capabilities: [],
                reasons: [
                  ...resolvedRoute.reasons.filter(
                    (reason) => reason !== "The requested action is blocked by policy",
                  ),
                  "Specify Gmail, Calendar, or Drive before using a Google connection",
                ],
              }
            : googleConnectionUnavailableReason !== undefined
              ? {
                  ...resolvedRoute,
                  status: "blocked",
                  approvalRequired: false,
                  // A configured assignment is routing metadata, not a grant.
                  // No connector capability enters the Run while its Connection
                  // is disabled or unhealthy.
                  capabilities: [],
                  reasons: [...resolvedRoute.reasons, googleConnectionUnavailableReason],
                }
              : protectedExecutorUnavailable
                ? {
                    ...resolvedRoute,
                    status: "blocked",
                    approvalRequired: false,
                    capabilities: [],
                    reasons: [
                      ...resolvedRoute.reasons,
                      "No narrow server-mediated executor is available for this protected action in v1",
                    ],
                  }
                : disallowedCapabilities.length > 0
                  ? {
                      ...resolvedRoute,
                      status: "blocked",
                      approvalRequired: false,
                      reasons: [
                        ...resolvedRoute.reasons,
                        "A required capability is not allowed by the selected Space policy",
                      ],
                    }
                  : policyRequiresApproval && resolvedRoute.status !== "blocked"
                    ? {
                        ...resolvedRoute,
                        status: "approval-required",
                        approvalRequired: true,
                        reasons: [
                          ...resolvedRoute.reasons,
                          "The selected Space policy requires approval for this risk level",
                        ],
                      }
                    : resolvedRoute;
        const nowDateTime = yield* DateTime.now;
        const now = DateTime.formatIso(nowDateTime);
        const approvalExpiresAt = DateTime.formatIso(
          DateTime.add(nowDateTime, { hours: APPROVAL_TTL_HOURS }),
        );
        const runId = yield* crypto.randomUUIDv4;
        const state: RunType["status"] =
          route.status === "blocked"
            ? "failed"
            : route.approvalRequired
              ? "waiting_approval"
              : "queued";
        const run = yield* decodeRun({
          id: runId,
          spaceId: selectedSpace.id,
          kind: classifier.intent === "automation" ? "automation" : "agent",
          status: state,
          commandId: input.commandId,
          repositoryId: route.repositoryId ?? undefined,
          projectId: route.projectId ?? undefined,
          providerId: route.providerId ?? undefined,
          modelId: route.modelId ?? undefined,
          artifactIds: [],
          createdAt: now,
          finishedAt: state === "failed" ? now : undefined,
        }).pipe(
          Effect.mapError((cause) => routingError("Could not create the routed Run.", cause)),
        );

        const result = {
          run,
          route,
          duplicate: false,
        } satisfies CommandCenterCommandSubmitResultType;

        yield* sql.withTransaction(
          Effect.gen(function* () {
            let requestedApproval:
              | {
                  readonly approvalId: string;
                  readonly itemId: string;
                  readonly payloadDigest: string;
                }
              | undefined;
            let blockedItemId: string | undefined;
            yield* sql`
            INSERT INTO command_center_runs (
              id, command_id, space_id, project_id, kind, state, route_json, input_json,
              error, started_at, finished_at
            ) VALUES (
              ${run.id}, ${input.commandId}, ${selectedSpace.id}, ${route.projectId}, ${run.kind},
              ${state}, ${stringify(route)}, ${requestJson},
              ${state === "failed" ? route.reasons.join("; ") : null}, ${now},
              ${state === "failed" ? now : null}
            )
          `;

            if (route.approvalRequired) {
              const approvalId = yield* crypto.randomUUIDv4;
              const itemId = yield* crypto.randomUUIDv4;
              const approvalPayload = makeCommandApprovalPayload({
                command: input,
                route,
              });
              const payloadJson = stringify(approvalPayload);
              const payloadDigest = yield* digest(payloadJson);
              const provenance = {
                kind: "agent",
                sourceRef: run.id,
                capturedAt: now,
              };
              yield* sql`
              INSERT INTO command_center_items (
                id, space_id, kind, status, title, body, priority,
                source_json, created_at, updated_at
              ) VALUES (
                ${itemId}, ${selectedSpace.id}, 'approval', 'waiting',
                ${approvalPayload.summary}, ${approvalPayload.proposal}, 'urgent',
                ${stringify(provenance)}, ${now}, ${now}
              )
            `;
              yield* sql`
              INSERT INTO command_center_approvals (
                id, item_id, run_id, action_kind, risk, payload_digest, payload_json,
                status, idempotency_key, requested_at, expires_at
              ) VALUES (
                ${approvalId}, ${itemId}, ${run.id}, ${route.actionKind}, ${route.risk},
                ${payloadDigest}, ${payloadJson}, 'requested',
                ${`approval:${input.commandId}`}, ${now}, ${approvalExpiresAt}
              )
            `;
              requestedApproval = { approvalId, itemId, payloadDigest };
            }

            if (route.status === "blocked") {
              blockedItemId = `blocked-route:${run.id}`;
              yield* sql`
                INSERT INTO command_center_items (
                  id, space_id, kind, status, title, body, priority,
                  source_json, metadata_json, created_at, updated_at
                ) VALUES (
                  ${blockedItemId}, ${selectedSpace.id}, 'alert', 'review',
                  'Command was blocked by policy', ${route.reasons.join("\n")}, 'high',
                  ${stringify({ kind: "agent", sourceRef: run.id, capturedAt: now })},
                  ${stringify({ type: "blocked-route", runId: run.id, actionKind: route.actionKind })},
                  ${now}, ${now}
                )
              `;
            }

            yield* appendAudit({
              actorKind: "user",
              action: "cc.command.submit",
              spaceId: selectedSpace.id,
              runId: run.id,
              payload: { commandId: input.commandId, route, state },
              occurredAt: now,
            });
            if (requestedApproval !== undefined) {
              yield* appendAudit({
                eventId: `approval:${requestedApproval.approvalId}:requested`,
                actorKind: "system",
                action: "cc.approvals.changed",
                spaceId: selectedSpace.id,
                runId: run.id,
                payload: {
                  approvalId: requestedApproval.approvalId,
                  status: "requested",
                  payloadDigest: requestedApproval.payloadDigest,
                },
                occurredAt: now,
              });
              yield* appendAudit({
                eventId: `approval-item:${requestedApproval.itemId}:created`,
                actorKind: "system",
                action: "cc.items.changed",
                spaceId: selectedSpace.id,
                runId: run.id,
                payload: {
                  itemId: requestedApproval.itemId,
                  change: "created",
                  kind: "approval",
                  status: "waiting",
                },
                occurredAt: now,
              });
            }
            if (blockedItemId !== undefined) {
              yield* appendAudit({
                eventId: `blocked-route:${run.id}:failure`,
                actorKind: "system",
                action: "cc.failures.recorded",
                spaceId: selectedSpace.id,
                runId: run.id,
                payload: {
                  scope: "command",
                  reason: "route-blocked",
                  message: "The command route was blocked by policy.",
                  retryable: false,
                },
                occurredAt: now,
              });
              yield* appendAudit({
                eventId: `blocked-route:${run.id}:item`,
                actorKind: "system",
                action: "cc.items.changed",
                spaceId: selectedSpace.id,
                runId: run.id,
                payload: {
                  itemId: blockedItemId,
                  change: "created",
                  kind: "alert",
                  status: "review",
                },
                occurredAt: now,
              });
            }
            yield* sql`
            INSERT INTO command_center_command_receipts (
              command_id, request_digest, response_json, accepted_at
            ) VALUES (
              ${input.commandId}, ${requestDigest}, ${stringify(result)}, ${now}
            )
          `;
          }),
        );
        return result;
      },
      Effect.mapError((cause) =>
        isCommandCenterError(cause)
          ? cause
          : persistenceError("Could not submit Command Center command.", cause),
      ),
    );

    const authorizeRunExecution = Effect.fn("CommandCenter.authorizeRunExecution")(
      function* (input: Parameters<CommandCenterServiceShape["authorizeRunExecution"]>[0]) {
        const authorizedAt = DateTime.formatIso(yield* DateTime.now);
        const authorized = yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{
              readonly id: string;
              readonly spaceId: string;
            }>`
              UPDATE command_center_runs
              SET execution_authorized_at = ${authorizedAt}
              WHERE id = ${input.runId}
                AND state = 'queued'
                AND thread_id IS NULL
                AND execution_authorized_at IS NULL
                AND NOT EXISTS (
                  SELECT 1
                  FROM command_center_approvals approval
                  JOIN command_center_inbox_discussion discussion
                    ON discussion.item_id = approval.item_id
                  WHERE approval.run_id = ${input.runId}
                    AND discussion.kind = 'change-request'
                    AND discussion.resolved_at IS NULL
                )
              RETURNING id, space_id AS "spaceId"
            `;
            const row = rows[0];
            if (row === undefined) return undefined;
            yield* appendAudit({
              eventId: `run-execution-authorized:${row.id}`,
              actorKind: input.actorKind,
              action: "cc.runs.execution.authorized",
              spaceId: row.spaceId,
              runId: row.id,
              payload: { runId: row.id, authorizedAt },
              occurredAt: authorizedAt,
            });
            return row;
          }),
        );
        if (authorized !== undefined) return { authorizedAt, duplicate: false };

        const rows = yield* sql<{
          readonly state: string;
          readonly executionAuthorizedAt: string | null;
          readonly blockedByChangeRequest: number;
        }>`
          SELECT run.state, run.execution_authorized_at AS "executionAuthorizedAt",
            EXISTS (
              SELECT 1
              FROM command_center_approvals approval
              JOIN command_center_inbox_discussion discussion
                ON discussion.item_id = approval.item_id
              WHERE approval.run_id = run.id
                AND discussion.kind = 'change-request'
                AND discussion.resolved_at IS NULL
            ) AS "blockedByChangeRequest"
          FROM command_center_runs run
          WHERE run.id = ${input.runId}
          LIMIT 1
        `;
        const current = rows[0];
        if (current === undefined) {
          return yield* new CommandCenterError({
            reason: "not_found",
            message: "Run was not found.",
          });
        }
        if (current.blockedByChangeRequest === 1) {
          return yield* new CommandCenterError({
            reason: "conflict",
            message: "Run execution is blocked by an unresolved Inbox change request.",
          });
        }
        if (current.executionAuthorizedAt !== null) {
          return {
            authorizedAt: current.executionAuthorizedAt,
            duplicate: true,
          };
        }
        return yield* new CommandCenterError({
          reason: "conflict",
          message: `Run is '${current.state}' and cannot be authorized for execution.`,
        });
      },
      Effect.mapError((cause) =>
        isCommandCenterError(cause)
          ? cause
          : persistenceError("Could not authorize Run execution.", cause),
      ),
    );

    const bindMcpChildRun = Effect.fn("CommandCenter.bindMcpChildRun")(
      function* (input: {
        readonly runId: RunType["id"];
        readonly spaceId: string;
        readonly repositoryId?: string;
        readonly threadId: string;
        readonly providerSessionId: string;
        readonly providerInstanceId: string;
      }) {
        if (
          [input.spaceId, input.threadId, input.providerSessionId, input.providerInstanceId].some(
            (value) => value.trim().length === 0,
          ) ||
          input.repositoryId?.trim().length === 0
        ) {
          return yield* new CommandCenterError({
            reason: "validation",
            message: "The authenticated MCP source scope is incomplete.",
          });
        }

        const eventId = `mcp-child-run:${input.runId}:bound`;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const children = yield* sql<{
              readonly id: string;
              readonly parentRunId: string | null;
              readonly spaceId: string;
              readonly threadId: string | null;
              readonly state: string;
              readonly routeJson: string;
              readonly executionAuthorizedAt: string | null;
            }>`
              SELECT id, parent_run_id AS "parentRunId", space_id AS "spaceId",
                thread_id AS "threadId", state, route_json AS "routeJson",
                execution_authorized_at AS "executionAuthorizedAt"
              FROM command_center_runs
              WHERE id = ${input.runId}
              LIMIT 1
            `;
            const child = children[0];
            if (child === undefined) {
              return yield* new CommandCenterError({
                reason: "not_found",
                message: "The child Run was not found.",
              });
            }

            const sources = yield* sql<{
              readonly id: string;
              readonly spaceId: string;
              readonly routeJson: string;
            }>`
              SELECT id, space_id AS "spaceId", route_json AS "routeJson"
              FROM command_center_runs
              WHERE thread_id = ${input.threadId}
              ORDER BY id
            `;
            if (sources.length === 0) {
              return yield* new CommandCenterError({
                reason: "not_found",
                message: "The authenticated MCP source thread is not linked to a Run.",
              });
            }
            if (sources.length !== 1) {
              return yield* new CommandCenterError({
                reason: "conflict",
                message: "The authenticated MCP source thread is linked ambiguously.",
              });
            }
            const source = sources[0]!;
            if (source.id === child.id) {
              return yield* new CommandCenterError({
                reason: "validation",
                message: "A Run cannot be its own MCP parent.",
              });
            }

            const [sourceRoute, childRoute] = yield* Effect.all([
              parseJson(source.routeJson, "source Run route").pipe(
                Effect.flatMap(decodeRouteDecision),
                Effect.mapError((cause) =>
                  persistenceError("The source Run route is invalid.", cause),
                ),
              ),
              parseJson(child.routeJson, "child Run route").pipe(
                Effect.flatMap(decodeRouteDecision),
                Effect.mapError((cause) =>
                  persistenceError("The child Run route is invalid.", cause),
                ),
              ),
            ]);
            const repositoryMatches =
              input.repositoryId === undefined ||
              (sourceRoute.repositoryId === input.repositoryId &&
                childRoute.repositoryId === input.repositoryId);
            if (
              source.spaceId !== input.spaceId ||
              sourceRoute.spaceId !== input.spaceId ||
              child.spaceId !== input.spaceId ||
              childRoute.spaceId !== input.spaceId ||
              !repositoryMatches
            ) {
              return yield* new CommandCenterError({
                reason: "validation",
                message:
                  "The MCP source thread and child Run must remain inside the credential-bound Space and repository.",
              });
            }

            const recorded = yield* sql<{
              readonly actorKind: string;
              readonly action: string;
              readonly spaceId: string | null;
              readonly runId: string | null;
              readonly payloadJson: string;
              readonly occurredAt: string;
            }>`
              SELECT actor_kind AS "actorKind", action, space_id AS "spaceId",
                run_id AS "runId", payload_json AS "payloadJson",
                occurred_at AS "occurredAt"
              FROM command_center_audit_events
              WHERE event_id = ${eventId}
              LIMIT 1
            `;
            const existingEvent = recorded[0];
            if (
              child.executionAuthorizedAt !== null ||
              child.parentRunId !== null ||
              existingEvent !== undefined
            ) {
              const payload =
                existingEvent === undefined
                  ? undefined
                  : yield* parseJson(existingEvent.payloadJson, "MCP child authorization event");
              const payloadSource =
                typeof payload === "object" &&
                payload !== null &&
                "source" in payload &&
                typeof payload.source === "object" &&
                payload.source !== null
                  ? payload.source
                  : undefined;
              const recordedLinkedAt =
                typeof payload === "object" &&
                payload !== null &&
                "linkedAt" in payload &&
                typeof payload.linkedAt === "string"
                  ? payload.linkedAt
                  : undefined;
              const recordedExecutionAuthorizedAt =
                typeof payload === "object" &&
                payload !== null &&
                "executionAuthorizedAt" in payload &&
                (payload.executionAuthorizedAt === null ||
                  typeof payload.executionAuthorizedAt === "string")
                  ? payload.executionAuthorizedAt
                  : undefined;
              const isExactReplay =
                child.parentRunId === source.id &&
                existingEvent?.actorKind === "agent" &&
                existingEvent.action === "cc.runs.mcp-child.bound" &&
                existingEvent.spaceId === input.spaceId &&
                existingEvent.runId === child.id &&
                recordedLinkedAt !== undefined &&
                existingEvent.occurredAt === recordedLinkedAt &&
                recordedExecutionAuthorizedAt !== undefined &&
                (recordedExecutionAuthorizedAt === null ||
                  recordedExecutionAuthorizedAt === child.executionAuthorizedAt) &&
                typeof payload === "object" &&
                payload !== null &&
                "childRunId" in payload &&
                payload.childRunId === child.id &&
                "parentRunId" in payload &&
                payload.parentRunId === source.id &&
                payloadSource !== undefined &&
                "kind" in payloadSource &&
                payloadSource.kind === "mcp" &&
                "threadId" in payloadSource &&
                payloadSource.threadId === input.threadId &&
                "providerSessionId" in payloadSource &&
                payloadSource.providerSessionId === input.providerSessionId &&
                "providerInstanceId" in payloadSource &&
                payloadSource.providerInstanceId === input.providerInstanceId &&
                "spaceId" in payloadSource &&
                payloadSource.spaceId === input.spaceId &&
                "repositoryId" in payloadSource &&
                payloadSource.repositoryId === (input.repositoryId ?? null);
              if (!isExactReplay) {
                return yield* new CommandCenterError({
                  reason: "conflict",
                  message: "The child Run is already bound to different execution provenance.",
                });
              }
              return {
                parentRunId: RunId.make(source.id),
                linkedAt: recordedLinkedAt,
                executionAuthorizedAt: child.executionAuthorizedAt,
                duplicate: true,
              };
            }

            if (
              !["queued", "waiting_approval", "failed"].includes(child.state) ||
              child.threadId !== null
            ) {
              return yield* new CommandCenterError({
                reason: "conflict",
                message: `Run is '${child.state}' and cannot be bound as an MCP child.`,
              });
            }

            const linkedAt = DateTime.formatIso(yield* DateTime.now);
            const executionAuthorizedAt = child.state === "queued" ? linkedAt : null;
            const updated = yield* sql<{ readonly id: string }>`
              UPDATE command_center_runs
              SET parent_run_id = ${source.id},
                execution_authorized_at = ${executionAuthorizedAt}
              WHERE id = ${child.id}
                AND state IN ('queued', 'waiting_approval', 'failed')
                AND thread_id IS NULL
                AND parent_run_id IS NULL
                AND execution_authorized_at IS NULL
              RETURNING id
            `;
            if (updated.length !== 1) {
              return yield* new CommandCenterError({
                reason: "conflict",
                message: "The child Run changed before its MCP provenance could be recorded.",
              });
            }

            yield* appendAudit({
              eventId,
              actorKind: "agent",
              action: "cc.runs.mcp-child.bound",
              spaceId: input.spaceId,
              runId: child.id,
              payload: {
                childRunId: child.id,
                parentRunId: source.id,
                linkedAt,
                executionAuthorizedAt,
                source: {
                  kind: "mcp",
                  threadId: input.threadId,
                  providerSessionId: input.providerSessionId,
                  providerInstanceId: input.providerInstanceId,
                  spaceId: input.spaceId,
                  repositoryId: input.repositoryId ?? null,
                },
              },
              occurredAt: linkedAt,
            });

            return {
              parentRunId: RunId.make(source.id),
              linkedAt,
              executionAuthorizedAt,
              duplicate: false,
            };
          }),
        );
      },
      Effect.mapError((cause) =>
        isCommandCenterError(cause)
          ? cause
          : persistenceError(
              "Could not bind the MCP child Run to its authenticated source.",
              cause,
            ),
      ),
    );

    const submitMcpChildCommand: CommandCenterServiceShape["submitMcpChildCommand"] = (
      input,
      providers,
      source,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const result = yield* submitCommand(input, providers);
            yield* bindMcpChildRun({
              runId: result.run.id,
              spaceId: source.spaceId,
              ...(source.repositoryId === undefined ? {} : { repositoryId: source.repositoryId }),
              threadId: source.threadId,
              providerSessionId: source.providerSessionId,
              providerInstanceId: source.providerInstanceId,
            });
            return result;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isCommandCenterError(cause)
              ? cause
              : persistenceError("Could not submit the authenticated MCP child Run.", cause),
          ),
        );

    const submitSpaceAgentCommand: CommandCenterServiceShape["submitSpaceAgentCommand"] = (
      input,
      providers,
      source,
    ) =>
      Effect.gen(function* () {
        if (
          [
            source.spaceId,
            source.threadId,
            source.providerSessionId,
            source.providerInstanceId,
          ].some((value) => value.trim().length === 0) ||
          (input.spaceId !== undefined && input.spaceId !== source.spaceId)
        ) {
          return yield* new CommandCenterError({
            reason: "validation",
            message: "The Space agent source scope is incomplete or does not match the command.",
          });
        }
        // Warm the config cache before the transaction so a rollback below can
        // never leave the cached projection ahead of the database.
        const space = yield* requireConfiguredSpace(source.spaceId);
        if (space.agent?.enabled !== true) {
          return yield* new CommandCenterError({
            reason: "validation",
            message: "This Space does not have an enabled agent.",
          });
        }
        const pinnedInput = { ...input, spaceId: space.id };
        const outcome = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const result = yield* submitCommand(pinnedInput, providers);
              // A replayed command id never authorizes anything new.
              if (result.duplicate) return { _tag: "Submitted" as const, result };
              const risk = result.route.risk;
              const inPolicy =
                result.route.spaceId === space.id &&
                result.run.status === "queued" &&
                result.route.status === "ready" &&
                !result.route.approvalRequired &&
                (risk === "low" || risk === "reversible") &&
                space.policy.autoRunRiskLevels.includes(risk);
              if (!inPolicy) {
                return yield* new SpaceAgentProposalRequired({ route: result.route });
              }
              const authorizedAt = DateTime.formatIso(yield* DateTime.now);
              const authorized = yield* sql<{ readonly id: string }>`
                UPDATE command_center_runs
                SET execution_authorized_at = ${authorizedAt}
                WHERE id = ${result.run.id}
                  AND state = 'queued'
                  AND thread_id IS NULL
                  AND parent_run_id IS NULL
                  AND execution_authorized_at IS NULL
                RETURNING id
              `;
              if (authorized.length !== 1) {
                return yield* new CommandCenterError({
                  reason: "conflict",
                  message: "The Space agent Run changed before it could be authorized.",
                });
              }
              yield* appendAudit({
                eventId: spaceAgentRunAuthorizedEventId(result.run.id),
                actorKind: "agent",
                action: "cc.runs.space-agent.authorized",
                spaceId: space.id,
                runId: result.run.id,
                payload: {
                  runId: result.run.id,
                  authorizedAt,
                  risk,
                  autoRunRiskLevels: space.policy.autoRunRiskLevels,
                  source: {
                    kind: "space-agent",
                    threadId: source.threadId,
                    providerSessionId: source.providerSessionId,
                    providerInstanceId: source.providerInstanceId,
                    spaceId: space.id,
                  },
                },
                occurredAt: authorizedAt,
              });
              return { _tag: "Submitted" as const, result };
            }),
          )
          .pipe(
            Effect.catchIf(
              (cause): cause is SpaceAgentProposalRequired =>
                cause instanceof SpaceAgentProposalRequired,
              (proposal) => Effect.succeed({ _tag: "Proposal" as const, route: proposal.route }),
            ),
          );
        if (outcome._tag === "Submitted") return outcome.result;
        const item = yield* recordSpaceAgentProposal({
          spaceId: space.id,
          threadId: source.threadId,
          command: pinnedInput,
          route: outcome.route,
        });
        return { proposal: "decision" as const, item, route: outcome.route };
      }).pipe(
        Effect.mapError((cause) =>
          isCommandCenterError(cause)
            ? cause
            : persistenceError("Could not submit the Space agent command.", cause),
        ),
      );

    const spaceBrief: CommandCenterServiceShape["spaceBrief"] = (input) =>
      Effect.gen(function* () {
        const space = yield* requireConfiguredSpace(input.spaceId);
        const briefInput = yield* loadSpaceBriefInput({
          space: { id: space.id, displayName: space.displayName },
          repositoryId: input.repositoryId,
          now: DateTime.formatIso(yield* DateTime.now),
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
        return { spaceId: space.id, brief: renderSpaceBrief(briefInput) };
      }).pipe(
        Effect.mapError((cause) =>
          isCommandCenterError(cause)
            ? cause
            : persistenceError("Could not load the Space brief.", cause),
        ),
      );

    const recordSpaceAgentProposal = Effect.fn("CommandCenter.recordSpaceAgentProposal")(
      function* (input: {
        readonly spaceId: string;
        readonly threadId: string;
        readonly command: CommandCenterCommandSubmitInput;
        readonly route: RouteDecisionType;
      }) {
        const itemId = `space-agent-proposal:${(yield* digest(
          `${input.spaceId}\0${input.command.commandId}`,
        )).slice(0, 40)}`;
        const existing = yield* sql<ItemRow>`
          SELECT id, space_id AS "spaceId", kind, status, title, body, priority,
            due_at AS "dueAt", source_json AS "sourceJson", links_json AS "linksJson",
            metadata_json AS "metadataJson", created_at AS "createdAt", updated_at AS "updatedAt"
          FROM command_center_items WHERE id = ${itemId}
        `;
        if (existing[0] !== undefined) {
          const stored = yield* decodeItemRow(existing[0]);
          if (stored.spaceId !== input.spaceId) {
            return yield* new CommandCenterError({
              reason: "conflict",
              message: "The Space agent proposal id is already bound to a different Space.",
            });
          }
          return stored;
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        const commandText = clipProposalText(input.command.text, SPACE_AGENT_PROPOSAL_TEXT_CHARS);
        const reasons = input.route.reasons
          .slice(0, 8)
          .map((reason) => clipProposalText(reason, 240));
        const item = yield* decodeItem({
          id: itemId,
          spaceId: input.spaceId,
          kind: "decision",
          status: "review",
          priority: "high",
          title: clipProposalText(`Agent proposal: ${input.command.text}`, 120),
          description: [
            commandText,
            `Risk: ${input.route.risk} (${input.route.actionKind}). This is outside the Space's auto-run policy, so the agent did not start it.`,
            ...(reasons.length === 0 ? [] : [`Route notes: ${reasons.join("; ")}`]),
          ].join("\n\n"),
          artifactIds: [],
          provenance: { kind: "agent", sourceRef: input.threadId, capturedAt: now },
          metadata: {
            spaceAgent: true,
            type: "space-agent-proposal",
            threadId: input.threadId,
            commandId: input.command.commandId,
            risk: input.route.risk,
            actionKind: input.route.actionKind,
            routeStatus: input.route.status,
            reasons,
            proposal: {
              text: commandText,
              ...(input.command.repositoryId === undefined
                ? {}
                : { repositoryId: input.command.repositoryId }),
              ...(input.command.providerId === undefined
                ? {}
                : { providerId: input.command.providerId }),
              ...(input.command.modelId === undefined ? {} : { modelId: input.command.modelId }),
            },
          },
          createdAt: now,
          updatedAt: now,
        }).pipe(
          Effect.mapError((cause) =>
            persistenceError("Could not record the Space agent proposal.", cause),
          ),
        );
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO command_center_items (
                id, space_id, kind, status, title, body, priority, due_at,
                source_json, links_json, metadata_json, created_at, updated_at
              ) VALUES (
                ${item.id}, ${item.spaceId}, ${item.kind}, ${item.status}, ${item.title},
                ${item.description ?? null}, ${item.priority}, NULL,
                ${stringify(item.provenance)}, ${stringify(item.artifactIds)},
                ${stringify(item.metadata)}, ${item.createdAt}, ${item.updatedAt}
              )
            `;
            yield* appendAudit({
              eventId: `space-agent-proposal:${item.id}:created`,
              actorKind: "agent",
              action: "cc.items.changed",
              spaceId: item.spaceId,
              payload: {
                itemId: item.id,
                change: "created",
                kind: item.kind,
                status: item.status,
              },
              occurredAt: now,
            });
          }),
        );
        return item;
      },
    );

    const createItem = Effect.fn("CommandCenter.createItem")(
      function* (input: CommandCenterItemCreateInput, actor?: CommandCenterItemActor) {
        yield* requireConfiguredSpace(input.spaceId);
        const existing = yield* sql<ItemRow>`
        SELECT id, space_id AS "spaceId", kind, status, title, body, priority,
          due_at AS "dueAt", source_json AS "sourceJson", links_json AS "linksJson",
          metadata_json AS "metadataJson", created_at AS "createdAt", updated_at AS "updatedAt"
        FROM command_center_items WHERE id = ${input.requestId}
      `;
        if (existing[0] !== undefined) {
          const stored = yield* decodeItemRow(existing[0]);
          if (stored.spaceId !== input.spaceId) {
            return yield* new CommandCenterError({
              reason: "conflict",
              message: "The Item request id is already bound to a different Space.",
            });
          }
          return stored;
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        const item = yield* decodeItem({
          id: input.requestId,
          spaceId: input.spaceId,
          kind: input.kind,
          status: "captured",
          priority: input.priority,
          title: input.title,
          description: input.description,
          dueAt: input.dueAt,
          artifactIds: [],
          provenance:
            actor === undefined
              ? { kind: "user", capturedAt: now }
              : { kind: "agent", sourceRef: actor.threadId, capturedAt: now },
          metadata: actor === undefined ? {} : { spaceAgent: true, threadId: actor.threadId },
          createdAt: now,
          updatedAt: now,
        }).pipe(Effect.mapError((cause) => persistenceError("Could not create Item.", cause)));
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
            INSERT INTO command_center_items (
              id, space_id, kind, status, title, body, priority, due_at,
              source_json, links_json, metadata_json, created_at, updated_at
            ) VALUES (
              ${item.id}, ${item.spaceId}, ${item.kind}, ${item.status}, ${item.title},
              ${item.description ?? null}, ${item.priority}, ${item.dueAt ?? null},
              ${stringify(item.provenance)}, ${stringify(item.artifactIds)},
              ${stringify(item.metadata)}, ${item.createdAt}, ${item.updatedAt}
            )
          `;
            yield* appendAudit({
              actorKind: actor === undefined ? "user" : "agent",
              action: "cc.items.create",
              spaceId: item.spaceId,
              payload: { itemId: item.id, kind: item.kind },
              occurredAt: now,
            });
          }),
        );
        return item;
      },
      Effect.mapError((cause) =>
        isCommandCenterError(cause) ? cause : persistenceError("Could not create Item.", cause),
      ),
    );

    const updateItem = Effect.fn("CommandCenter.updateItem")(
      function* (input: CommandCenterItemUpdateInput, actor?: CommandCenterItemActor) {
        yield* requireConfiguredSpace(input.spaceId);
        const patchFields = Object.keys(input.patch);
        if (
          patchFields.length === 0 ||
          patchFields.some((field) => !ITEM_UPDATE_FIELDS.has(field))
        ) {
          return yield* new CommandCenterError({
            reason: "validation",
            message: "The Item update contains no allowed fields.",
          });
        }

        const rows = yield* sql<ItemRow>`
          SELECT id, space_id AS "spaceId", kind, status, title, body, priority,
            due_at AS "dueAt", source_json AS "sourceJson", links_json AS "linksJson",
            metadata_json AS "metadataJson", created_at AS "createdAt",
            updated_at AS "updatedAt"
          FROM command_center_items
          WHERE id = ${input.itemId} AND space_id = ${input.spaceId}
          LIMIT 1
        `;
        const row = rows[0];
        if (row === undefined) {
          return yield* new CommandCenterError({
            reason: "not_found",
            message: "The Item was not found in the requested Space.",
          });
        }
        const current = yield* decodeItemRow(row);
        if (itemMatchesPatch(current, input.patch)) {
          return { item: current, duplicate: true };
        }
        if (current.updatedAt !== input.expectedUpdatedAt) {
          return yield* new CommandCenterError({
            reason: "conflict",
            message: "The Item changed after the supplied optimistic-concurrency timestamp.",
          });
        }

        const observedAt = DateTime.formatIso(yield* DateTime.now);
        const updatedAt = nextItemUpdatedAt(current.updatedAt, observedAt);
        const next = yield* decodeItem({
          ...applyItemPatch(current, input.patch),
          updatedAt,
        }).pipe(Effect.mapError((cause) => persistenceError("Could not update Item.", cause)));
        const eventId = `item-update:${next.id}:${yield* digest(
          stringify({
            expectedUpdatedAt: input.expectedUpdatedAt,
            patch: input.patch,
          }),
        )}`;

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const updatedRows = yield* sql<ItemRow>`
              UPDATE command_center_items
              SET status = ${next.status}, title = ${next.title}, body = ${next.description ?? null},
                priority = ${next.priority}, due_at = ${next.dueAt ?? null},
                updated_at = ${next.updatedAt}
              WHERE id = ${next.id} AND space_id = ${next.spaceId}
                AND updated_at = ${input.expectedUpdatedAt}
              RETURNING id, space_id AS "spaceId", kind, status, title, body, priority,
                due_at AS "dueAt", source_json AS "sourceJson", links_json AS "linksJson",
                metadata_json AS "metadataJson", created_at AS "createdAt",
                updated_at AS "updatedAt"
            `;
            const updatedRow = updatedRows[0];
            if (updatedRow === undefined) {
              const latestRows = yield* sql<ItemRow>`
                SELECT id, space_id AS "spaceId", kind, status, title, body, priority,
                  due_at AS "dueAt", source_json AS "sourceJson", links_json AS "linksJson",
                  metadata_json AS "metadataJson", created_at AS "createdAt",
                  updated_at AS "updatedAt"
                FROM command_center_items
                WHERE id = ${input.itemId} AND space_id = ${input.spaceId}
                LIMIT 1
              `;
              const latestRow = latestRows[0];
              if (latestRow !== undefined) {
                const latest = yield* decodeItemRow(latestRow);
                if (itemMatchesPatch(latest, input.patch)) {
                  return { item: latest, duplicate: true };
                }
              }
              return yield* new CommandCenterError({
                reason: "conflict",
                message: "The Item changed while this update was being applied.",
              });
            }

            const updatedItem = yield* decodeItemRow(updatedRow);
            if (
              actor === undefined &&
              current.status !== updatedItem.status &&
              isSpaceAgentItemMetadata(updatedItem.metadata)
            ) {
              yield* recordSpaceAgentReply(sql, {
                sourceId: eventId,
                spaceId: updatedItem.spaceId,
                itemId: updatedItem.id,
                itemTitle: updatedItem.title,
                kind: "status",
                body: `Status changed from ${current.status} to ${updatedItem.status}.`,
                occurredAt: updatedAt,
              });
            }
            yield* appendAudit({
              eventId,
              actorKind: actor === undefined ? "user" : "agent",
              action: "cc.items.changed",
              spaceId: updatedItem.spaceId,
              payload: {
                itemId: updatedItem.id,
                change: "updated",
                kind: updatedItem.kind,
                status: updatedItem.status,
              },
              occurredAt: updatedAt,
            });
            return { item: updatedItem, duplicate: false };
          }),
        );
      },
      Effect.mapError((cause) =>
        isCommandCenterError(cause) ? cause : persistenceError("Could not update Item.", cause),
      ),
    );

    const recordArtifact = Effect.fn("CommandCenter.recordArtifact")(
      function* (input: Parameters<CommandCenterServiceShape["recordArtifact"]>[0]) {
        const artifact = yield* decodeArtifact(input.artifact).pipe(
          Effect.mapError((cause) => persistenceError("Could not decode Artifact.", cause)),
        );
        if (!artifact.locator.startsWith("cc-artifact://")) {
          return yield* new CommandCenterError({
            reason: "validation",
            message: "Artifacts must use a server-managed Command Center locator.",
          });
        }
        if (!/^[a-f0-9]{64}$/u.test(artifact.contentDigest)) {
          return yield* new CommandCenterError({
            reason: "validation",
            message: "Artifact content digest must be a lowercase SHA-256 digest.",
          });
        }
        yield* requireConfiguredSpace(artifact.spaceId);
        if (artifact.runId !== undefined) {
          const runs = yield* sql<{ readonly id: string }>`
            SELECT id
            FROM command_center_runs
            WHERE id = ${artifact.runId} AND space_id = ${artifact.spaceId}
            LIMIT 1
          `;
          if (runs.length === 0) {
            return yield* new CommandCenterError({
              reason: "not_found",
              message: "The Artifact Run was not found in the requested Space.",
            });
          }
        }

        const existing = yield* sql<ArtifactRow>`
          SELECT id, space_id AS "spaceId", run_id AS "runId", kind, title, uri,
            content_digest AS "contentDigest", provenance_json AS "provenanceJson",
            metadata_json AS "metadataJson", created_at AS "createdAt"
          FROM command_center_artifacts
          WHERE id = ${artifact.id}
          LIMIT 1
        `;
        if (existing[0] !== undefined) {
          const recorded = yield* decodeArtifactRow(existing[0]);
          if (stringify(recorded) !== stringify(artifact)) {
            return yield* new CommandCenterError({
              reason: "conflict",
              message: "The Artifact id is already bound to different metadata.",
            });
          }
          return recorded;
        }

        const metadata = {
          ...(artifact.mimeType === undefined ? {} : { mimeType: artifact.mimeType }),
          ...(input.sizeBytes === undefined ? {} : { sizeBytes: input.sizeBytes }),
          ...(input.format === undefined ? {} : { format: input.format }),
        };
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO command_center_artifacts (
                id, space_id, run_id, kind, title, uri, content_digest,
                provenance_json, metadata_json, created_at
              ) VALUES (
                ${artifact.id}, ${artifact.spaceId}, ${artifact.runId ?? null}, ${artifact.kind},
                ${artifact.name}, ${artifact.locator}, ${artifact.contentDigest},
                ${stringify(artifact.provenance)}, ${stringify(metadata)}, ${artifact.createdAt}
              )
            `;
            yield* appendAudit({
              eventId: `artifact:${artifact.id}:created`,
              actorKind: "connector",
              action: "cc.artifacts.changed",
              spaceId: artifact.spaceId,
              ...(artifact.runId === undefined ? {} : { runId: artifact.runId }),
              payload: { change: "created", artifact },
              occurredAt: artifact.createdAt,
            });
          }),
        );
        return artifact;
      },
      Effect.mapError((cause) =>
        isCommandCenterError(cause) ? cause : persistenceError("Could not record Artifact.", cause),
      ),
    );

    const ensureCandidateProjection = Effect.fn("CommandCenter.ensureCandidateProjection")(
      function* (memory: MemoryType, now: string) {
        yield* sql`
          INSERT OR IGNORE INTO command_center_memory_candidates (
            id, space_id, repository_ref, proposed_kind, content, confidence,
            provenance_json, status, proposed_at
          ) VALUES (
            ${memory.id}, ${memory.spaceId}, ${memory.repositoryId ?? null}, ${memory.kind},
            ${memory.content}, ${memory.confidence}, ${stringify(memory.provenance)},
            'pending', ${memory.createdAt}
          )
        `;
        const itemId = `memory-review:${memory.id}`;
        const inserted = yield* sql<{ readonly id: string }>`
          INSERT OR IGNORE INTO command_center_items (
            id, space_id, kind, status, title, body, priority,
            source_json, metadata_json, created_at, updated_at
          ) VALUES (
            ${itemId}, ${memory.spaceId}, 'decision', 'review', 'Review suggested memory',
            ${memory.content}, 'normal',
            ${stringify({ kind: "agent", sourceRef: memory.id, capturedAt: memory.createdAt })},
            ${stringify({
              type: "memory-candidate",
              memoryId: memory.id,
              ...(memory.repositoryId === undefined ? {} : { repositoryId: memory.repositoryId }),
            })},
            ${memory.createdAt}, ${now}
          )
          RETURNING id
        `;
        if (inserted.length > 0) {
          yield* appendAudit({
            eventId: `memory-review-item:${memory.id}:created`,
            actorKind: "agent",
            action: "cc.items.changed",
            spaceId: memory.spaceId,
            payload: {
              itemId,
              change: "created",
              kind: "decision",
              status: "review",
            },
            occurredAt: now,
          });
        }
      },
    );

    const storeMemory = Effect.fn("CommandCenter.storeMemory")(
      function* (
        input: CommandCenterMemoryRememberInput | CommandCenterMemoryProposeInput,
        status: "approved" | "candidate",
        confidence: number,
        approvedBy: "user" | "agent" = "user",
      ) {
        const actorKind = status === "approved" ? approvedBy : "agent";
        const configuredSpace = yield* requireConfiguredSpace(input.spaceId);
        if (
          input.repositoryId !== undefined &&
          !configuredSpace.repositories.some((repository) => repository.id === input.repositoryId)
        ) {
          return yield* new CommandCenterError({
            reason: "not_found",
            message: "The Memory repository is not configured in this Space.",
          });
        }
        const existing = yield* sql<MemoryRow>`
        SELECT id, space_id AS "spaceId", repository_ref AS "repositoryRef", kind, status,
          content, confidence, provenance_json AS "provenanceJson",
          contradiction_of AS "contradictionOf", expires_at AS "expiresAt",
          created_at AS "createdAt", updated_at AS "updatedAt"
        FROM command_center_memories WHERE id = ${input.requestId}
      `;
        if (existing[0] !== undefined) {
          const stored = yield* decodeMemoryRow(existing[0]);
          if (
            stored.spaceId !== input.spaceId ||
            stored.repositoryId !== input.repositoryId ||
            stored.content !== input.content ||
            stored.kind !== input.kind ||
            stored.provenance.sourceRef !== input.sourceRef ||
            (status === "candidate" &&
              (stored.confidence !== confidence ||
                stored.expiresAt !== ("expiresAt" in input ? input.expiresAt : undefined) ||
                stored.contradictionOf !==
                  ("contradictionOf" in input ? input.contradictionOf : undefined)))
          ) {
            return yield* new CommandCenterError({
              reason: "conflict",
              message: "The Memory request id is already bound to different content or scope.",
            });
          }
          if (stored.status === "candidate") {
            const now = DateTime.formatIso(yield* DateTime.now);
            yield* sql.withTransaction(ensureCandidateProjection(stored, now));
          }
          return stored;
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        const memory = yield* decodeMemory({
          id: input.requestId,
          spaceId: input.spaceId,
          repositoryId: input.repositoryId,
          kind: input.kind,
          status,
          content: input.content,
          confidence,
          provenance: {
            kind: actorKind,
            sourceRef: input.sourceRef,
            capturedAt: now,
          },
          ...(status === "candidate" && "expiresAt" in input && input.expiresAt !== undefined
            ? { expiresAt: input.expiresAt }
            : {}),
          ...(status === "candidate" &&
          "contradictionOf" in input &&
          input.contradictionOf !== undefined
            ? { contradictionOf: input.contradictionOf }
            : {}),
          createdAt: now,
          updatedAt: now,
        }).pipe(Effect.mapError((cause) => persistenceError("Could not store Memory.", cause)));
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
            INSERT INTO command_center_memories (
              id, space_id, repository_ref, scope, kind, content, status, confidence,
              provenance_json, expires_at, contradiction_of, created_at, updated_at
            ) VALUES (
              ${memory.id}, ${memory.spaceId}, ${memory.repositoryId ?? null},
              ${memory.repositoryId === undefined ? "space" : "repository"}, ${memory.kind},
              ${memory.content}, ${memory.status}, ${memory.confidence},
              ${stringify(memory.provenance)}, ${memory.expiresAt ?? null},
              ${memory.contradictionOf ?? null}, ${memory.createdAt}, ${memory.updatedAt}
            )
          `;
            if (status === "candidate") {
              yield* ensureCandidateProjection(memory, now);
            }
            yield* appendAudit({
              actorKind,
              action: status === "approved" ? "cc.memory.remember" : "cc.memory.propose",
              spaceId: memory.spaceId,
              payload: { memoryId: memory.id, kind: memory.kind, status },
              occurredAt: now,
            });
          }),
        );
        return memory;
      },
      Effect.mapError((cause) =>
        isCommandCenterError(cause) ? cause : persistenceError("Could not store Memory.", cause),
      ),
    );

    const remember = (input: CommandCenterMemoryRememberInput) => storeMemory(input, "approved", 1);
    const rememberFromSpaceAgent: CommandCenterServiceShape["rememberFromSpaceAgent"] = (
      input,
      source,
    ) => storeMemory({ ...input, sourceRef: source.threadId }, "approved", 1, "agent");
    const proposeMemory = Effect.fn("CommandCenter.proposeMemory")(
      function* (input: CommandCenterMemoryProposeInput) {
        if (input.evidence === undefined)
          return yield* storeMemory(input, "candidate", input.confidence);
        const evidence = input.evidence;
        const revisions = yield* sql<{
          readonly spaceId: string;
          readonly observationId: string;
          readonly version: number;
          readonly revisionKind: string;
          readonly actorKind: string;
          readonly retired: number;
        }>`
          SELECT space_id AS "spaceId", observation_id AS "observationId", version,
            revision_kind AS "revisionKind", actor_kind AS "actorKind", retired
          FROM command_center_observation_revisions
          WHERE revision_id = ${evidence.revisionId}
          LIMIT 1
        `;
        const revision = revisions[0];
        if (
          revision === undefined ||
          revision.spaceId !== input.spaceId ||
          revision.observationId !== evidence.observationId ||
          revision.revisionKind !== "corrected" ||
          revision.actorKind !== "user" ||
          revision.retired !== 0
        ) {
          return yield* new CommandCenterError({
            reason: "validation",
            message: "A reviewed lesson needs an explicit correction in the same Space.",
          });
        }
        if (
          input.expiresAt !== undefined &&
          input.expiresAt <= DateTime.formatIso(yield* DateTime.now)
        ) {
          return yield* new CommandCenterError({
            reason: "validation",
            message: "The lesson expiry must be in the future.",
          });
        }
        if (input.contradictionOf !== undefined) {
          const conflicts = yield* sql<{ readonly id: string }>`
            SELECT id FROM command_center_memories
            WHERE id = ${input.contradictionOf} AND space_id = ${input.spaceId}
              AND repository_ref IS ${input.repositoryId ?? null} AND status = 'approved'
            LIMIT 1
          `;
          if (conflicts.length === 0) {
            return yield* new CommandCenterError({
              reason: "validation",
              message: "The conflicting approved Memory is not in this scope.",
            });
          }
        }
        const normalized = input.content.trim().replace(/\s+/gu, " ").toLowerCase();
        const memoryId = `lesson:${yield* digest(
          stringify([input.spaceId, input.repositoryId ?? null, evidence.revisionId, normalized]),
        )}`;
        return yield* storeMemory(
          {
            ...input,
            requestId: memoryId,
            sourceRef: `observation/${encodeURIComponent(evidence.observationId)}/version/${revision.version}/revision/${encodeURIComponent(evidence.revisionId)}`,
          },
          "candidate",
          input.confidence,
        );
      },
      Effect.mapError((cause) =>
        isCommandCenterError(cause) ? cause : persistenceError("Could not propose Memory.", cause),
      ),
    );

    const reviewMemory = Effect.fn("CommandCenter.reviewMemory")(
      function* (input: CommandCenterMemoryReviewInput) {
        yield* requireConfiguredSpace(input.spaceId);
        const rows = yield* sql<MemoryRow>`
          SELECT id, space_id AS "spaceId", repository_ref AS "repositoryRef", kind, status,
            content, confidence, provenance_json AS "provenanceJson",
            contradiction_of AS "contradictionOf", expires_at AS "expiresAt",
            created_at AS "createdAt", updated_at AS "updatedAt"
          FROM command_center_memories
          WHERE id = ${input.memoryId}
          LIMIT 1
        `;
        const row = rows[0];
        if (
          row === undefined ||
          row.spaceId !== input.spaceId ||
          (row.repositoryRef ?? undefined) !== input.repositoryId
        ) {
          return yield* new CommandCenterError({
            reason: "not_found",
            message: "The Memory candidate was not found in the requested scope.",
          });
        }
        const nextStatus =
          input.decision === "approve"
            ? "approved"
            : input.decision === "expire"
              ? "expired"
              : "rejected";
        if (row.status === nextStatus) return yield* decodeMemoryRow(row);
        if (
          (input.decision === "expire" &&
            row.status !== "approved" &&
            row.status !== "candidate") ||
          (input.decision !== "expire" && row.status !== "candidate")
        ) {
          return yield* new CommandCenterError({
            reason: "conflict",
            message: "The Memory candidate has already been reviewed.",
          });
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        if (input.decision === "approve" && row.expiresAt !== null && row.expiresAt <= now) {
          return yield* new CommandCenterError({
            reason: "conflict",
            message: "The Memory candidate has expired; expire it instead of approving it.",
          });
        }
        // Approval must still rest on the current correction. Reject and expire stay allowed so
        // a stale lesson can always be cleared out of review.
        const evidence =
          input.decision === "approve"
            ? lessonEvidenceRef((yield* decodeMemoryRow(row)).provenance.sourceRef)
            : undefined;
        const wonDecision = yield* sql.withTransaction(
          Effect.gen(function* () {
            if (evidence !== undefined) {
              const current = yield* sql<{ readonly id: string }>`
                SELECT id FROM command_center_observations
                WHERE space_id = ${row.spaceId} AND id = ${evidence.observationId}
                  AND current_revision_id = ${evidence.revisionId} AND retired_at IS NULL
                LIMIT 1
              `;
              if (current.length === 0) {
                return yield* new CommandCenterError({
                  reason: "conflict",
                  message:
                    "The lesson's Observation was corrected again or retired; reject this lesson instead.",
                });
              }
            }
            const decided = yield* sql<{ readonly id: string }>`
              UPDATE command_center_memories
              SET status = ${nextStatus}, updated_at = ${now}
              WHERE id = ${row.id} AND status = ${row.status}
              RETURNING id
            `;
            if (decided.length === 0) return false;
            yield* sql`
              UPDATE command_center_memory_candidates
              SET status = ${input.decision === "approve" ? "promoted" : "rejected"},
                resolved_at = ${now}
              WHERE id = ${row.id} AND status = 'pending'
            `;
            yield* sql`
              UPDATE command_center_items
              SET status = 'done', updated_at = ${now},
                metadata_json = ${stringify({
                  type: "memory-candidate",
                  memoryId: row.id,
                  decision: input.decision,
                  ...(row.repositoryRef === null ? {} : { repositoryId: row.repositoryRef }),
                })}
              WHERE id = ${`memory-review:${row.id}`} AND status = 'review'
            `;
            yield* appendAudit({
              eventId: `memory-review:${row.id}:${nextStatus}`,
              actorKind: "user",
              action: "cc.memory.changed",
              spaceId: row.spaceId,
              payload: {
                memoryId: row.id,
                change: "updated",
                kind: row.kind,
                status: nextStatus,
              },
              occurredAt: now,
            });
            yield* appendAudit({
              eventId: `memory-review:${row.id}:item-done`,
              actorKind: "user",
              action: "cc.items.changed",
              spaceId: row.spaceId,
              payload: {
                itemId: `memory-review:${row.id}`,
                change: "updated",
                kind: "decision",
                status: "done",
              },
              occurredAt: now,
            });
            return true;
          }),
        );
        if (!wonDecision) {
          const current = yield* sql<MemoryRow>`
            SELECT id, space_id AS "spaceId", repository_ref AS "repositoryRef", kind, status,
              content, confidence, provenance_json AS "provenanceJson",
              contradiction_of AS "contradictionOf", expires_at AS "expiresAt",
              created_at AS "createdAt", updated_at AS "updatedAt"
            FROM command_center_memories
            WHERE id = ${row.id}
            LIMIT 1
          `;
          const currentRow = current[0];
          if (currentRow?.status === nextStatus) return yield* decodeMemoryRow(currentRow);
          return yield* new CommandCenterError({
            reason: "conflict",
            message: "The Memory candidate was decided concurrently; reload before reviewing.",
          });
        }
        return yield* decodeMemoryRow({
          ...row,
          status: nextStatus,
          updatedAt: now,
        });
      },
      Effect.mapError((cause) =>
        isCommandCenterError(cause) ? cause : persistenceError("Could not review Memory.", cause),
      ),
    );

    const decideApproval = Effect.fn("CommandCenter.decideApproval")(
      function* (input: CommandCenterApprovalDecisionInput) {
        const loaded = yield* syncConfig(false);
        if (loaded.health.status !== "loaded") {
          return yield* new CommandCenterError({
            reason: "config",
            message:
              "Private Command Center configuration is unavailable; Approval decisions are disabled.",
          });
        }
        const rows = yield* sql<ApprovalRow & { readonly hasUnresolvedChangeRequest: number }>`
        SELECT a.id, a.item_id AS "itemId", a.run_id AS "runId", r.space_id AS "spaceId",
          a.action_kind AS "actionKind", a.risk, a.payload_digest AS "payloadDigest",
          a.payload_json AS "payloadJson", a.status, a.idempotency_key AS "idempotencyKey",
          a.requested_at AS "requestedAt", a.expires_at AS "expiresAt",
          a.decided_at AS "decidedAt", a.decision_note AS "decisionNote",
          EXISTS (
            SELECT 1
            FROM command_center_inbox_discussion discussion
            WHERE discussion.item_id = a.item_id
              AND discussion.kind = 'change-request'
              AND discussion.resolved_at IS NULL
          ) AS "hasUnresolvedChangeRequest"
        FROM command_center_approvals a
        JOIN command_center_runs r ON r.id = a.run_id
        WHERE a.id = ${input.approvalId}
      `;
        const row = rows[0];
        if (row === undefined) {
          return yield* new CommandCenterError({
            reason: "not_found",
            message: "Approval was not found.",
          });
        }
        if (!loaded.spaces.some((space) => space.id === row.spaceId)) {
          return yield* new CommandCenterError({
            reason: "not_found",
            message: "Approval was not found in an active configured Space.",
          });
        }
        if (row.hasUnresolvedChangeRequest === 1) {
          return yield* new CommandCenterError({
            reason: "conflict",
            message: "Approval is blocked by an unresolved Inbox change request.",
          });
        }
        const storedPayloadDigest = yield* digest(row.payloadJson);
        if (storedPayloadDigest !== row.payloadDigest) {
          return yield* new CommandCenterError({
            reason: "conflict",
            message: "The stored Approval proposal no longer matches its digest.",
          });
        }
        const storedPayload = yield* parseJson(row.payloadJson, "Approval payload");
        if (
          typeof storedPayload === "object" &&
          storedPayload !== null &&
          "kind" in storedPayload &&
          storedPayload.kind === "command-action"
        ) {
          yield* decodeCommandApprovalPayload(storedPayload).pipe(
            Effect.mapError((cause) =>
              persistenceError("Stored command Approval proposal is invalid.", cause),
            ),
          );
          if (row.runId === null) {
            return yield* persistenceError("The command Approval is missing its Run binding.");
          }
          const runRows = yield* sql<{
            readonly inputJson: string;
            readonly routeJson: string;
          }>`
            SELECT input_json AS "inputJson", route_json AS "routeJson"
            FROM command_center_runs
            WHERE id = ${row.runId}
            LIMIT 1
          `;
          const boundRun = runRows[0];
          if (boundRun === undefined) {
            return yield* persistenceError("The command Approval's Run binding is unavailable.");
          }
          const boundCommand = yield* parseJson(boundRun.inputJson, "Run input").pipe(
            Effect.flatMap(decodeCommandInput),
            Effect.mapError((cause) =>
              persistenceError("The command Approval's Run input is invalid.", cause),
            ),
          );
          const boundRoute = yield* parseJson(boundRun.routeJson, "Run route").pipe(
            Effect.flatMap(decodeRouteDecision),
            Effect.mapError((cause) =>
              persistenceError("The command Approval's Run route is invalid.", cause),
            ),
          );
          const reboundDigest = yield* digest(
            stringify(
              makeCommandApprovalPayload({
                command: boundCommand,
                route: boundRoute,
              }),
            ),
          );
          if (reboundDigest !== row.payloadDigest) {
            return yield* new CommandCenterError({
              reason: "conflict",
              message: "The Approval proposal no longer matches its bound command and route.",
            });
          }
        }
        if (row.payloadDigest !== input.payloadDigest) {
          return yield* new CommandCenterError({
            reason: "conflict",
            message: "Approval payload changed; review the current request before deciding.",
          });
        }
        if (row.status === input.decision) {
          return yield* decodeApprovalRow(row);
        }
        if (row.status !== "requested") {
          return yield* new CommandCenterError({
            reason: "conflict",
            message: "Approval has already been decided.",
          });
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        if (row.expiresAt !== null && row.expiresAt <= now) {
          yield* expireApprovals();
          return yield* new CommandCenterError({
            reason: "conflict",
            message: "Approval has expired; submit the action again to review a fresh digest.",
          });
        }
        const nextRunState = input.decision === "approved" ? "queued" : "canceled";
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const decided = yield* sql<{ readonly id: string }>`
            UPDATE command_center_approvals
            SET status = ${input.decision}, decided_at = ${now}, decision_note = ${input.note ?? null}
            WHERE id = ${input.approvalId} AND status = 'requested'
            RETURNING id
          `;
            if (decided.length === 0) {
              return yield* new CommandCenterError({
                reason: "conflict",
                message: "Approval has already been decided.",
              });
            }
            if (row.runId !== null) {
              yield* sql`
              UPDATE command_center_runs
              SET state = ${nextRunState},
                execution_authorized_at = ${input.decision === "approved" ? now : null},
                finished_at = ${input.decision === "declined" ? now : null}
              WHERE id = ${row.runId}
            `;
            }
            if (row.itemId !== null) {
              yield* sql`
              UPDATE command_center_items
              SET status = ${input.decision === "approved" ? "done" : "canceled"}, updated_at = ${now}
              WHERE id = ${row.itemId}
            `;
            }
            yield* appendAudit({
              actorKind: "user",
              action: "cc.approvals.decide",
              spaceId: row.spaceId,
              ...(row.runId === null ? {} : { runId: row.runId }),
              payload: {
                approvalId: row.id,
                decision: input.decision,
                payloadDigest: row.payloadDigest,
              },
              occurredAt: now,
            });
            if (row.runId !== null) {
              yield* appendAudit({
                eventId: `approval:${row.id}:run-${nextRunState}`,
                actorKind: "user",
                action: "cc.runs.state",
                spaceId: row.spaceId,
                runId: row.runId,
                payload: {
                  status: nextRunState,
                  previousStatus: "waiting_approval",
                },
                occurredAt: now,
              });
            }
            if (row.itemId !== null) {
              yield* appendAudit({
                eventId: `approval:${row.id}:item-${input.decision}`,
                actorKind: "user",
                action: "cc.items.changed",
                spaceId: row.spaceId,
                ...(row.runId === null ? {} : { runId: row.runId }),
                payload: {
                  itemId: row.itemId,
                  change: "updated",
                  kind: "approval",
                  status: input.decision === "approved" ? "done" : "canceled",
                },
                occurredAt: now,
              });
            }
          }),
        );
        return yield* decodeApprovalRow({
          ...row,
          status: input.decision,
          decidedAt: now,
          decisionNote: input.note ?? null,
        });
      },
      Effect.mapError((cause) =>
        isCommandCenterError(cause) ? cause : persistenceError("Could not decide Approval.", cause),
      ),
    );

    return CommandCenterService.of({
      bootstrap,
      syncConfiguration: (input) => syncConfig(input?.force ?? true),
      refreshInboxSpaceProjection,
      querySpaces,
      queryItems,
      queryRuns,
      queryAutomations,
      queryApprovals,
      queryArtifacts,
      getArtifactsByIds,
      queryConnections,
      queryMemories,
      submitCommand,
      authorizeRunExecution,
      submitMcpChildCommand,
      submitSpaceAgentCommand,
      getConfiguredSpace: requireConfiguredSpace,
      spaceBrief,
      createItem,
      updateItem,
      recordArtifact,
      remember,
      rememberFromSpaceAgent,
      proposeMemory,
      reviewMemory,
      decideApproval,
      ensureAutomationApproval,
      getAutomationApprovalBinding,
      recordAutomationEvent,
      recordAutomationDefinitionCommit,
    });
  }),
);

const commandCenterConfigLive = commandCenterConfigLayer.pipe(Layer.provide(ProcessRunner.layer));

export const runtimeLayer = layer.pipe(
  Layer.provide(commandCenterConfigLive),
  Layer.provide(connectionHealthLayer),
);
