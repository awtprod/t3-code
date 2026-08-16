import {
  ApprovalRequestId,
  type AssistantDeliveryMode,
  CommandId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationMessage,
  type OrchestrationProposedPlanId,
  CheckpointRef,
  classifyTaskAgentKind,
  isToolLifecycleItemType,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationProposedPlan,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
  ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import {
  ProjectionTurnRepository,
  type ProjectionPendingTurnStart,
  type ProjectionTurnById,
} from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProviderTurnSendClaimRepository } from "../../persistence/Services/ProviderTurnSendClaims.ts";
import { ProviderTurnSendClaimRepositoryLive } from "../../persistence/Layers/ProviderTurnSendClaims.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { COMMAND_PRODUCED_NO_EVENTS_DETAIL } from "../Errors.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ThreadBackgroundLivenessService } from "../ThreadBackgroundLiveness.ts";
import { ThreadPlanProgressService } from "../ThreadPlanProgress.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import { projectActivityPayload } from "../ActivityPayloadProjection.ts";
import { forkParked } from "../../serverActivation.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProjectionTurnUsageRepository } from "../../persistence/Services/ProjectionTurnUsage.ts";
import { ProjectionTurnUsageRepositoryLive } from "../../persistence/Layers/ProjectionTurnUsage.ts";
import { isCommandCenterThreadId } from "../../provider/security/CommandCenterProviderIsolation.ts";
import { canReplaceThreadTitle } from "../threadTitles.ts";

const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;
const providerTaskKey = (threadId: ThreadId, taskId: string) => `${threadId}:${taskId}`;

// Fallback when the in-memory description cache no longer has the task name
// (server restart, session-exit sweep, TTL/capacity eviction): earlier
// task.started/task.progress activities for the task are persisted with it.
function findTaskTitleInActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity> | undefined,
  taskId: string,
): string | undefined {
  if (!activities) {
    return undefined;
  }
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || (activity.kind !== "task.started" && activity.kind !== "task.progress")) {
      continue;
    }
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as { taskId?: unknown; title?: unknown; detail?: unknown })
        : undefined;
    if (payload?.taskId !== taskId) {
      continue;
    }
    const title =
      typeof payload.title === "string"
        ? payload.title
        : activity.kind === "task.started" && typeof payload.detail === "string"
          ? payload.detail
          : undefined;
    if (title && title.trim().length > 0) {
      return title;
    }
  }
  return undefined;
}

// Decode a persisted session binding's stored model selection. The binding's
// `runtimePayload` is opaque (`unknown | null`); the interrupted turn's
// modelSelection lives under `runtimePayload.modelSelection` when set.
const decodeModelSelectionExit = Schema.decodeUnknownExit(ModelSelection);

interface AssistantSegmentState {
  baseKey: string;
  nextSegmentIndex: number;
  activeMessageId: MessageId | null;
}

const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 10_000;
const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(120);
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 20_000;
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(120);
const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = 10_000;
const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(120);
const TASK_DESCRIPTION_BY_TASK_CACHE_CAPACITY = 10_000;
const TASK_DESCRIPTION_BY_TASK_TTL = Duration.minutes(120);
const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
const STRICT_PROVIDER_LIFECYCLE_GUARD = process.env.T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD !== "0";

// At most this many consecutive auto-resumes per user message after a provider
// session exits mid-turn. On the next crash beyond this, give up and leave the
// turn interrupted with an "auto-resume exhausted" activity.
const AUTO_RESUME_MAX_ATTEMPTS = 2;

// Activity kinds that record the provider having executed work outside its own
// head — running a command, changing a file, calling an MCP or dynamic tool, or
// running a configured hook. Their presence on a turn is this process's durable
// proof that side effects may already have landed, which disqualifies that turn
// from automatic re-issue.
//
// The tool.* kinds are exactly what `runtimeEventToActivities` emits for the
// `item.started` / `item.updated` / `item.completed` events whose itemType
// passes `isToolLifecycleItemType`. The hook.* kinds are what it emits for
// `hook.started` / `hook.completed`; hooks are user-configured shell commands,
// so they are side-effecting by construction regardless of what the turn's
// tools did. Adding a kind there that executes anything without adding it here
// would silently re-open the duplicate-execution hole.
const SIDE_EFFECT_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "tool.started",
  "tool.updated",
  "tool.completed",
  "hook.started",
  "hook.completed",
]);

type RecoveryBoundaryDomainEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;

type RuntimeIngestionInput =
  | {
      source: "runtime";
      event: ProviderRuntimeEvent;
    }
  | {
      source: "domain";
      event: RecoveryBoundaryDomainEvent;
    };

interface ResumeSelection {
  readonly selected:
    | { readonly kind: "pending"; readonly row: ProjectionPendingTurnStart }
    | { readonly kind: "active"; readonly row: ProjectionTurnById };
  readonly targetMessageId: MessageId;
  readonly activeTurn: ProjectionTurnById | null;
  readonly evidenceSince: string;
  readonly attemptBudgetKey: MessageId;
  readonly modelSelection: ModelSelection | undefined;
  readonly sourceProposedPlan:
    | { readonly threadId: ThreadId; readonly planId: OrchestrationProposedPlanId }
    | undefined;
  readonly neverClaimedPendingOrphan: boolean;
}

function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.make(String(value));
}

function toApprovalRequestId(value: string | undefined): ApprovalRequestId | undefined {
  return value === undefined ? undefined : ApprovalRequestId.make(value);
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function hasRecoveryCheckpointEvidence(turn: ProjectionTurnById): boolean {
  return (
    turn.checkpointRef !== null ||
    turn.checkpointStatus !== null ||
    turn.checkpointFiles.length > 0 ||
    turn.checkpointTurnCount !== null
  );
}

function hasAssistantMessageForTurn(
  messages: ReadonlyArray<OrchestrationMessage>,
  turnId: TurnId,
  options?: { readonly streamingOnly?: boolean },
): boolean {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (message.role !== "assistant" || message.turnId !== turnId) {
      continue;
    }
    if (options?.streamingOnly === true && !message.streaming) {
      continue;
    }
    return true;
  }
  return false;
}

function findMessageById(
  messages: ReadonlyArray<OrchestrationMessage>,
  messageId: MessageId,
): OrchestrationMessage | undefined {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.id === messageId) {
      return message;
    }
  }
  return undefined;
}

function findProposedPlanById(
  proposedPlans: ReadonlyArray<
    Pick<OrchestrationProposedPlan, "id" | "createdAt" | "implementedAt" | "implementationThreadId">
  >,
  planId: string,
):
  | Pick<OrchestrationProposedPlan, "id" | "createdAt" | "implementedAt" | "implementationThreadId">
  | undefined {
  for (let index = 0; index < proposedPlans.length; index += 1) {
    const proposedPlan = proposedPlans[index];
    if (proposedPlan?.id === planId) {
      return proposedPlan;
    }
  }
  return undefined;
}

function hasCheckpointForTurn(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
  turnId: TurnId,
): boolean {
  for (let index = 0; index < checkpoints.length; index += 1) {
    if (checkpoints[index]?.turnId === turnId) {
      return true;
    }
  }
  return false;
}

function maxCheckpointTurnCount(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
): number {
  let maxTurnCount = 0;
  for (let index = 0; index < checkpoints.length; index += 1) {
    const checkpoint = checkpoints[index];
    if (checkpoint && checkpoint.checkpointTurnCount > maxTurnCount) {
      maxTurnCount = checkpoint.checkpointTurnCount;
    }
  }
  return maxTurnCount;
}

function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

/**
 * Cap on any single string inside a tool activity's opaque `data` blob.
 *
 * Tool payloads are the dominant consumer of the event store: on this instance
 * `item.aggregatedOutput` alone accounted for 33.7 MB — 87% of all text across
 * 9,295 tool activities — with individual rows hitting the provider's own 1 MiB
 * ceiling. Every event is also projected into `projection_thread_activities`,
 * so an uncapped payload is written twice and replayed on every reconnect.
 *
 * 32 KiB keeps a command's output readable (the p99 command here is far under
 * it) while turning a pathological 1 MiB row into a bounded one. Truncation is
 * marked inline so a reader can tell the difference between "the command
 * printed nothing more" and "we stopped recording".
 */
const MAX_ACTIVITY_DATA_STRING_CHARS = 32_768;
const MAX_ACTIVITY_DATA_DEPTH = 8;

const truncationNotice = (originalLength: number): string =>
  `\n… [truncated ${(originalLength - MAX_ACTIVITY_DATA_STRING_CHARS).toLocaleString("en-US")} more characters]`;

/**
 * Bound every string in a tool payload, structure preserved.
 *
 * `payload` is `Schema.Unknown` in the contract and the shapes come straight
 * from provider SDKs, so this walks generically rather than naming fields:
 * capping `aggregatedOutput` by name would miss the next provider's equivalent.
 * Non-string leaves, object keys, and array positions are all left intact, so
 * consumers that read a specific path still find it.
 */
function truncateActivityData(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_ACTIVITY_DATA_STRING_CHARS
      ? `${value.slice(0, MAX_ACTIVITY_DATA_STRING_CHARS)}${truncationNotice(value.length)}`
      : value;
  }
  // Depth guard: provider payloads are attacker-adjacent (a tool prints what it
  // likes) and a cyclic or absurdly nested blob must not take the ingester down.
  if (depth >= MAX_ACTIVITY_DATA_DEPTH || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => truncateActivityData(entry, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = truncateActivityData(entry, depth + 1);
  }
  return result;
}

function readActivityString(record: Record<string, unknown>, ...keys: ReadonlyArray<string>) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function readActivityNumber(record: Record<string, unknown>, ...keys: ReadonlyArray<string>) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
  }
  return undefined;
}

function normalizeSubagentActivityData(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >,
) {
  if (event.payload.itemType !== "collab_agent_tool_call") return undefined;
  const raw =
    event.payload.data &&
    typeof event.payload.data === "object" &&
    !Array.isArray(event.payload.data)
      ? (event.payload.data as Record<string, unknown>)
      : {};
  const input =
    raw.input && typeof raw.input === "object" && !Array.isArray(raw.input)
      ? (raw.input as Record<string, unknown>)
      : raw;
  const providerAgentId =
    readActivityString(raw, "providerAgentId", "agentId", "taskId", "subagentId", "toolUseId") ??
    readActivityString(input, "agent_id", "agentId", "task_id", "taskId") ??
    event.providerRefs?.providerItemId ??
    event.itemId;
  if (!providerAgentId) return undefined;
  const explicitState = readActivityString(raw, "state", "status");
  const state =
    explicitState === "suspended"
      ? "suspended"
      : explicitState === "failed" || event.payload.status === "failed"
        ? "failed"
        : event.type === "item.completed"
          ? "completed"
          : event.type === "item.started"
            ? "spawned"
            : "running";
  const background =
    raw.background === true ||
    input.background === true ||
    readActivityString(raw, "mode") === "background";
  const rawUsage =
    raw.usage && typeof raw.usage === "object" && !Array.isArray(raw.usage)
      ? (raw.usage as Record<string, unknown>)
      : undefined;
  const usage = rawUsage
    ? {
        ...(readActivityNumber(rawUsage, "uncachedInputTokens", "inputOther") === undefined
          ? {}
          : {
              uncachedInputTokens: readActivityNumber(
                rawUsage,
                "uncachedInputTokens",
                "inputOther",
              ),
            }),
        ...(readActivityNumber(rawUsage, "cacheReadInputTokens", "inputCacheRead") === undefined
          ? {}
          : {
              cacheReadInputTokens: readActivityNumber(
                rawUsage,
                "cacheReadInputTokens",
                "inputCacheRead",
              ),
            }),
        ...(readActivityNumber(rawUsage, "cacheWriteInputTokens", "inputCacheCreation") ===
        undefined
          ? {}
          : {
              cacheWriteInputTokens: readActivityNumber(
                rawUsage,
                "cacheWriteInputTokens",
                "inputCacheCreation",
              ),
            }),
        ...(readActivityNumber(rawUsage, "outputTokens", "output") === undefined
          ? {}
          : { outputTokens: readActivityNumber(rawUsage, "outputTokens", "output") }),
        ...(readActivityNumber(rawUsage, "reasoningOutputTokens") === undefined
          ? {}
          : {
              reasoningOutputTokens: readActivityNumber(rawUsage, "reasoningOutputTokens"),
            }),
        ...(readActivityNumber(rawUsage, "durationMs") === undefined
          ? {}
          : { durationMs: readActivityNumber(rawUsage, "durationMs") }),
        ...(typeof rawUsage.costUsd === "number" && Number.isFinite(rawUsage.costUsd)
          ? { costUsd: Math.max(0, rawUsage.costUsd) }
          : {}),
      }
    : undefined;
  return {
    provider: event.provider,
    providerAgentId,
    ...((readActivityString(raw, "name", "agentName") ??
    readActivityString(input, "name", "agent_name"))
      ? {
          name:
            readActivityString(raw, "name", "agentName") ??
            readActivityString(input, "name", "agent_name"),
        }
      : {}),
    ...((readActivityString(raw, "agentType", "type", "subagentType") ??
    readActivityString(input, "subagent_type", "agent_type"))
      ? {
          agentType:
            readActivityString(raw, "agentType", "type", "subagentType") ??
            readActivityString(input, "subagent_type", "agent_type"),
        }
      : {}),
    ...((readActivityString(raw, "description", "prompt") ??
    readActivityString(input, "description", "prompt"))
      ? {
          description:
            readActivityString(raw, "description", "prompt") ??
            readActivityString(input, "description", "prompt"),
        }
      : {}),
    ...(readActivityString(raw, "parentToolCallId", "parentId")
      ? { parentToolCallId: readActivityString(raw, "parentToolCallId", "parentId") }
      : {}),
    ...(readActivityNumber(raw, "swarmIndex", "swarmPosition") === undefined
      ? {}
      : { swarmIndex: readActivityNumber(raw, "swarmIndex", "swarmPosition") }),
    ...(readActivityNumber(raw, "swarmSize") === undefined
      ? {}
      : { swarmSize: readActivityNumber(raw, "swarmSize") }),
    mode: background ? ("background" as const) : ("foreground" as const),
    state,
    ...(readActivityString(raw, "resultSummary", "summary", "result")
      ? { resultSummary: readActivityString(raw, "resultSummary", "summary", "result") }
      : {}),
    ...(readActivityString(raw, "errorSummary", "error")
      ? { errorSummary: readActivityString(raw, "errorSummary", "error") }
      : {}),
    ...(usage !== undefined && Object.keys(usage).length > 0 ? { usage } : {}),
  };
}

function toolActivityId(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >,
) {
  const subagent = normalizeSubagentActivityData(event);
  return subagent
    ? EventId.make(`subagent:${event.provider}:${subagent.providerAgentId}`)
    : event.eventId;
}

