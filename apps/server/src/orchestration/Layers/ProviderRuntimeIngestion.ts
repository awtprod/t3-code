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
} from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;

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

type TurnStartRequestedDomainEvent = Extract<
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
      event: TurnStartRequestedDomainEvent;
    };

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

function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
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
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
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
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.progress": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.progress",
          summary: "Reasoning update",
          payload: {
            taskId: event.payload.taskId,
            detail: truncateDetail(event.payload.summary ?? event.payload.description),
            ...(event.payload.summary ? { summary: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.lastToolName ? { lastToolName: event.payload.lastToolName } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
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
            ...(event.payload.summary ? { detail: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
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
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.updated",
          summary: event.payload.title ?? "Tool updated",
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.completed": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.completed",
          summary: event.payload.title ?? "Tool",
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
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
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.started",
          summary: `${event.payload.title ?? "Tool"} started`,
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
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
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const serverSettingsService = yield* ServerSettingsService;
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
    });

  const getSourceProposedPlanReferenceForPendingTurnStart = Effect.fn(
    "getSourceProposedPlanReferenceForPendingTurnStart",
  )(function* (threadId: ThreadId) {
    const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
      threadId,
    });
    if (Option.isNone(pendingTurnStart)) {
      return null;
    }

    const sourceThreadId = pendingTurnStart.value.sourceProposedPlanThreadId;
    const sourcePlanId = pendingTurnStart.value.sourceProposedPlanId;
    if (sourceThreadId === null || sourcePlanId === null) {
      return null;
    }

    return {
      sourceThreadId,
      sourcePlanId,
    } as const;
  });

  const getExpectedProviderTurnIdForThread = Effect.fn("getExpectedProviderTurnIdForThread")(
    function* (threadId: ThreadId) {
      const sessions = yield* providerService.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      return session?.activeTurnId;
    },
  );

  const getSourceProposedPlanReferenceForAcceptedTurnStart = Effect.fn(
    "getSourceProposedPlanReferenceForAcceptedTurnStart",
  )(function* (threadId: ThreadId, eventTurnId: TurnId | undefined) {
    if (eventTurnId === undefined) {
      return null;
    }

    const expectedTurnId = yield* getExpectedProviderTurnIdForThread(threadId);
    if (!sameId(expectedTurnId, eventTurnId)) {
      return null;
    }

    return yield* getSourceProposedPlanReferenceForPendingTurnStart(threadId);
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

  const processRuntimeEvent = (event: ProviderRuntimeEvent) =>
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
      const userInterruptedActiveTurn =
        event.type === "session.exited" && activeTurnId !== null
          ? yield* projectionTurnRepository
              .getByTurnId({ threadId: thread.id, turnId: activeTurnId })
              .pipe(Effect.map((row) => Option.isSome(row) && row.value.state === "interrupted"))
          : false;

      // A turn.started that conflicts with the active turn is legitimate when
      // the server itself has a turn start pending for this thread AND the
      // provider session already tracks the event's turn as its active turn:
      // steering a running turn makes some providers (e.g. opencode) open a
      // new turn without ever completing the superseded one. A stale
      // turn.started for some other turn id still gets rejected.
      const conflictingTurnStartIsPendingTurnStart =
        event.type === "turn.started" && conflictsWithActiveTurn
          ? sameId(yield* getExpectedProviderTurnIdForThread(thread.id), eventTurnId) &&
            Option.isSome(
              yield* projectionTurnRepository.getPendingTurnStartByThreadId({
                threadId: thread.id,
              }),
            )
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
            // If no active turn is tracked, accept completion scoped to this thread.
            return true;
          default:
            return true;
        }
      })();
      const acceptedTurnStartedSourcePlan =
        event.type === "turn.started" && shouldApplyThreadLifecycle
          ? yield* getSourceProposedPlanReferenceForAcceptedTurnStart(thread.id, eventTurnId)
          : null;

      if (
        event.type === "session.started" ||
        event.type === "session.state.changed" ||
        event.type === "session.exited" ||
        event.type === "thread.started" ||
        event.type === "turn.started" ||
        event.type === "turn.completed"
      ) {
        const nextActiveTurnId =
          event.type === "turn.started"
            ? (eventTurnId ?? null)
            : event.type === "turn.completed" || event.type === "session.exited"
              ? null
              : activeTurnId;
        const status = (() => {
          switch (event.type) {
            case "session.state.changed":
              return orchestrationSessionStatusFromRuntimeState(event.payload.state);
            case "turn.started":
              return "running";
            case "session.exited":
              return "stopped";
            case "turn.completed":
              return normalizeRuntimeTurnState(event.payload.state) === "failed"
                ? "error"
                : "ready";
            case "session.started":
            case "thread.started":
              // Provider thread/session start notifications can arrive during an
              // active turn; preserve turn-running state in that case.
              return activeTurnId !== null ? "running" : "ready";
          }
        })();
        const lastError =
          event.type === "session.state.changed" && event.payload.state === "error"
            ? (event.payload.reason ?? thread.session?.lastError ?? "Provider session error")
            : event.type === "turn.completed" &&
                normalizeRuntimeTurnState(event.payload.state) === "failed"
              ? (event.payload.errorMessage ?? thread.session?.lastError ?? "Turn failed")
              : status === "ready"
                ? null
                : (thread.session?.lastError ?? null);

        if (shouldApplyThreadLifecycle && !supersededLifecycleEvent) {
          if (event.type === "turn.started" && acceptedTurnStartedSourcePlan !== null) {
            yield* markSourceProposedPlanImplemented(
              acceptedTurnStartedSourcePlan.sourceThreadId,
              acceptedTurnStartedSourcePlan.sourcePlanId,
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
            // Only a turn.started answers a specific turn-start request. Every
            // other lifecycle event that lands here (session state changes,
            // exits, completions) is about the session, not about which queued
            // message just began, so stamping them would let an unrelated
            // transition consume a placeholder.
            ...(event.type === "turn.started" &&
            event.payload?.turnRequestSequence !== undefined
              ? { turnRequestSequence: event.payload.turnRequestSequence }
              : {}),
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
          (settings) => (settings.enableAssistantStreaming ? "streaming" : "buffered"),
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
          (settings) => (settings.enableAssistantStreaming ? "streaming" : "buffered"),
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
        const orphanedPendingTurnStarts = yield* projectionTurnRepository
          .listPendingTurnStartsByThreadId({ threadId: thread.id })
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<ProjectionPendingTurnStart>));
        // The orphan overrides the interrupt suppression only when it is a
        // genuinely live queued message. If the user also interrupted this
        // pending start (its row carries `pendingInterruptRequested`, set by
        // `thread.turn-interrupt-requested`), the queued message was stopped
        // too — re-issuing it would auto-resume work the user explicitly
        // canceled. An interrupted orphan therefore must NOT re-enable
        // eligibility; this mirrors ProjectionPipeline's `bornInterrupted`,
        // which births such a turn `interrupted` rather than `running`.
        const hasOrphanedPendingTurnStart = orphanedPendingTurnStarts.some(
          (pending) => !pending.pendingInterruptRequested,
        );
        // `userInterruptedActiveTurn` is the early projection snapshot, taken
        // before this event's own session-set settled the running turn (see its
        // definition). A user who deliberately interrupted the
        // turn must not have it auto-resumed by the ensuing crash — UNLESS an
        // orphaned pending turn-start exists, meaning a newer message was queued
        // after the interrupt and orphaned by the crash. The interrupt suppresses
        // the OLD turn (a started row); it must not also drop that newer message,
        // whose pending row is necessarily for a different message than the
        // started, interrupted turn. The resume targets the newest user message
        // (that orphan), so it re-issues B, not the interrupted A.
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
          Effect.orElseSucceed(() => null),
        );
        // The message a resume would actually re-issue: the newest user message,
        // which is NOT necessarily the one the crashed active turn was running.
        // Computed before the side-effect gate because the gate has to be scoped
        // to the turn that would be re-run, and that turn is decided here.
        const resumeTargetMessageId = threadDetailForSideEffects
          ? (threadDetailForSideEffects.messages
              .toReversed()
              .find((message) => message.role === "user")?.id ?? null)
          : null;
        // The active turn's originating user message. `pendingMessageId` is
        // copied onto the concrete turn row when `turn.started` consumes the
        // pending start, so it survives as that turn's identity here.
        const activeTurnRowForScope =
          activeTurnId === null
            ? Option.none()
            : yield* projectionTurnRepository
                .getByTurnId({ threadId: thread.id, turnId: activeTurnId })
                .pipe(Effect.orElseSucceed(() => Option.none()));
        const activeTurnMessageId = Option.isSome(activeTurnRowForScope)
          ? activeTurnRowForScope.value.pendingMessageId
          : null;
        // A resume aimed at a still-pending steer re-issues a message the
        // provider was never sent: its pending row (turn_id NULL) is proof that
        // no turn for it ever started, so nothing could have executed on its
        // behalf. The older turn's tool work is therefore irrelevant to whether
        // re-issuing THIS message duplicates anything — scoping the gate to the
        // old turn would strand the steer permanently, which is the silent-drop
        // failure this whole path exists to prevent.
        //
        // The bypass turns on the messages differing, NOT on a pending row
        // merely existing: an auto-resume writes a fresh pending row for the
        // SAME message it is retrying, so existence alone would let a second
        // crash re-run the very tools the first left in an unknown state. Both
        // ids must be readable to earn the bypass; an unreadable active-turn row
        // yields null and keeps the gate closed, which is the safe direction.
        const resumeTargetsUnstartedSteer =
          resumeTargetMessageId !== null &&
          activeTurnMessageId !== null &&
          !sameId(activeTurnMessageId, resumeTargetMessageId);
        const sideEffectActivityKind =
          activeTurnId === null ||
          resumeTargetsUnstartedSteer ||
          threadDetailForSideEffects === null
            ? null
            : (threadDetailForSideEffects.activities.find(
                (activity) =>
                  activity.turnId !== null &&
                  sameId(activity.turnId, activeTurnId) &&
                  SIDE_EFFECT_ACTIVITY_KINDS.has(activity.kind),
              )?.kind ?? null);
        const hasCommittedSideEffects =
          activeTurnId === null || resumeTargetsUnstartedSteer
            ? false
            : threadDetailForSideEffects === null
              ? true
              : sideEffectActivityKind !== null;
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
        const eligibleIgnoringRefusals =
          activeTurnId !== null &&
          !gracefulExit &&
          !parkedOnHuman &&
          !archived &&
          (!userInterruptedActiveTurn || hasOrphanedPendingTurnStart);
        const eligibleIgnoringSideEffects =
          eligibleIgnoringRefusals && !nonRecoverableBlocksResume;
        const baseEligible = eligibleIgnoringSideEffects && !hasCommittedSideEffects;

        if (eligibleIgnoringRefusals && nonRecoverableBlocksResume) {
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

        if (eligibleIgnoringSideEffects && hasCommittedSideEffects) {
          const blockedActivityId = yield* crypto.randomUUIDv4.pipe(
            Effect.map((uuid) => EventId.make(`auto-resume-side-effects:${event.eventId}:${uuid}`)),
          );
          // A hook is a shell command the user configured, not something the
          // model chose to run, so naming it accurately matters: "ran tools"
          // would send someone looking through the transcript for a tool call
          // that is not there.
          const ranHook = sideEffectActivityKind?.startsWith("hook.") === true;
          const workDescription = ranHook ? "run a configured hook" : "started running tools";
          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: yield* providerCommandId(event, "auto-resume-side-effects-activity"),
            threadId: thread.id,
            activity: {
              id: blockedActivityId,
              tone: "error",
              kind: "provider.turn.auto-resume-blocked",
              summary: ranHook
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
                detectedFrom:
                  threadDetailForSideEffects === null
                    ? "thread-detail-unavailable"
                    : ranHook
                      ? "hook-activity"
                      : "tool-activity",
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
          const detail = yield* getLoadedThreadDetail();
          const targetUserMessage = detail
            ? detail.messages.toReversed().find((message) => message.role === "user")
            : undefined;
          if (targetUserMessage) {
            const targetMessageId = targetUserMessage.id;
            const existing = (yield* Ref.get(autoResumeAttemptsByThreadId)).get(thread.id);
            // A different (newer) user message resets the budget to zero.
            const priorAttempts =
              existing && existing.messageId === targetMessageId ? existing.attempts : 0;
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
              // still matches so the cursor is recovered either way). A directory
              // read failure is non-fatal — fall back to the default path.
              const binding = yield* providerSessionDirectory
                .getBinding(thread.id)
                .pipe(Effect.orElseSucceed(() => Option.none()));
              let resumeModelSelection: ModelSelection | undefined;
              if (Option.isSome(binding)) {
                const rawModelSelection = (
                  binding.value.runtimePayload as { modelSelection?: unknown } | null | undefined
                )?.modelSelection;
                if (rawModelSelection !== undefined && rawModelSelection !== null) {
                  const decoded = decodeModelSelectionExit(rawModelSelection);
                  if (decoded._tag === "Success") {
                    resumeModelSelection = decoded.value;
                  }
                }
              }

              // When the message being resumed is a still-pending steer (a newer
              // turn-start queued behind the older, already-sent turn), the
              // session binding above describes the OLDER turn, not this steer.
              // The pending row carries the steer's own model and source-plan, so
              // prefer them: run the resume on the model the user chose for the
              // steer, and carry its source proposed-plan so a resumed
              // plan-implementation turn re-associates with (and can mark
              // implemented) its plan. A read failure is non-fatal.
              //
              // Searched by message id across the whole queue rather than taken
              // from its head. The resume targets the NEWEST user message, but
              // the head of the queue is the oldest outstanding request; with
              // more than one message queued those are different rows, and
              // matching against the head alone would find no match and
              // silently fall back to the older active turn's model and plan.
              const pendingForResume = yield* projectionTurnRepository
                .listPendingTurnStartsByThreadId({ threadId: thread.id })
                .pipe(
                  Effect.map((rows) =>
                    rows.find((pending) => pending.messageId === targetMessageId),
                  ),
                  Effect.orElseSucceed(() => undefined as ProjectionPendingTurnStart | undefined),
                );
              // When a pending turn-start row exists for the targeted message it
              // is the authoritative source for the resume (its own model +
              // source-plan), and the active-turn fallback below must not
              // override it.
              const resumingMatchingPendingSteer = pendingForResume !== undefined;
              let resumeSourceProposedPlan:
                | { threadId: ThreadId; planId: OrchestrationProposedPlanId }
                | undefined;
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
              // the source-plan onto the concrete turn row. A crash after that
              // leaves no pending row, so the block above finds nothing; fall
              // back to the interrupted active turn's persisted source-plan so
              // the resumed turn keeps the linkage the UI uses to associate the
              // turn with (and mark implemented) its plan. Read failure is
              // non-fatal. Skip this when resuming a matching pending steer: that
              // newer message intentionally carries no plan of its own, so
              // copying the OLDER active turn's plan onto it would wrongly re-run
              // the steer as an implementation of a plan the user never attached.
              if (
                resumeSourceProposedPlan === undefined &&
                !resumingMatchingPendingSteer &&
                activeTurnId !== null
              ) {
                const activeTurnRow = yield* projectionTurnRepository
                  .getByTurnId({ threadId: thread.id, turnId: activeTurnId })
                  .pipe(Effect.orElseSucceed(() => Option.none()));
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
              const resumeOutcome = yield* orchestrationEngine
                .dispatch({
                  type: "thread.turn.resume",
                  commandId: yield* providerCommandId(event, "auto-resume"),
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
                })
                .pipe(
                  Effect.as("resumed" as const),
                  Effect.catchTag("OrchestrationCommandInvariantError", (error) =>
                    Effect.logDebug("provider-runtime.auto-resume.noop", {
                      threadId: thread.id,
                      messageId: targetMessageId,
                      interruptedTurnId: activeTurnId,
                      reason: error.message,
                    }).pipe(Effect.as("noop" as const)),
                  ),
                );

              if (resumeOutcome === "resumed") {
                yield* Ref.update(autoResumeAttemptsByThreadId, (map) => {
                  const next = new Map(map);
                  next.set(thread.id, { messageId: targetMessageId, attempts: attempt });
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
            createdAt: now,
          });
        }
      }

      if (event.type === "thread.metadata.updated" && event.payload.name) {
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* providerCommandId(event, "thread-meta-update"),
          threadId: thread.id,
          title: event.payload.name,
        });
      }

      if (event.type === "turn.diff.updated") {
        const turnId = toTurnId(event.turnId);
        const checkpointContext = turnId
          ? yield* projectionSnapshotQuery
              .getThreadCheckpointContext(thread.id)
              .pipe(Effect.map(Option.getOrUndefined))
          : undefined;
        const workspaceCwd =
          checkpointContext?.worktreePath ?? checkpointContext?.workspaceRoot ?? undefined;
        if (turnId && checkpointContext && workspaceCwd && isGitRepository(workspaceCwd)) {
          // Skip if a checkpoint already exists for this turn. A real
          // (non-placeholder) capture from CheckpointReactor should not
          // be clobbered, and dispatching a duplicate placeholder for the
          // same turnId would produce an unstable checkpointTurnCount.
          if (hasCheckpointForTurn(checkpointContext.checkpoints, turnId)) {
            // Already tracked; no-op.
          } else {
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
      }

      const activities = runtimeEventToActivities(event);
      yield* Effect.forEach(activities, (activity) =>
        providerCommandId(event, "thread-activity-append").pipe(
          Effect.flatMap((commandId) =>
            orchestrationEngine.dispatch({
              type: "thread.activity.append",
              commandId,
              threadId: thread.id,
              activity,
              createdAt: activity.createdAt,
            }),
          ),
        ),
      ).pipe(Effect.asVoid);
    });

  const processDomainEvent = (_event: TurnStartRequestedDomainEvent) => Effect.void;

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
      yield* Effect.forkScoped(
        Stream.runForEach(providerService.streamEvents, (event) =>
          worker.enqueue({ source: "runtime", event }),
        ),
      );
      yield* Effect.forkScoped(
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
).pipe(Layer.provide(ProjectionTurnRepositoryLive));
