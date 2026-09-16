import {
  ApprovalRequestId,
  isImportedAgentSessionMessageId,
  UserInputAttachmentAnswerPayload,
  type ChatAttachment,
  type OrchestrationEvent,
  type OrchestrationSessionStatus,
  type ThreadSessionTerminalTurnTransition,
  ThreadId,
} from "@t3tools/contracts";
import { compareDateTimeStrings } from "@t3tools/shared/dateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  legacyThreadPullRequestKey,
  threadPullRequestKeysEqual,
} from "@t3tools/shared/threadPullRequests";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionStateRepository } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { type ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import {
  type ProjectionThreadMessage,
  ProjectionThreadMessageRepository,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import {
  type ProjectionThreadProposedPlan,
  ProjectionThreadProposedPlanRepository,
} from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import * as ProjectionThreadPullRequests from "../../persistence/ProjectionThreadPullRequests.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import {
  type ProjectionPendingTurnStart,
  type ProjectionTurn,
  ProjectionTurnRepository,
} from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../../persistence/Layers/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionStateRepositoryLive } from "../../persistence/Layers/ProjectionState.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "../../persistence/Layers/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepositoryLive } from "../../persistence/Layers/ProjectionThreadSessions.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { ServerConfig } from "../../config.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import {
  attachmentRelativePath,
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../../attachmentStore.ts";

export const ORCHESTRATION_PROJECTOR_NAMES = {
  projects: "projection.projects",
  threads: "projection.threads",
  threadMessages: "projection.thread-messages",
  threadProposedPlans: "projection.thread-proposed-plans",
  threadActivities: "projection.thread-activities",
  threadSessions: "projection.thread-sessions",
  threadTurns: "projection.thread-turns",
  checkpoints: "projection.checkpoints",
  pendingApprovals: "projection.pending-approvals",
} as const;

type ProjectorName =
  (typeof ORCHESTRATION_PROJECTOR_NAMES)[keyof typeof ORCHESTRATION_PROJECTOR_NAMES];

/**
 * Turn state to apply when a session update explicitly names a still-running
 * turn to settle, or null while the session is (re)starting or running.
 */
function settledTurnStateForSessionStatus(
  status: OrchestrationSessionStatus,
): "completed" | "interrupted" | "error" | null {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "interrupted":
    case "stopped":
      return "interrupted";
    case "starting":
    case "running":
      return null;
  }
}

function normalizeTerminalTurnTransitions(
  payload: Extract<OrchestrationEvent, { type: "thread.session-set" }>["payload"],
  legacyTerminalState: "completed" | "interrupted" | "error" | null,
): ReadonlyArray<ThreadSessionTerminalTurnTransition> {
  const transitions = [
    ...(payload.terminalTurnTransitions ?? []),
    ...(payload.terminalTurnTransition === undefined ? [] : [payload.terminalTurnTransition]),
    ...(payload.settledTurnId === undefined || legacyTerminalState === null
      ? []
      : [{ turnId: payload.settledTurnId, state: legacyTerminalState }]),
  ];
  const seenTurnIds = new Set<string>();
  return transitions.filter((transition) => {
    if (seenTurnIds.has(transition.turnId)) {
      return false;
    }
    seenTurnIds.add(transition.turnId);
    return true;
  });
}

interface ProjectorDefinition {
  readonly name: ProjectorName;
  readonly apply: (
    event: OrchestrationEvent,
    attachmentSideEffects: AttachmentSideEffects,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

interface AttachmentSideEffects {
  readonly deletedThreadIds: Set<string>;
  readonly prunedThreadRelativePaths: Map<string, Set<string>>;
}

const materializeAttachmentsForProjection = Effect.fn("materializeAttachmentsForProjection")(
  (input: { readonly attachments: ReadonlyArray<ChatAttachment> }) =>
    Effect.succeed(input.attachments.length === 0 ? [] : input.attachments),
);

function extractActivityRequestId(payload: unknown): ApprovalRequestId | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? ApprovalRequestId.make(requestId) : null;
}

function isStalePendingApprovalFailureDetail(detail: string | null): boolean {
  if (detail === null) {
    return false;
  }
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request")
  );
}

// A refresh reads each persisted summary source, so skip activities that cannot change the result.
function shouldRefreshThreadShellSummary(event: OrchestrationEvent): boolean {
  if (event.type !== "thread.activity-appended") {
    return true;
  }

  switch (event.payload.activity.kind) {
    case "approval.requested":
    case "approval.resolved":
    case "provider.approval.respond.failed":
    case "user-input.requested":
    case "user-input.resolved":
    case "provider.user-input.respond.failed":
      return true;
    default:
      return false;
  }
}

function derivePendingUserInputCountFromActivities(
  activities: ReadonlyArray<ProjectionThreadActivity>,
): number {
  const openRequestIds = new Set<string>();
  const ordered = [...activities].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.activityId.localeCompare(right.activityId),
  );

  for (const activity of ordered) {
    const requestId = extractActivityRequestId(activity.payload);
    if (requestId === null) {
      continue;
    }
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;

    if (activity.kind === "user-input.requested") {
      openRequestIds.add(requestId);
      continue;
    }

    if (activity.kind === "user-input.resolved") {
      openRequestIds.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.user-input.respond.failed" &&
      detail !== null &&
      (detail.includes("stale pending user-input request") ||
        detail.includes("unknown pending user-input request") ||
        detail.includes("unknown pending user input request") ||
        detail.includes("unknown pending codex user input request"))
    ) {
      openRequestIds.delete(requestId);
    }
  }

  return openRequestIds.size;
}