function normalizeProposedPlanMarkdown(planMarkdown: string | undefined): string | undefined {
  const trimmed = planMarkdown?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function hasRenderableAssistantText(text: string | undefined): boolean {
  return (text?.trim().length ?? 0) > 0;
}

function proposedPlanIdForTurn(threadId: ThreadId, turnId: TurnId): string {
  return `plan:${threadId}:turn:${turnId}`;
}

function proposedPlanIdFromEvent(event: ProviderRuntimeEvent, threadId: ThreadId): string {
  const turnId = toTurnId(event.turnId);
  if (turnId) {
    return proposedPlanIdForTurn(threadId, turnId);
  }
  if (event.itemId) {
    return `plan:${threadId}:item:${event.itemId}`;
  }
  return `plan:${threadId}:event:${event.eventId}`;
}

function assistantSegmentBaseKeyFromEvent(event: ProviderRuntimeEvent): string {
  return String(event.itemId ?? event.turnId ?? event.eventId);
}

function assistantSegmentMessageId(baseKey: string, segmentIndex: number): MessageId {
  return MessageId.make(
    segmentIndex === 0 ? `assistant:${baseKey}` : `assistant:${baseKey}:segment:${segmentIndex}`,
  );
}
function buildContextWindowActivityPayload(
  event: ProviderRuntimeEvent,
): ThreadTokenUsageSnapshot | undefined {
  if (event.type !== "thread.token-usage.updated" || event.payload.usage.usedTokens <= 0) {
    return undefined;
  }
  return event.payload.usage;
}

function finiteUsageInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function usageRecordFromTokenSnapshot(
  event: Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }>,
  model: string | undefined,
  workload: "interactive" | "automation",
) {
  if (!event.turnId) return undefined;
  const usage = event.payload.usage;
  const input = usage.lastInputTokens ?? usage.inputTokens;
  const cacheRead = usage.lastCachedInputTokens ?? usage.cachedInputTokens;
  const cacheWrite = usage.lastCacheWriteInputTokens ?? usage.cacheWriteInputTokens;
  const output = usage.lastOutputTokens ?? usage.outputTokens;
  const uncached =
    input === undefined ? undefined : Math.max(0, input - (cacheRead ?? 0) - (cacheWrite ?? 0));
  if (
    uncached === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    output === undefined
  ) {
    return undefined;
  }
  return {
    component: { kind: "main" as const, id: "main" },
    ...(model ? { model } : {}),
    workload,
    quality: "derived" as const,
    ...(uncached !== undefined ? { uncachedInputTokens: uncached } : {}),
    ...(cacheRead !== undefined ? { cacheReadInputTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteInputTokens: cacheWrite } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...((usage.lastReasoningOutputTokens ?? usage.reasoningOutputTokens) !== undefined
      ? {
          reasoningOutputTokens:
            usage.lastReasoningOutputTokens ?? usage.reasoningOutputTokens ?? 0,
        }
      : {}),
    contextUsedTokens: usage.usedTokens,
    ...(usage.maxTokens !== undefined ? { contextLimitTokens: usage.maxTokens } : {}),
    ...(usage.durationMs !== undefined ? { durationMs: usage.durationMs } : {}),
    ...(usage.toolUses !== undefined ? { toolUses: usage.toolUses } : {}),
    completedAt: event.createdAt,
  };
}

function usageRecordFromTurnCompletion(
  event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
  model: string | undefined,
  workload: "interactive" | "automation",
) {
  if (!event.turnId) return undefined;
  const raw =
    event.payload.usage &&
    typeof event.payload.usage === "object" &&
    !Array.isArray(event.payload.usage)
      ? (event.payload.usage as Record<string, unknown>)
      : undefined;
  const iterations = Array.isArray(raw?.iterations) ? raw.iterations : [];
  const lastIteration = iterations.findLast(
    (value): value is Record<string, unknown> =>
      value !== null && typeof value === "object" && !Array.isArray(value),
  );
  const usage = lastIteration ?? raw;
  const uncached = finiteUsageInteger(usage?.input_tokens ?? usage?.inputTokens);
  const cacheRead = finiteUsageInteger(usage?.cache_read_input_tokens ?? usage?.cachedInputTokens);
  const cacheWrite = finiteUsageInteger(
    usage?.cache_creation_input_tokens ?? usage?.cacheWriteInputTokens,
  );
  const output = finiteUsageInteger(usage?.output_tokens ?? usage?.outputTokens);
  const reasoning = finiteUsageInteger(
    usage?.reasoning_output_tokens ?? usage?.reasoningOutputTokens,
  );
  if (
    uncached === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    output === undefined &&
    event.payload.totalCostUsd === undefined
  ) {
    // Codex records the authoritative per-turn counters on its token snapshot,
    // and Kimi emits an explicit canonical usage event before completion. Do
    // not replace either richer row with an empty terminal marker.
    if (event.provider === "codex" || event.provider === "kimi") return undefined;
  }
  const hasReportedMetrics =
    uncached !== undefined ||
    cacheRead !== undefined ||
    cacheWrite !== undefined ||
    output !== undefined ||
    event.payload.totalCostUsd !== undefined;
  return {
    component: { kind: "main" as const, id: "main" },
    ...(model ? { model } : {}),
    workload,
    quality: hasReportedMetrics ? ("reported" as const) : ("partial" as const),
    ...(uncached !== undefined ? { uncachedInputTokens: uncached } : {}),
    ...(cacheRead !== undefined ? { cacheReadInputTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteInputTokens: cacheWrite } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(reasoning !== undefined ? { reasoningOutputTokens: reasoning } : {}),
    ...(event.payload.totalCostUsd !== undefined
      ? { providerReportedCostUsd: event.payload.totalCostUsd }
      : {}),
    completedAt: event.createdAt,
  };
}

function normalizeRuntimeTurnState(
  value: string | undefined,
): "completed" | "failed" | "interrupted" | "cancelled" {
  switch (value) {
    case "failed":
    case "interrupted":
    case "cancelled":
    case "completed":
      return value;
    default:
      return "completed";
  }
}

function terminalTurnStateFromRuntimeTurnState(
  state: "completed" | "failed" | "interrupted" | "cancelled",
): "completed" | "interrupted" | "error" {
  switch (state) {
    case "completed":
      return "completed";
    case "failed":
      return "error";
    case "interrupted":
    case "cancelled":
      return "interrupted";
  }
}

function orchestrationSessionStatusFromRuntimeState(
  state: "starting" | "running" | "waiting" | "ready" | "interrupted" | "stopped" | "error",
): "starting" | "running" | "ready" | "interrupted" | "stopped" | "error" {
  switch (state) {
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "ready":
      return "ready";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
  }
}

function sessionStatusAllowsActiveTurn(
  status: ReturnType<typeof orchestrationSessionStatusFromRuntimeState>,
): boolean {
  return status === "starting" || status === "running";
}

function requestKindFromCanonicalRequestType(
  requestType: string | undefined,
): "command" | "file-read" | "file-change" | undefined {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return undefined;
  }
}

/**
 * Copies the optional TaskAgentLinkage bundle from a task.* runtime payload
 * into the persisted activity payload. Identity fields ride on every row so
 * client folds survive activity retention; absent fields stay absent.
 */
function taskLinkageActivityFields(payload: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    // Server-stamped classification: persisted rows are self-describing, so
    // clients trust the stamp instead of re-deriving agent-vs-background
    // from taskType denylists and marker heuristics (legacy rows without a
    // stamp keep the client fallback).
    agentKind: classifyTaskAgentKind({
      taskType: typeof payload.taskType === "string" ? payload.taskType : undefined,
      agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
    }),
  };
  for (const key of [
    "taskType",
    "agentId",
    "title",
    "role",
    "model",
    "effort",
    "toolUseId",
    "parentAgentId",
    "workflowName",
    "agentIndex",
    "phaseIndex",
    "phaseTitle",
    "phases",
    "attempt",
    "runHandles",
    "outputFile",
    "agentPath",
    "timelineBypass",
    "typedUsage",
    "status",
    "error",
  ] as const) {
    if (payload[key] !== undefined) {
      fields[key] = payload[key];
    }
  }
  return fields;
}