function retainProjectionMessagesAfterRevert(
  messages: ReadonlyArray<ProjectionThreadMessage>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadMessage> {
  const retainedMessageIds = new Set<string>();
  const retainedTurnIds = new Set<string>();
  const keptTurns = turns.filter(
    (turn) =>
      turn.turnId !== null &&
      turn.checkpointTurnCount !== null &&
      turn.checkpointTurnCount <= turnCount,
  );
  for (const turn of keptTurns) {
    if (turn.turnId !== null) {
      retainedTurnIds.add(turn.turnId);
    }
    if (turn.pendingMessageId !== null) {
      retainedMessageIds.add(turn.pendingMessageId);
    }
    if (turn.assistantMessageId !== null) {
      retainedMessageIds.add(turn.assistantMessageId);
    }
  }

  for (const message of messages) {
    if (message.role === "system" || isImportedAgentSessionMessageId(message.messageId)) {
      retainedMessageIds.add(message.messageId);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedUserCount = messages.filter(
    (message) =>
      message.role === "user" &&
      !isImportedAgentSessionMessageId(message.messageId) &&
      retainedMessageIds.has(message.messageId),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          compareDateTimeStrings(left.createdAt, right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) =>
      message.role === "assistant" &&
      !isImportedAgentSessionMessageId(message.messageId) &&
      retainedMessageIds.has(message.messageId),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          compareDateTimeStrings(left.createdAt, right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.messageId));
}

function retainProjectionActivitiesAfterRevert(
  activities: ReadonlyArray<ProjectionThreadActivity>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadActivity> {
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainProjectionProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<ProjectionThreadProposedPlan>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadProposedPlan> {
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

const decodeQuestionAttachmentAnswer = Schema.decodeUnknownOption(UserInputAttachmentAnswerPayload);

function collectThreadAttachmentRelativePaths(
  threadId: string,
  messages: ReadonlyArray<ProjectionThreadMessage>,
): Set<string> {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return new Set();
  }
  const relativePaths = new Set<string>();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachment.id);
      if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
        continue;
      }
      const relativePath = attachmentRelativePath(attachment);
      if (relativePath) {
        relativePaths.add(relativePath);
      }
    }
  }
  return relativePaths;
}

const runAttachmentSideEffects = Effect.fn("runAttachmentSideEffects")(function* (
  sideEffects: AttachmentSideEffects,
) {
  const serverConfig = yield* Effect.service(ServerConfig);
  const fileSystem = yield* Effect.service(FileSystem.FileSystem);
  const path = yield* Effect.service(Path.Path);

  const attachmentsRootDir = serverConfig.attachmentsDir;
  const readAttachmentRootEntries = fileSystem.readDirectory(attachmentsRootDir, {
    recursive: false,
  });

  const removeDeletedThreadAttachmentEntry = Effect.fn("removeDeletedThreadAttachmentEntry")(
    function* (threadSegment: string, entry: string) {
      const normalizedEntry = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
      if (normalizedEntry.length === 0 || normalizedEntry.includes("/")) {
        return;
      }
      const attachmentId = parseAttachmentIdFromRelativePath(normalizedEntry);
      if (!attachmentId) {
        return;
      }
      const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
      if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
        return;
      }
      yield* fileSystem.remove(path.join(attachmentsRootDir, normalizedEntry), {
        force: true,
      });
    },
  );

  const deleteThreadAttachments = Effect.fn("deleteThreadAttachments")(function* (
    threadId: string,
  ) {
    const threadSegment = toSafeThreadAttachmentSegment(threadId);
    if (!threadSegment) {
      yield* Effect.logWarning("skipping attachment cleanup for unsafe thread id", {
        threadId,
      });
      return;
    }

    const entries = yield* readAttachmentRootEntries;
    yield* Effect.forEach(
      entries,
      (entry) => removeDeletedThreadAttachmentEntry(threadSegment, entry),
      {
        concurrency: 1,
      },
    );
  });

  const pruneThreadAttachmentEntry = Effect.fn("pruneThreadAttachmentEntry")(function* (
    threadSegment: string,
    keptThreadRelativePaths: Set<string>,
    entry: string,
  ) {
    const relativePath = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
    if (relativePath.length === 0 || relativePath.includes("/")) {
      return;
    }
    const attachmentId = parseAttachmentIdFromRelativePath(relativePath);
    if (!attachmentId) {
      return;
    }
    const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
      return;
    }

    const absolutePath = path.join(attachmentsRootDir, relativePath);
    const fileInfo = yield* fileSystem.stat(absolutePath);
    if (!fileInfo || fileInfo.type !== "File") {
      return;
    }

    if (!keptThreadRelativePaths.has(relativePath)) {
      yield* fileSystem.remove(absolutePath, { force: true });
    }
  });

  const pruneThreadAttachments = Effect.fn("pruneThreadAttachments")(function* (
    threadId: string,
    keptThreadRelativePaths: Set<string>,
  ) {
    if (sideEffects.deletedThreadIds.has(threadId)) {
      return;
    }

    const threadSegment = toSafeThreadAttachmentSegment(threadId);
    if (!threadSegment) {
      yield* Effect.logWarning("skipping attachment prune for unsafe thread id", { threadId });
      return;
    }

    const entries = yield* readAttachmentRootEntries;
    yield* Effect.forEach(
      entries,
      (entry) => pruneThreadAttachmentEntry(threadSegment, keptThreadRelativePaths, entry),
      { concurrency: 1 },
    );
  });

  yield* Effect.forEach(sideEffects.deletedThreadIds, deleteThreadAttachments, {
    concurrency: 1,
  });

  yield* Effect.forEach(
    sideEffects.prunedThreadRelativePaths.entries(),
    ([threadId, keptThreadRelativePaths]) =>
      pruneThreadAttachments(threadId, keptThreadRelativePaths),
    { concurrency: 1 },
  );
});

const makeOrchestrationProjectionPipeline = Effect.fn("makeOrchestrationProjectionPipeline")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* OrchestrationEventStore;
    const projectionStateRepository = yield* ProjectionStateRepository;
    const projectionProjectRepository = yield* ProjectionProjectRepository;
    const projectionThreadRepository = yield* ProjectionThreadRepository;
    const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
    const projectionThreadProposedPlanRepository = yield* ProjectionThreadProposedPlanRepository;
    const projectionThreadPullRequestRepository =
      yield* ProjectionThreadPullRequests.ProjectionThreadPullRequestRepository;
    const projectionThreadActivityRepository = yield* ProjectionThreadActivityRepository;
    const projectionThreadSessionRepository = yield* ProjectionThreadSessionRepository;
    const projectionTurnRepository = yield* ProjectionTurnRepository;
    const projectionPendingApprovalRepository = yield* ProjectionPendingApprovalRepository;

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;

    const applyProjectsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyProjectsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "project.created":
          yield* projectionProjectRepository.upsert({
            projectId: event.payload.projectId,
            title: event.payload.title,
            workspaceRoot: event.payload.workspaceRoot,
            defaultModelSelection: event.payload.defaultModelSelection,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: event.payload.faviconPath ?? null,
            projectIcon: event.payload.projectIcon ?? null,
            scripts: event.payload.scripts,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            deletedAt: null,
          });
          return;

        case "project.meta-updated": {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.workspaceRoot !== undefined
              ? { workspaceRoot: event.payload.workspaceRoot }
              : {}),
            ...(event.payload.defaultModelSelection !== undefined
              ? { defaultModelSelection: event.payload.defaultModelSelection }
              : {}),
            ...(event.payload.defaultThreadEnvMode !== undefined
              ? { defaultThreadEnvMode: event.payload.defaultThreadEnvMode }
              : {}),
            ...(event.payload.autoPull !== undefined ? { autoPull: event.payload.autoPull } : {}),
            ...(event.payload.faviconPath !== undefined
              ? { faviconPath: event.payload.faviconPath }
              : {}),
            ...(event.payload.projectIcon !== undefined
              ? { projectIcon: event.payload.projectIcon }
              : {}),
            ...(event.payload.scripts !== undefined ? { scripts: event.payload.scripts } : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "project.deleted": {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          });
          return;
        }

        default:
          return;
      }
    });

    const refreshThreadShellSummary = Effect.fn("refreshThreadShellSummary")(function* (
      threadId: ThreadId,
    ) {
      const existingRow = yield* projectionThreadRepository.getById({
        threadId,
      });
      if (Option.isNone(existingRow)) {
        return;
      }

      const [latestUserMessageAt, hasActionableProposedPlan, activities, pendingApprovalCount] =
        yield* Effect.all([
          projectionThreadMessageRepository.getLatestUserMessageAt({ threadId }),
          projectionThreadProposedPlanRepository.hasActionableByThreadId({
            threadId,
            latestTurnId: existingRow.value.latestTurnId,
          }),
          projectionThreadActivityRepository.listUserInputLifecycleByThreadId({ threadId }),
          projectionPendingApprovalRepository.countPendingByThreadId({ threadId }),
        ]);

      const pendingUserInputCount = derivePendingUserInputCountFromActivities(activities);

      yield* projectionThreadRepository.upsert({
        ...existingRow.value,
        latestUserMessageAt,
        pendingApprovalCount,
        pendingUserInputCount,
        hasActionableProposedPlan: hasActionableProposedPlan ? 1 : 0,
      });
    });

    const applyThreadsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadsProjection",
    )(function* (event, attachmentSideEffects) {
      switch (event.type) {
        case "thread.created":
          // A draft retry can re-create this id; links belong to the old incarnation.
          yield* projectionThreadPullRequestRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* projectionThreadRepository.upsert({
            threadId: event.payload.threadId,
            projectId: event.payload.projectId,
            title: event.payload.title,
            modelSelection: event.payload.modelSelection,
            routingMode: event.payload.routingMode ?? "manual",
            efficiencyTier: event.payload.efficiencyTier ?? null,
            runtimeMode: event.payload.runtimeMode,
            interactionMode: event.payload.interactionMode,
            branch: event.payload.branch,
            worktreePath: event.payload.worktreePath,
            sandbox: event.payload.sandbox ?? null,
            linkedPullRequest: null,
            branchPullRequest: null,
            latestTurnId: null,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            unsettledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            pinnedAt: null,
            pinOrderKey: null,
            activeOrderKey: null,
            titleRegenerationRequestId: null,
            titleRegenerationStartedAt: null,
            latestUserMessageAt: null,
            pendingApprovalCount: 0,
            pendingUserInputCount: 0,
            hasActionableProposedPlan: 0,
            deletedAt: null,
          });
          return;

        case "sandbox.provisioning-started":
        case "sandbox.ready":
        case "sandbox.failed":
        case "sandbox.paused":
        case "sandbox.takeover-requested":
        case "sandbox.takeover-acquired":
        case "sandbox.resumed":
        case "sandbox.stopping":
        case "sandbox.expired":
        case "sandbox.stopped":
        case "sandbox.reconciled":
        case "sandbox.branch-exported": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            sandbox: event.payload.sandbox,
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.archived": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt: event.payload.archivedAt,
            titleRegenerationRequestId: null,
            titleRegenerationStartedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unarchived": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.settled": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            settledOverride: "settled",
            settledAt: event.payload.settledAt,
            unsettledAt: null,
            activeOrderKey: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unsettled": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            settledOverride: event.payload.reason === "user" ? "active" : null,
            settledAt: null,
            // Re-entry stamp for active-list ordering. A thread already pinned
            // active keeps its stamp: the activity reset that clears the pin
            // is not a re-entry and must not reorder the list.
            unsettledAt:
              existingRow.value.settledOverride === "active"
                ? existingRow.value.unsettledAt
                : event.payload.updatedAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.snoozed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            snoozedUntil: event.payload.snoozedUntil,
            snoozedAt: event.payload.snoozedAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unsnoozed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            snoozedUntil: null,
            snoozedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.pinned": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            pinnedAt: event.payload.pinnedAt,
            ...(event.payload.pinOrderKey !== undefined
              ? { pinOrderKey: event.payload.pinOrderKey }
              : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unpinned": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            pinnedAt: null,
            pinOrderKey: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.pin-reordered": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            pinOrderKey: event.payload.orderKey,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.meta-updated": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.activeOrderKey !== undefined
              ? { activeOrderKey: event.payload.activeOrderKey }
              : {}),
            ...(event.payload.titleState !== undefined
              ? { titleState: event.payload.titleState }
              : {}),
            ...(event.payload.titleRegeneration !== undefined
              ? {
                  titleRegenerationRequestId: event.payload.titleRegeneration?.requestId ?? null,
                  titleRegenerationStartedAt: event.payload.titleRegeneration?.startedAt ?? null,
                }
              : {}),
            ...(event.payload.modelSelection !== undefined
              ? { modelSelection: event.payload.modelSelection }
              : {}),
            ...(event.payload.routingMode !== undefined
              ? { routingMode: event.payload.routingMode }
              : {}),
            ...(event.payload.efficiencyTier !== undefined
              ? { efficiencyTier: event.payload.efficiencyTier }
              : {}),
            ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
            ...(event.payload.worktreePath !== undefined
              ? { worktreePath: event.payload.worktreePath }
              : {}),
            ...(event.payload.linkedPullRequest !== undefined
              ? { linkedPullRequest: event.payload.linkedPullRequest }
              : {}),
            ...(event.payload.branchPullRequest !== undefined
              ? { branchPullRequest: event.payload.branchPullRequest }
              : {}),
            updatedAt: event.payload.updatedAt,
          });
          // Legacy single-link events replay into the link table. The old
          // field held one user-chosen link, so it only ever owns the manual
          // rows; created/agent/stack links are left alone.
          if (event.payload.linkedPullRequest !== undefined) {
            yield* projectionThreadPullRequestRepository.deleteByThreadIdAndSource({
              threadId: event.payload.threadId,
              source: "manual",
            });
            if (event.payload.linkedPullRequest !== null) {
              const linked = event.payload.linkedPullRequest;
              yield* projectionThreadPullRequestRepository.upsert({
                threadId: event.payload.threadId,
                ...legacyThreadPullRequestKey(linked),
                url: linked.url,
                source: "manual",
                linkedAt: event.payload.updatedAt,
                snapshot: null,
                stack: null,
              });
            }
          }
          return;
        }

        case "thread.pull-request-linked": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadPullRequestRepository.upsert({
            threadId: event.payload.threadId,
            ...event.payload.link,
          });
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.pull-request-unlinked": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const links = yield* projectionThreadPullRequestRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const link = links.find((candidate) =>
            threadPullRequestKeysEqual(candidate, event.payload),
          );
          if (link !== undefined) {
            yield* projectionThreadPullRequestRepository.delete({
              threadId: event.payload.threadId,
              host: link.host,
              repository: link.repository,
              number: link.number,
            });
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.pull-request-synced": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          // A sync for a link the user removed in the meantime is stale; drop it.
          const links = yield* projectionThreadPullRequestRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const link = links.find((candidate) =>
            threadPullRequestKeysEqual(candidate, event.payload),
          );
          if (link === undefined) {
            return;
          }
          yield* projectionThreadPullRequestRepository.upsert({
            ...link,
            snapshot: event.payload.snapshot,
            stack: event.payload.stack,
          });
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.runtime-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            runtimeMode: event.payload.runtimeMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.interaction-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            interactionMode: event.payload.interactionMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.turn-start-requested": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) return;
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...(event.payload.modelSelection === undefined
              ? {}
              : { modelSelection: event.payload.modelSelection }),
            ...(event.payload.routingMode === undefined
              ? {}
              : { routingMode: event.payload.routingMode }),
            ...(event.payload.efficiencyTier === undefined
              ? {}
              : { efficiencyTier: event.payload.efficiencyTier }),
            updatedAt: event.payload.createdAt,
          });
          return;
        }

        case "thread.deleted": {
          // A draft retry can re-create this id later in the log. During
          // replay the attachment files on disk already belong to that later
          // incarnation, so only an unsuperseded deletion removes them.
          const recreatedLater = yield* eventStore.hasEventAfter({
            aggregateKind: "thread",
            aggregateId: event.payload.threadId,
            type: "thread.created",
            sequenceExclusive: event.sequence,
          });
          if (!recreatedLater) {
            attachmentSideEffects.deletedThreadIds.add(event.payload.threadId);
          }
          // A tombstoned thread must not show up as linked to a pull request.
          yield* projectionThreadPullRequestRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          });
          return;
        }

        // A message cannot change any summary field except latestUserMessageAt,
        // which is a monotonic maximum that folds in directly. The full refresh
        // would re-read every message body in the thread per user message.
        case "thread.message-sent": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const previousLatest = existingRow.value.latestUserMessageAt;
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            updatedAt: event.occurredAt,
            latestUserMessageAt:
              event.payload.role === "user" &&
              !isImportedAgentSessionMessageId(event.payload.messageId) &&
              (previousLatest === null || event.payload.createdAt > previousLatest)
                ? event.payload.createdAt
                : previousLatest,
          });
          return;
        }

        case "thread.proposed-plan-upserted":
        case "thread.activity-appended":
        case "thread.approval-response-requested":
        case "thread.user-input-response-requested": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            updatedAt: event.occurredAt,
          });
          if (shouldRefreshThreadShellSummary(event)) {
            yield* refreshThreadShellSummary(event.payload.threadId);
          }
          return;
        }

        case "thread.session-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            // activeTurnId describes current work; a terminal session must not erase history.
            latestTurnId: event.payload.session.activeTurnId ?? existingRow.value.latestTurnId,
            updatedAt: event.occurredAt,
          });
          yield* refreshThreadShellSummary(event.payload.threadId);
          return;
        }

        case "thread.turn-diff-completed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (
            Option.isSome(existingTurn) &&
            existingTurn.value.checkpointStatus !== null &&
            existingTurn.value.checkpointStatus !== "missing" &&
            event.payload.status === "missing"
          ) {
            return;
          }
          // The concrete-turn projector repeats this guard before
          // clearCheckpointTurnConflict so neither projector can perturb ready
          // checkpoint state for a delayed missing placeholder.
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId: event.payload.turnId,
            updatedAt: event.occurredAt,
          });
          yield* refreshThreadShellSummary(event.payload.threadId);
          return;
        }

        case "thread.reverted": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }

          const retainedTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          let latestTurnId: ProjectionTurn["turnId"] = null;
          let latestCheckpointTurnCount = -1;
          for (let index = 0; index < retainedTurns.length; index += 1) {
            const turn = retainedTurns[index];
            if (
              !turn ||
              turn.turnId === null ||
              turn.checkpointTurnCount === null ||
              turn.checkpointTurnCount > event.payload.turnCount
            ) {
              continue;
            }
            if (turn.checkpointTurnCount > latestCheckpointTurnCount) {
              latestCheckpointTurnCount = turn.checkpointTurnCount;
              latestTurnId = turn.turnId;
            }
          }

          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId,
            updatedAt: event.occurredAt,
          });
          yield* refreshThreadShellSummary(event.payload.threadId);
          return;
        }

        default:
          return;
      }
    });

    const applyThreadMessagesProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadMessagesProjection",
    )(function* (event, attachmentSideEffects) {
      switch (event.type) {
        // A draft retry re-creates a soft-deleted thread id. Every projector
        // drops its own rows for the old incarnation here so replay from any
        // per-projector cursor rebuilds the new thread without stale history.
        case "thread.created":
          yield* projectionThreadMessageRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          return;

        case "thread.message-sent": {
          if (event.payload.streaming) {
            const attachments =
              event.payload.attachments !== undefined
                ? yield* materializeAttachmentsForProjection({
                    attachments: event.payload.attachments,
                  })
                : undefined;
            yield* projectionThreadMessageRepository.appendStreaming({
              messageId: event.payload.messageId,
              threadId: event.payload.threadId,
              turnId: event.payload.turnId,
              role: event.payload.role,
              text: event.payload.text,
              ...(attachments !== undefined ? { attachments: [...attachments] } : {}),
              ...(event.payload.context !== undefined ? { context: event.payload.context } : {}),
              createdAt: event.payload.createdAt,
              updatedAt: event.payload.updatedAt,
            });
            return;
          }

          const existingMessage = yield* projectionThreadMessageRepository.getByMessageId({
            messageId: event.payload.messageId,
          });
          const previousMessage = Option.getOrUndefined(existingMessage);
          const nextText = Option.match(existingMessage, {
            onNone: () => event.payload.text,
            onSome: (message) =>
              event.payload.text.length === 0 ? message.text : event.payload.text,
          });
          const nextAttachments =
            event.payload.attachments !== undefined
              ? yield* materializeAttachmentsForProjection({
                  attachments: event.payload.attachments,
                })
              : previousMessage?.attachments;
          yield* projectionThreadMessageRepository.upsert({
            messageId: event.payload.messageId,
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            role: event.payload.role,
            text: nextText,
            ...(nextAttachments !== undefined ? { attachments: [...nextAttachments] } : {}),
            ...((event.payload.context ?? previousMessage?.context) !== undefined
              ? { context: event.payload.context ?? previousMessage?.context }
              : {}),
            isStreaming: false,
            createdAt: previousMessage?.createdAt ?? event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.reverted": {
          const existingRows = yield* projectionThreadMessageRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionMessagesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }

          yield* projectionThreadMessageRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadMessageRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          attachmentSideEffects.prunedThreadRelativePaths.set(
            event.payload.threadId,
            collectThreadAttachmentRelativePaths(event.payload.threadId, keptRows),
          );
          return;
        }

        default:
          return;
      }
    });

    const applyThreadProposedPlansProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadProposedPlansProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.created":
          yield* projectionThreadProposedPlanRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          return;

        case "thread.proposed-plan-upserted":
          yield* projectionThreadProposedPlanRepository.upsert({
            planId: event.payload.proposedPlan.id,
            threadId: event.payload.threadId,
            turnId: event.payload.proposedPlan.turnId,
            planMarkdown: event.payload.proposedPlan.planMarkdown,
            implementedAt: event.payload.proposedPlan.implementedAt,
            implementationThreadId: event.payload.proposedPlan.implementationThreadId,
            createdAt: event.payload.proposedPlan.createdAt,
            updatedAt: event.payload.proposedPlan.updatedAt,
          });
          return;

        case "thread.reverted": {
          const existingRows = yield* projectionThreadProposedPlanRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionProposedPlansAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }

          yield* projectionThreadProposedPlanRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadProposedPlanRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyThreadActivitiesProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadActivitiesProjection",
    )(function* (event, attachmentSideEffects) {
      switch (event.type) {
        case "thread.created":
          yield* projectionThreadActivityRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          return;

        case "thread.activity-appended":
          yield* projectionThreadActivityRepository.upsert({
            activityId: event.payload.activity.id,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            ...(event.payload.activity.correlatedMessageId !== undefined
              ? { correlatedMessageId: event.payload.activity.correlatedMessageId }
              : {}),
            tone: event.payload.activity.tone,
            kind: event.payload.activity.kind,
            summary: event.payload.activity.summary,
            payload: event.payload.activity.payload,
            ...(event.payload.activity.sequence !== undefined
              ? { sequence: event.payload.activity.sequence }
              : {}),
            createdAt: event.payload.activity.createdAt,
          });
          return;

        case "thread.reverted": {
          const existingRows = yield* projectionThreadActivityRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionActivitiesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }
          yield* projectionThreadActivityRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadActivityRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          attachmentSideEffects.prunedThreadRelativePaths.set(event.payload.threadId, new Set());
          return;
        }

        default:
          return;
      }
    });

    const applyThreadSessionsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadSessionsProjection",
    )(function* (event, _attachmentSideEffects) {
      if (event.type === "thread.created") {
        yield* projectionThreadSessionRepository.deleteByThreadId({
          threadId: event.payload.threadId,
        });
        return;
      }
      if (event.type !== "thread.session-set") {
        return;
      }
      yield* projectionThreadSessionRepository.upsert({
        threadId: event.payload.threadId,
        status: event.payload.session.status,
        providerName: event.payload.session.providerName,
        providerInstanceId: event.payload.session.providerInstanceId ?? null,
        sessionGeneration: event.payload.session.sessionGeneration ?? null,
        runtimeMode: event.payload.session.runtimeMode,
        activeTurnId: event.payload.session.activeTurnId,
        lastError: event.payload.session.lastError,
        updatedAt: event.payload.session.updatedAt,
      });
    });

    const applyThreadTurnsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadTurnsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.created":
          yield* projectionTurnRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          return;

        case "thread.turn-start-requested": {
          // Appended, not replaced. Each turn-start-requested gets its own
          // placeholder keyed by this event's sequence, so a message queued
          // behind an already-sent turn keeps its own row instead of evicting
          // (and being evicted by) its neighbours.
          const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          });
          if (Option.isSome(pendingTurnStart)) {
            const pendingMessage = yield* projectionThreadMessageRepository.getByMessageId({
              messageId: pendingTurnStart.value.messageId,
            });
            if (
              Option.isSome(pendingMessage) &&
              pendingMessage.value.role === "user" &&
              (pendingMessage.value.attachments?.length ?? 0) === 0 &&
              pendingMessage.value.text.trim().toLowerCase() === "/compact"
            ) {
              return;
            }
          }
          yield* projectionTurnRepository.appendPendingTurnStart({
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            sourceProposedPlanThreadId: event.payload.sourceProposedPlan?.threadId ?? null,
            sourceProposedPlanId: event.payload.sourceProposedPlan?.planId ?? null,
            requestedAt: event.payload.createdAt,
            requestSequence: event.sequence,
            modelSelection: event.payload.modelSelection ?? null,
            efficiencyDecision: event.payload.efficiencyDecision ?? null,
            pendingInterruptRequested: false,
          });
          return;
        }

        case "thread.activity-appended": {
          if (event.payload.activity.kind === "context-compaction") {
            const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId(
              event.payload,
            );
            if (
              Option.isNone(pendingTurnStart) ||
              String(pendingTurnStart.value.messageId) !==
                extractActivityRequestId(event.payload.activity.payload)
            ) {
              return;
            }
            yield* projectionTurnRepository.deletePendingTurnStartByThreadId(event.payload);
            return;
          }
          if (event.payload.activity.kind !== "provider.turn.start.failed") return;
          const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId(
            event.payload,
          );
          if (
            Option.isNone(pendingTurnStart) ||
            String(pendingTurnStart.value.messageId) !==
              extractActivityRequestId(event.payload.activity.payload)
          ) {
            return;
          }
          yield* projectionTurnRepository.deletePendingTurnStartByThreadId(event.payload);
          return;
        }

        case "thread.session-set": {
          const turnId = event.payload.session.activeTurnId;
          const legacyTerminalState = settledTurnStateForSessionStatus(
            event.payload.session.status,
          );
          const terminalTurnTransitions = normalizeTerminalTurnTransitions(
            event.payload,
            legacyTerminalState,
          );
          const legacySessionSet =
            event.payload.pendingTurnStartAdoption === undefined &&
            event.payload.terminalTurnTransitions === undefined;
          const terminalSession =
            event.payload.session.status === "interrupted" ||
            event.payload.session.status === "stopped" ||
            event.payload.session.status === "error";

          yield* Effect.forEach(
            terminalTurnTransitions,
            (terminalTurnTransition) =>
              Effect.gen(function* () {
                const settledTurn = yield* projectionTurnRepository.getByTurnId({
                  threadId: event.payload.threadId,
                  turnId: terminalTurnTransition.turnId,
                });
                if (Option.isSome(settledTurn) && settledTurn.value.state === "running") {
                  yield* projectionTurnRepository.upsertByTurnId({
                    ...settledTurn.value,
                    state: terminalTurnTransition.state,
                    completedAt: event.payload.session.updatedAt,
                  });
                }
              }),
            { concurrency: 1 },
          );

          if (turnId === null || event.payload.session.status !== "running") {
            // Once the provider session is terminal, no queued start can still
            // be adopted by that session. Starting and ready states can still
            // be reconnecting with a queued turn, so preserve their placeholder.
            // A `ready` set by an explicit server provider-session-set command is
            // the exception: it settles the session without adopting the queue.
            if (
              terminalSession ||
              (event.payload.session.status === "ready" &&
                event.commandId?.startsWith("server:provider-session-set:") === true)
            ) {
              yield* projectionTurnRepository.deletePendingTurnStartByThreadId({
                threadId: event.payload.threadId,
              });
            }
            if (terminalTurnTransitions.length > 0) {
              return;
            }
            if (!legacySessionSet || legacyTerminalState === null) {
              return;
            }

            // Historical session-set events predate exact transition metadata.
            // Rebuild them with their original broad terminalization semantics;
            // every newly-decided event carries the adoption discriminator above
            // and therefore cannot enter this compatibility branch.
            const existingTurns = yield* projectionTurnRepository.listByThreadId({
              threadId: event.payload.threadId,
            });
            yield* Effect.forEach(
              existingTurns.filter((turn) => turn.turnId !== null && turn.state === "running"),
              (turn) =>
                turn.turnId === null
                  ? Effect.void
                  : projectionTurnRepository.upsertByTurnId({
                      ...turn,
                      turnId: turn.turnId,
                      state: legacyTerminalState,
                      completedAt: event.payload.session.updatedAt,
                    }),
              { concurrency: 1 },
            );
            return;
          }

          if (legacySessionSet) {
            const otherRunningTurns = yield* projectionTurnRepository.listByThreadId({
              threadId: event.payload.threadId,
            });
            yield* Effect.forEach(
              otherRunningTurns.filter(
                (turn) =>
                  turn.turnId !== null && turn.turnId !== turnId && turn.state === "running",
              ),
              (turn) =>
                turn.turnId === null
                  ? Effect.void
                  : projectionTurnRepository.upsertByTurnId({
                      ...turn,
                      turnId: turn.turnId,
                      state: "completed",
                      completedAt: event.payload.session.updatedAt,
                    }),
              { concurrency: 1 },
            );
          }

          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId,
          });
          // Adopt the placeholder this turn was actually started for, not
          // whichever one happens to be oldest. Sends run in independent
          // fibers and every adapter has a yield point between "is a turn
          // active?" and recording the new turn, so two turn-start requests
          // can produce `turn.started` events in the opposite order to the
          // requests. Positional adoption then hands the later turn the
          // earlier message's model, source plan and interrupt flag.
          //
          // `turnRequestSequence` is the request's own event sequence, carried
          // through the send input and echoed back on `turn.started`. The
          // adoption discriminator distinguishes exact starts, genuine
          // sequence-less starts, and routine lifecycle writes that must adopt
          // nothing. Historical events lack the discriminator and retain their
          // pre-upgrade exact-or-oldest behavior during rebuild.
          const pendingTurnStarts = yield* projectionTurnRepository.listPendingTurnStartsByThreadId(
            { threadId: event.payload.threadId },
          );
          const requestSequence = event.payload.turnRequestSequence;
          const matchedPendingTurnStart =
            requestSequence === undefined
              ? undefined
              : pendingTurnStarts.find((row) => row.requestSequence === requestSequence);
          const adoptedPendingTurnStart = (() => {
            switch (event.payload.pendingTurnStartAdoption) {
              case "none":
                return undefined;
              case "exact":
                return matchedPendingTurnStart;
              case "oldest-pending":
                return pendingTurnStarts[0];
              case undefined:
                return requestSequence === undefined
                  ? pendingTurnStarts[0]
                  : matchedPendingTurnStart;
            }
          })();
          // Adopting nothing is a real outcome with real consequences — the
          // turn loses its pendingMessageId, its source plan and its
          // born-interrupted flag — so it must not be silent. On replay the
          // placeholder is legitimately gone, but rows still WAITING while a
          // correlated start declines to adopt any of them is the signature
          // of a correlation bug, and without this line the only evidence is
          // a turn that quietly forgot which message asked for it.
          if (
            requestSequence !== undefined &&
            event.payload.pendingTurnStartAdoption !== "none" &&
            matchedPendingTurnStart === undefined
          ) {
            yield* Effect.logWarning("projection.turn-start.pending-start-not-correlated", {
              threadId: event.payload.threadId,
              turnId,
              requestSequence,
              pendingTurnStartCount: pendingTurnStarts.length,
              pendingRequestSequences: pendingTurnStarts.map((row) => row.requestSequence),
            });
          }
          const pendingTurnStart: Option.Option<ProjectionPendingTurnStart> =
            adoptedPendingTurnStart === undefined
              ? Option.none()
              : Option.some(adoptedPendingTurnStart);
          // A user interrupt that landed on the pending start before the provider
          // reported `turn.started` (id-less interrupt) births this turn already
          // `interrupted`, so the ensuing session exit does not auto-resume it.
          const bornInterrupted =
            Option.isSome(pendingTurnStart) && pendingTurnStart.value.pendingInterruptRequested;
          const matchingTerminalTransition = terminalTurnTransitions.find(
            (transition) => transition.turnId === turnId,
          );
          if (Option.isSome(existingTurn)) {
            const existingTurnIsTerminal =
              existingTurn.value.state === "completed" ||
              existingTurn.value.state === "interrupted" ||
              existingTurn.value.state === "error";
            const nextState = existingTurnIsTerminal
              ? existingTurn.value.state
              : (matchingTerminalTransition?.state ??
                (bornInterrupted ? "interrupted" : "running"));
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: nextState,
              completedAt: existingTurnIsTerminal
                ? existingTurn.value.completedAt
                : nextState === "running"
                  ? existingTurn.value.completedAt
                  : event.payload.session.updatedAt,
              pendingMessageId:
                existingTurn.value.pendingMessageId ??
                (Option.isSome(pendingTurnStart) ? pendingTurnStart.value.messageId : null),
              sourceProposedPlanThreadId:
                existingTurn.value.sourceProposedPlanThreadId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanThreadId
                  : null),
              sourceProposedPlanId:
                existingTurn.value.sourceProposedPlanId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanId
                  : null),
              startedAt:
                existingTurn.value.startedAt ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt),
              requestedAt:
                existingTurn.value.requestedAt ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt),
              requestSequence:
                existingTurn.value.requestSequence ??
                (Option.isSome(pendingTurnStart) ? pendingTurnStart.value.requestSequence : null),
              efficiencyDecision:
                existingTurn.value.efficiencyDecision ??
                (Option.isSome(pendingTurnStart)
                  ? (pendingTurnStart.value.efficiencyDecision ?? null)
                  : null),
            });
          } else {
            yield* projectionTurnRepository.upsertByTurnId({
              turnId,
              threadId: event.payload.threadId,
              pendingMessageId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.messageId
                : null,
              sourceProposedPlanThreadId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanThreadId
                : null,
              sourceProposedPlanId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanId
                : null,
              assistantMessageId: null,
              state:
                matchingTerminalTransition?.state ?? (bornInterrupted ? "interrupted" : "running"),
              requestedAt: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt,
              requestSequence: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestSequence
                : null,
              startedAt: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt,
              completedAt:
                matchingTerminalTransition !== undefined || bornInterrupted
                  ? event.payload.session.updatedAt
                  : null,
              checkpointTurnCount: null,
              checkpointRef: null,
              checkpointStatus: null,
              checkpointFiles: [],
              efficiencyDecision: Option.isSome(pendingTurnStart)
                ? (pendingTurnStart.value.efficiencyDecision ?? null)
                : null,
            });
          }

          // Consume only the placeholder this turn actually corresponds to —
          // the correlated one selected above, whose metadata was just copied
          // onto the turn. Clearing the whole thread here would silently
          // discard messages the user queued behind this turn, leaving no row
          // for the provider's next `turn.started` to adopt and nothing for
          // reconciliation to report if the session dies first.
          if (Option.isSome(pendingTurnStart)) {
            yield* projectionTurnRepository.deletePendingTurnStart({
              threadId: event.payload.threadId,
              requestSequence: pendingTurnStart.value.requestSequence,
            });
          }
          return;
        }

        case "thread.turn-start-folded": {
          // A steer: the message reached the provider and was folded into the
          // running turn, which emits no `turn.started` and so never consumes
          // this placeholder. Consuming it here is what keeps a delivered
          // message from reading as "requested but never started" — the premise
          // auto-resume, the side-effect gate, and orphan reconciliation all
          // draw their conclusions from.
          //
          // The row is deleted rather than turned into a turn of its own: the
          // steered message has no turn boundary and no distinct turn id, so a
          // second row for the same running turn would double-count the work.
          yield* projectionTurnRepository.deletePendingTurnStart({
            threadId: event.payload.threadId,
            requestSequence: event.payload.turnRequestSequence,
          });
          return;
        }

        case "thread.message-sent": {
          if (event.payload.turnId === null || event.payload.role !== "assistant") {
            return;
          }
          // A completed assistant message only settles the turn once the
          // session is no longer running it — providers may emit several
          // assistant messages per turn (commentary between tool calls), and
          // the turn must stay unsettled until the provider reports turn end
          // (projected as thread.session-set leaving the "running" status).
          const session = yield* projectionThreadSessionRepository.getByThreadId({
            threadId: event.payload.threadId,
          });
          const turnStillRunning =
            Option.isSome(session) &&
            session.value.status === "running" &&
            session.value.activeTurnId === event.payload.turnId;
          const settlesTurn = !event.payload.streaming && !turnStillRunning;
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId: event.payload.messageId,
              state: settlesTurn
                ? existingTurn.value.state === "interrupted"
                  ? "interrupted"
                  : existingTurn.value.state === "error"
                    ? "error"
                    : "completed"
                : existingTurn.value.state,
              completedAt: settlesTurn
                ? (existingTurn.value.completedAt ?? event.payload.updatedAt)
                : existingTurn.value.completedAt,
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.messageId,
            state: settlesTurn ? "completed" : "running",
            requestedAt: event.payload.createdAt,
            requestSequence: null,
            startedAt: event.payload.createdAt,
            completedAt: settlesTurn ? event.payload.updatedAt : null,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
          return;
        }

        case "thread.turn-interrupt-requested": {
          // The user stopped the thread. The provider interrupts by session, so
          // any turn-start still pending (a steer whose provider `turn.started`
          // has not been projected yet) is canceled along with it. Flag its
          // placeholder — the only row spanning the turn-start-requested ->
          // session-set(running) window — so the turn is born `interrupted`
          // rather than `running` when that placeholder is consumed. This runs
          // unconditionally, regardless of whether the interrupt resolved a
          // concrete turn id: an id-less interrupt has no turn row to settle,
          // and an interrupt that resolved the *older* active turn (because the
          // newer steer's `turn.started` had not landed, so the session still
          // exposed the previous turn id) would otherwise settle the old turn
          // yet leave the newer pending steer unmarked — a delayed `turn.started`
          // would then birth it `running` and a later exit auto-resume work the
          // user stopped. A no-op when nothing is pending.
          yield* projectionTurnRepository.markPendingTurnStartInterrupted({
            threadId: event.payload.threadId,
          });
          if (event.payload.turnId === undefined) {
            return;
          }
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: "interrupted",
              completedAt: existingTurn.value.completedAt ?? event.payload.createdAt,
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: null,
            state: "interrupted",
            requestedAt: event.payload.createdAt,
            requestSequence: null,
            startedAt: event.payload.createdAt,
            completedAt: event.payload.createdAt,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
          return;
        }

        case "thread.turn-diff-completed": {
          // Mid-turn diff updates produce placeholder checkpoints; record the
          // checkpoint, but don't settle a turn its session is still running.
          const session = yield* projectionThreadSessionRepository.getByThreadId({
            threadId: event.payload.threadId,
          });
          const turnStillRunning =
            Option.isSome(session) &&
            session.value.status === "running" &&
            session.value.activeTurnId === event.payload.turnId;
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (
            Option.isSome(existingTurn) &&
            existingTurn.value.checkpointStatus !== null &&
            existingTurn.value.checkpointStatus !== "missing" &&
            event.payload.status === "missing"
          ) {
            return;
          }
          const nextState = event.payload.status === "error" ? "error" : "completed";
          yield* projectionTurnRepository.clearCheckpointTurnConflict({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            checkpointTurnCount: event.payload.checkpointTurnCount,
          });

          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId: event.payload.assistantMessageId,
              state:
                turnStillRunning || existingTurn.value.state === "interrupted"
                  ? existingTurn.value.state
                  : nextState,
              checkpointTurnCount: event.payload.checkpointTurnCount,
              checkpointRef: event.payload.checkpointRef,
              checkpointStatus: event.payload.status,
              checkpointFiles: event.payload.files,
              startedAt: existingTurn.value.startedAt ?? event.payload.completedAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.completedAt,
              completedAt: event.payload.completedAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.assistantMessageId,
            state: turnStillRunning ? "running" : nextState,
            requestedAt: event.payload.completedAt,
            requestSequence: null,
            startedAt: event.payload.completedAt,
            completedAt: event.payload.completedAt,
            checkpointTurnCount: event.payload.checkpointTurnCount,
            checkpointRef: event.payload.checkpointRef,
            checkpointStatus: event.payload.status,
            checkpointFiles: event.payload.files,
          });
          return;
        }

        case "thread.reverted": {
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptTurns = existingTurns.filter(
            (turn) =>
              turn.turnId !== null &&
              turn.checkpointTurnCount !== null &&
              turn.checkpointTurnCount <= event.payload.turnCount,
          );
          yield* projectionTurnRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(
            keptTurns,
            (turn) =>
              turn.turnId === null
                ? Effect.void
                : projectionTurnRepository.upsertByTurnId({
                    ...turn,
                    turnId: turn.turnId,
                  }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyCheckpointsProjection: ProjectorDefinition["apply"] = () => Effect.void;

    const applyPendingApprovalsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyPendingApprovalsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.created":
          yield* projectionPendingApprovalRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          return;

        case "thread.activity-appended": {
          const requestId =
            extractActivityRequestId(event.payload.activity.payload) ??
            event.metadata.requestId ??
            null;
          if (requestId === null) {
            return;
          }
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId,
          });
          if (event.payload.activity.kind === "approval.resolved") {
            const resolvedDecisionRaw =
              typeof event.payload.activity.payload === "object" &&
              event.payload.activity.payload !== null &&
              "decision" in event.payload.activity.payload
                ? (event.payload.activity.payload as { decision?: unknown }).decision
                : null;
            const resolvedDecision =
              resolvedDecisionRaw === "accept" ||
              resolvedDecisionRaw === "acceptForSession" ||
              resolvedDecisionRaw === "acceptAlways" ||
              resolvedDecisionRaw === "decline" ||
              resolvedDecisionRaw === "cancel"
                ? resolvedDecisionRaw
                : null;
            yield* projectionPendingApprovalRepository.upsert({
              requestId,
              threadId: Option.isSome(existingRow)
                ? existingRow.value.threadId
                : event.payload.threadId,
              turnId: Option.isSome(existingRow)
                ? existingRow.value.turnId
                : event.payload.activity.turnId,
              status: "resolved",
              decision: resolvedDecision,
              createdAt: Option.isSome(existingRow)
                ? existingRow.value.createdAt
                : event.payload.activity.createdAt,
              resolvedAt: event.payload.activity.createdAt,
            });
            return;
          }
          if (event.payload.activity.kind === "provider.approval.respond.failed") {
            const payload =
              typeof event.payload.activity.payload === "object" &&
              event.payload.activity.payload !== null
                ? (event.payload.activity.payload as Record<string, unknown>)
                : null;
            const detail =
              typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
            if (isStalePendingApprovalFailureDetail(detail)) {
              if (Option.isNone(existingRow)) {
                return;
              }
              if (existingRow.value.status === "resolved") {
                return;
              }
              yield* projectionPendingApprovalRepository.upsert({
                requestId,
                threadId: existingRow.value.threadId,
                turnId: existingRow.value.turnId,
                status: "resolved",
                decision: null,
                createdAt: existingRow.value.createdAt,
                resolvedAt: event.payload.activity.createdAt,
              });
              return;
            }
            if (Option.isNone(existingRow) || existingRow.value.status !== "resolved") {
              return;
            }

            // Sending a reply clears the badge before the provider accepts it.
            // A failed reply must restore the request unless a terminal event
            // already closed it, including a reply from another client.
            const requestActivities = (yield* projectionThreadActivityRepository.listByThreadId({
              threadId: existingRow.value.threadId,
            })).filter((activity) => extractActivityRequestId(activity.payload) === requestId);
            const wasRequested = requestActivities.some(
              (activity) => activity.kind === "approval.requested",
            );
            const wasResolved = requestActivities.some((activity) => {
              if (activity.kind === "approval.resolved") {
                return true;
              }
              if (activity.kind !== "provider.approval.respond.failed") {
                return false;
              }
              const activityPayload =
                typeof activity.payload === "object" && activity.payload !== null
                  ? (activity.payload as Record<string, unknown>)
                  : null;
              return isStalePendingApprovalFailureDetail(
                typeof activityPayload?.detail === "string"
                  ? activityPayload.detail.toLowerCase()
                  : null,
              );
            });
            if (wasRequested && !wasResolved) {
              yield* projectionPendingApprovalRepository.upsert({
                ...existingRow.value,
                status: "pending",
                decision: null,
                resolvedAt: null,
              });
            }
            return;
          }
          // Only approval-requested activities should create pending-approval
          // rows.  Other activity kinds that happen to carry a requestId
          // (e.g. user-input.requested / user-input.resolved) must not
          // pollute this projection — they have their own accounting via
          // derivePendingUserInputCountFromActivities.
          if (event.payload.activity.kind !== "approval.requested") {
            return;
          }
          if (Option.isSome(existingRow) && existingRow.value.status === "resolved") {
            return;
          }
          yield* projectionPendingApprovalRepository.upsert({
            requestId,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            status: "pending",
            decision: null,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.activity.createdAt,
            resolvedAt: null,
          });
          return;
        }

        case "thread.approval-response-requested": {
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId: event.payload.requestId,
          });
          yield* projectionPendingApprovalRepository.upsert({
            requestId: event.payload.requestId,
            threadId: Option.isSome(existingRow)
              ? existingRow.value.threadId
              : event.payload.threadId,
            turnId: Option.isSome(existingRow) ? existingRow.value.turnId : null,
            status: "resolved",
            decision: event.payload.decision,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.createdAt,
            resolvedAt: event.payload.createdAt,
          });
          return;
        }

        default:
          return;
      }
    });

    const projectors: ReadonlyArray<ProjectorDefinition> = [
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.projects,
        apply: applyProjectsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
        apply: applyThreadMessagesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
        apply: applyThreadProposedPlansProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
        apply: applyThreadActivitiesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
        apply: applyThreadSessionsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
        apply: applyThreadTurnsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
        apply: applyCheckpointsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.pendingApprovals,
        apply: applyPendingApprovalsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threads,
        apply: applyThreadsProjection,
      },
    ];

    const applyAttachmentSideEffects = Effect.fn("applyAttachmentSideEffects")(
      function* (event: OrchestrationEvent, sideEffects: AttachmentSideEffects) {
        if (
          sideEffects.deletedThreadIds.size === 0 &&
          sideEffects.prunedThreadRelativePaths.size === 0
        ) {
          return;
        }

        const deletedThreadIds = new Set<string>();
        for (const threadId of sideEffects.deletedThreadIds) {
          const recreatedLater = yield* eventStore.hasEventAfter({
            aggregateKind: "thread",
            aggregateId: ThreadId.make(threadId),
            type: "thread.created",
            sequenceExclusive: event.sequence,
          });
          if (!recreatedLater) {
            deletedThreadIds.add(threadId);
          }
        }

        // Later events in the same transaction can add attachment references.
        const prunedThreadRelativePaths = new Map<string, Set<string>>();
        for (const threadId of sideEffects.prunedThreadRelativePaths.keys()) {
          const messages = yield* projectionThreadMessageRepository.listByThreadId({
            threadId: ThreadId.make(threadId),
          });
          const retainedPaths = collectThreadAttachmentRelativePaths(threadId, messages);
          const activities = yield* projectionThreadActivityRepository.listByThreadId({
            threadId: ThreadId.make(threadId),
          });
          for (const activity of activities) {
            if (activity.kind !== "user-input.answer-submitted") continue;
            const payload = decodeQuestionAttachmentAnswer(activity.payload);
            if (Option.isNone(payload)) continue;
            for (const attachment of Object.values(payload.value.attachmentsByQuestionId).flat()) {
              const relativePath = attachmentRelativePath(attachment);
              if (relativePath) retainedPaths.add(relativePath);
            }
          }
          prunedThreadRelativePaths.set(threadId, retainedPaths);
        }

        yield* runAttachmentSideEffects({ deletedThreadIds, prunedThreadRelativePaths });
      },
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
      (effect, event) =>
        effect.pipe(
          Effect.as(true),
          Effect.catch((cause) =>
            Effect.logWarning("failed to apply projected attachment side-effects", {
              sequence: event.sequence,
              eventType: event.type,
              cause,
            }).pipe(Effect.as(false)),
          ),
        ),
    );

    const runProjectorForEvent = Effect.fn("runProjectorForEvent")(function* (
      projector: ProjectorDefinition,
      event: OrchestrationEvent,
    ) {
      const attachmentSideEffects: AttachmentSideEffects = {
        deletedThreadIds: new Set<string>(),
        prunedThreadRelativePaths: new Map<string, Set<string>>(),
      };

      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* projector.apply(event, attachmentSideEffects);
          yield* projectionStateRepository.upsert({
            projector: projector.name,
            lastAppliedSequence: event.sequence,
            updatedAt: event.occurredAt,
          });
        }),
      );
    });

    const bootstrapProjector = (projector: ProjectorDefinition) =>
      projectionStateRepository
        .getByProjector({
          projector: projector.name,
        })
        .pipe(
          Effect.flatMap((stateRow) =>
            Stream.runForEach(
              eventStore.readFromSequence(
                Option.isSome(stateRow) ? stateRow.value.lastAppliedSequence : 0,
                Number.MAX_SAFE_INTEGER,
              ),
              (event) => runProjectorForEvent(projector, event),
            ),
          ),
        );

    const projectEventDeferred: OrchestrationProjectionPipelineShape["projectEventDeferred"] =
      Effect.fn("projectEventDeferred")(
        function* (event) {
          const attachmentSideEffects: AttachmentSideEffects = {
            deletedThreadIds: new Set<string>(),
            prunedThreadRelativePaths: new Map<string, Set<string>>(),
          };
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* Effect.forEach(
                projectors,
                (projector) => projector.apply(event, attachmentSideEffects),
                { concurrency: 1, discard: true },
              );
              // Runtime projectors commit together. Bootstrap still advances each cursor separately.
              yield* projectionStateRepository.upsertMany(
                projectors.map((projector) => ({
                  projector: projector.name,
                  lastAppliedSequence: event.sequence,
                  updatedAt: event.occurredAt,
                })),
              );
            }),
          );
          // Return the cleanup effect so the caller runs it after the outer transaction commits.
          // @effect-diagnostics-next-line returnEffectInGen:off
          return applyAttachmentSideEffects(event, attachmentSideEffects).pipe(Effect.asVoid);
        },
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ServerConfig, serverConfig),
        Effect.catchTag("SqlError", (sqlError) =>
          Effect.fail(toPersistenceSqlError("ProjectionPipeline.projectEvent:query")(sqlError)),
        ),
      );

    const projectEvent: OrchestrationProjectionPipelineShape["projectEvent"] = Effect.fn(
      "projectEvent",
    )(function* (event) {
      const cleanup = yield* projectEventDeferred(event);
      yield* cleanup;
    });

    const bootstrap: OrchestrationProjectionPipelineShape["bootstrap"] = Effect.gen(function* () {
      const cleanupProjector = "projection.attachment-cleanup";
      const states = yield* projectionStateRepository.listAll();
      const byProjector = new Map(states.map((state) => [state.projector, state]));
      const cleanupState = byProjector.get(cleanupProjector);
      const cleanupStart = Math.min(
        cleanupState?.lastAppliedSequence ?? 0,
        ...projectors.map((projector) => byProjector.get(projector.name)?.lastAppliedSequence ?? 0),
      );
      // Persist this boundary before replay: a reset projector can encounter an old
      // revert, then fail after other projectors have committed past that event.
      yield* projectionStateRepository.upsert({
        projector: cleanupProjector,
        lastAppliedSequence: cleanupStart,
        updatedAt: cleanupState?.updatedAt ?? "1970-01-01T00:00:00.000Z",
      });
      yield* Effect.forEach(projectors, bootstrapProjector, { concurrency: 1, discard: true });

      // Cleanup has its own cursor so retries never have to replay committed text.
      // All message and activity references are current before any files are removed.
      const pendingCleanup = new Map<string, OrchestrationEvent>();
      let lastEvent: OrchestrationEvent | undefined;
      yield* Stream.runForEach(
        eventStore.readFromSequence(cleanupStart, Number.MAX_SAFE_INTEGER),
        (event) =>
          Effect.sync(() => {
            lastEvent = event;
            if (event.type === "thread.reverted" || event.type === "thread.deleted") {
              pendingCleanup.set(`${event.type}:${event.payload.threadId}`, event);
            }
          }),
      );
      for (const event of pendingCleanup.values()) {
        if (event.type !== "thread.reverted" && event.type !== "thread.deleted") continue;
        const threadId = event.payload.threadId;
        const cleaned = yield* applyAttachmentSideEffects(event, {
          deletedThreadIds: new Set(event.type === "thread.deleted" ? [threadId] : []),
          prunedThreadRelativePaths: new Map(
            event.type === "thread.reverted" ? [[threadId, new Set<string>()]] : [],
          ),
        });
        // Leave the cleanup cursor behind this event so the next bootstrap retries it.
        if (!cleaned) return;
      }
      if (lastEvent) {
        yield* projectionStateRepository.upsert({
          projector: cleanupProjector,
          lastAppliedSequence: lastEvent.sequence,
          updatedAt: lastEvent.occurredAt,
        });
      }
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
      Effect.asVoid,
      Effect.tap(() =>
        Effect.logDebug("orchestration projection pipeline bootstrapped").pipe(
          Effect.annotateLogs({ projectors: projectors.length }),
        ),
      ),
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(toPersistenceSqlError("ProjectionPipeline.bootstrap:query")(sqlError)),
      ),
    );

    return {
      bootstrap,
      projectEvent,
      projectEventDeferred,
    } satisfies OrchestrationProjectionPipelineShape;
  },
);

export const OrchestrationProjectionPipelineLive = Layer.effect(
  OrchestrationProjectionPipeline,
  makeOrchestrationProjectionPipeline(),
).pipe(
  Layer.provideMerge(ProjectionProjectRepositoryLive),
  Layer.provideMerge(ProjectionThreadRepositoryLive),
  Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
  Layer.provideMerge(ProjectionThreadProposedPlanRepositoryLive),
  Layer.provideMerge(ProjectionThreadPullRequests.layer),
  Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
  Layer.provideMerge(ProjectionThreadSessionRepositoryLive),
  Layer.provideMerge(ProjectionTurnRepositoryLive),
  Layer.provideMerge(ProjectionPendingApprovalRepositoryLive),
  Layer.provideMerge(ProjectionStateRepositoryLive),
);