export function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
  taskTitle?: string,
): ReadonlyArray<OrchestrationThreadActivity> {
  const maybeSequence = (() => {
    const eventWithSequence = event as ProviderRuntimeEvent & { sessionSequence?: number };
    return eventWithSequence.sessionSequence !== undefined
      ? { sequence: eventWithSequence.sessionSequence }
      : {};
  })();
  switch (event.type) {
    case "request.opened": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.requested",
          summary:
            requestKind === "command"
              ? "Command approval requested"
              : requestKind === "file-read"
                ? "File-read approval requested"
                : requestKind === "file-change"
                  ? "File-change approval requested"
                  : "Approval requested",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.detail ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "request.resolved": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.resolved",
          summary: "Approval resolved",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.decision ? { decision: event.payload.decision } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.error": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.error",
          summary: "Runtime error",
          payload: {
            message: truncateDetail(event.payload.message),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "tool.denied": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "tool.denied",
          summary: `Tool denied: ${event.payload.toolName}`,
          payload: {
            toolName: event.payload.toolName,
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.reason ? { detail: truncateDetail(event.payload.reason) } : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.warning": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.warning",
          // Use the adapter-supplied message as the row label so the work log
          // shows what the warning was about, not a generic "Runtime warning".
          summary: truncateDetail(event.payload.message, 120),
          payload: {
            message: truncateDetail(event.payload.message),
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.plan.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "turn.plan.updated",
          summary: "Plan updated",
          payload: {
            plan: event.payload.plan,
            ...(event.payload.explanation !== undefined
              ? { explanation: event.payload.explanation }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.requested": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            questions: event.payload.questions,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.resolved": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.resolved",
          summary: "User input submitted",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            answers: event.payload.answers,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.started": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.started",
          summary:
            event.payload.taskType === "plan"
              ? "Plan task started"
              : event.payload.taskType
                ? `${event.payload.taskType} task started`
                : "Task started",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.taskType ? { taskType: event.payload.taskType } : {}),
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
            ...taskLinkageActivityFields(event.payload as Record<string, unknown>),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.progress": {
      const linkage = taskLinkageActivityFields(event.payload as Record<string, unknown>);
      // Usage and activity are independent latest-state streams. Keeping them
      // under separate stable ids prevents a command/reasoning update from
      // replacing the last known token count (and prevents a usage-only tick
      // from blanking the last meaningful activity).
      const identityLinkage = { ...linkage };
      delete identityLinkage.typedUsage;
      delete identityLinkage.status;
      delete identityLinkage.error;
      const title =
        event.payload.description.trim().length > 0
          ? { title: truncateDetail(event.payload.description, 120) }
          : {};
      const hasProgressState =
        event.payload.typedUsage === undefined ||
        event.payload.summary !== undefined ||
        event.payload.lastToolName !== undefined ||
        event.payload.status !== undefined ||
        event.payload.error !== undefined;
      return [
        ...(hasProgressState
          ? [
              {
                // Stable per-task id: activity is "latest state", not
                // history, so each meaningful tick replaces the last. This
                // bounds a large fleet to one activity row per task.
                id: EventId.make(`task-progress:${event.threadId}:${event.payload.taskId}`),
                createdAt: event.createdAt,
                tone: "info" as const,
                kind: "task.progress" as const,
                summary:
                  event.payload.description.trim().length > 0
                    ? truncateDetail(event.payload.description, 120)
                    : "Reasoning update",
                payload: {
                  taskId: event.payload.taskId,
                  ...title,
                  detail: truncateDetail(event.payload.summary ?? event.payload.description),
                  ...(event.payload.summary
                    ? { summary: truncateDetail(event.payload.summary) }
                    : {}),
                  ...(event.payload.lastToolName
                    ? { lastToolName: event.payload.lastToolName }
                    : {}),
                  ...(event.payload.status ? { status: event.payload.status } : {}),
                  ...(event.payload.error ? { error: event.payload.error } : {}),
                  ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
                  ...identityLinkage,
                },
                turnId: toTurnId(event.turnId) ?? null,
                ...maybeSequence,
              },
            ]
          : []),
        ...(event.payload.typedUsage !== undefined
          ? [
              {
                id: EventId.make(`task-usage:${event.threadId}:${event.payload.taskId}`),
                createdAt: event.createdAt,
                tone: "info" as const,
                kind: "task.progress" as const,
                summary: "Task usage updated",
                payload: {
                  taskId: event.payload.taskId,
                  ...title,
                  ...identityLinkage,
                  usageSnapshot: true,
                  typedUsage: event.payload.typedUsage,
                },
                turnId: toTurnId(event.turnId) ?? null,
                ...maybeSequence,
              },
            ]
          : []),
      ];
    }

    case "task.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.updated",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status
                ? `Task ${event.payload.status}`
                : "Task updated",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
            ...(event.payload.endedAt ? { endedAt: event.payload.endedAt } : {}),
            ...(event.payload.isBackgrounded !== undefined
              ? { isBackgrounded: event.payload.isBackgrounded }
              : {}),
            ...taskLinkageActivityFields(event.payload as Record<string, unknown>),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "tool.progress": {
      // Only agent-owned heartbeats are persisted: they feed the owning
      // agent's activity line. Parent-conversation tool progress stays
      // ephemeral (item lifecycle already covers it).
      if (event.payload.taskId === undefined) {
        return [];
      }
      return [
        {
          // Same stable-id treatment as task.progress: a heartbeat is
          // "what is this agent doing right now", so one row per task
          // (thread-scoped for the same global-PK collision reason).
          id: EventId.make(`tool-progress:${event.threadId}:${event.payload.taskId}`),
          createdAt: event.createdAt,
          tone: "info",
          kind: "tool.progress",
          summary: event.payload.toolName ?? "Tool progress",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.toolName ? { toolName: event.payload.toolName } : {}),
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.elapsedSeconds !== undefined
              ? { elapsedSeconds: event.payload.elapsedSeconds }
              : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.completed": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.completed",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status === "stopped"
                ? "Task stopped"
                : "Task completed",
          payload: {
            taskId: event.payload.taskId,
            status: event.payload.status,
            ...(taskTitle ? { title: truncateDetail(taskTitle, 120) } : {}),
            // summary + detail mirror task.progress: clients label the row from
            // summary and keep detail for the preview/expanded body.
            ...(event.payload.summary
              ? {
                  summary: truncateDetail(event.payload.summary),
                  detail: truncateDetail(event.payload.summary),
                }
              : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...taskLinkageActivityFields(event.payload as Record<string, unknown>),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.state.changed": {
      if (event.payload.state !== "compacted") {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-compaction",
          summary: "Context compacted",
          payload: {
            state: event.payload.state,
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.token-usage.updated": {
      const payload = buildContextWindowActivityPayload(event);
      if (!payload) {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.updated": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      // A streaming update's `data` carries the full tool output accumulated
      // so far (adapters merge state forward), and a new activity is emitted
      // per chunk, so persisting `data` verbatim writes O(N²) bytes per tool
      // call into both the event store and the projection table. No reader
      // needs it: ws.ts and http.ts apply `projectActivityPayload` before any
      // payload reaches a client. Persist the projected form for non-terminal
      // updates; `item.completed` below still persists the full payload.
      return [
        projectActivityPayload({
          id: toolActivityId(event),
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.updated",
          summary: event.payload.title ?? "Tool updated",
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(normalizeSubagentActivityData(event)
              ? { data: normalizeSubagentActivityData(event) }
              : event.payload.data !== undefined
                ? { data: truncateActivityData(event.payload.data) }
                : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        }),
      ];
    }

    case "item.completed": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: toolActivityId(event),
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.completed",
          summary: event.payload.title ?? "Tool",
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(normalizeSubagentActivityData(event)
              ? { data: normalizeSubagentActivityData(event) }
              : event.payload.data !== undefined
                ? { data: truncateActivityData(event.payload.data) }
                : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.started": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: toolActivityId(event),
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.started",
          summary: `${event.payload.title ?? "Tool"} started`,
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(normalizeSubagentActivityData(event)
              ? { data: normalizeSubagentActivityData(event) }
              : event.payload.data !== undefined
                ? { data: truncateActivityData(event.payload.data) }
                : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    // Hooks are provider-configured shell commands that run around a turn
    // (Claude maps `hook_started`/`hook_progress`/`hook_response` here). They
    // execute on the user's machine and can do anything a command can, so they
    // are side-effecting work in exactly the sense the auto-resume gate cares
    // about — but they are NOT `item.*` events and so produced no activity at
    // all until now. That made them invisible twice over: absent from the
    // transcript, and absent from the durable record the resume gate reads,
    // meaning a crash right after a side-effecting hook still looked safe to
    // re-issue.
    case "hook.started": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "hook.started",
          summary: `Hook ${event.payload.hookName} started`,
          payload: {
            hookId: event.payload.hookId,
            hookName: event.payload.hookName,
            hookEvent: event.payload.hookEvent,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "hook.completed": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.outcome === "error" ? "error" : "tool",
          kind: "hook.completed",
          summary: `Hook finished (${event.payload.outcome})`,
          payload: {
            hookId: event.payload.hookId,
            outcome: event.payload.outcome,
            ...(event.payload.exitCode !== undefined ? { exitCode: event.payload.exitCode } : {}),
            ...(event.payload.output ? { detail: truncateDetail(event.payload.output) } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    default:
      break;
  }

  return [];
}

const make = Effect.gen(function* () {
  const threadBackgroundLiveness = yield* ThreadBackgroundLivenessService;
  const threadPlanProgress = yield* ThreadPlanProgressService;
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const providerTurnSendClaimRepository = yield* ProviderTurnSendClaimRepository;
  const serverSettingsService = yield* ServerSettingsService;
  const projectionTurnUsageRepository = yield* ProjectionTurnUsageRepository;
  const providerCommandId = (event: ProviderRuntimeEvent, tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`provider:${event.eventId}:${tag}:${uuid}`)),
    );

  // In-memory crash-loop guard for session-exit auto-resume. Deliberately NOT
  // durable: auto-resume should only fire for live crashes within a server's
  // lifetime — after a restart, reconcileOrphanedTurns settles orphaned turns to
  // interrupted (no resume), and a fresh budget is fine. Keyed by thread; each
  // entry tracks the user message being resumed and how many consecutive
  // auto-resumes have fired for it.
  const autoResumeAttemptsByThreadId = yield* Ref.make(
    new Map<ThreadId, { readonly messageId: MessageId; readonly attempts: number }>(),
  );
  // Recovery evidence is a worker-lifetime safety invariant. Once any
  // non-interruption evidence read or write fails, no later runtime event can
  // prove this worker's recovery history complete, even for another thread.
  const evidencePersistenceDegraded = yield* Ref.make(false);

  const markRecoveryEvidenceDegraded = Effect.fn("markRecoveryEvidenceDegraded")(function* (
    threadId: ThreadId,
    evidenceKind: string,
    cause: Cause.Cause<unknown>,
  ) {
    yield* Ref.set(evidencePersistenceDegraded, true);
    yield* Effect.logError("provider-runtime.recovery-evidence-state-degraded", {
      threadId,
      evidenceKind,
      cause: Cause.pretty(cause),
    });
  });

  const persistRecoveryEvidence = <E, R>(
    threadId: ThreadId,
    evidenceKind: string,
    effect: Effect.Effect<void, E, R>,
  ): Effect.Effect<void, E, R> =>
    effect.pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return markRecoveryEvidenceDegraded(threadId, evidenceKind, cause).pipe(
          Effect.andThen(Effect.failCause(cause)),
        );
      }),
    );

  const turnMessageIdsByTurnKey = yield* Cache.make<string, Set<MessageId>>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () => Effect.succeed(new Set<MessageId>()),
  });

  const bufferedAssistantTextByMessageId = yield* Cache.make<MessageId, string>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(""),
  });

  const assistantSegmentStateByTurnKey = yield* Cache.make<string, AssistantSegmentState>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () =>
      Effect.die(
        new Error("assistant segment state should be read through getOption before initialization"),
      ),
  });

  const bufferedProposedPlanById = yield* Cache.make<string, { text: string; createdAt: string }>({
    capacity: BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_PROPOSED_PLAN_BY_ID_TTL,
    lookup: () => Effect.succeed({ text: "", createdAt: "" }),
  });

  // Task names arrive on task.started/task.progress but not on task.completed,
  // so remember them per task to title the completion activity.
  const taskDescriptionByTaskKey = yield* Cache.make<string, string>({
    capacity: TASK_DESCRIPTION_BY_TASK_CACHE_CAPACITY,
    timeToLive: TASK_DESCRIPTION_BY_TASK_TTL,
    lookup: () => Effect.succeed(""),
  });

  const rememberTaskDescription = (threadId: ThreadId, taskId: string, description: string) =>
    Cache.set(taskDescriptionByTaskKey, providerTaskKey(threadId, taskId), description);

  // Entries are left in place after completion so replayed or duplicate
  // terminal events stay titled; TTL, capacity, and the session-exit sweep
  // bound the cache.
  const lookupTaskDescription = (threadId: ThreadId, taskId: string) =>
    Cache.getOption(taskDescriptionByTaskKey, providerTaskKey(threadId, taskId)).pipe(
      Effect.map((description) =>
        Option.filter(description, (value) => value.length > 0).pipe(Option.getOrUndefined),
      ),
    );

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadShell = Effect.fn("resolveThreadShell")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const rememberAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Cache.set(
          turnMessageIdsByTurnKey,
          providerTurnKey(threadId, turnId),
          Option.match(existingIds, {
            onNone: () => new Set([messageId]),
            onSome: (ids) => {
              const nextIds = new Set(ids);
              nextIds.add(messageId);
              return nextIds;
            },
          }),
        ),
      ),
    );

  const forgetAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Option.match(existingIds, {
          onNone: () => Effect.void,
          onSome: (ids) => {
            const nextIds = new Set(ids);
            nextIds.delete(messageId);
            if (nextIds.size === 0) {
              return Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));
            }
            return Cache.set(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId), nextIds);
          },
        }),
      ),
    );

  const getAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.map((existingIds) =>
        Option.getOrElse(existingIds, (): Set<MessageId> => new Set<MessageId>()),
      ),
    );

  const clearAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));

  const getAssistantSegmentStateForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(assistantSegmentStateByTurnKey, providerTurnKey(threadId, turnId));

  const setAssistantSegmentStateForTurn = (
    threadId: ThreadId,
    turnId: TurnId,
    state: AssistantSegmentState,
  ) => Cache.set(assistantSegmentStateByTurnKey, providerTurnKey(threadId, turnId), state);

  const clearAssistantSegmentStateForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(assistantSegmentStateByTurnKey, providerTurnKey(threadId, turnId));

  const getActiveAssistantMessageIdForTurn = (threadId: ThreadId, turnId: TurnId) =>
    getAssistantSegmentStateForTurn(threadId, turnId).pipe(
      Effect.map((state) =>
        Option.flatMap(state, (entry) =>
          entry.activeMessageId ? Option.some(entry.activeMessageId) : Option.none(),
        ),
      ),
    );

  const startAssistantSegmentForTurn = (input: {
    threadId: ThreadId;
    turnId: TurnId;
    baseKey: string;
  }) =>
    getAssistantSegmentStateForTurn(input.threadId, input.turnId).pipe(
      Effect.flatMap((existingState) =>
        Effect.gen(function* () {
          const nextState = Option.match(existingState, {
            onNone: () => ({
              baseKey: input.baseKey,
              nextSegmentIndex: 1,
              activeMessageId: assistantSegmentMessageId(input.baseKey, 0),
            }),
            onSome: (state) => {
              const segmentIndex = state.baseKey === input.baseKey ? state.nextSegmentIndex : 0;
              const messageId = assistantSegmentMessageId(input.baseKey, segmentIndex);
              return {
                baseKey: input.baseKey,
                nextSegmentIndex: state.baseKey === input.baseKey ? state.nextSegmentIndex + 1 : 1,
                activeMessageId: messageId,
              } satisfies AssistantSegmentState;
            },
          });
          yield* setAssistantSegmentStateForTurn(input.threadId, input.turnId, nextState);
          return nextState.activeMessageId!;
        }),
      ),
    );

  const getOrCreateAssistantMessageId = (input: {
    threadId: ThreadId;
    event: ProviderRuntimeEvent;
    turnId?: TurnId;
  }) =>
    Effect.gen(function* () {
      if (!input.turnId) {
        return assistantSegmentMessageId(assistantSegmentBaseKeyFromEvent(input.event), 0);
      }

      const activeMessageId = yield* getActiveAssistantMessageIdForTurn(
        input.threadId,
        input.turnId,
      );
      if (Option.isSome(activeMessageId)) {
        return activeMessageId.value;
      }

      return yield* startAssistantSegmentForTurn({
        threadId: input.threadId,
        turnId: input.turnId,
        baseKey: assistantSegmentBaseKeyFromEvent(input.event),
      });
    });

  const appendBufferedAssistantText = (messageId: MessageId, delta: string) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Effect.gen(function* () {
          const nextText = Option.match(existingText, {
            onNone: () => delta,
            onSome: (text) => `${text}${delta}`,
          });
          if (nextText.length <= MAX_BUFFERED_ASSISTANT_CHARS) {
            yield* Cache.set(bufferedAssistantTextByMessageId, messageId, nextText);
            return "";
          }

          // Safety valve: flush full buffered text as an assistant delta to cap memory.
          yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
          return nextText;
        }),
      ),
    );

  const takeBufferedAssistantText = (messageId: MessageId) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Cache.invalidate(bufferedAssistantTextByMessageId, messageId).pipe(
          Effect.as(Option.getOrElse(existingText, () => "")),
        ),
      ),
    );

  const clearBufferedAssistantText = (messageId: MessageId) =>
    Cache.invalidate(bufferedAssistantTextByMessageId, messageId);

  const appendBufferedProposedPlan = (planId: string, delta: string, createdAt: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) => {
        const existing = Option.getOrUndefined(existingEntry);
        return Cache.set(bufferedProposedPlanById, planId, {
          text: `${existing?.text ?? ""}${delta}`,
          createdAt:
            existing?.createdAt && existing.createdAt.length > 0 ? existing.createdAt : createdAt,
        });
      }),
    );

  const takeBufferedProposedPlan = (planId: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) =>
        Cache.invalidate(bufferedProposedPlanById, planId).pipe(
          Effect.as(Option.getOrUndefined(existingEntry)),
        ),
      ),
    );

  const clearBufferedProposedPlan = (planId: string) =>
    Cache.invalidate(bufferedProposedPlanById, planId);

  const clearAssistantMessageState = (messageId: MessageId) =>
    clearBufferedAssistantText(messageId);

  const flushBufferedAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
  }) =>
    Effect.gen(function* () {
      const bufferedText = yield* takeBufferedAssistantText(input.messageId);
      if (!hasRenderableAssistantText(bufferedText)) {
        return false;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: yield* providerCommandId(input.event, input.commandTag),
        threadId: input.threadId,
        messageId: input.messageId,
        delta: bufferedText,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
      });
      return true;
    });

  const flushBufferedAssistantMessagesForTurn = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
  }) =>
    Effect.gen(function* () {
      const assistantMessageIds = yield* getAssistantMessageIdsForTurn(
        input.threadId,
        input.turnId,
      );
      const flushedMessageIds = new Set<MessageId>();
      yield* Effect.forEach(
        assistantMessageIds,
        (messageId) =>
          flushBufferedAssistantMessage({
            event: input.event,
            threadId: input.threadId,
            messageId,
            turnId: input.turnId,
            createdAt: input.createdAt,
            commandTag: input.commandTag,
          }).pipe(
            Effect.tap((flushed) =>
              flushed ? Effect.sync(() => flushedMessageIds.add(messageId)) : Effect.void,
            ),
          ),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      return flushedMessageIds;
    });

  const finalizeAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    fallbackText?: string;
    hasProjectedMessage?: boolean;
  }) =>
    Effect.gen(function* () {
      const bufferedText = yield* takeBufferedAssistantText(input.messageId);
      const text =
        bufferedText.length > 0
          ? bufferedText
          : (input.fallbackText?.trim().length ?? 0) > 0
            ? input.fallbackText!
            : "";
      const hasRenderableText = hasRenderableAssistantText(text);

      if (hasRenderableText) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: yield* providerCommandId(input.event, input.finalDeltaCommandTag),
          threadId: input.threadId,
          messageId: input.messageId,
          delta: text,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }

      if (input.hasProjectedMessage || hasRenderableText) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: yield* providerCommandId(input.event, input.commandTag),
          threadId: input.threadId,
          messageId: input.messageId,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }
      yield* clearAssistantMessageState(input.messageId);
    });

  const finalizeActiveAssistantSegmentForTurn = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    hasProjectedMessage: boolean;
    flushedMessageIds?: ReadonlySet<MessageId>;
  }) =>
    Effect.gen(function* () {
      const activeMessageId = yield* getActiveAssistantMessageIdForTurn(
        input.threadId,
        input.turnId,
      );
      if (Option.isNone(activeMessageId)) {
        return;
      }

      yield* finalizeAssistantMessage({
        event: input.event,
        threadId: input.threadId,
        messageId: activeMessageId.value,
        turnId: input.turnId,
        createdAt: input.createdAt,
        commandTag: input.commandTag,
        finalDeltaCommandTag: input.finalDeltaCommandTag,
        hasProjectedMessage:
          input.hasProjectedMessage ||
          (input.flushedMessageIds?.has(activeMessageId.value) ?? false),
      });
      yield* forgetAssistantMessageId(input.threadId, input.turnId, activeMessageId.value);

      const state = yield* getAssistantSegmentStateForTurn(input.threadId, input.turnId);
      if (Option.isSome(state)) {
        yield* setAssistantSegmentStateForTurn(input.threadId, input.turnId, {
          ...state.value,
          activeMessageId: null,
        });
      }
    });

  const upsertProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    planMarkdown: string | undefined;
    createdAt: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const planMarkdown = normalizeProposedPlanMarkdown(input.planMarkdown);
      if (!planMarkdown) {
        return;
      }

      const existingPlan = findProposedPlanById(input.threadProposedPlans, input.planId);
      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: yield* providerCommandId(input.event, "proposed-plan-upsert"),
        threadId: input.threadId,
        proposedPlan: {
          id: input.planId,
          turnId: input.turnId ?? null,
          planMarkdown,
          implementedAt: existingPlan?.implementedAt ?? null,
          implementationThreadId: existingPlan?.implementationThreadId ?? null,
          createdAt: existingPlan?.createdAt ?? input.createdAt,
          updatedAt: input.updatedAt,
        },
        createdAt: input.updatedAt,
      });
    });

  const finalizeBufferedProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    fallbackMarkdown?: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const bufferedPlan = yield* takeBufferedProposedPlan(input.planId);
      const bufferedMarkdown = normalizeProposedPlanMarkdown(bufferedPlan?.text);
      const fallbackMarkdown = normalizeProposedPlanMarkdown(input.fallbackMarkdown);
      const planMarkdown = bufferedMarkdown ?? fallbackMarkdown;
      if (!planMarkdown) {
        return;
      }

      yield* upsertProposedPlan({
        event: input.event,
        threadId: input.threadId,
        threadProposedPlans: input.threadProposedPlans,
        planId: input.planId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        planMarkdown,
        createdAt:
          bufferedPlan?.createdAt && bufferedPlan.createdAt.length > 0
            ? bufferedPlan.createdAt
            : input.updatedAt,
        updatedAt: input.updatedAt,
      });
      yield* clearBufferedProposedPlan(input.planId);
    });

  const clearTurnStateForSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const prefix = `${threadId}:`;
      const proposedPlanPrefix = `plan:${threadId}:`;
      const turnKeys = Array.from(yield* Cache.keys(turnMessageIdsByTurnKey));
      const assistantSegmentKeys = Array.from(yield* Cache.keys(assistantSegmentStateByTurnKey));
      const proposedPlanKeys = Array.from(yield* Cache.keys(bufferedProposedPlanById));
      const taskDescriptionKeys = Array.from(yield* Cache.keys(taskDescriptionByTaskKey));
      yield* Effect.forEach(
        turnKeys,
        (key) =>
          Effect.gen(function* () {
            if (!key.startsWith(prefix)) {
              return;
            }

            const messageIds = yield* Cache.getOption(turnMessageIdsByTurnKey, key);
            if (Option.isSome(messageIds)) {
              yield* Effect.forEach(messageIds.value, clearAssistantMessageState, {
                concurrency: 1,
              }).pipe(Effect.asVoid);
            }

            yield* Cache.invalidate(turnMessageIdsByTurnKey, key);
          }),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        assistantSegmentKeys,
        (key) =>
          key.startsWith(prefix)
            ? Cache.invalidate(assistantSegmentStateByTurnKey, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        proposedPlanKeys,
        (key) =>
          key.startsWith(proposedPlanPrefix)
            ? Cache.invalidate(bufferedProposedPlanById, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        taskDescriptionKeys,
        (key) =>
          key.startsWith(prefix) ? Cache.invalidate(taskDescriptionByTaskKey, key) : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
    });

  // Selects the exact placeholder the projector will adopt for this
  // `turn.started`. Keeping the row, rather than resolving only its source-plan
  // reference, also carries the pending interrupt flag into the in-memory and
  // client projectors through the terminal transition on the session-set.
  const getPendingTurnStartForAdoption = Effect.fn("getPendingTurnStartForAdoption")(function* (
    threadId: ThreadId,
    adoption: "none" | "exact" | "oldest-pending",
    requestSequence: number | undefined,
  ) {
    if (adoption === "none") {
      return null;
    }
    if (adoption === "oldest-pending") {
      return Option.getOrNull(
        yield* projectionTurnRepository.getPendingTurnStartByThreadId({ threadId }),
      );
    }
    if (requestSequence === undefined) {
      return null;
    }
    const rows = yield* projectionTurnRepository.listPendingTurnStartsByThreadId({ threadId });
    return rows.find((row) => row.requestSequence === requestSequence) ?? null;
  });

  const getExpectedProviderTurnIdForThread = Effect.fn("getExpectedProviderTurnIdForThread")(
    function* (threadId: ThreadId) {
      const sessions = yield* providerService.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      return session?.activeTurnId;
    },
  );

  // The `activeTurnId` cross-check is a fallback, NOT the primary correlation,
  // and applying it to a correlated event is a false negative with real cost.
  //
  // `ProviderService.sendTurn` writes `activeTurnId` into the session directory
  // only AFTER the adapter's `sendTurn` resolves. Codex deliberately emits
  // `turn.started` before its `turn/start` response returns — that ordering is
  // supported and tested by the adapter — so a plan-backed turn arrives here
  // while the provider session still has no active turn at all. Requiring the
  // match then discards the mark for a plan the provider is at that moment
  // implementing, and nothing retries: the same accepted `turn.started` projects
  // the running turn and consumes the pending row, so the placeholder is gone by
  // the time the directory catches up. The plan stays actionable in the UI
  // forever and the user can run it a second time.
  //
  // Exact starts are already correlated by the request sequence. A genuine
  // sequence-less `turn.started` may adopt the oldest placeholder, but retains
  // the provider directory's active-turn check as its only correlation guard.
  const getPendingTurnStartForAcceptedTurnStart = Effect.fn(
    "getPendingTurnStartForAcceptedTurnStart",
  )(function* (
    threadId: ThreadId,
    eventTurnId: TurnId | undefined,
    adoption: "none" | "exact" | "oldest-pending",
    requestSequence: number | undefined,
  ) {
    if (eventTurnId === undefined || adoption === "none") {
      return null;
    }

    if (adoption === "oldest-pending") {
      const expectedTurnId = yield* getExpectedProviderTurnIdForThread(threadId);
      if (!sameId(expectedTurnId, eventTurnId)) {
        return null;
      }
    }

    return yield* getPendingTurnStartForAdoption(threadId, adoption, requestSequence);
  });

  const markSourceProposedPlanImplemented = Effect.fn("markSourceProposedPlanImplemented")(
    function* (
      sourceThreadId: ThreadId,
      sourcePlanId: OrchestrationProposedPlanId,
      implementationThreadId: ThreadId,
      implementedAt: string,
    ) {
      const sourceThread = yield* resolveThreadDetail(sourceThreadId);
      const sourcePlan = sourceThread?.proposedPlans.find((entry) => entry.id === sourcePlanId);
      if (!sourceThread || !sourcePlan || sourcePlan.implementedAt !== null) {
        return;
      }

      const commandUuid = yield* crypto.randomUUIDv4;
      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: CommandId.make(
          `provider:source-proposed-plan-implemented:${implementationThreadId}:${commandUuid}`,
        ),
        threadId: sourceThread.id,
        proposedPlan: {
          ...sourcePlan,
          implementedAt,
          implementationThreadId,
          updatedAt: implementedAt,
        },
        createdAt: implementedAt,
      });
    },
  );

  const resolveActivityCorrelation = Effect.fn("resolveActivityCorrelation")(
    function* (threadId: ThreadId, runtimeTurnId: TurnId | undefined, activeTurnId: TurnId | null) {
      if (runtimeTurnId !== undefined) {
        const runtimeTurn = yield* projectionTurnRepository.getByTurnId({
          threadId,
          turnId: runtimeTurnId,
        });
        if (Option.isSome(runtimeTurn) && runtimeTurn.value.pendingMessageId !== null) {
          return runtimeTurn.value.pendingMessageId;
        }
        return null;
      }

      if (activeTurnId !== null && !sameId(activeTurnId, runtimeTurnId)) {
        const activeTurn = yield* projectionTurnRepository.getByTurnId({
          threadId,
          turnId: activeTurnId,
        });
        if (Option.isSome(activeTurn) && activeTurn.value.pendingMessageId !== null) {
          return activeTurn.value.pendingMessageId;
        }
      }

      const pendingRows = yield* projectionTurnRepository.listPendingTurnStartsByThreadId({
        threadId,
      });
      return (
        pendingRows
          .filter((row) => !row.pendingInterruptRequested)
          .toSorted((left, right) => right.requestSequence - left.requestSequence)[0]?.messageId ??
        null
      );
    },
    (effect, threadId, runtimeTurnId, activeTurnId) =>
      effect.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning("provider runtime activity correlation read failed", {
            threadId,
            runtimeTurnId,
            activeTurnId,
            cause: Cause.pretty(cause),
          }).pipe(
            Effect.andThen(markRecoveryEvidenceDegraded(threadId, "activity-correlation", cause)),
            Effect.as(null),
          );
        }),
      ),
  );

  const computeResumeSelection = Effect.fn("computeResumeSelection")(function* (
    threadId: ThreadId,
    activeTurnId: TurnId | null,
  ) {
    const pendingRows = yield* projectionTurnRepository.listPendingTurnStartsByThreadId({
      threadId,
    });
    const pendingWinner = pendingRows
      .filter((row) => !row.pendingInterruptRequested)
      .toSorted((left, right) => right.requestSequence - left.requestSequence)[0];
    const activeTurn =
      activeTurnId === null
        ? null
        : Option.getOrNull(
            yield* projectionTurnRepository.getByTurnId({ threadId, turnId: activeTurnId }),
          );

    const selected =
      pendingWinner === undefined
        ? activeTurn === null || activeTurn.pendingMessageId === null
          ? null
          : ({ kind: "active", row: activeTurn } as const)
        : activeTurn === null
          ? ({ kind: "pending", row: pendingWinner } as const)
          : activeTurn.requestSequence === null
            ? null
            : pendingWinner.requestSequence > activeTurn.requestSequence
              ? ({ kind: "pending", row: pendingWinner } as const)
              : activeTurn.pendingMessageId === null
                ? null
                : ({ kind: "active", row: activeTurn } as const);

    if (selected?.kind === "pending") {
      const selectedPending = selected.row;
      const hasEverClaimed = yield* providerTurnSendClaimRepository.hasEverClaimed({
        threadId,
        messageId: selectedPending.messageId,
      });
      return {
        selected,
        targetMessageId: selectedPending.messageId,
        activeTurn,
        evidenceSince: selectedPending.requestedAt,
        attemptBudgetKey: selectedPending.messageId,
        modelSelection: selectedPending.modelSelection ?? undefined,
        sourceProposedPlan:
          selectedPending.sourceProposedPlanThreadId !== null &&
          selectedPending.sourceProposedPlanId !== null
            ? {
                threadId: selectedPending.sourceProposedPlanThreadId,
                planId: selectedPending.sourceProposedPlanId,
              }
            : undefined,
        neverClaimedPendingOrphan: !hasEverClaimed,
      } satisfies ResumeSelection;
    }

    if (selected?.kind !== "active") {
      return null;
    }
    const selectedActive = selected.row;

    const binding = yield* providerSessionDirectory.getBinding(threadId);
    let modelSelection: ModelSelection | undefined;
    if (Option.isSome(binding)) {
      const rawModelSelection = (
        binding.value.runtimePayload as { modelSelection?: unknown } | null | undefined
      )?.modelSelection;
      if (rawModelSelection !== undefined && rawModelSelection !== null) {
        const decoded = decodeModelSelectionExit(rawModelSelection);
        if (decoded._tag === "Success") {
          modelSelection = decoded.value;
        }
      }
    }
    return {
      selected,
      targetMessageId: selectedActive.pendingMessageId!,
      activeTurn,
      evidenceSince: selectedActive.startedAt ?? selectedActive.requestedAt,
      attemptBudgetKey: selectedActive.pendingMessageId!,
      modelSelection,
      sourceProposedPlan:
        selectedActive.sourceProposedPlanThreadId !== null &&
        selectedActive.sourceProposedPlanId !== null
          ? {
              threadId: selectedActive.sourceProposedPlanThreadId,
              planId: selectedActive.sourceProposedPlanId,
            }
          : undefined,
      neverClaimedPendingOrphan: false,
    } satisfies ResumeSelection;
  });

  const processRuntimeEventUnprotected = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      const thread = yield* resolveThreadShell(event.threadId);
      if (!thread) return;

      let loadedThreadDetail: OrchestrationThread | null | undefined;
      const getLoadedThreadDetail = () =>
        Effect.gen(function* () {
          if (loadedThreadDetail !== undefined) {
            return loadedThreadDetail;
          }
          loadedThreadDetail = (yield* resolveThreadDetail(thread.id)) ?? null;
          return loadedThreadDetail;
        });

      const now = event.createdAt;
      const eventTurnId = toTurnId(event.turnId);
      const activeTurnId = thread.session?.activeTurnId ?? null;
      const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
        threadId: thread.id,
      });
      const hasPendingTurnStart =
        Option.isSome(pendingTurnStart) && thread.session?.status === "starting";

      const conflictsWithActiveTurn =
        activeTurnId !== null && eventTurnId !== undefined && !sameId(activeTurnId, eventTurnId);
      const missingTurnForActiveTurn = activeTurnId !== null && eventTurnId === undefined;

      // A user-requested `thread.turn.interrupt` settles the active turn's
      // projection row to `interrupted` (ProjectionPipeline's
      // `thread.turn-interrupt-requested` case) via a prior, already-committed
      // event. Capture that here for a session exit, because this event's own
      // `thread.session-set` (status: stopped, dispatched below) also settles a
      // still-running turn to `interrupted` — so a read taken after that dispatch
      // could not tell a deliberate user interrupt apart from the crash itself.
      // A plain crash's active-turn row is still `running` at this point.
      // A turn.started that conflicts with the active turn is legitimate when
      // the server itself has a turn start pending for this thread AND the
      // provider session already tracks the event's turn as its active turn:
      // steering a running turn makes some providers (e.g. opencode) open a
      // new turn without ever completing the superseded one. A stale
      // turn.started for some other turn id still gets rejected.
      const conflictingTurnStartIsPendingTurnStart =
        event.type === "turn.started" && conflictsWithActiveTurn
          ? sameId(yield* getExpectedProviderTurnIdForThread(thread.id), eventTurnId) &&
            Option.isSome(pendingTurnStart)
          : false;

      // A terminal event (session.exited) stamped with a provider instance that
      // is NOT the one currently bound to this thread comes from a superseded
      // instance. ProviderService.startSession starts the replacement — emitting
      // session.started stamped with the new instance — BEFORE it stops the
      // stale adapter, whose drained session/closed then arrives here stamped
      // with the OLD instance (CodexSessionRuntime's Queue.end flushes that
      // buffered terminal to the consumer rather than dropping it). By the time
      // this stale exit is processed, the projection's session instance already
      // reflects the replacement, so applying it would wrongly mark the healthy
      // replacement session stopped and interrupt its live turn. Suppress both
      // the lifecycle session-set and the auto-resume for it. Correlate only
      // when BOTH ids are known — providerInstanceId is optional during the
      // driver/instance migration, so absent ids preserve apply-always behavior.
      //
      // A restarted runtime can also REUSE the same providerInstanceId (the
      // instance id is a routing key, not a per-start identity), so an instance
      // match alone cannot prove the terminal event belongs to the live runtime.
      // The per-runtime sessionGeneration nonce (stamped by CodexSessionRuntime,
      // recorded on the projection session at session.started) disambiguates: a
      // terminal event whose generation differs from the projection's current
      // generation is from a superseded runtime, even when the instance matches.
      //
      // The same correlation must gate NON-terminal events too, and for a
      // subtler reason than "don't apply stale state". The session-set below
      // writes `event.sessionGeneration ?? thread.session?.sessionGeneration`,
      // so a stale non-terminal event (the dying runtime's buffered
      // `session/connecting` / `session/ready`, both of which map to
      // `session.state.changed`) would REWIND the projection's generation to the
      // superseded runtime's nonce. The stale `session.exited` that follows it
      // then compares equal to the projection and is no longer recognized as
      // superseded — so it applies, marks the healthy replacement stopped and
      // interrupts its live turn. The guard below is therefore what makes the
      // terminal guard reliable, not merely a hygiene addition: gating the exit
      // alone is defeated by the very events that precede it.
      const supersededEventIdentity =
        (event.providerInstanceId !== undefined &&
          thread.session?.providerInstanceId !== undefined &&
          thread.session.providerInstanceId !== event.providerInstanceId) ||
        (event.sessionGeneration !== undefined &&
          thread.session?.sessionGeneration !== undefined &&
          thread.session.sessionGeneration !== event.sessionGeneration);
      const supersededTerminalEvent = event.type === "session.exited" && supersededEventIdentity;
      const resumeSelectionRead =
        event.type === "session.exited" &&
        !supersededTerminalEvent &&
        event.payload.exitKind !== "graceful"
          ? yield* computeResumeSelection(thread.id, activeTurnId).pipe(
              Effect.map((selection) => ({ _tag: "Success" as const, selection }) as const),
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) {
                  return Effect.failCause(cause);
                }
                return markRecoveryEvidenceDegraded(thread.id, "resume-selection", cause).pipe(
                  Effect.andThen(
                    Effect.logWarning("provider runtime resume selection read failed", {
                      threadId: thread.id,
                      cause: Cause.pretty(cause),
                    }),
                  ),
                  Effect.as({ _tag: "Failure" as const, cause } as const),
                );
              }),
            )
          : null;
      const userInterruptedActiveTurn =
        resumeSelectionRead?._tag === "Success" &&
        resumeSelectionRead.selection?.selected.kind === "active" &&
        resumeSelectionRead.selection.selected.row.state === "interrupted";
      // Lifecycle events from a superseded runtime must not touch the projection
      // session at all. Only lifecycle-bearing types are gated: item/content
      // events carry no session identity to clobber, and dropping them would
      // lose transcript content that is still legitimately the thread's.
      const supersededLifecycleEvent =
        supersededEventIdentity &&
        (event.type === "session.started" ||
          event.type === "session.state.changed" ||
          event.type === "session.exited" ||
          event.type === "thread.started" ||
          event.type === "turn.started" ||
          event.type === "turn.completed");

      const shouldApplyThreadLifecycle = (() => {
        if (!STRICT_PROVIDER_LIFECYCLE_GUARD) {
          return true;
        }
        switch (event.type) {
          case "session.exited":
            return true;
          case "session.started":
          case "thread.started":
            return true;
          case "turn.started":
            return !conflictsWithActiveTurn || conflictingTurnStartIsPendingTurnStart;
          case "turn.completed":
            if (conflictsWithActiveTurn || missingTurnForActiveTurn) {
              return false;
            }
            // Only the active turn may close the lifecycle state.
            if (activeTurnId !== null && eventTurnId !== undefined) {
              return sameId(activeTurnId, eventTurnId);
            }
            // No active turn tracked: accept only completions that name their
            // turn (covers a real completion whose turn.started was lost). An
            // untargeted completion cannot prove it belongs to any turn this
            // thread ran — the known emitter was the Claude resume handshake
            // (system/init + result(num_turns: 0)), which is not a turn at
            // all — and applying it here stomps the "starting" lifecycle
            // state while a turn start is pending.
            return eventTurnId !== undefined;
          default:
            return true;
        }
      })();
      const requestedPendingTurnStartAdoption =
        event.type !== "turn.started"
          ? "none"
          : event.payload?.turnRequestSequence === undefined
            ? "oldest-pending"
            : "exact";
      const acceptedTurnStartedPendingStart =
        event.type === "turn.started" && shouldApplyThreadLifecycle
          ? yield* getPendingTurnStartForAcceptedTurnStart(
              thread.id,
              eventTurnId,
              requestedPendingTurnStartAdoption,
              event.payload?.turnRequestSequence,
            )
          : null;
      const pendingTurnStartAdoption =
        requestedPendingTurnStartAdoption === "oldest-pending" &&
        acceptedTurnStartedPendingStart === null
          ? "none"
          : requestedPendingTurnStartAdoption;

      if (
        event.type === "session.started" ||
        event.type === "session.state.changed" ||
        event.type === "session.exited" ||
        event.type === "thread.started" ||
        event.type === "turn.started" ||
        event.type === "turn.completed"
      ) {
        const status = (() => {
          switch (event.type) {
            case "session.state.changed": {
              const runtimeStatus = orchestrationSessionStatusFromRuntimeState(event.payload.state);
              return hasPendingTurnStart && runtimeStatus === "ready" ? "starting" : runtimeStatus;
            }
            case "turn.started":
              return "running";
            case "session.exited":
              return "stopped";
            case "turn.completed": {
              const turnState = normalizeRuntimeTurnState(event.payload.state);
              return turnState === "failed"
                ? "error"
                : turnState === "interrupted" || turnState === "cancelled"
                  ? "interrupted"
                  : "ready";
            }
            case "session.started":
            case "thread.started":
              // Provider thread/session start notifications can arrive during an
              // active or pending turn; preserve that lifecycle state.
              return activeTurnId !== null ? "running" : hasPendingTurnStart ? "starting" : "ready";
          }
        })();
        const nextActiveTurnId =
          event.type === "turn.started"
            ? (eventTurnId ?? null)
            : event.type === "turn.completed" || event.type === "session.exited"
              ? null
              : event.type === "session.state.changed" &&
                  !sessionStatusAllowsActiveTurn(
                    orchestrationSessionStatusFromRuntimeState(event.payload.state),
                  )
                ? null
                : activeTurnId;
        const lastError =
          event.type === "session.state.changed" && event.payload.state === "error"
            ? (event.payload.reason ?? thread.session?.lastError ?? "Provider session error")
            : event.type === "turn.completed" &&
                normalizeRuntimeTurnState(event.payload.state) === "failed"
              ? (event.payload.errorMessage ?? thread.session?.lastError ?? "Turn failed")
              : status === "ready"
                ? null
                : (thread.session?.lastError ?? null);
        // The turn a `turn.completed` closes: the event's own id when it
        // carries one, else the tracked active turn (the lifecycle guard has
        // already vouched they agree when both exist). Null only when neither
        // side knows a turn, in which case the write settles nothing.
        const settledTurnIdForCompletion =
          event.type === "turn.completed" ? (eventTurnId ?? activeTurnId) : null;
        const terminalTurnTransition = (() => {
          if (event.type === "turn.completed" && settledTurnIdForCompletion !== null) {
            return {
              turnId: settledTurnIdForCompletion,
              state: terminalTurnStateFromRuntimeTurnState(
                normalizeRuntimeTurnState(event.payload.state),
              ),
            } as const;
          }
          if (event.type === "session.exited" && activeTurnId !== null) {
            return { turnId: activeTurnId, state: "interrupted" } as const;
          }
          if (
            event.type === "turn.started" &&
            eventTurnId !== undefined &&
            acceptedTurnStartedPendingStart?.pendingInterruptRequested === true
          ) {
            return { turnId: eventTurnId, state: "interrupted" } as const;
          }
          return undefined;
        })();
        // A provider can accept a steer by opening B while A is still the
        // projected active turn. Once the lifecycle guard accepts that boundary,
        // the same session-set that advances the pointer must terminalize A
        // exactly. Exact request-sequence adoption may independently decline to
        // consume a mismatched placeholder; that must not leave accepted A
        // running. If an adopted placeholder was already interrupted, B is born
        // interrupted in that same atomic write as well.
        const terminalTurnTransitions =
          event.type === "turn.started" &&
          conflictsWithActiveTurn &&
          activeTurnId !== null &&
          shouldApplyThreadLifecycle
            ? [
                { turnId: activeTurnId, state: "interrupted" as const },
                ...(terminalTurnTransition === undefined ? [] : [terminalTurnTransition]),
              ]
            : undefined;

        if (shouldApplyThreadLifecycle && !supersededLifecycleEvent) {
          if (
            event.type === "turn.started" &&
            acceptedTurnStartedPendingStart?.sourceProposedPlanThreadId !== null &&
            acceptedTurnStartedPendingStart?.sourceProposedPlanThreadId !== undefined &&
            acceptedTurnStartedPendingStart.sourceProposedPlanId !== null
          ) {
            yield* markSourceProposedPlanImplemented(
              acceptedTurnStartedPendingStart.sourceProposedPlanThreadId,
              acceptedTurnStartedPendingStart.sourceProposedPlanId,
              thread.id,
              now,
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  "provider runtime ingestion failed to mark source proposed plan",
                  {
                    eventId: event.eventId,
                    eventType: event.type,
                    cause: Cause.pretty(cause),
                  },
                ),
              ),
            );
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: yield* providerCommandId(event, "thread-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status,
              providerName: event.provider,
              ...(event.providerInstanceId !== undefined
                ? { providerInstanceId: event.providerInstanceId }
                : {}),
              ...((event.sessionGeneration ?? thread.session?.sessionGeneration) !== undefined
                ? {
                    sessionGeneration: event.sessionGeneration ?? thread.session?.sessionGeneration,
                  }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: nextActiveTurnId,
              lastError,
              updatedAt: now,
            },
            // Every new event explicitly says whether this transition may adopt
            // a pending turn-start. Routine lifecycle writes adopt none; an
            // exact start adopts its sequence, while a genuine sequence-less
            // start may use the historical oldest-pending fallback.
            pendingTurnStartAdoption,
            ...(event.type === "turn.started" && event.payload?.turnRequestSequence !== undefined
              ? { turnRequestSequence: event.payload?.turnRequestSequence }
              : {}),
            // And only a turn.completed closes a specific turn. This is the
            // write the escalated-stop re-drive reads to decide a spared
            // request already ran to its end, and it must name WHICH turn
            // ended: several other writers produce a session-set with no
            // active turn (teardown, rebind, a different request's failure),
            // and treating any of those as this turn's successful settlement
            // silently drops a prompt from re-drive. A session.exited instead
            // uses `terminalTurnTransition` below: it terminalizes the known
            // active turn without stamping successful-settlement evidence.
            ...(event.type === "turn.completed" && settledTurnIdForCompletion !== null
              ? { settledTurnId: settledTurnIdForCompletion }
              : {}),
            ...(terminalTurnTransition !== undefined ? { terminalTurnTransition } : {}),
            ...(terminalTurnTransitions !== undefined ? { terminalTurnTransitions } : {}),
            createdAt: now,
          });
        }
      }

      const assistantDelta =
        event.type === "content.delta" && event.payload.streamKind === "assistant_text"
          ? event.payload.delta
          : undefined;
      const proposedPlanDelta =
        event.type === "turn.proposed.delta" ? event.payload.delta : undefined;

      if (assistantDelta && assistantDelta.length > 0) {
        const turnId = toTurnId(event.turnId);
        const assistantMessageId = yield* getOrCreateAssistantMessageId({
          threadId: thread.id,
          event,
          ...(turnId ? { turnId } : {}),
        });
        if (turnId) {
          yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
        }

        const assistantDeliveryMode: AssistantDeliveryMode = yield* Effect.map(
          serverSettingsService.getSettings,
          (settings) => (settings.enableLegacyTokenStreaming ? "streaming" : "buffered"),
        );
        if (assistantDeliveryMode === "buffered") {
          const spillChunk = yield* appendBufferedAssistantText(assistantMessageId, assistantDelta);
          if (spillChunk.length > 0) {
            yield* orchestrationEngine.dispatch({
              type: "thread.message.assistant.delta",
              commandId: yield* providerCommandId(event, "assistant-delta-buffer-spill"),
              threadId: thread.id,
              messageId: assistantMessageId,
              delta: spillChunk,
              ...(turnId ? { turnId } : {}),
              createdAt: now,
            });
          }
        } else {
          yield* orchestrationEngine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: yield* providerCommandId(event, "assistant-delta"),
            threadId: thread.id,
            messageId: assistantMessageId,
            delta: assistantDelta,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
          });
        }
      }

      const pauseForUserTurnId =
        event.type === "request.opened" || event.type === "user-input.requested"
          ? toTurnId(event.turnId)
          : undefined;
      if (pauseForUserTurnId) {
        const detailedThread = yield* getLoadedThreadDetail();
        const assistantDeliveryMode: AssistantDeliveryMode = yield* Effect.map(
          serverSettingsService.getSettings,
          (settings) => (settings.enableLegacyTokenStreaming ? "streaming" : "buffered"),
        );
        const flushedMessageIds =
          assistantDeliveryMode === "buffered"
            ? yield* flushBufferedAssistantMessagesForTurn({
                event,
                threadId: thread.id,
                turnId: pauseForUserTurnId,
                createdAt: now,
                commandTag:
                  event.type === "request.opened"
                    ? "assistant-delta-flush-on-request-opened"
                    : "assistant-delta-flush-on-user-input-requested",
              })
            : new Set<MessageId>();
        yield* finalizeActiveAssistantSegmentForTurn({
          event,
          threadId: thread.id,
          turnId: pauseForUserTurnId,
          createdAt: now,
          commandTag:
            event.type === "request.opened"
              ? "assistant-complete-on-request-opened"
              : "assistant-complete-on-user-input-requested",
          finalDeltaCommandTag:
            event.type === "request.opened"
              ? "assistant-delta-finalize-on-request-opened"
              : "assistant-delta-finalize-on-user-input-requested",
          hasProjectedMessage:
            detailedThread !== null &&
            hasAssistantMessageForTurn(detailedThread.messages, pauseForUserTurnId, {
              streamingOnly: true,
            }),
          flushedMessageIds,
        });
      }

      if (proposedPlanDelta && proposedPlanDelta.length > 0) {
        const planId = proposedPlanIdFromEvent(event, thread.id);
        yield* appendBufferedProposedPlan(planId, proposedPlanDelta, now);
      }

      const assistantCompletion =
        event.type === "item.completed" && event.payload.itemType === "assistant_message"
          ? {
              messageId: MessageId.make(
                `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
              ),
              fallbackText: event.payload.detail,
            }
          : undefined;
      const proposedPlanCompletion =
        event.type === "turn.proposed.completed"
          ? {
              planId: proposedPlanIdFromEvent(event, thread.id),
              turnId: toTurnId(event.turnId),
              planMarkdown: event.payload.planMarkdown,
            }
          : undefined;

      if (assistantCompletion) {
        const detailedThread = yield* getLoadedThreadDetail();
        const messages = detailedThread?.messages ?? [];
        const turnId = toTurnId(event.turnId);
        const activeAssistantMessageId = turnId
          ? yield* getActiveAssistantMessageIdForTurn(thread.id, turnId)
          : Option.none<MessageId>();
        const hasAssistantMessagesForTurn =
          turnId !== undefined ? hasAssistantMessageForTurn(messages, turnId) : false;
        const assistantMessageId = Option.getOrElse(
          activeAssistantMessageId,
          () => assistantCompletion.messageId,
        );
        const existingAssistantMessage = findMessageById(messages, assistantMessageId);
        const shouldApplyFallbackCompletionText =
          !existingAssistantMessage || existingAssistantMessage.text.length === 0;

        const shouldSkipRedundantCompletion =
          Option.isNone(activeAssistantMessageId) &&
          turnId !== undefined &&
          hasAssistantMessagesForTurn &&
          (assistantCompletion.fallbackText?.trim().length ?? 0) === 0;

        if (!shouldSkipRedundantCompletion) {
          if (turnId && Option.isNone(activeAssistantMessageId)) {
            yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
          }

          yield* finalizeAssistantMessage({
            event,
            threadId: thread.id,
            messageId: assistantMessageId,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
            commandTag: "assistant-complete",
            finalDeltaCommandTag: "assistant-delta-finalize",
            hasProjectedMessage: existingAssistantMessage !== undefined,
            ...(assistantCompletion.fallbackText !== undefined && shouldApplyFallbackCompletionText
              ? { fallbackText: assistantCompletion.fallbackText }
              : {}),
          });

          if (turnId) {
            yield* forgetAssistantMessageId(thread.id, turnId, assistantMessageId);
          }
        }

        if (turnId) {
          yield* clearAssistantSegmentStateForTurn(thread.id, turnId);
        }
      }

      if (proposedPlanCompletion) {
        const detailedThread = yield* getLoadedThreadDetail();
        yield* finalizeBufferedProposedPlan({
          event,
          threadId: thread.id,
          threadProposedPlans: detailedThread?.proposedPlans ?? [],
          planId: proposedPlanCompletion.planId,
          ...(proposedPlanCompletion.turnId ? { turnId: proposedPlanCompletion.turnId } : {}),
          fallbackMarkdown: proposedPlanCompletion.planMarkdown,
          updatedAt: now,
        });
      }

      if (event.type === "turn.completed") {
        const detailedThread = yield* getLoadedThreadDetail();
        const messages = detailedThread?.messages ?? [];
        const proposedPlans = detailedThread?.proposedPlans ?? [];
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          const assistantMessageIds = yield* getAssistantMessageIdsForTurn(thread.id, turnId);
          yield* Effect.forEach(
            assistantMessageIds,
            (assistantMessageId) =>
              finalizeAssistantMessage({
                event,
                threadId: thread.id,
                messageId: assistantMessageId,
                turnId,
                createdAt: now,
                commandTag: "assistant-complete-finalize",
                finalDeltaCommandTag: "assistant-delta-finalize-fallback",
                hasProjectedMessage: findMessageById(messages, assistantMessageId) !== undefined,
              }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          yield* clearAssistantMessageIdsForTurn(thread.id, turnId);
          yield* clearAssistantSegmentStateForTurn(thread.id, turnId);

          yield* finalizeBufferedProposedPlan({
            event,
            threadId: thread.id,
            threadProposedPlans: proposedPlans,
            planId: proposedPlanIdForTurn(thread.id, turnId),
            turnId,
            updatedAt: now,
          });
        }
      }

      // A turn that completes without failing clears the crash-loop budget for
      // this thread, so a later unrelated crash gets a fresh set of auto-resumes.
      // Only a completion attributable to the CURRENTLY tracked active turn may
      // clear it. `shouldApplyThreadLifecycle` alone is too loose here: for a
      // turn.completed it accepts any thread-scoped completion when no active
      // turn is tracked (activeTurnId === null) — but that is exactly the
      // crash→resume window (session.exited cleared the active turn; the
      // replacement's turn.started has not yet arrived). A buffered stale
      // completion for the crashed turn landing there would hand back budget on
      // every crash and defeat the two-attempt cap. Require a matching active
      // turn, so only the replacement (or a genuinely completed) turn resets it.
      if (
        event.type === "turn.completed" &&
        normalizeRuntimeTurnState(event.payload.state) !== "failed" &&
        activeTurnId !== null &&
        eventTurnId !== undefined &&
        sameId(activeTurnId, eventTurnId)
      ) {
        yield* Ref.update(autoResumeAttemptsByThreadId, (map) => {
          if (!map.has(thread.id)) {
            return map;
          }
          const next = new Map(map);
          next.delete(thread.id);
          return next;
        });
      }

      if (event.type === "session.exited" && !supersededTerminalEvent) {
        yield* clearTurnStateForSession(thread.id);

        // Session-exit auto-resume: when the provider subprocess exits *while a
        // turn was running* (not a graceful shutdown, not parked on a human
        // decision), re-issue that turn for the existing user message so the work
        // continues with provider context — bounded by AUTO_RESUME_MAX_ATTEMPTS.
        // Runs after the interrupted-settlement dispatch above, on the same
        // sequential worker, so it cannot race or double-fire.
        const gracefulExit = event.payload.exitKind === "graceful";
        // A provider that declares the exit explicitly non-recoverable (e.g.
        // OpenCode's unexpected-exit path emits `recoverable: false`) must not be
        // auto-resumed: reissuing the prompt could duplicate work or side effects
        // the provider is telling us are unsafe to retry. Absent/true ⇒ eligible.
        //
        // This gate is one of two that bound the duplicate-side-effect risk, so
        // it is worth stating precisely what auto-resume does and does not
        // guarantee.
        //
        // Re-issuing the user's message is NOT idempotent by itself: if a tool
        // call (a command, an API write) completed before the subprocess died,
        // nothing in the resume cursor prevents the provider from running it
        // again. The resume cursor restores CONVERSATIONAL context — the
        // provider sees its own prior transcript and generally continues rather
        // than restarting — but it is a best-effort behavioral property of the
        // model, not an execution guarantee, and it is not a durable record that
        // a given command already ran. A resume must not be justified by it
        // alone.
        //
        // So the durable record is consulted directly. `hasCommittedSideEffects`
        // below reads the projected activity log for tool lifecycle work already
        // attributed to the crashed turn. Those rows are written as the provider
        // reports each item, before the crash, and they survive it — they are
        // the only evidence this process has about what actually executed. When
        // any exists, auto-resume is refused and the turn is surfaced for the
        // user to decide, because a machine cannot tell a re-runnable `ls` from
        // a non-re-runnable deploy and must not guess with the user's side
        // effects.
        //
        // The two gates cover different halves: `declaredNonRecoverable` is the
        // provider's own claim that retrying is unsafe; `hasCommittedSideEffects`
        // is our observation that work already landed. Neither subsumes the
        // other — a provider can crash recoverably having already run a
        // migration.
        //
        // The resume-cursor coupling remains load-bearing for the case that
        // survives both gates (a crash with no committed tool work, where the
        // provider should pick up its own transcript). Verified against the
        // adapters in this repo: Claude, Codex, Cursor and Grok all accept a
        // `resumeCursor` on startSession; OpenCode does not implement one, and
        // is safe today because both its `session.exited` emissions declare
        // `recoverable: false`. Treat that as a contract: an adapter without
        // resume-cursor support MUST declare its exits non-recoverable, and one
        // that gains a recoverable exit path must gain a resume cursor in the
        // same change.
        const declaredNonRecoverable = event.payload.recoverable === false;
        const parkedOnHuman = thread.hasPendingApprovals || thread.hasPendingUserInput;
        const archived = thread.archivedAt !== null;
        // A surviving pending turn-start row (turn_id NULL) means a turn was
        // requested but never started — turn.started deletes the row, so one that
        // outlives the crash was orphaned. This distinguishes a queued *new*
        // message from the interrupted turn below: when the user interrupts turn
        // A and then sends message B, B's turn-start-requested writes a fresh
        // pending row that the crash orphans before it can start. A plain
        // interrupt (no queued message) leaves no pending row.
        //
        // Reads the whole queue, not its head: with several messages queued,
        // the head is the OLDEST, and it is the existence of any live queued
        // message that matters here. Testing only the head would call a thread
        // ineligible because its oldest queued message was interrupted, even
        // though a newer, uninterrupted one — the one a resume would actually
        // target — is still waiting.
        const resumeSelection =
          resumeSelectionRead?._tag === "Success" ? resumeSelectionRead.selection : null;
        const resumeSelectionReadFailed = resumeSelectionRead?._tag === "Failure";
        // The orphan overrides the interrupt suppression only when it is a
        // genuinely live queued message. If the user also interrupted this
        // pending start (its row carries `pendingInterruptRequested`, set by
        // `thread.turn-interrupt-requested`), the queued message was stopped
        // too — re-issuing it would auto-resume work the user explicitly
        // canceled. An interrupted orphan therefore must NOT re-enable
        // eligibility; this mirrors ProjectionPipeline's `bornInterrupted`,
        // which births such a turn `interrupted` rather than `running`.
        // `userInterruptedActiveTurn` is the early projection snapshot, taken
        // before this event's own session-set settled the running turn (see its
        // definition). A user who deliberately interrupted the
        // turn must not have it auto-resumed by the ensuing crash — UNLESS an
        // orphaned pending turn-start exists, meaning a newer message was queued
        // after the interrupt and orphaned by the crash. The interrupt suppresses
        // the OLD turn (a started row); it must not also drop that newer message,
        // whose pending row is necessarily for a different message than the
        // started, interrupted turn. The immutable selection targets the newest
        // live pending request (that orphan), so it re-issues B, not interrupted A.
        // The durable side-effect record for the crashed turn. Every tool
        // lifecycle item the provider reported was projected into an activity
        // row tagged with this turn's id (`tool.started` / `tool.updated` /
        // `tool.completed`, from `runtimeEventToActivities`) as it happened, so
        // a crash cannot erase it.
        //
        // `tool.started` counts, not just `tool.completed`. A subprocess that
        // dies mid-command leaves a started row and no completion, and that is
        // precisely the case where the command's effect is UNKNOWN — it may have
        // written, partially written, or not run at all. Unknown is not a reason
        // to re-run it; it is the strongest reason not to.
        //
        // Read from the loaded thread detail rather than a fresh query, so this
        // shares the single detail load the resume path already performs.
        // Read failure is non-fatal but is NOT treated as "no side effects": a
        // detail we could not load tells us nothing, and the safe reading of
        // nothing is that work may have landed.
        const threadDetailForSideEffects = yield* getLoadedThreadDetail().pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.failCause(cause);
            }
            return markRecoveryEvidenceDegraded(thread.id, "exit-snapshot", cause).pipe(
              Effect.as(null),
            );
          }),
        );
        // The message the immutable selection would actually re-issue. A live
        // pending request wins by request sequence; otherwise the active turn's
        // correlated message (or historical latest-message fallback) wins.
        // Computed before the side-effect gate because the gate has to be scoped
        // to the turn that would be re-run, and that turn is decided here.
        const resumeTargetMessageId = resumeSelection?.targetMessageId ?? null;
        // The active turn's originating user message. `pendingMessageId` is
        // copied onto the concrete turn row when `turn.started` consumes the
        // pending start, so it survives as that turn's identity here.
        // A resume aimed at a still-pending steer re-issues a message the
        // provider was never sent: its pending row (turn_id NULL) is proof that
        // no turn for it ever started, so nothing could have executed on its
        // behalf. The older turn's tool work is therefore irrelevant to whether
        // re-issuing THIS message duplicates anything — scoping the gate to the
        // old turn would strand the steer permanently, which is the silent-drop
        // failure this whole path exists to prevent.
        //
        // The bypass needs BOTH halves, and each rejects a different impostor.
        //
        // The messages must differ, because an auto-resume writes a fresh
        // pending row for the SAME message it is retrying: existence alone
        // would let a second crash re-run the very tools the first left in an
        // unknown state. Both ids must be readable to earn that half; an
        // unreadable active-turn row yields null and keeps the gate closed,
        // which is the safe direction.
        //
        // And a pending row for the targeted message must still exist, because
        // "different message" alone does not mean "never sent". A steer that
        // was successfully delivered mid-turn is FOLDED into the running turn:
        // the provider has it, but no turn.started ever names it, and
        // ProjectionPipeline deletes its pending row on
        // `thread.turn-start-folded`. Such a message is still the newest and
        // still differs from the active turn's originating message, so the
        // message-differs test alone would call work the provider already ran
        // "unstarted" and re-issue it past both refusal gates — the exact
        // duplicate-side-effect outcome those gates exist to prevent.
        const resumeTargetHasPendingTurnStart = resumeSelection?.selected.kind === "pending";
        // The surviving pending row is necessary but NOT sufficient, and
        // treating it as proof was the remaining hole. It proves only that
        // neither `turn.started` nor the post-return fold was projected — both
        // of which happen strictly AFTER `sendTurn` returns. A provider that
        // received the steer, began running tools on it, and then exited before
        // returning leaves the row exactly as an undelivered steer would, so the
        // row alone cannot separate "never sent" from "sent, ran, and died mid
        // call". Believing it re-issues a prompt whose tools already executed,
        // and — because this same flag suppresses the observed-side-effect check
        // and bypasses the provider's own `recoverable: false` — it does so past
        // every gate that would otherwise have stopped it.
        //
        // The durable send claim is the positive evidence the projection cannot
        // supply. The reactor acquires it in the statement immediately upstream
        // of `sendTurn`, so no row means the adapter was never called for this
        // message. It is checked here as the authority and the pending row is
        // kept alongside it: the claim answers "was a send attempted", the row
        // answers "did a turn or fold ever result", and a resume needs both to
        // read no.
        //
        // A failed read is NOT "no claim". An unreadable claim tells us nothing
        // about whether the prompt was sent, and the safe reading of nothing is
        // that it may have been — so the bypass is refused, the ordinary
        // side-effect and non-recoverable gates apply in full, and the worst
        // outcome is a steer the user re-sends by hand.
        const resumeTargetHasNeverBeenSent = resumeSelection?.neverClaimedPendingOrphan === true;
        const activeTurnMessageId = resumeSelection?.activeTurn?.pendingMessageId ?? null;
        const resumeTargetsUnstartedSteer =
          resumeTargetMessageId !== null &&
          activeTurnMessageId !== null &&
          !sameId(activeTurnMessageId, resumeTargetMessageId) &&
          resumeTargetHasPendingTurnStart &&
          resumeTargetHasNeverBeenSent;
        const recoveryEvidence =
          resumeSelection === null || threadDetailForSideEffects === null
            ? []
            : threadDetailForSideEffects.activities.filter(
                (activity) =>
                  SIDE_EFFECT_ACTIVITY_KINDS.has(activity.kind) ||
                  activity.kind === "turn.diff.observed",
              );
        const inCandidateWindow = (activity: OrchestrationThreadActivity) => {
          if (resumeSelection === null) {
            return false;
          }
          const activityCreatedAt = Date.parse(activity.createdAt);
          const evidenceSince = Date.parse(resumeSelection.evidenceSince);
          return (
            Number.isNaN(activityCreatedAt) ||
            Number.isNaN(evidenceSince) ||
            activityCreatedAt >= evidenceSince
          );
        };
        const onInterruptedActiveTurn = (activity: OrchestrationThreadActivity) =>
          resumeSelection?.activeTurn !== null &&
          resumeSelection?.activeTurn !== undefined &&
          activity.turnId !== null &&
          sameId(activity.turnId, resumeSelection.activeTurn.turnId);
        const unattributedEvidence =
          recoveryEvidence.find(
            (activity) =>
              activity.correlatedMessageId === undefined &&
              (inCandidateWindow(activity) || onInterruptedActiveTurn(activity)),
          ) ?? null;
        const selectedEvidence =
          resumeSelection === null
            ? null
            : (recoveryEvidence.find(
                (activity) =>
                  inCandidateWindow(activity) &&
                  sameId(activity.correlatedMessageId, resumeSelection.targetMessageId),
              ) ?? null);
        const unrelatedEvidence =
          resumeSelection === null
            ? null
            : (recoveryEvidence.find(
                (activity) =>
                  onInterruptedActiveTurn(activity) &&
                  activity.correlatedMessageId !== undefined &&
                  !sameId(activity.correlatedMessageId, resumeSelection.targetMessageId),
              ) ?? null);
        const checkpointTurn =
          resumeSelection?.selected.kind === "active"
            ? resumeSelection.selected.row
            : resumeSelection?.activeTurn;
        const checkpointEvidence =
          checkpointTurn !== null &&
          checkpointTurn !== undefined &&
          hasRecoveryCheckpointEvidence(checkpointTurn);
        const unattributedCheckpoint =
          checkpointEvidence && checkpointTurn.pendingMessageId === null;
        const selectedCheckpoint =
          checkpointEvidence &&
          sameId(checkpointTurn.pendingMessageId, resumeSelection?.targetMessageId);
        const unrelatedCheckpoint =
          checkpointEvidence &&
          checkpointTurn.pendingMessageId !== null &&
          !sameId(checkpointTurn.pendingMessageId, resumeSelection?.targetMessageId);
        const hasCommittedSideEffects =
          threadDetailForSideEffects === null ||
          unattributedEvidence !== null ||
          selectedEvidence !== null ||
          unattributedCheckpoint ||
          selectedCheckpoint ||
          (!resumeTargetsUnstartedSteer && unrelatedEvidence !== null) ||
          (!resumeTargetsUnstartedSteer && unrelatedCheckpoint);
        const evidencePersistenceFailed = yield* Ref.get(evidencePersistenceDegraded);
        // Split out so the side-effect refusal can be reported. A crash that
        // would otherwise have been auto-resumed, and is held back only because
        // work already landed, is exactly the case the user needs told: the
        // turn stops here and only they can decide whether re-running is safe.
        // Silently declining would reproduce the defect this PR fixes
        // elsewhere — a turn that just stops with no explanation.
        // The provider's "do not retry" claim is about the work it was RUNNING.
        // A resume that targets an unstarted steer re-issues a different message
        // the provider was never given, so there is nothing of that claim's
        // subject to duplicate — the same reasoning, and the same evidence (a
        // pending row with turn_id NULL), that scopes the side-effect gate above.
        // Left thread-wide, this gate strands the user's newest message on a
        // thread whose OLDER turn happened to die badly.
        //
        // Scoped, not dropped: when the resume would re-issue the very message
        // the non-recoverable turn was running, the claim applies in full and the
        // resume is still refused. What changes is that the refusal is reported
        // rather than dropped in silence, which is the defect this whole path
        // exists to fix.
        const nonRecoverableBlocksResume = declaredNonRecoverable && !resumeTargetsUnstartedSteer;
        // Eligible on every ground except the two refusals we report: the
        // provider's non-recoverable claim, and side effects we observed. Split
        // out so each refusal can be explained rather than inferred from silence.
        const recoveryContextEligible =
          activeTurnId !== null && !gracefulExit && !parkedOnHuman && !archived;
        const eligibleIgnoringRefusals =
          recoveryContextEligible &&
          resumeSelection !== null &&
          (!userInterruptedActiveTurn || resumeSelection.selected.kind === "pending");
        const blockingDetectedFrom = !recoveryContextEligible
          ? null
          : resumeSelectionReadFailed
            ? "thread-detail-unavailable"
            : evidencePersistenceFailed
              ? "evidence-persistence-failed"
              : resumeSelection === null
                ? "resume-target-unresolved"
                : threadDetailForSideEffects === null
                  ? "thread-detail-unavailable"
                  : unattributedEvidence !== null
                    ? "unattributed-activity"
                    : unattributedCheckpoint
                      ? "unattributed-checkpoint"
                      : selectedCheckpoint || selectedEvidence?.kind === "turn.diff.observed"
                        ? "turn-diff"
                        : selectedEvidence?.kind.startsWith("hook.") === true
                          ? "hook-activity"
                          : selectedEvidence !== null
                            ? "tool-activity"
                            : !resumeTargetsUnstartedSteer &&
                                (unrelatedEvidence !== null || unrelatedCheckpoint)
                              ? "unrelated-message-evidence"
                              : nonRecoverableBlocksResume
                                ? "provider-non-recoverable-exit"
                                : null;
        const blockedSummary =
          unattributedEvidence?.kind === "turn.diff.observed" ||
          selectedCheckpoint ||
          selectedEvidence?.kind === "turn.diff.observed"
            ? "turn-diff"
            : unattributedEvidence?.kind.startsWith("hook.") === true ||
                selectedEvidence?.kind.startsWith("hook.") === true
              ? "hook-activity"
              : unattributedEvidence !== null || selectedEvidence !== null
                ? "tool-activity"
                : blockingDetectedFrom;
        const baseEligible = eligibleIgnoringRefusals && blockingDetectedFrom === null;

        if (
          recoveryContextEligible &&
          (resumeSelectionReadFailed || resumeSelection === null || evidencePersistenceFailed)
        ) {
          const detectedFrom = blockingDetectedFrom ?? "resume-target-unresolved";
          const blockedActivityId = yield* crypto.randomUUIDv4.pipe(
            Effect.map((uuid) => EventId.make(`auto-resume-blocked:${event.eventId}:${uuid}`)),
          );
          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: yield* providerCommandId(event, "auto-resume-blocked-activity"),
            threadId: thread.id,
            activity: {
              id: blockedActivityId,
              tone: "error",
              kind: "provider.turn.auto-resume-blocked",
              summary:
                detectedFrom === "evidence-persistence-failed"
                  ? "Not auto-resumed: recovery evidence could not be persisted"
                  : detectedFrom === "resume-target-unresolved"
                    ? "Not auto-resumed: no safe resume target could be resolved"
                    : "Not auto-resumed: recovery safety state could not be read",
              payload: {
                detail:
                  `The provider session exited, but the server could not prove that ` +
                  `re-issuing a specific message was safe. The message was not sent again.`,
                exitReason: event.payload.reason ?? "provider session exited",
                detectedFrom,
              },
              turnId: resumeSelection?.activeTurn?.turnId ?? activeTurnId,
              createdAt: now,
            },
            createdAt: now,
          });
        }

        if (eligibleIgnoringRefusals && blockingDetectedFrom === "provider-non-recoverable-exit") {
          // A crash the provider itself declared unsafe to retry, on a turn that
          // would otherwise have been resumed. The turn stops here and only the
          // user can decide whether re-sending is safe — but they can only decide
          // if they are told, and the provider's own reason is the useful part.
          const nonRecoverableActivityId = yield* crypto.randomUUIDv4.pipe(
            Effect.map((uuid) =>
              EventId.make(`auto-resume-non-recoverable:${event.eventId}:${uuid}`),
            ),
          );
          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: yield* providerCommandId(event, "auto-resume-non-recoverable-activity"),
            threadId: thread.id,
            activity: {
              id: nonRecoverableActivityId,
              tone: "error",
              kind: "provider.turn.auto-resume-blocked",
              summary: "Not auto-resumed: the provider reported an unrecoverable exit",
              payload: {
                detail:
                  `The provider session exited mid-turn and reported the exit as ` +
                  `unrecoverable, so this turn was not re-issued automatically — ` +
                  `retrying it could repeat work the provider is telling us is ` +
                  `unsafe to repeat, and the conversation context may not carry ` +
                  `over. Re-send the message yourself if it is safe to repeat.`,
                exitReason: event.payload.reason ?? "provider session exited",
                detectedFrom: "provider-non-recoverable-exit",
              },
              turnId: activeTurnId,
              createdAt: now,
            },
            createdAt: now,
          });
        }

        if (
          eligibleIgnoringRefusals &&
          hasCommittedSideEffects &&
          blockingDetectedFrom !== null &&
          blockingDetectedFrom !== "provider-non-recoverable-exit"
        ) {
          const blockedActivityId = yield* crypto.randomUUIDv4.pipe(
            Effect.map((uuid) => EventId.make(`auto-resume-side-effects:${event.eventId}:${uuid}`)),
          );
          // A hook is a shell command the user configured, not something the
          // model chose to run, so naming it accurately matters: "ran tools"
          // would send someone looking through the transcript for a tool call
          // that is not there.
          const ranHook = blockedSummary === "hook-activity";
          const observedDiff = blockedSummary === "turn-diff";
          const workDescription = ranHook
            ? "run a configured hook"
            : observedDiff
              ? "observed file changes"
              : "started running tools";
          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: yield* providerCommandId(event, "auto-resume-side-effects-activity"),
            threadId: thread.id,
            activity: {
              id: blockedActivityId,
              tone: "error",
              kind: "provider.turn.auto-resume-blocked",
              summary: observedDiff
                ? "Not auto-resumed: this turn had already observed file changes"
                : ranHook
                  ? "Not auto-resumed: this turn had already run a hook"
                  : "Not auto-resumed: this turn had already run tool work",
              payload: {
                detail:
                  `The provider session exited mid-turn, but the turn had already ` +
                  `${workDescription}, so re-issuing it could repeat work that ` +
                  `already took effect. Review what ran above, then re-send the ` +
                  `message yourself if it is safe to repeat.`,
                exitReason: event.payload.reason ?? "provider session exited",
                // Distinguishes "we saw tool rows" from "we could not read the
                // transcript and refused on that basis" when reading a report.
                detectedFrom: blockingDetectedFrom,
              },
              turnId: activeTurnId,
              createdAt: now,
            },
            createdAt: now,
          });
        }
        // Always auto-resume an eligible crash, even when a turn-start is still
        // pending for this thread. A pending row alone cannot prove another
        // worker will drive the turn: the reactor may already have consumed the
        // steer's turn-start-requested and issued `sendTurn` before the
        // subprocess died, leaving the row "pending" yet orphaned. The
        // double-drive that a not-yet-consumed pending start would otherwise
        // cause is prevented downstream by the reactor's scoped supersession
        // guard (skips a turn-start-requested that a newer same-message
        // re-request has superseded), so resuming here is safe.
        if (baseEligible) {
          if (resumeSelection !== null) {
            const targetMessageId = resumeSelection.targetMessageId;
            const existing = (yield* Ref.get(autoResumeAttemptsByThreadId)).get(thread.id);
            // A different (newer) user message resets the budget to zero.
            const priorAttempts =
              existing && existing.messageId === resumeSelection.attemptBudgetKey
                ? existing.attempts
                : 0;
            const exitReason = event.payload.reason ?? "provider session exited";

            if (priorAttempts >= AUTO_RESUME_MAX_ATTEMPTS) {
              // Budget exhausted: give up, leave the turn interrupted, surface why.
              const exhaustedActivityId = yield* crypto.randomUUIDv4.pipe(
                Effect.map((uuid) =>
                  EventId.make(`auto-resume-exhausted:${event.eventId}:${uuid}`),
                ),
              );
              yield* orchestrationEngine.dispatch({
                type: "thread.activity.append",
                commandId: yield* providerCommandId(event, "auto-resume-exhausted-activity"),
                threadId: thread.id,
                activity: {
                  id: exhaustedActivityId,
                  tone: "error",
                  kind: "provider.turn.auto-resume-exhausted",
                  summary: `Auto-resume exhausted after ${AUTO_RESUME_MAX_ATTEMPTS} attempts; turn left interrupted`,
                  payload: {
                    detail:
                      `The provider session exited mid-turn and was auto-resumed ` +
                      `${AUTO_RESUME_MAX_ATTEMPTS} times without completing. Auto-resume gave ` +
                      `up to avoid a crash loop; re-send the message to try again.`,
                    exitReason,
                    attempts: priorAttempts,
                  },
                  turnId: activeTurnId,
                  createdAt: now,
                },
                createdAt: now,
              });
            } else {
              const attempt = priorAttempts + 1;

              // Carry the interrupted turn's effective model selection into the
              // resume so the restarted session resolves to the same provider
              // instance/model and recovers the persisted resume cursor (the
              // same-instance binding fallback in ProviderService.startSession).
              // The interrupted turn's modelSelection is durably captured only
              // on the persisted session binding's runtimePayload; when absent
              // we omit it so the reactor falls back to thread.modelSelection
              // (correct for the no-override case, and the binding's instance
              // still matches so the cursor is recovered either way). The
              // binding was captured with the immutable selection; a failed
              // directory read fails that selection closed.
              let resumeModelSelection = resumeSelection.modelSelection;

              // When the message being resumed is a still-pending steer (a newer
              // turn-start queued behind the older, already-sent turn), the
              // session binding above describes the OLDER turn, not this steer.
              // The pending row carries the steer's own model and source-plan, so
              // prefer them: run the resume on the model the user chose for the
              // steer, and carry its source proposed-plan so a resumed
              // plan-implementation turn re-associates with (and can mark
              // implemented) its plan. The row was captured with the immutable
              // selection.
              //
              // Searched by message id across the whole queue rather than taken
              // from its head. The resume targets the NEWEST user message, but
              // the head of the queue is the oldest outstanding request; with
              // more than one message queued those are different rows, and
              // matching against the head alone would find no match and
              // silently fall back to the older active turn's model and plan.
              const pendingForResume =
                resumeSelection.selected.kind === "pending"
                  ? resumeSelection.selected.row
                  : undefined;
              // When a pending turn-start row exists for the targeted message it
              // is the authoritative source for the resume (its own model +
              // source-plan), and the active-turn fallback below must not
              // override it.
              const resumingMatchingPendingSteer = pendingForResume !== undefined;
              let resumeSourceProposedPlan = resumeSelection.sourceProposedPlan;
              if (pendingForResume !== undefined) {
                const pending = pendingForResume;
                // The pending steer's own selection is authoritative for the
                // message being resumed — the binding above describes the OLDER
                // turn. A null selection means "thread default": clear the
                // binding-derived model so the resume omits modelSelection (the
                // reactor then falls back to thread.modelSelection) instead of
                // silently running the steer on the older turn's persisted model.
                resumeModelSelection = pending.modelSelection ?? undefined;
                if (
                  pending.sourceProposedPlanThreadId !== null &&
                  pending.sourceProposedPlanId !== null
                ) {
                  resumeSourceProposedPlan = {
                    threadId: pending.sourceProposedPlanThreadId,
                    planId: pending.sourceProposedPlanId,
                  };
                }
              }

              // A plan-implementation turn that already emitted turn.started has
              // had its pending row consumed — turn.started deletes it and copies
              // the source-plan onto the concrete turn row. A folded steer is the
              // other way a row is consumed: it was delivered INTO the running
              // turn, so `thread.turn-start-folded` deletes its row and the
              // provider is executing it as part of that turn. Both land here
              // with no pending row, and for both the active turn's plan is the
              // right one to carry — the resumed work continues that turn's
              // implementation rather than starting something the user never
              // attached a plan to. A crash after that leaves no pending row, so
              // the block above finds nothing; fall
              // back to the interrupted active turn's persisted source-plan so
              // the resumed turn keeps the linkage the UI uses to associate the
              // turn with (and mark implemented) its plan. Skip this when
              // resuming a matching pending steer: that
              // newer message intentionally carries no plan of its own, so
              // copying the OLDER active turn's plan onto it would wrongly re-run
              // the steer as an implementation of a plan the user never attached.
              if (
                resumeSourceProposedPlan === undefined &&
                !resumingMatchingPendingSteer &&
                activeTurnId !== null
              ) {
                const activeTurnRow = Option.fromNullishOr(resumeSelection.activeTurn);
                if (
                  Option.isSome(activeTurnRow) &&
                  activeTurnRow.value.sourceProposedPlanThreadId !== null &&
                  activeTurnRow.value.sourceProposedPlanId !== null
                ) {
                  resumeSourceProposedPlan = {
                    threadId: activeTurnRow.value.sourceProposedPlanThreadId,
                    planId: activeTurnRow.value.sourceProposedPlanId,
                  };
                }
              }

              // 1. Re-issue the turn for the existing user message first (no
              //    duplicate message-sent; fresh commandId avoids turn-start
              //    dedup collision). If the message was concurrently reverted
              //    the resume decider emits no events and the engine rejects the
              //    command — treat that as a benign no-op so we do NOT append the
              //    marker or consume budget for a resume that never happened.
              const resumeOutcome = yield* Effect.gen(function* () {
                const commandId = yield* providerCommandId(event, "auto-resume");
                yield* orchestrationEngine.dispatch({
                  type: "thread.turn.resume",
                  commandId,
                  threadId: thread.id,
                  messageId: targetMessageId,
                  ...(resumeModelSelection !== undefined
                    ? { modelSelection: resumeModelSelection }
                    : {}),
                  ...(resumeSourceProposedPlan !== undefined
                    ? { sourceProposedPlan: resumeSourceProposedPlan }
                    : {}),
                  reason: `auto-resume after provider session exit: ${exitReason}`,
                  createdAt: now,
                });
                return "resumed" as const;
              }).pipe(
                // Only THAT invariant is benign, though. The tag is shared:
                // the engine raises it for genuine failures too — a failed
                // event-id generation, a source plan that no longer resolves —
                // and the session has already stopped, so swallowing one of
                // those leaves the user's prompt unrun with a debug log as its
                // only trace, which is the silent loss this auto-resume exists
                // to close. Match the empty decision by its own detail and let
                // everything else fall through to the report below.
                Effect.catchIf(
                  (error) =>
                    error._tag === "OrchestrationCommandInvariantError" &&
                    error.detail === COMMAND_PRODUCED_NO_EVENTS_DETAIL,
                  (error) =>
                    Effect.logDebug("provider-runtime.auto-resume.noop", {
                      threadId: thread.id,
                      messageId: targetMessageId,
                      interruptedTurnId: activeTurnId,
                      reason: error.message,
                    }).pipe(Effect.as("noop" as const)),
                ),
                // The session is down either way, but the un-resumed prompt is
                // reported on the thread rather than only in the server log:
                // the user is the only one who can recover it, and they cannot
                // do that without knowing it happened. Catch the entire attempt,
                // including command-id generation and defects from dispatch.
                Effect.catchCause((resumeCause) => {
                  if (Cause.hasInterruptsOnly(resumeCause)) {
                    return Effect.failCause(resumeCause);
                  }
                  const resumeError = Cause.squash(resumeCause);
                  const invariantDetail =
                    typeof resumeError === "object" &&
                    resumeError !== null &&
                    "_tag" in resumeError &&
                    resumeError._tag === "OrchestrationCommandInvariantError" &&
                    "detail" in resumeError &&
                    typeof resumeError.detail === "string"
                      ? resumeError.detail
                      : undefined;
                  const resumeDetail =
                    invariantDetail ??
                    (resumeError instanceof Error
                      ? resumeError.message
                      : Cause.pretty(resumeCause));

                  return Effect.gen(function* () {
                    yield* Effect.logWarning("provider-runtime.auto-resume.dispatch-failed", {
                      threadId: thread.id,
                      messageId: targetMessageId,
                      interruptedTurnId: activeTurnId,
                      detail: resumeDetail,
                      cause: Cause.pretty(resumeCause),
                    });
                    yield* orchestrationEngine.dispatch({
                      type: "thread.activity.append",
                      commandId: CommandId.make(
                        `provider:${event.eventId}:auto-resume-failed-activity`,
                      ),
                      threadId: thread.id,
                      activity: {
                        id: EventId.make(`auto-resume-failed:${event.eventId}`),
                        tone: "error",
                        kind: "provider.turn.auto-resume-failed",
                        summary: "Not auto-resumed: re-issuing the turn failed",
                        payload: {
                          detail:
                            `The provider session exited mid-turn and this turn was ` +
                            `eligible to be re-issued, but re-issuing it failed, so the ` +
                            `message was NOT sent again: ${resumeDetail}. Re-send the ` +
                            `message yourself to run it.`,
                          exitReason,
                          failureDetail: resumeDetail,
                          ...(invariantDetail !== undefined ? { invariantDetail } : {}),
                        },
                        turnId: activeTurnId,
                        createdAt: now,
                      },
                      createdAt: now,
                    });
                  }).pipe(
                    Effect.catchCause((appendCause) =>
                      Effect.logError(
                        "provider runtime ingestion could not report a failed auto-resume",
                        {
                          threadId: thread.id,
                          messageId: targetMessageId,
                          interruptedTurnId: activeTurnId,
                          resumeDetail,
                          cause: Cause.pretty(appendCause),
                        },
                      ),
                    ),
                    Effect.as("failed" as const),
                  );
                }),
              );

              if (resumeOutcome === "resumed") {
                yield* Ref.update(autoResumeAttemptsByThreadId, (map) => {
                  const next = new Map(map);
                  next.set(thread.id, {
                    messageId: resumeSelection.attemptBudgetKey,
                    attempts: attempt,
                  });
                  return next;
                });

                // 2. Visible marker so the transcript explains the re-issued
                //    turn — only now that we know a turn was actually re-issued.
                const markerActivityId = yield* crypto.randomUUIDv4.pipe(
                  Effect.map((uuid) => EventId.make(`auto-resumed:${event.eventId}:${uuid}`)),
                );
                yield* orchestrationEngine.dispatch({
                  type: "thread.activity.append",
                  commandId: yield* providerCommandId(event, "auto-resumed-activity"),
                  threadId: thread.id,
                  activity: {
                    id: markerActivityId,
                    tone: "info",
                    kind: "provider.turn.auto-resumed",
                    summary: `Auto-resumed after provider session exit (attempt ${attempt}/${AUTO_RESUME_MAX_ATTEMPTS})`,
                    payload: {
                      detail:
                        `The provider session exited while the turn was running. ` +
                        `Re-issuing the turn to continue with provider context.`,
                      exitReason,
                      attempt,
                    },
                    turnId: activeTurnId,
                    createdAt: now,
                  },
                  createdAt: now,
                });

                yield* Effect.logInfo("provider-runtime.auto-resume.reissued-turn", {
                  threadId: thread.id,
                  messageId: targetMessageId,
                  interruptedTurnId: activeTurnId,
                  attempt,
                  exitReason,
                });
              }
            }
          }
        }
      }

      if (event.type === "runtime.error") {
        const runtimeErrorMessage = event.payload.message;

        // A superseded runtime's dying error rewinds the projection's identity
        // exactly as a stale lifecycle event would (this dispatch writes the same
        // `event.sessionGeneration ?? …` fallback), re-arming the stale-exit
        // hazard described at `supersededEventIdentity`. It also parks the live
        // replacement in `error` on a dead runtime's behalf. Drop it.
        const shouldApplyRuntimeError = supersededEventIdentity
          ? false
          : !STRICT_PROVIDER_LIFECYCLE_GUARD
            ? true
            : activeTurnId === null ||
              eventTurnId === undefined ||
              sameId(activeTurnId, eventTurnId);

        if (shouldApplyRuntimeError) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: yield* providerCommandId(event, "runtime-error-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "error",
              providerName: event.provider,
              ...(event.providerInstanceId !== undefined
                ? { providerInstanceId: event.providerInstanceId }
                : {}),
              ...((event.sessionGeneration ?? thread.session?.sessionGeneration) !== undefined
                ? {
                    sessionGeneration: event.sessionGeneration ?? thread.session?.sessionGeneration,
                  }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              // Preserve the currently-active turn for an unscoped runtime error
              // (no turnId on the event). A crash often surfaces as a turn-less
              // runtime.error immediately followed by session.exited — e.g. Codex
              // fatal stderr maps to exactly such a turn-less error. Nulling the
              // active turn here would make the ensuing exit see no running turn
              // and skip session-exit auto-resume entirely. A scoped error keeps
              // its own turn id.
              activeTurnId: eventTurnId ?? thread.session?.activeTurnId ?? null,
              lastError: runtimeErrorMessage,
              updatedAt: now,
            },
            pendingTurnStartAdoption: "none",
            ...(eventTurnId !== undefined
              ? {
                  terminalTurnTransition: {
                    turnId: eventTurnId,
                    state: "error",
                  } as const,
                }
              : {}),
            createdAt: now,
          });
        }
      }

      if (event.type === "thread.metadata.updated" && event.payload.name) {
        if (canReplaceThreadTitle(thread.title)) {
          yield* orchestrationEngine.dispatch({
            type: "thread.meta.update",
            commandId: yield* providerCommandId(event, "thread-meta-update"),
            threadId: thread.id,
            title: event.payload.name,
          });
        }
      }

      if (event.type === "turn.diff.updated") {
        const turnId = toTurnId(event.turnId);
        const correlatedMessageId = yield* resolveActivityCorrelation(
          thread.id,
          turnId,
          activeTurnId,
        );
        const markerScope =
          correlatedMessageId ?? (turnId !== undefined ? `turn:${turnId}` : "unattributed");
        const markerActivityId = EventId.make(`turn-diff-observed:${thread.id}:${markerScope}`);
        yield* orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: yield* providerCommandId(event, "turn-diff-observed"),
          threadId: thread.id,
          activity: {
            id: markerActivityId,
            tone: "tool",
            kind: "turn.diff.observed",
            summary: "Provider observed file changes",
            payload: {
              sourceEventId: event.eventId,
              observedCharacterCount: event.payload.unifiedDiff.length,
            },
            turnId: turnId ?? null,
            ...(correlatedMessageId !== null ? { correlatedMessageId } : {}),
            createdAt: now,
          },
          createdAt: now,
        });

        const checkpointContext = turnId
          ? yield* projectionSnapshotQuery
              .getThreadCheckpointContext(thread.id)
              .pipe(Effect.map(Option.getOrUndefined))
          : undefined;
        const workspaceCwd =
          checkpointContext?.worktreePath ?? checkpointContext?.workspaceRoot ?? undefined;
        if (
          turnId &&
          checkpointContext &&
          workspaceCwd &&
          isGitRepository(workspaceCwd) &&
          !hasCheckpointForTurn(checkpointContext.checkpoints, turnId)
        ) {
          const assistantMessageId = MessageId.make(
            `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
          );
          yield* orchestrationEngine.dispatch({
            type: "thread.turn.diff.complete",
            commandId: yield* providerCommandId(event, "thread-turn-diff-complete"),
            threadId: thread.id,
            turnId,
            completedAt: now,
            checkpointRef: CheckpointRef.make(`provider-diff:${event.eventId}`),
            status: "missing",
            files: [],
            assistantMessageId,
            checkpointTurnCount: maxCheckpointTurnCount(checkpointContext.checkpoints) + 1,
            createdAt: now,
          });
        }
      }

      if (event.type === "task.started" || event.type === "task.progress") {
        const description = event.payload.description?.trim();
        if (description) {
          yield* rememberTaskDescription(thread.id, event.payload.taskId, description);
        }
      }
      if (event.type === "turn.usage.recorded") {
        const threadDetail = yield* getLoadedThreadDetail();
        yield* projectionTurnUsageRepository.record({
          threadId: thread.id,
          turnId: event.turnId,
          projectId: event.payload.usage.projectId ?? threadDetail?.projectId ?? null,
          providerInstanceId:
            event.providerInstanceId ?? ProviderInstanceId.make(String(event.provider)),
          provider: event.provider,
          usage: event.payload.usage,
        });
      } else if (event.type === "thread.token-usage.updated" || event.type === "turn.completed") {
        const threadDetail = yield* getLoadedThreadDetail();
        const usage =
          event.type === "thread.token-usage.updated"
            ? usageRecordFromTokenSnapshot(
                event,
                threadDetail?.modelSelection.model,
                isCommandCenterThreadId(thread.id) ? "automation" : "interactive",
              )
            : usageRecordFromTurnCompletion(
                event,
                threadDetail?.modelSelection.model,
                isCommandCenterThreadId(thread.id) ? "automation" : "interactive",
              );
        if (usage && event.turnId) {
          yield* projectionTurnUsageRepository.record({
            threadId: thread.id,
            turnId: event.turnId,
            projectId: threadDetail?.projectId ?? null,
            providerInstanceId:
              event.providerInstanceId ?? ProviderInstanceId.make(String(event.provider)),
            provider: event.provider,
            usage,
          });
        }
      }

      // Working-indicator plan progress: current step while the turn runs,
      // cleared on settle so a finished plan never lingers as stale UI.
      // Events carrying a turn id that conflicts with the active turn are
      // stale (superseded turn) and must neither overwrite nor clear the
      // active turn's progress; session.exited always clears.
      if (event.type === "session.exited") {
        threadPlanProgress.clearThreadPlanProgress(thread.id);
      } else if (!conflictsWithActiveTurn) {
        if (event.type === "turn.plan.updated") {
          threadPlanProgress.recordPlanProgress(thread.id, event.payload.plan);
        } else if (event.type === "turn.completed" || event.type === "turn.aborted") {
          threadPlanProgress.clearThreadPlanProgress(thread.id);
        }
      }

      // Sidebar background liveness: fed from the same lifecycle stream,
      // read by the shell query at mapping time (no persistence).
      switch (event.type) {
        case "task.started":
        case "task.progress":
        case "task.updated":
        case "task.completed": {
          const payload = event.payload as {
            taskId: string;
            taskType?: string;
            status?: string;
            agentId?: string;
          };
          threadBackgroundLiveness.recordTaskLiveness({
            threadId: thread.id,
            taskId: payload.taskId,
            taskType: payload.taskType,
            status: payload.status,
            agentId: payload.agentId,
            kind:
              event.type === "task.started"
                ? "started"
                : event.type === "task.progress"
                  ? "progress"
                  : event.type === "task.updated"
                    ? "updated"
                    : "completed",
          });
          break;
        }
        case "session.exited":
          threadBackgroundLiveness.clearThreadLiveness(thread.id);
          break;
        default:
          break;
      }
      let taskTitle: string | undefined;
      if (event.type === "task.completed") {
        taskTitle = yield* lookupTaskDescription(thread.id, event.payload.taskId);
        if (!taskTitle) {
          const threadDetail = yield* getLoadedThreadDetail();
          taskTitle = findTaskTitleInActivities(threadDetail?.activities, event.payload.taskId);
        }
      }

      const activities = runtimeEventToActivities(event, taskTitle);
      yield* Effect.forEach(activities, (activity) =>
        Effect.gen(function* () {
          const sideEffectEvidence = SIDE_EFFECT_ACTIVITY_KINDS.has(activity.kind);
          const correlatedMessageId = sideEffectEvidence
            ? yield* resolveActivityCorrelation(thread.id, eventTurnId, activeTurnId)
            : null;
          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: yield* providerCommandId(event, "thread-activity-append"),
            threadId: thread.id,
            activity: {
              ...activity,
              ...(correlatedMessageId !== null ? { correlatedMessageId } : {}),
            },
            createdAt: activity.createdAt,
          });
        }),
      ).pipe(Effect.asVoid);
    });

  const processRuntimeEvent = (event: ProviderRuntimeEvent) => {
    const recoveryEvidenceKind =
      event.type === "turn.diff.updated"
        ? "turn.diff.observed"
        : event.type === "session.exited"
          ? "exit-recovery-safety"
          : runtimeEventToActivities(event).find((activity) =>
              SIDE_EFFECT_ACTIVITY_KINDS.has(activity.kind),
            )?.kind;
    const process = processRuntimeEventUnprotected(event);
    return recoveryEvidenceKind === undefined
      ? process
      : persistRecoveryEvidence(event.threadId, recoveryEvidenceKind, process);
  };

  const processDomainEvent = (_event: RecoveryBoundaryDomainEvent) => Effect.void;

  const processInput = (input: RuntimeIngestionInput) =>
    input.source === "runtime" ? processRuntimeEvent(input.event) : processDomainEvent(input.event);

  const processInputSafely = (input: RuntimeIngestionInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider runtime ingestion failed to process event", {
          source: input.source,
          eventId: input.event.eventId,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const reconcileOrphanedTurns: ProviderRuntimeIngestionShape["reconcileOrphanedTurns"] =
    Effect.gen(function* () {
      const [snapshot, providerSessions] = yield* Effect.all([
        projectionSnapshotQuery.getShellSnapshot(),
        providerService.listSessions(),
      ]);
      const liveTurnsByThreadId = new Map(
        providerSessions
          .filter((session) => session.status === "running" && session.activeTurnId !== undefined)
          .map((session) => [session.threadId, session.activeTurnId] as const),
      );
      const orphanedThreads = snapshot.threads.filter((thread) => {
        const projectedTurnId =
          thread.session?.activeTurnId ??
          (thread.latestTurn?.state === "running" ? thread.latestTurn.turnId : null);
        if (projectedTurnId === null) {
          return false;
        }
        return !sameId(liveTurnsByThreadId.get(thread.id), projectedTurnId);
      });

      // A thread can be orphaned with no concrete turn to point at. A turn-start
      // that never reached `turn.started` leaves only a pending row (turn_id
      // NULL): no `session.activeTurnId`, no running `latestTurn` — so the filter
      // above cannot see it, and auto-resume cannot rescue it either (eligibility
      // requires a non-null activeTurnId). That happens whenever a replacement
      // session dies before reporting its first turn, and the thread would
      // otherwise sit "pending" forever. Sweep those rows here, where a provider
      // session is known not to be running for the thread.
      const orphanedIds = new Set(orphanedThreads.map((thread) => thread.id));
      const pendingOnlyOrphans = yield* Effect.forEach(
        snapshot.threads.filter(
          (thread) => !orphanedIds.has(thread.id) && !liveTurnsByThreadId.has(thread.id),
        ),
        (thread) =>
          // The WHOLE queue, not just its head. A thread can strand several
          // messages at once (each turn-start-requested keeps its own
          // placeholder), and every one of them is a user message that was
          // accepted and never ran — reporting only the first would leave the
          // rest to be cleared below with no transcript entry explaining them.
          projectionTurnRepository.listPendingTurnStartsByThreadId({ threadId: thread.id }).pipe(
            Effect.map((pending) => (pending.length > 0 ? { thread, pending } : null)),
            Effect.orElseSucceed(() => null),
          ),
        { concurrency: 1 },
      ).pipe(Effect.map((entries) => entries.filter((entry) => entry !== null)));

      if (orphanedThreads.length === 0 && pendingOnlyOrphans.length === 0) {
        return;
      }

      const reconciledAt = DateTime.formatIso(yield* DateTime.now);

      // Report each stranded placeholder in the transcript, THEN clear it. The
      // session-set dispatched below cannot clear it — the pending row carries
      // no turn id, so the turns projector's settle path (which only touches
      // rows with a concrete turnId) leaves it untouched.
      //
      // The order is the point. Clearing alone makes an accepted user message
      // disappear: the reactor does not replay historical domain events when it
      // subscribes, so nothing will ever drive this start again, and with the
      // row gone the UI shows no turn at all — not a failed one, not a pending
      // one. The user's message stays in the transcript (`thread.message-sent`
      // was appended when it was accepted) with no visible reason why it never
      // ran. The activity below is that reason, and it is appended FIRST so a
      // dispatch failure leaves the row in place rather than clearing it
      // silently — a stuck pending row is recoverable on the next boot; a
      // vanished one is not.
      //
      // The turn is reported, not re-issued. Reconciliation runs on every boot
      // with no durable attempt budget across restarts, so auto-driving here
      // would re-send on each boot for as long as the provider keeps dying
      // before its first turn — the crash loop that `AUTO_RESUME_MAX_ATTEMPTS`
      // bounds in-process but cannot bound across them. Surfacing the outcome
      // puts the retry back in the user's hands, one click away, with no loop.
      yield* Effect.forEach(
        // Flattened to one entry per stranded placeholder: each queued message
        // gets its own activity and is cleared only after that activity is
        // recorded, so a failure part-way through leaves the remaining rows
        // intact for the next boot rather than dropping them unreported.
        pendingOnlyOrphans.flatMap((entry) =>
          entry.pending.map((pending) => ({ thread: entry.thread, pending })),
        ),
        ({ thread, pending }) =>
          Effect.gen(function* () {
            const commandUuid = yield* crypto.randomUUIDv4;
            const activityId = EventId.make(
              `reconcile-pending-orphan:${thread.id}:${pending.requestSequence}:${commandUuid}`,
            );
            yield* orchestrationEngine.dispatch({
              type: "thread.activity.append",
              commandId: CommandId.make(
                `server:reconcile-pending-orphan-activity:${thread.id}:${pending.requestSequence}:${commandUuid}`,
              ),
              threadId: thread.id,
              activity: {
                id: activityId,
                tone: "error",
                kind: "provider.turn.start.orphaned",
                summary: "Turn never reported starting; the provider session ended first",
                payload: {
                  // Deliberately does NOT claim the turn was never sent. The
                  // placeholder is cleared by `turn.started` being PROJECTED,
                  // not by `sendTurn` returning, so its survival proves only
                  // that no start was ever reported back. The provider may have
                  // received the turn and begun work before dying — that window
                  // is exactly where a crash is most likely. Telling the user
                  // "nothing reached the provider" and to re-send would be
                  // asserting more than this process knows, and acting on it
                  // could duplicate side effects.
                  detail:
                    `This turn was accepted, but the provider session ended before it ` +
                    `ever reported starting. It is not known whether the provider ` +
                    `received it — it may have begun work that was never reported ` +
                    `back. Check for any effects above before re-sending.`,
                },
                // No concrete turn exists — the pending row never got an id.
                turnId: null,
                createdAt: reconciledAt,
              },
              createdAt: reconciledAt,
            });
            // Clears just the placeholder that was reported. The others in this
            // thread's queue are reported by their own iterations; clearing by
            // thread here would delete them before their activity is written.
            yield* projectionTurnRepository.deletePendingTurnStart({
              threadId: thread.id,
              requestSequence: pending.requestSequence,
            });
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to report and clear orphaned pending turn start", {
                threadId: thread.id,
                requestSequence: pending.requestSequence,
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        { concurrency: 1 },
      );

      yield* Effect.forEach(
        orphanedThreads,
        (thread) =>
          Effect.gen(function* () {
            const commandUuid = yield* crypto.randomUUIDv4;
            const orphanedTurnId =
              thread.session?.activeTurnId ??
              (thread.latestTurn?.state === "running" ? thread.latestTurn.turnId : null);
            if (orphanedTurnId === null) {
              return;
            }
            yield* orchestrationEngine.dispatch({
              type: "thread.session.set",
              commandId: CommandId.make(
                `server:reconcile-orphaned-turn:${thread.id}:${commandUuid}`,
              ),
              threadId: thread.id,
              session: {
                threadId: thread.id,
                status: "stopped",
                providerName: thread.session?.providerName ?? null,
                ...(thread.session?.providerInstanceId !== undefined
                  ? { providerInstanceId: thread.session.providerInstanceId }
                  : {}),
                ...(thread.session?.sessionGeneration !== undefined
                  ? { sessionGeneration: thread.session.sessionGeneration }
                  : {}),
                runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
                activeTurnId: null,
                lastError: thread.session?.lastError ?? null,
                updatedAt: reconciledAt,
              },
              pendingTurnStartAdoption: "none",
              terminalTurnTransition: {
                turnId: orphanedTurnId,
                state: "interrupted",
              },
              createdAt: reconciledAt,
            });
          }),
        { concurrency: 1 },
      );
      yield* Effect.logInfo("reconciled orphaned provider turns", {
        threadCount: orphanedThreads.length,
        pendingOnlyThreadCount: pendingOnlyOrphans.length,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to reconcile orphaned provider turns", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const start: ProviderRuntimeIngestionShape["start"] = () =>
    Effect.gen(function* () {
      yield* forkParked(
        Stream.runForEach(providerService.streamEvents, (event) =>
          worker.enqueue({ source: "runtime", event }),
        ),
      );
      yield* forkParked(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          if (event.type !== "thread.turn-start-requested") {
            return Effect.void;
          }
          return worker.enqueue({ source: "domain", event });
        }),
      );
    });

  return {
    start,
    drain: worker.drain,
    reconcileOrphanedTurns,
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(
  ProviderRuntimeIngestionService,
  make,
).pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectionTurnRepositoryLive,
      ProviderTurnSendClaimRepositoryLive,
      ProjectionTurnUsageRepositoryLive,
    ),
  ),
);
