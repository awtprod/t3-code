import {
  type ChatAttachment,
  CommandId,
  EventId,
  type MessageId,
  type ModelSelection,
  NonNegativeInt,
  type OrchestrationEvent,
  type OrchestrationProposedPlanId,
  ProviderDriverKind,
  SandboxId,
  type ProjectId,
  type OrchestrationSession,
  ThreadId,
  type ProviderSession,
  type ProviderTurnStartResult,
  type RuntimeMode,
  type TurnId,
} from "@t3tools/contracts";
import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
} from "../../provider/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { COMMAND_PRODUCED_NO_EVENTS_DETAIL } from "../Errors.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationEventStore,
  type ThreadTurnStartAboveCutoff,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  ProviderTurnSendClaimRepository,
  type ProviderTurnSendClaimOutcome,
} from "../../persistence/Services/ProviderTurnSendClaims.ts";
import { ProviderTurnSendClaimRepositoryLive } from "../../persistence/Layers/ProviderTurnSendClaims.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { forkParked, ServerActivation } from "../../serverActivation.ts";
import { canReplaceThreadTitle, DEFAULT_THREAD_TITLE } from "../threadTitles.ts";
import {
  resolveSourceControlWriterModelSelection,
  ServerSettingsService,
} from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import {
  ThreadSandboxRuntime,
  type ProviderExecutionTarget,
} from "../../sandbox/ThreadSandboxRuntime.ts";
import {
  SandboxRuntimeManager,
  sandboxPreviewProxyRequired,
  resolveSandboxImage,
  resolveSandboxPreviewProxyImage,
  resolveSandboxRuntime,
} from "../../sandbox/SandboxRuntimeManager.ts";
import { reconcileProviderStoreCursor } from "../../sandbox/providerStoreCursor.ts";
import { dispatchProvisionReadyOrTearDown } from "../../sandbox/provisionReadyDispatch.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import {
  T3ProjectFileLoader,
  layer as T3ProjectFileLoaderLive,
} from "../../project/T3ProjectFileLoader.ts";
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderAdapterProcessError = Schema.is(ProviderAdapterProcessError);
const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);
const isProviderDriverKind = Schema.is(ProviderDriverKind);

const changedModelSelectionOptionIds = (
  previous: ModelSelection | undefined,
  requested: ModelSelection,
): ReadonlyArray<string> => {
  const previousOptions = new Map(previous?.options?.map((option) => [option.id, option.value]));
  const requestedOptions = new Map(requested.options?.map((option) => [option.id, option.value]));
  return [...new Set([...previousOptions.keys(), ...requestedOptions.keys()])].filter(
    (id) => previousOptions.get(id) !== requestedOptions.get(id),
  );
};

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.meta-updated"
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const SANDBOX_PROVISION_WAIT_TIMEOUT = Duration.minutes(10);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const MAX_REGENERATION_ATTACHMENTS = 4;
const MAX_THREAD_TITLE_CONTEXT_CHARS = 8_000;
const MAX_FIRST_USER_TITLE_CONTEXT_CHARS = 2_000;
const THREAD_TITLE_CONTEXT_TRUNCATION_MARKER = "[Earlier content truncated]\n\n";
const FIRST_USER_CONTEXT_TRUNCATION_MARKER = "\n[First user message truncated]";

type ThreadTitleMessage = {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
};

function formatThreadTitleSection(message: ThreadTitleMessage): string | undefined {
  if (message.role === "system") {
    return undefined;
  }
  const text = message.text.trim();
  const attachmentSummary = (message.attachments ?? [])
    .map((attachment) => attachment.name)
    .join(", ");
  const contents = [
    ...(text.length > 0 ? [text] : []),
    ...(attachmentSummary.length > 0 ? [`[Attachments: ${attachmentSummary}]`] : []),
  ].join("\n");
  return contents.length > 0 ? `${message.role.toUpperCase()}:\n${contents}` : undefined;
}

function limitFirstUserSection(section: string): string {
  if (section.length <= MAX_FIRST_USER_TITLE_CONTEXT_CHARS) {
    return section;
  }
  return `${section.slice(
    0,
    MAX_FIRST_USER_TITLE_CONTEXT_CHARS - FIRST_USER_CONTEXT_TRUNCATION_MARKER.length,
  )}${FIRST_USER_CONTEXT_TRUNCATION_MARKER}`;
}

function collectRecentThreadTitleContext(
  messages: ReadonlyArray<ThreadTitleMessage>,
  maxChars: number,
): {
  readonly context: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly truncated: boolean;
} {
  let context = "";
  let truncated = false;
  const retainedAttachments: Array<ChatAttachment> = [];

  for (const message of messages.toReversed()) {
    const section = formatThreadTitleSection(message);
    if (section === undefined) {
      continue;
    }

    const separator = context.length > 0 ? "\n\n" : "";
    const available = maxChars - context.length - separator.length;
    if (section.length > available) {
      if (available > 0) {
        context = `${section.slice(-available)}${separator}${context}`;
        retainedAttachments.unshift(...(message.attachments ?? []));
      }
      truncated = true;
      break;
    }
    context = `${section}${separator}${context}`;
    retainedAttachments.unshift(...(message.attachments ?? []));
  }

  return { context, attachments: retainedAttachments, truncated };
}

function formatThreadTitleContext(messages: ReadonlyArray<ThreadTitleMessage>): {
  readonly message: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
} {
  const recent = collectRecentThreadTitleContext(messages, MAX_THREAD_TITLE_CONTEXT_CHARS);
  if (!recent.truncated) {
    return {
      message: recent.context,
      attachments: recent.attachments.slice(-MAX_REGENERATION_ATTACHMENTS),
    };
  }

  const firstUserMessage = messages.find(
    (message) => message.role === "user" && formatThreadTitleSection(message),
  );
  const firstUserSection = firstUserMessage
    ? formatThreadTitleSection(firstUserMessage)
    : undefined;
  if (!firstUserMessage || !firstUserSection) {
    return {
      message: `${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${recent.context}`,
      attachments: recent.attachments.slice(-MAX_REGENERATION_ATTACHMENTS),
    };
  }

  const pinnedSection = limitFirstUserSection(firstUserSection);
  const recentContextBudget =
    MAX_THREAD_TITLE_CONTEXT_CHARS -
    pinnedSection.length -
    "\n\n".length -
    THREAD_TITLE_CONTEXT_TRUNCATION_MARKER.length;
  const retainedRecent = collectRecentThreadTitleContext(messages, recentContextBudget);
  const pinnedAttachment = firstUserMessage.attachments?.[0];
  const recentAttachments = retainedRecent.attachments.filter(
    (attachment) => attachment.id !== pinnedAttachment?.id,
  );

  return {
    message: `${pinnedSection}\n\n${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${retainedRecent.context}`,
    attachments: [
      ...(pinnedAttachment ? [pinnedAttachment] : []),
      ...recentAttachments.slice(
        -(MAX_REGENERATION_ATTACHMENTS - (pinnedAttachment === undefined ? 0 : 1)),
      ),
    ],
  };
}

export function providerErrorLabel(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined;
  readonly modelSelectionInstanceId?: string | undefined;
  readonly sessionProvider?: string | undefined;
}): string {
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  );
}

function findProviderAdapterRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined;
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  const message = Cause.pretty(cause);
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending user-input request") ||
    message.includes("unknown pending user input request") ||
    message.includes("unknown pending codex user input request")
  );
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEventStore = yield* OrchestrationEventStore;
  const providerTurnSendClaimRepository = yield* ProviderTurnSendClaimRepository;
  const providerService = yield* ProviderService;
  const threadSandboxRuntime = yield* ThreadSandboxRuntime;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const sandboxRuntimeManager = yield* SandboxRuntimeManager;
  const projectFileLoader = yield* T3ProjectFileLoader;
  // Both maps hold one tiny per-thread entry (a mutex; a target descriptor)
  // and are bounded by the number of sandbox threads this server generation
  // ever provisioned, so neither needs an eviction scheme for memory. What the
  // target cache DOES need is staleness protection: a stop, an expiry, or a
  // failure destroys the container an entry names without touching the map, so
  // every read is validated against the current sandbox projection before it
  // is served (see the cache hit in `ensureExecutionTarget`). The locks carry
  // no container state at all and never go stale.
  const sandboxProvisionLocks = new Map<string, Semaphore.Semaphore>();
  const provisionedTargets = new Map<
    string,
    Extract<ProviderExecutionTarget, { kind: "sandbox" }>
  >();
  const providerRegistry = yield* ProviderRegistry;
  const gitWorkflow = yield* GitWorkflowService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
  const awaitSandboxProvisionSettlement = Effect.fn(
    "ProviderCommandReactor.awaitSandboxProvisionSettlement",
  )(function* (threadId: ThreadId) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const pull = yield* Stream.toPull(
          orchestrationEngine.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.aggregateId === threadId &&
                [
                  "sandbox.ready",
                  "sandbox.failed",
                  "sandbox.stopped",
                  "sandbox.expired",
                  "sandbox.reconciled",
                  "thread.deleted",
                ].includes(event.type),
            ),
          ),
        );
        const settledEvent = yield* pull.pipe(Effect.forkScoped);
        // Acquire the hot-stream subscription before reading the projection.
        // A provision that settles in between is then observed either in the
        // snapshot or by the parked pull, never missed by both.
        yield* Effect.yieldNow;
        const current = Option.getOrUndefined(
          yield* projectionSnapshotQuery.getThreadDetailById(threadId),
        );
        if (current === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: "sandbox",
            method: "sandbox.provision",
            detail: `Thread '${threadId}' disappeared while its sandbox was provisioning.`,
          });
        }
        if (current.sandbox?.lifecycle !== "provisioning") return current;
        yield* Fiber.join(settledEvent);
        const settled = Option.getOrUndefined(
          yield* projectionSnapshotQuery.getThreadDetailById(threadId),
        );
        if (settled === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: "sandbox",
            method: "sandbox.provision",
            detail: `Thread '${threadId}' disappeared while its sandbox was provisioning.`,
          });
        }
        return settled;
      }),
    ).pipe(
      Effect.timeout(SANDBOX_PROVISION_WAIT_TIMEOUT),
      Effect.mapError((cause) =>
        isProviderAdapterRequestError(cause)
          ? cause
          : new ProviderAdapterRequestError({
              provider: "sandbox",
              method: "sandbox.provision",
              detail: `Sandbox for thread '${threadId}' did not finish provisioning within ${Duration.format(SANDBOX_PROVISION_WAIT_TIMEOUT)}.`,
              cause,
            }),
      ),
    );
  });
  const ensureExecutionTarget = Effect.fn("ProviderCommandReactor.ensureExecutionTarget")(
    function* (
      initialThread: Parameters<typeof threadSandboxRuntime.ensureReady>[0],
      legacyCwd: string | undefined,
    ) {
      const thread =
        initialThread.sandbox?.lifecycle === "provisioning"
          ? yield* awaitSandboxProvisionSettlement(initialThread.id)
          : initialThread;
      if (
        thread.sandbox != null &&
        thread.sandbox.lifecycle !== "unprovisioned" &&
        thread.sandbox.lifecycle !== "failed" &&
        thread.sandbox.lifecycle !== "stopped" &&
        thread.sandbox.lifecycle !== "expired"
      ) {
        return yield* threadSandboxRuntime.ensureReady(thread, legacyCwd);
      }
      // Cache invalidation happens under the lock below, against the CURRENT
      // projection, not here against the caller's snapshot: this snapshot was
      // read before any lock wait, and evicting on it can throw away an entry
      // another fiber just provisioned. The lock itself is deliberately kept
      // across provisions: it is a per-thread mutex, not state about a
      // container, and replacing one another fiber currently holds would let
      // two provisions run at once.
      let lock = sandboxProvisionLocks.get(thread.id);
      if (lock === undefined) {
        lock = yield* Semaphore.make(1);
        sandboxProvisionLocks.set(thread.id, lock);
      }
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          // A hit only proves some fiber provisioned this thread once, not
          // that the container still exists: the entry survives every stop,
          // expiry, and failure, and this reactor never observes sandbox
          // lifecycle events to evict it. Point-of-use validation against the
          // CURRENT projection (not the caller's snapshot, which is from
          // before the lock wait) is what keeps a dead container's name from
          // being handed to the provider. Valid means the projection still
          // names this exact container and calls it ready -- anything else
          // evicts the entry and re-provisions below.
          const cached = provisionedTargets.get(thread.id);
          if (cached !== undefined) {
            const currentSandbox = Option.getOrUndefined(
              yield* projectionSnapshotQuery.getThreadDetailById(thread.id),
            )?.sandbox;
            if (
              currentSandbox != null &&
              currentSandbox.lifecycle === "ready" &&
              currentSandbox.sandboxId === cached.sandboxId &&
              currentSandbox.runtimeRef === cached.runtimeRef
            )
              return cached;
            provisionedTargets.delete(thread.id);
          }
          const project = yield* resolveProject(thread.projectId);
          if (project === undefined) {
            return yield* new ProviderAdapterRequestError({
              provider: "sandbox",
              method: "sandbox.provision",
              detail: `Project '${thread.projectId}' was not found.`,
            });
          }
          const projectFile = Option.getOrUndefined(
            yield* projectFileLoader.load(project.workspaceRoot),
          );
          const declaration = projectFile?.sandbox;
          const image = resolveSandboxImage(projectFile);
          if (
            image === undefined ||
            (sandboxPreviewProxyRequired(declaration?.previewPorts) &&
              resolveSandboxPreviewProxyImage() === undefined)
          ) {
            if (legacyCwd === undefined) {
              return yield* new ProviderAdapterRequestError({
                provider: "sandbox",
                method: "sandbox.provision",
                detail:
                  "Sandbox images are not configured and no host workspace directory is available.",
              });
            }
            return { kind: "legacy-host", cwd: legacyCwd } as const;
          }
          // Per-thread config wins, then the deployment default, then docker.
          const runtime = thread.sandboxConfig?.runtime ?? resolveSandboxRuntime();
          if (runtime !== "docker" && runtime !== "podman") {
            return yield* new ProviderAdapterRequestError({
              provider: "sandbox",
              method: "sandbox.provision",
              detail: `Sandbox runtime '${runtime}' is not available in v1.`,
            });
          }
          const occurredAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
          const branch =
            thread.sandbox?.branch ??
            (yield* Effect.gen(function* () {
              const local = yield* gitWorkflow.localStatus({ cwd: project.workspaceRoot });
              if (!local.isRepo || local.refName === null)
                return yield* new ProviderAdapterRequestError({
                  provider: "sandbox",
                  method: "sandbox.provision",
                  detail: "Isolated threads require a Git repository with a selected branch.",
                });
              const base = yield* gitWorkflow.resolveRemoteTrackingCommit({
                cwd: project.workspaceRoot,
                refName: local.refName,
                fallbackRemoteName: "origin",
              });
              return { branchName: `t3/thread/${thread.id}`, baseCommit: base.commitSha };
            }).pipe(
              Effect.mapError((cause) =>
                isProviderAdapterRequestError(cause)
                  ? cause
                  : new ProviderAdapterRequestError({
                      provider: "sandbox",
                      method: "sandbox.provision",
                      detail: cause instanceof Error ? cause.message : String(cause),
                      cause,
                    }),
              ),
            ));
          // The provider CLI keeps its conversation store inside the
          // container, so whatever conversation a persisted resume cursor
          // names does not exist in the one about to be created -- the turn
          // would fail outright with "No conversation found with session ID".
          // Placed here rather than beside the cache eviction above because
          // this is the point where a fresh container is certain: the
          // host-fallback return is behind us, and a thread that stays on the
          // host keeps a cursor that is still good.
          //
          // Unless the teardown archived the store: the provision below then
          // restores it to the same in-container home, under the same cwd the
          // transcripts are keyed by, so the cursor resolves again and the
          // thread comes back with its context. Clearing it there would throw
          // away the conversation the export went out of its way to save.
          // Deferred until after the provision below reports what it actually
          // restored. Deciding here from `lastExport.storeSha256` alone was
          // wrong in the case that matters: the artifact may have been swept,
          // or the copy/extract may have failed (it is best-effort), and the
          // thread then came back to a clean container while the host kept a
          // cursor naming a conversation that no longer exists -- every
          // following turn dying on "No conversation found with session ID".
          yield* orchestrationEngine.dispatch({
            type: "sandbox.provision",
            commandId: yield* serverCommandId("sandbox-provision"),
            threadId: thread.id,
            // The RESOLVED runtime, not the raw config. The decider is pure and
            // defaults an absent `config.runtime` to docker, while the runtime
            // manager honours `T3_SANDBOX_RUNTIME` -- so a podman deployment's
            // projection claimed docker for the whole provisioning window, and
            // a stop or delete landing in it addressed the wrong backend.
            config: { ...thread.sandboxConfig, runtime },
            ...(thread.sandbox === null ? { branch } : {}),
            // This reactor calls `runtimes.provision` immediately below, so it
            // takes the decider's inline path rather than asking the lifecycle
            // reactor to do the work a second time.
            provisionsInline: true,
            createdAt: occurredAt,
          });
          // The decider accepted the `sandbox.provision` above, which is what
          // distinguishes this provision from a stale one a deletion already
          // stopped. The token identifies this attempt for admission below and
          // for the teardown that follows a refused readiness, so neither can
          // act on a container a newer attempt owns.
          const attempt = yield* sandboxRuntimeManager.authorizeProvision(thread.id);
          const provision = yield* sandboxRuntimeManager
            .provision({
              attempt,
              bootstrap: {
                threadId: thread.id,
                projectId: thread.projectId,
                // The canonical repository identity intentionally prefers an
                // upstream remote, but this commit was resolved from the local
                // checkout's tracked remote and may only exist in the fork.
                // Seed from the checkout so the bundle must contain it.
                repositoryUrl: project.workspaceRoot,
                baseCommit: branch.baseCommit,
                branchName: branch.branchName,
                ...("parentThreadId" in branch && branch.parentThreadId
                  ? { parentThreadId: branch.parentThreadId }
                  : {}),
              },
              config: { ...thread.sandboxConfig, runtime },
              image,
              // Re-provisioning a settled or reaped thread: seed from the
              // bundle its teardown exported so the user comes back to their
              // work rather than to the project's base commit.
              ...(thread.sandbox?.lastExport ? { restore: thread.sandbox.lastExport } : {}),
              ...(process.env.T3_SANDBOX_EGRESS_PROXY_IMAGE?.trim()
                ? { egressProxyImage: process.env.T3_SANDBOX_EGRESS_PROXY_IMAGE.trim() }
                : {}),
              ...(declaration?.caches ? { caches: declaration.caches } : {}),
              ...(declaration?.setup ? { setup: declaration.setup } : {}),
              ...(declaration?.teardown ? { teardown: declaration.teardown } : {}),
              ...(declaration?.services ? { services: declaration.services } : {}),
              ...(declaration?.previewPorts ? { previewPorts: declaration.previewPorts } : {}),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: "sandbox",
                    method: "sandbox.provision",
                    detail: cause instanceof Error ? cause.message : String(cause),
                    cause,
                  }),
              ),
              Effect.catch((error) =>
                Effect.gen(function* () {
                  const failedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
                  yield* orchestrationEngine
                    .dispatch({
                      type: "sandbox.operation.fail",
                      commandId: yield* serverCommandId("sandbox-failed"),
                      threadId: thread.id,
                      failure: {
                        stage: "provision",
                        code: "sandbox_provision_failed",
                        message: error.detail,
                        retryable: true,
                        occurredAt: failedAt,
                      },
                      createdAt: failedAt,
                    })
                    .pipe(Effect.ignore);
                  return yield* error;
                }),
              ),
            );
          // The provision reports what it did to the conversation store --
          // preserved it, restored it, or came up without it. The shared
          // helper is what keeps this decision identical across every
          // provisioning entry point.
          yield* reconcileProviderStoreCursor(
            providerSessionDirectory,
            thread.id,
            provision.providerStore,
          );
          const readyAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
          // A refused readiness means the thread is no longer provisionable --
          // a stop or a deletion landed while this provision was running -- so
          // the containers it just created have to go with it.
          yield* dispatchProvisionReadyOrTearDown({
            threadId: thread.id,
            dispatch: orchestrationEngine.dispatch({
              type: "sandbox.provision.ready",
              commandId: yield* serverCommandId("sandbox-ready"),
              threadId: thread.id,
              sandboxId: SandboxId.make(provision.sandboxId),
              runtime: provision.runtime,
              runtimeRef: provision.containerName,
              ...(provision.desktopSessionId === undefined
                ? {}
                : { desktopSessionId: provision.desktopSessionId }),
              ...(provision.desktopStreamPath === undefined
                ? {}
                : { desktopStreamPath: provision.desktopStreamPath }),
              createdAt: readyAt,
            }),
            // Scoped to the attempt rather than the thread: a stop is what
            // refuses this readiness, and the re-provision that follows it can
            // already have published a container of its own.
            teardown: () => sandboxRuntimeManager.stopProvisionAttempt(runtime, provision.attempt),
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: "sandbox",
                  method: "sandbox.provision.ready",
                  detail: cause instanceof Error ? cause.message : String(cause),
                  cause,
                }),
            ),
          );
          const readyThread = Option.getOrUndefined(
            yield* projectionSnapshotQuery.getThreadDetailById(thread.id),
          );
          if (readyThread?.sandbox !== null && readyThread?.sandbox !== undefined) {
            yield* orchestrationEngine.dispatch({
              type: "sandbox.reconcile.result",
              commandId: yield* serverCommandId("sandbox-service-health"),
              threadId: thread.id,
              disposition: "matched",
              sandbox: {
                ...readyThread.sandbox,
                services: provision.services.map((service) => ({
                  name: service.name,
                  status: "healthy" as const,
                  ...(service.internalPorts[0] === undefined
                    ? {}
                    : { internalPort: service.internalPorts[0] }),
                  checkedAt: readyAt,
                })),
              },
              createdAt: readyAt,
            });
          }
          const target = {
            kind: "sandbox",
            threadId: thread.id,
            sandboxId: provision.sandboxId,
            runtimeRef: provision.containerName,
            runtime,
            workspaceCwd: "/workspace/repo",
          } as const;
          provisionedTargets.set(thread.id, target);
          return target;
        }),
      );
    },
  );
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();

  /**
   * Raise a thread's cancel barrier, retrying, and report whether it holds.
   *
   * Both stop paths — turn-interrupt and session-stop — depend on this write
   * for the half of the stop that reaches work not yet sent. A queued
   * turn-start tests the barrier when it acquires its claim, so a barrier that
   * was never written is a turn-start that will pass its guard, call
   * `sendTurn`, and (on the session-stop path) recover the binding and
   * resurrect the very session the user just shut down.
   *
   * Retried because the failure mode is a contended SQLite write, and repeating
   * the raise is free: it is monotonic, so a second write at the same sequence
   * changes nothing.
   *
   * Returns whether the barrier is up rather than failing, because the two
   * callers must act on that answer rather than abort — a stop that cannot be
   * recorded still has a live provider session to stop, and abandoning the rest
   * of the handler would leave the session running as well as unbarriered.
   */
  const raiseCancelBarrier = (input: {
    readonly threadId: ThreadId;
    readonly canceledThroughSequence: number;
    readonly updatedAt: string;
    readonly failureKind: "provider.turn.interrupt.failed" | "provider.session.stop.failed";
    readonly failureSummary: string;
    readonly failureDetailPrefix: string;
    readonly turnId: TurnId | null;
  }) =>
    providerTurnSendClaimRepository
      .cancel({
        threadId: input.threadId,
        canceledThroughSequence: input.canceledThroughSequence,
        updatedAt: input.updatedAt,
      })
      .pipe(
        Effect.retry({ times: 2, schedule: Schedule.exponential(100) }),
        Effect.as(true),
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: input.threadId,
            kind: input.failureKind,
            summary: input.failureSummary,
            detail: `${input.failureDetailPrefix}: ${Cause.pretty(cause)}`,
            turnId: input.turnId,
            createdAt: input.updatedAt,
          }).pipe(
            Effect.catchCause((appendCause) =>
              Effect.logError("provider command reactor failed to report an unraised barrier", {
                threadId: input.threadId,
                cause: Cause.pretty(appendCause),
              }),
            ),
            Effect.as(false),
          ),
        ),
      );

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.fold.failed"
      | "provider.plan.mark-implemented.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("provider-failure-activity"),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: "error",
            kind: input.kind,
            summary: input.summary,
            payload: {
              detail: input.detail,
              ...(input.requestId ? { requestId: input.requestId } : {}),
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const formatFailureDetail = (cause: Cause.Cause<unknown>): string => {
    const failReason = cause.reasons.find(Cause.isFailReason);
    const failure = failReason?.error;
    if (isProviderAdapterValidationError(failure)) return failure.issue;
    if (isProviderAdapterRequestError(failure) || isProviderAdapterProcessError(failure)) {
      return failure.detail;
    }
    if (failure instanceof Error && failure.message.trim().length > 0) return failure.message;
    return "The provider operation failed. Check the server logs for technical details.";
  };

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    serverCommandId("provider-session-set").pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId,
          threadId: input.threadId,
          session: input.session,
          createdAt: input.createdAt,
        }),
      ),
    );

  const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...(session ?? {
          threadId: input.threadId,
          providerName: null,
          providerInstanceId: thread.modelSelection.instanceId,
          runtimeMode: thread.runtimeMode,
        }),
        status: session?.status === "stopped" ? "stopped" : "error",
        activeTurnId: null,
        lastError: input.detail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const resolveProject = Effect.fnUntraced(function* (projectId: ProjectId) {
    return yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const rejectStartedThreadModelChangeIfRequired = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly currentModelSelection: ModelSelection;
    readonly requestedModelSelection: ModelSelection | undefined;
  }) {
    const requestedModelSelection = input.requestedModelSelection;
    if (
      requestedModelSelection === undefined ||
      (input.currentModelSelection.instanceId === requestedModelSelection.instanceId &&
        input.currentModelSelection.model === requestedModelSelection.model)
    ) {
      return;
    }
    const providers = yield* providerRegistry.getProviders;
    const requiresNewThread =
      providers.find((snapshot) => snapshot.instanceId === input.currentModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true ||
      providers.find((snapshot) => snapshot.instanceId === requestedModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true;
    if (!requiresNewThread) {
      return;
    }
    return yield* new ProviderAdapterRequestError({
      provider: providerErrorLabelFromInstanceHint({
        instanceId: String(requestedModelSelection.instanceId),
        modelSelectionInstanceId: String(input.currentModelSelection.instanceId),
      }),
      method: "thread.turn.start",
      detail: `Thread '${input.threadId}' cannot switch models after the conversation has started. Start a new thread to use '${requestedModelSelection.model}'.`,
    });
  });

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly pendingTurnStart?: boolean;
      readonly executionTarget?: ProviderExecutionTarget;
    },
  ) {
    const thread = yield* resolveThread(threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = thread.runtimeMode;
    const requestedModelSelection = options?.modelSelection;
    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const activeSession = yield* resolveActiveSession(threadId);
    const activeThreadSession =
      thread.session !== null && thread.session.status !== "stopped" && activeSession
        ? thread.session
        : null;
    if (
      activeThreadSession !== null &&
      activeSession !== undefined &&
      (activeThreadSession.providerInstanceId === undefined ||
        activeSession.providerInstanceId === undefined)
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
        method: "thread.turn.start",
        detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
      });
    }
    const currentInstanceId =
      activeThreadSession !== null &&
      activeSession !== undefined &&
      activeSession.providerInstanceId !== undefined
        ? activeSession.providerInstanceId
        : (thread.session?.providerInstanceId ?? thread.modelSelection.instanceId);
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const desiredInstanceId = desiredModelSelection.instanceId;
    const currentInfo = yield* providerService.getInstanceInfo(currentInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(currentInstanceId),
              modelSelectionInstanceId: String(thread.modelSelection.instanceId),
              sessionProvider: thread.session?.providerName ?? undefined,
            }),
            method: "thread.turn.start",
            detail: `Thread '${threadId}' references unknown provider instance '${currentInstanceId}'. The instance is not configured in this build.`,
          }),
      ),
    );
    const desiredInfo = yield* providerService.getInstanceInfo(desiredInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(desiredModelSelection.instanceId),
            }),
            method: "thread.turn.start",
            detail: `Requested provider instance '${desiredInstanceId}' is not configured in this build.`,
          }),
      ),
    );
    const desiredDriverKind = desiredInfo.driverKind;
    if (!isProviderDriverKind(desiredDriverKind)) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(desiredDriverKind)),
        method: "thread.turn.start",
        detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
      });
    }
    const preferredProvider: ProviderDriverKind = desiredDriverKind;
    if (options?.pendingTurnStart === true && thread.session?.status !== "running") {
      yield* setThreadSession({
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: activeSession?.provider ?? preferredProvider,
          providerInstanceId: activeSession?.providerInstanceId ?? desiredInstanceId,
          runtimeMode: desiredRuntimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });
    }
    if (thread.session !== null) {
      yield* rejectStartedThreadModelChangeIfRequired({
        threadId,
        currentModelSelection:
          activeSession?.model !== undefined
            ? {
                ...thread.modelSelection,
                instanceId: currentInstanceId,
                model: activeSession.model,
              }
            : thread.modelSelection,
        requestedModelSelection,
      });
    }
    if (
      thread.session !== null &&
      requestedModelSelection !== undefined &&
      requestedModelSelection.instanceId !== currentInstanceId
    ) {
      if (currentInfo.driverKind !== desiredInfo.driverKind) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' is bound to driver '${currentInfo.driverKind}' and cannot switch to '${desiredInfo.driverKind}'.`,
        });
      }
      if (
        currentInfo.continuationIdentity.continuationKey !==
        desiredInfo.continuationIdentity.continuationKey
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' cannot switch from instance '${currentInstanceId}' to '${desiredInstanceId}' because their provider resume state is incompatible.`,
        });
      }
    }
    const project = yield* resolveProject(thread.projectId);
    const legacyCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project ? [project] : [],
    });
    const executionTarget =
      options?.executionTarget ?? (yield* ensureExecutionTarget(thread, legacyCwd));
    const effectiveCwd =
      executionTarget.kind === "sandbox" ? executionTarget.workspaceCwd : executionTarget.cwd;

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderDriverKind;
    }) =>
      providerService.startSession(
        threadId,
        {
          threadId,
          projectId: thread.projectId,
          ...(preferredProvider ? { provider: preferredProvider } : {}),
          providerInstanceId: desiredInstanceId,
          ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
          ...(thread.title ? { title: thread.title } : {}),
          modelSelection: desiredModelSelection,
          ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
          runtimeMode: desiredRuntimeMode,
        },
        executionTarget,
      );

    const bindSessionToThread = (session: ProviderSession) =>
      Effect.gen(function* () {
        if (session.providerInstanceId === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(session.provider),
            method: "thread.turn.start",
            detail: `Provider session '${session.threadId}' started without a provider instance id.`,
          });
        }
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status:
              options?.pendingTurnStart === true && session.status === "ready"
                ? "starting"
                : mapProviderSessionStatusToOrchestrationStatus(session.status),
            providerName: session.provider,
            providerInstanceId: session.providerInstanceId,
            // The replacement runtime's own generation. This is the handoff the
            // ingestion generation guard depends on: it drops a lifecycle event
            // whose `sessionGeneration` differs from the bound session's, so a
            // binding that omitted this left the projection holding `undefined`
            // — which never mismatches, so a superseded runtime's exit was
            // accepted, written into the projection as the current identity, and
            // then caused the LIVE runtime's events to be suppressed as stale.
            // Omitted (rather than nulled) when the adapter does not mint one,
            // which keeps the guard's "either side unknown ⇒ don't drop"
            // behavior for adapters that have not adopted generations.
            ...(session.sessionGeneration !== undefined
              ? { sessionGeneration: session.sessionGeneration }
              : {}),
            runtimeMode: desiredRuntimeMode,
            // Provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
            updatedAt: session.updatedAt,
          },
          createdAt,
        });
      });

    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const cwdChanged = effectiveCwd !== activeSession?.cwd;
      const adapterCapabilities = yield* providerService.getCapabilities(desiredInstanceId);
      const sessionModelSwitch = adapterCapabilities.sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const instanceChanged =
        requestedModelSelection !== undefined &&
        activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";
      const previousModelSelection = threadModelSelections.get(threadId);
      const changedOptionIds =
        requestedModelSelection === undefined
          ? []
          : changedModelSelectionOptionIds(previousModelSelection, requestedModelSelection);
      const declaredInSessionOptionIds = new Set(adapterCapabilities.inSessionOptionIds ?? []);
      const shouldRestartForOptionChange = changedOptionIds.some(
        (optionId) => !declaredInSessionOptionIds.has(optionId),
      );

      if (
        !runtimeModeChanged &&
        !cwdChanged &&
        !instanceChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForOptionChange
      ) {
        return existingSessionThreadId;
      }

      const resumeCursor = shouldRestartForModelChange
        ? undefined
        : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider: activeSession?.provider,
        currentInstanceId,
        desiredInstanceId,
        desiredProvider: desiredModelSelection.instanceId,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        changedOptionIds,
        shouldRestartForOptionChange,
        runtimeModeChanged,
        previousCwd: activeSession?.cwd,
        desiredCwd: effectiveCwd,
        cwdChanged,
        modelChanged,
        instanceChanged,
        shouldRestartForModelChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
        cwd: restartedSession.cwd,
      });
      yield* bindSessionToThread(restartedSession);
      return restartedSession.threadId;
    }

    const startedSession = yield* startProviderSession(undefined);
    yield* bindSessionToThread(startedSession);
    return startedSession.threadId;
  });

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: "default" | "plan";
    readonly createdAt: string;
    /**
     * Sequence of the `thread.turn-start-requested` this send answers.
     *
     * Rides through to the adapter so the `turn.started` it produces can name
     * the placeholder it belongs to. Optional because this builder also serves
     * paths with no requesting event (resume, adapter-internal starts), which
     * legitimately fall back to oldest-first adoption.
     */
    readonly turnRequestSequence?: number;
    readonly executionTarget?: ProviderExecutionTarget;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${input.threadId}' was not found in read model.`),
      );
    }
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      pendingTurnStart: true,
      ...(input.executionTarget !== undefined ? { executionTarget: input.executionTarget } : {}),
    });
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }
    const normalizedInput = toNonEmptyProviderInput(input.messageText);
    const normalizedAttachments = input.attachments ?? [];
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : activeSession.providerInstanceId === undefined
          ? yield* new ProviderAdapterRequestError({
              provider: providerErrorLabel(activeSession.provider),
              method: "thread.turn.start",
              detail: `Active provider session '${activeSession.threadId}' is missing a provider instance id.`,
            })
          : (yield* providerService.getCapabilities(activeSession.providerInstanceId))
              .sessionModelSwitch;
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
    const modelForTurn =
      sessionModelSwitch === "unsupported" && input.modelSelection === undefined
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : input.modelSelection;

    return {
      threadId: input.threadId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      ...(input.turnRequestSequence !== undefined
        ? { turnRequestSequence: input.turnRequestSequence }
        : {}),
    };
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const settings = yield* serverSettingsService.getSettings;
      const modelSelection =
        settings.sourceControlWriterModelSelection === null
          ? settings.textGenerationModelSelection
          : resolveSourceControlWriterModelSelection(
              settings,
              yield* providerRegistry.getProviders,
            );

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

      const renamed = yield* gitWorkflow.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
      yield* vcsStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly messageText: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly titleSeed?: string;
    }) {
      const attachments = input.attachments ?? [];
      yield* Effect.gen(function* () {
        const { textGenerationModelSelection: modelSelection } =
          yield* serverSettingsService.getSettings;

        const generated = yield* textGeneration.generateThreadTitle({
          cwd: input.cwd,
          message: input.messageText,
          ...(attachments.length > 0 ? { attachments } : {}),
          modelSelection,
        });
        if (!generated) return;

        const thread = yield* resolveThread(input.threadId);
        if (!thread) return;
        if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
          return;
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* serverCommandId("thread-title-rename"),
          threadId: input.threadId,
          title: generated.title,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to generate or rename thread title", {
            threadId: input.threadId,
            cwd: input.cwd,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    },
  );

  /**
   * Re-check the claim immediately AFTER the send and interrupt the turn we
   * just started if the stop landed during it.
   *
   * A durable claim can make "may I send?" atomic; it cannot make the send
   * itself atomic, because `sendTurn` is an RPC to another process and no
   * database write spans it. So a stop committed between the acquire returning
   * `acquired` and the provider receiving the prompt passes both — the claim was
   * genuinely held when it was read, and the turn is genuinely running by the
   * time the interrupt path looks for a session to stop.
   *
   * That residual window is closed by fencing rather than by locking: send
   * first, then ask again, and if the answer changed, stop what we just started.
   * The user sees a turn that begins and is immediately interrupted instead of
   * one that ignores their stop — recoverable, where an unstoppable turn is not.
   *
   * Two properties make that safe, and losing either turns the fence from a
   * repair into a new defect:
   *
   * WHY only `canceled` interrupts. Losing the claim is not evidence of a stop.
   * A newer request for the same message — a session-exit auto-resume — takes it
   * by design, and a stop issued before a legitimately later turn does not cover
   * that turn, because the barrier is compared by sequence. In both shapes the
   * work now running is work the user wants. Interrupting on a bare "I no longer
   * hold the claim" would kill it, which is strictly worse than the missed stop
   * this fence exists to prevent, so the repository reports WHY the claim was
   * lost and only a stop covering THIS request acts.
   *
   * WHY the interrupt is addressed to `turnId`. Even when this request really
   * was canceled, the session may already be running a different, later turn by
   * the time this fence executes — the interrupt is asynchronous with respect to
   * everything else on the thread. `sendTurn` returns the id of the turn it
   * started, and passing it makes the request name the turn it means rather than
   * "whatever this session is doing now". Adapters that ignore the id fall back
   * to session-scoped interruption, which is the pre-existing behavior and no
   * worse than before; adapters that honor it are now precise.
   */
  /**
   * Mark a plan implemented when the send that carried it was folded.
   *
   * Ingestion marks plans off `turn.started`, which a steer never emits. So a
   * plan-implementation message delivered as a steer would otherwise sit in the
   * user's queue forever — implemented in fact, unimplemented on screen, with no
   * later event able to correct it because the placeholder holding the plan
   * reference is deleted by the fold itself.
   *
   * Idempotent by the same `implementedAt !== null` check ingestion uses, so a
   * plan already marked by a racing `turn.started` is left alone rather than
   * restamped with a second implementation thread.
   */
  const markFoldedSourceProposedPlanImplemented = (input: {
    readonly sourceThreadId: ThreadId;
    readonly sourcePlanId: OrchestrationProposedPlanId;
    readonly implementationThreadId: ThreadId;
    readonly implementedAt: string;
  }) =>
    Effect.gen(function* () {
      const sourceThread = yield* resolveThread(input.sourceThreadId);
      const sourcePlan = sourceThread?.proposedPlans.find(
        (entry) => entry.id === input.sourcePlanId,
      );
      if (!sourceThread || !sourcePlan || sourcePlan.implementedAt !== null) {
        return;
      }

      const commandId = yield* serverCommandId("source-proposed-plan-implemented");
      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId,
        threadId: sourceThread.id,
        proposedPlan: {
          ...sourcePlan,
          implementedAt: input.implementedAt,
          implementationThreadId: input.implementationThreadId,
          updatedAt: input.implementedAt,
        },
        createdAt: input.implementedAt,
      });
    });

  /**
   * Record that a send was folded into an already-running turn.
   *
   * A steer produces no `turn.started`, and `turn.started` is the only thing
   * that consumes this request's pending turn-start placeholder. Left in place,
   * that row is read downstream as proof the message never reached the provider
   * — the premise auto-resume re-issues on, the committed-side-effect gate is
   * bypassed on, and orphan reconciliation reports on. The adapter is the only
   * component that knows a fold happened, so it reports it and this dispatch
   * turns that report into the durable fact the projector consumes.
   *
   * Retried before giving up, and reported to the user if it never lands. The
   * prompt is with the provider either way, so failing the turn-start here would
   * report a start that did not fail — but a silently lost fold restores the
   * duplicate-prompt defect this exists to prevent, which is the failure the
   * user actually feels. So it gets the same treatment as an undeliverable
   * stop: retry the transient case, then say so on the thread.
   */
  const foldSteeredTurnStart = (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
    turn: ProviderTurnStartResult,
  ) =>
    serverCommandId("turn-start-fold").pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch({
          type: "thread.turn-start.fold",
          commandId,
          threadId: event.payload.threadId,
          turnRequestSequence: event.sequence,
          turnId: turn.turnId,
          createdAt: event.payload.createdAt,
        }),
      ),
      // A dispatch failure here is far likelier to be transient (a busy write,
      // a contended connection) than deterministic, and a repeated fold is
      // harmless: the projector's delete is keyed by request sequence, so the
      // second one finds nothing to remove.
      Effect.retry({ times: 2, schedule: Schedule.exponential(100) }),
      Effect.flatMap(() => {
        const sourceProposedPlan = event.payload.sourceProposedPlan;
        if (sourceProposedPlan === undefined) {
          return Effect.void;
        }
        return markFoldedSourceProposedPlanImplemented({
          sourceThreadId: sourceProposedPlan.threadId,
          sourcePlanId: sourceProposedPlan.planId,
          implementationThreadId: event.payload.threadId,
          implementedAt: event.payload.createdAt,
        }).pipe(
          // Retried for the same reason the fold above is: the likely failure
          // is a contended write, and the dispatch is idempotent — the upsert
          // is keyed by plan id, and `markFoldedSourceProposedPlanImplemented`
          // re-reads the plan and returns early once `implementedAt` is set,
          // so a repeat is a no-op rather than a second mark.
          //
          // Retrying matters more here than anywhere else in this function
          // because nothing else will ever try again. The fold that triggered
          // this work has already deleted the pending placeholder, so there is
          // no row left for recovery to notice and no later event that re-runs
          // the mark: a failure here is permanent, not deferred.
          Effect.retry({ times: 2, schedule: Schedule.exponential(100) }),
          Effect.catchCause((cause) =>
            // The fold itself is durable by this point, which is the part that
            // prevents a duplicate prompt, so an unmarked plan must not undo
            // it — hence caught rather than propagated. But it is not merely
            // cosmetic either: the plan stays "unimplemented" forever while
            // the provider is in fact implementing it, and the user's only
            // recourse is to notice and act on that, which they can only do if
            // told. So it gets the same treatment as the lost fold below —
            // log, then say so on the thread.
            Effect.logWarning(
              "provider command reactor failed to mark a folded source proposed plan",
              {
                threadId: event.payload.threadId,
                sourceThreadId: sourceProposedPlan.threadId,
                planId: sourceProposedPlan.planId,
                cause: Cause.pretty(cause),
              },
            ).pipe(
              Effect.flatMap(() =>
                appendProviderFailureActivity({
                  threadId: event.payload.threadId,
                  kind: "provider.plan.mark-implemented.failed",
                  summary: "Plan could not be marked implemented",
                  detail: `The message was delivered to the running turn, but its source plan could not be recorded as implemented and will keep showing as unimplemented: ${formatFailureDetail(cause)}`,
                  turnId: turn.turnId,
                  createdAt: event.payload.createdAt,
                }),
              ),
              // Last line of defence, as elsewhere on this path: if reporting
              // also fails there is nothing further to try, and taking the
              // turn-start fiber down over a plan badge helps no one.
              Effect.catchCause((appendCause) =>
                Effect.logError("provider command reactor failed to report an unmarked plan", {
                  threadId: event.payload.threadId,
                  planId: sourceProposedPlan.planId,
                  cause: Cause.pretty(appendCause),
                }),
              ),
            ),
          ),
        );
      }),
      Effect.catchCause((cause) =>
        Effect.logError("provider command reactor failed to fold a steered turn start", {
          threadId: event.payload.threadId,
          messageId: event.payload.messageId,
          requestSequence: event.sequence,
          turnId: turn.turnId,
          cause: Cause.pretty(cause),
        }).pipe(
          Effect.flatMap(() =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.turn.fold.failed",
              summary: "Provider turn bookkeeping failed",
              detail: `The message was delivered to the running turn but could not be recorded as such, so it may be sent a second time on recovery: ${formatFailureDetail(cause)}`,
              turnId: turn.turnId,
              createdAt: event.payload.createdAt,
            }),
          ),
          // Last line of defence, as with the fence: if reporting also fails
          // there is nothing further to try, and taking the turn-start fiber
          // down over a log entry helps no one.
          Effect.catchCause((appendCause) =>
            Effect.logError("provider command reactor failed to report a lost fold", {
              threadId: event.payload.threadId,
              requestSequence: event.sequence,
              turnId: turn.turnId,
              cause: Cause.pretty(appendCause),
            }),
          ),
        ),
      ),
    );

  /**
   * Interrupt a turn, retrying, then escalating to a session stop.
   *
   * Both stop paths need the same three-step ladder, and the ordinary
   * `thread.turn.interrupt` handler used to have none of it: it called
   * `interruptTurn` bare, so a transport failure went to the reactor's generic
   * warning logger while the projection had ALREADY marked the turn
   * interrupted. That combination is the worst one available — the UI says
   * stopped, the provider keeps running, and nothing retries or tells the user.
   *
   * One retry, because the interrupt is a message to another process and a
   * transient failure is the likeliest kind; a duplicate interrupt costs
   * nothing, the call being idempotent for a turn already stopped.
   *
   * Then the session, because it is strictly stronger than interrupting one
   * turn inside it and the caller has already raised (or is covered by) the
   * cancel barrier, so nothing queued behind is still wanted. Escalation goes
   * through the ordinary `thread.session.stop` intent rather than calling
   * `providerService.stopSession` directly, because that handler does the OTHER
   * half too: it raises the barrier and writes the `stopped` session
   * projection. A direct provider call would kill the runtime while leaving the
   * UI showing a live session — trading a turn that ignores stop for a thread
   * that lies about it.
   *
   * The original interrupt cause is always re-raised, escalated or not: the
   * user asked to stop one turn and either got no stop at all or lost the whole
   * session instead, and both are outcomes the caller has to report. A failed
   * escalation is logged here and deliberately does not replace that cause.
   */
  type InterruptTurnEscalationOutcome =
    | { readonly _tag: "interrupted" }
    | {
        readonly _tag: "escalation-dispatched";
        readonly interruptCause: Cause.Cause<ProviderServiceError>;
      }
    | {
        readonly _tag: "failed";
        readonly interruptCause: Cause.Cause<ProviderServiceError>;
      };

  const interruptTurnAndObserveEscalation = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    /**
     * Sequence of the cancellation this escalation is widening.
     *
     * The escalation happens strictly LATER than the stop that prompted it — a
     * retried interrupt has to fail first — so the escalated stop lands at a
     * higher sequence than anything the user submitted while that retry was in
     * flight. Handing the original cutoff down keeps the widening to its
     * intended axis: from one turn to the whole session, not from one moment to
     * a later one. Interrupt semantics deliberately let requests above the
     * interrupt's sequence through, and an internally-delayed escalation must
     * not quietly revoke that.
     */
    readonly canceledThroughSequence: number;
    readonly createdAt: string;
    readonly escalationTag: string;
    readonly logContext: Record<string, unknown>;
  }) =>
    // Suspended so the retry below re-INVOKES the service rather than re-running
    // an already-built effect. The two are the same in production today, but
    // only by accident of `interruptTurn` being an `Effect.fn`; suspending makes
    // the retry mean what it says regardless.
    Effect.suspend(() =>
      providerService.interruptTurn(
        input.turnId === null
          ? { threadId: input.threadId }
          : { threadId: input.threadId, turnId: input.turnId },
      ),
    ).pipe(
      Effect.retry({ times: 1, schedule: Schedule.exponential(100) }),
      Effect.as<InterruptTurnEscalationOutcome>({ _tag: "interrupted" }),
      Effect.catchCause((interruptCause) =>
        Effect.logWarning(
          "provider command reactor escalating an undeliverable interrupt to a session stop",
          {
            ...input.logContext,
            threadId: input.threadId,
            turnId: input.turnId,
            cause: Cause.pretty(interruptCause),
          },
        ).pipe(
          Effect.flatMap(() => serverCommandId(input.escalationTag)),
          Effect.flatMap((commandId) =>
            orchestrationEngine.dispatch({
              type: "thread.session.stop",
              commandId,
              threadId: input.threadId,
              canceledThroughSequence: NonNegativeInt.make(input.canceledThroughSequence),
              createdAt: input.createdAt,
            }),
          ),
          Effect.as<InterruptTurnEscalationOutcome>({
            _tag: "escalation-dispatched",
            interruptCause,
          }),
          // Dispatch failure must not replace the interrupt failure — the
          // caller reports the original operation the user asked for — but it
          // also must not disappear. Losing this log makes an escalation that
          // never entered the event log indistinguishable from one that was
          // accepted and later failed in its own handler.
          Effect.catchCause((escalationCause) =>
            Effect.logError("provider command reactor failed to dispatch escalated session stop", {
              ...input.logContext,
              threadId: input.threadId,
              turnId: input.turnId,
              cause: Cause.pretty(escalationCause),
              originalInterruptCause: Cause.pretty(interruptCause),
            }).pipe(
              Effect.as<InterruptTurnEscalationOutcome>({
                _tag: "failed",
                interruptCause,
              }),
            ),
          ),
        ),
      ),
    );

  // Ordinary user/fence callers intentionally retain the historical contract:
  // even a successfully dispatched widening reports the original interrupt
  // failure. Ledger reconciliation uses the observed outcome above because it
  // must durably retire rows after either kind of successful action.
  const interruptTurnOrEscalateToSessionStop = (
    input: Parameters<typeof interruptTurnAndObserveEscalation>[0],
  ) =>
    interruptTurnAndObserveEscalation(input).pipe(
      Effect.flatMap((outcome) =>
        outcome._tag === "interrupted" ? Effect.void : Effect.failCause(outcome.interruptCause),
      ),
    );

  /**
   * Reconcile every successful send below the newest successful delivery.
   *
   * Ownership is intentionally absent from this decision. A newer request takes
   * the claim BEFORE calling the provider, so it can own the row and still fail
   * its RPC. The survivor is therefore the delivery with the highest REQUEST
   * sequence, not the current claim holder. In A/B/C where C owns but fails, B
   * survives and A is stale.
   *
   * Delivery evidence is one durable row per concrete (request, turn) result.
   * Rows are ordered by (request sequence, SQLite delivery id), so distinct
   * equal-sequence replays are retained and the later inserted concrete turn
   * survives. SQLite write serialization means a later completing sender sees
   * all earlier stamps, so at least one reconciliation pass observes every new
   * stale/survivor pair.
   *
   * Shared steers can put the same provider turn id in several rows. The
   * survivor's id is never interrupted, and duplicate stale ids are collapsed
   * to one external attempt. A successful attempt retires every row for that
   * concrete turn. Rows sharing the survivor id are retired without an
   * interrupt because they are duplicate steer evidence, not duplicate work.
   *
   * A direct interrupt retires only the concrete rows it reconciled. A
   * successfully dispatched widened session stop tears down every stale turn in
   * the session, so it retires every row before the survivor and ends the pass;
   * siblings do not enqueue redundant stops. If both actions fail, the row
   * remains live for a later completion to retry.
   */
  const reconcileDeliveredSendAgainstSupersession = (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
    turn: ProviderTurnStartResult,
  ) =>
    providerTurnSendClaimRepository
      .recordDelivery({
        threadId: event.payload.threadId,
        messageId: event.payload.messageId,
        requestSequence: event.sequence,
        turnId: turn.turnId,
      })
      .pipe(
        // The stamp is durable evidence needed by the OTHER completing sender,
        // not optional bookkeeping. A transient SQLite contention should not
        // erase the only side capable of reconciling the pair.
        Effect.retry({ times: 2, schedule: Schedule.exponential(100) }),
        Effect.flatMap((state) =>
          Effect.gen(function* () {
            if (state._tag === "unowned") {
              return yield* Effect.logDebug(
                "provider-command-reactor.turn-start.delivery-unowned",
                {
                  threadId: event.payload.threadId,
                  messageId: event.payload.messageId,
                  requestSequence: event.sequence,
                  turnId: turn.turnId,
                },
              );
            }

            const replacement = state.deliveries.at(-1);
            if (replacement === undefined || state.deliveries.length === 1) {
              return yield* Effect.logDebug(
                "provider-command-reactor.turn-start.supersession-not-delivered",
                {
                  threadId: event.payload.threadId,
                  messageId: event.payload.messageId,
                  requestSequence: event.sequence,
                  turnId: turn.turnId,
                },
              );
            }

            const staleRows = state.deliveries.slice(0, -1);
            const teardownCovered = staleRows.filter((delivery) => delivery.teardownDispatched);
            const actionableStaleRows = staleRows.filter(
              (delivery) => !delivery.teardownDispatched,
            );
            const staleByTurnId = new Map<
              TurnId,
              {
                representative: (typeof state.deliveries)[number];
                deliveryIds: Array<number>;
              }
            >();
            const sharedWithSurvivor: Array<number> = [];
            for (const delivery of actionableStaleRows) {
              if (delivery.turnId === replacement.turnId) {
                sharedWithSurvivor.push(delivery.deliveryId);
                continue;
              }
              const group = staleByTurnId.get(delivery.turnId);
              if (group === undefined) {
                staleByTurnId.set(delivery.turnId, {
                  representative: delivery,
                  deliveryIds: [delivery.deliveryId],
                });
              } else {
                // Rows arrive in total order, so the last row supplies the
                // strongest request-sequence cutoff for this concrete turn.
                group.representative = delivery;
                group.deliveryIds.push(delivery.deliveryId);
              }
            }

            const retire = (deliveryIds: ReadonlyArray<number>) =>
              providerTurnSendClaimRepository
                .retireDeliveries({
                  threadId: event.payload.threadId,
                  messageId: event.payload.messageId,
                  deliveryIds: [...deliveryIds],
                  survivorDeliveryId: replacement.deliveryId,
                  reconciledAt: event.payload.createdAt,
                })
                .pipe(Effect.retry({ times: 2, schedule: Schedule.exponential(100) }));

            // The exact-turn target disappeared with an earlier widened
            // teardown. It stayed live only because it was the survivor then;
            // this newly inserted survivor now makes guarded retirement legal.
            if (teardownCovered.length > 0) {
              yield* retire(teardownCovered.map((delivery) => delivery.deliveryId));
            }

            if (sharedWithSurvivor.length > 0) {
              yield* retire(sharedWithSurvivor);
            }

            if (staleByTurnId.size === 0) {
              return yield* Effect.logDebug(
                "provider-command-reactor.turn-start.supersession-shared-turn",
                {
                  threadId: event.payload.threadId,
                  messageId: event.payload.messageId,
                  requestSequence: event.sequence,
                  replacementRequestSequence: replacement.requestSequence,
                  turnId: replacement.turnId,
                },
              );
            }

            for (const { representative: stale, deliveryIds } of staleByTurnId.values()) {
              yield* Effect.logDebug(
                "provider-command-reactor.turn-start.superseded-delivery-reconciled",
                {
                  threadId: event.payload.threadId,
                  messageId: event.payload.messageId,
                  callerRequestSequence: event.sequence,
                  staleRequestSequence: stale.requestSequence,
                  staleTurnId: stale.turnId,
                  replacementRequestSequence: replacement.requestSequence,
                  replacementTurnId: replacement.turnId,
                },
              );
              const outcome = yield* interruptTurnAndObserveEscalation({
                threadId: event.payload.threadId,
                turnId: stale.turnId,
                // This is the stale request's own boundary. For an earlier
                // equal-sequence delivery the shared sequence is still the only
                // durable cutoff available; delivery_id orders the concrete
                // survivor inside the ledger, not the event log.
                canceledThroughSequence: stale.requestSequence,
                createdAt: event.payload.createdAt,
                escalationTag: "supersession-escalated-session-stop",
                logContext: {
                  messageId: event.payload.messageId,
                  staleRequestSequence: stale.requestSequence,
                  replacementRequestSequence: replacement.requestSequence,
                  replacementTurnId: replacement.turnId,
                },
              });

              if (outcome._tag === "interrupted") {
                yield* retire(deliveryIds);
                continue;
              }

              if (outcome._tag === "escalation-dispatched") {
                // A session teardown covers every stale concrete turn, regardless
                // of which row triggered it. Retire all rows the snapshot placed
                // strictly before this survivor and stop: sibling widened stops
                // would be redundant and can kill a freshly redriven survivor.
                yield* providerTurnSendClaimRepository
                  .markTeardownDispatched({
                    threadId: event.payload.threadId,
                    messageId: event.payload.messageId,
                    deliveryIds: state.deliveries.map((delivery) => delivery.deliveryId),
                    dispatchedAt: event.payload.createdAt,
                  })
                  .pipe(Effect.retry({ times: 2, schedule: Schedule.exponential(100) }));
                yield* retire(staleRows.map((delivery) => delivery.deliveryId));
                return;
              }

              yield* Effect.logWarning(
                "provider command reactor failed to reconcile stale delivered send",
                {
                  threadId: event.payload.threadId,
                  messageId: event.payload.messageId,
                  staleRequestSequence: stale.requestSequence,
                  staleTurnId: stale.turnId,
                  replacementRequestSequence: replacement.requestSequence,
                  replacementTurnId: replacement.turnId,
                  cause: Cause.pretty(outcome.interruptCause),
                },
              );
              yield* appendProviderFailureActivity({
                threadId: event.payload.threadId,
                kind: "provider.turn.interrupt.failed",
                summary: "Provider turn interrupt failed",
                detail: `A delivered turn could not be reconciled with its replacement: ${formatFailureDetail(outcome.interruptCause)}`,
                turnId: stale.turnId,
                createdAt: event.payload.createdAt,
              }).pipe(
                Effect.catchCause((appendCause) =>
                  Effect.logError(
                    "provider command reactor failed to report delivery reconciliation failure",
                    {
                      threadId: event.payload.threadId,
                      messageId: event.payload.messageId,
                      staleRequestSequence: stale.requestSequence,
                      staleTurnId: stale.turnId,
                      cause: Cause.pretty(appendCause),
                    },
                  ),
                ),
              );
            }
          }),
        ),
        // This outer failure path is for recording/reading the ledger itself.
        // Stale interrupt failures are caught per row above so they retain their
        // own sequence/turn attribution and do not abort later attempts.
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "provider command reactor failed to reconcile delivered send supersession",
            {
              threadId: event.payload.threadId,
              messageId: event.payload.messageId,
              requestSequence: event.sequence,
              turnId: turn.turnId,
              cause: Cause.pretty(cause),
            },
          ).pipe(
            Effect.flatMap(() =>
              appendProviderFailureActivity({
                threadId: event.payload.threadId,
                kind: "provider.turn.interrupt.failed",
                summary: "Provider turn interrupt failed",
                detail: `A delivered turn could not be reconciled with its replacement: ${formatFailureDetail(cause)}`,
                turnId: turn.turnId,
                createdAt: event.payload.createdAt,
              }),
            ),
            Effect.catchCause((appendCause) =>
              Effect.logError(
                "provider command reactor failed to report delivery reconciliation failure",
                {
                  threadId: event.payload.threadId,
                  messageId: event.payload.messageId,
                  requestSequence: event.sequence,
                  turnId: turn.turnId,
                  cause: Cause.pretty(appendCause),
                },
              ),
            ),
          ),
        ),
      );

  const fenceSendAgainstLateStop = (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
    turn: ProviderTurnStartResult,
  ) =>
    providerTurnSendClaimRepository
      .acquire({
        threadId: event.payload.threadId,
        messageId: event.payload.messageId,
        requestSequence: event.sequence,
        claimedAt: event.payload.createdAt,
      })
      .pipe(
        // Retried before anything downstream sees a failure. An unreadable
        // claim is not "no stop" — it is "we do not know", and the two are
        // opposite instructions: the first says leave the turn running, the
        // second says a user may be waiting for it to die. Treating the read as
        // authoritative when it never completed is what made this path fail
        // open silently. A repeat read is free (the acquire is idempotent for
        // the same request: a replay re-reads its own winning row), so the
        // transient case — a contended SQLite write — is absorbed here rather
        // than escalated into a missed stop.
        Effect.retry({ times: 2, schedule: Schedule.exponential(100) }),
        // Second opinion when the claim is still unreadable. The claim table
        // and the event log are separate stores answering overlapping
        // questions, so an outage of one does not have to end the enquiry —
        // and "we do not know" must not silently resolve to "no stop", which
        // is the one answer that costs the user a turn they asked to kill.
        //
        // Deliberately only ever ESCALATES to `canceled`. This read cannot see
        // a supersession by the same message the way the claim can, so an
        // absent interrupt here is not evidence the send is still the live one
        // — it is just an absent interrupt. Mapping that to `acquired` would
        // manufacture certainty the fallback does not have; mapping it to a
        // `superseded` outcome WITHOUT `heldBySequence` keeps it on the safe
        // do-nothing branch below rather than inventing an owner and stopping a
        // healthy turn.
        //
        // If this read fails too, the original claim failure is what propagates
        // — it is the one the outer handler reports, and the fallback failing
        // is not new information about the user's turn.
        Effect.catchCause((claimCause) =>
          Effect.logWarning(
            "provider command reactor falling back to the event log after an unreadable send claim",
            {
              threadId: event.payload.threadId,
              messageId: event.payload.messageId,
              requestSequence: event.sequence,
              turnId: turn.turnId,
              cause: Cause.pretty(claimCause),
            },
          ).pipe(
            Effect.flatMap(() =>
              orchestrationEventStore.getThreadTurnStartClaim({
                threadId: event.payload.threadId,
                messageId: event.payload.messageId,
                afterSequence: event.sequence,
              }),
            ),
            Effect.map(
              (claim): ProviderTurnSendClaimOutcome =>
                claim.interruptedAfter ? { _tag: "canceled" } : { _tag: "superseded" },
            ),
            Effect.catchCause(() => Effect.failCause(claimCause)),
          ),
        ),
        Effect.flatMap((outcome) => {
          // Supersession is deliberately a no-op here. `acquire` proves only
          // who owns the right to ATTEMPT the send; it says nothing about
          // whether that owner delivered a replacement. Delivery reconciliation
          // above is the sole path allowed to interrupt for supersession.
          if (outcome._tag !== "canceled") {
            return Effect.logDebug("provider-command-reactor.turn-start.fence-clear", {
              threadId: event.payload.threadId,
              messageId: event.payload.messageId,
              requestSequence: event.sequence,
              turnId: turn.turnId,
              outcome: outcome._tag,
              ...(outcome._tag === "superseded" && outcome.heldBySequence !== undefined
                ? { heldBySequence: outcome.heldBySequence }
                : {}),
            });
          }
          return Effect.logDebug("provider-command-reactor.turn-start.stopped-during-send", {
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            requestSequence: event.sequence,
            turnId: turn.turnId,
          }).pipe(
            // One retry, then escalate to the session — the shared ladder, so
            // the ordinary interrupt path and this one cannot drift apart. The
            // interrupt is addressed to THIS send's returned turn id because
            // this branch is now exclusively a concrete stop barrier.
            Effect.flatMap(() =>
              interruptTurnOrEscalateToSessionStop({
                threadId: event.payload.threadId,
                turnId: turn.turnId,
                // This request's own sequence is the weakest cutoff that covers
                // the work being fenced. The existing monotonic stop barrier is
                // already at or above it.
                canceledThroughSequence: event.sequence,
                createdAt: event.payload.createdAt,
                escalationTag: "fence-escalated-session-stop",
                logContext: {
                  messageId: event.payload.messageId,
                },
              }),
            ),
          );
        }),
        // Last resort, reached only after the claim read was retried, the
        // interrupt was retried, AND the escalation to a session stop also
        // failed. Every mechanism this process has for stopping the turn is
        // exhausted by this point, so what remains is genuinely a report and
        // not a choice to fail open: nothing here can unsend an RPC that
        // already landed, and no further call is available to make it stop.
        //
        // It must not fail the turn-start — the prompt is with the provider
        // either way, and reporting a start failure for a turn that started
        // would be a worse lie than the missed stop. But it must not be silent
        // either: the user pressed stop and the turn kept going, so the same
        // interrupt-failure activity every other unfulfillable stop appends is
        // appended here, and the UI shows a turn that did not obey rather than
        // one that quietly did not.
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to fence send against late stop", {
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            turnId: turn.turnId,
            cause: Cause.pretty(cause),
          }).pipe(
            Effect.flatMap(() =>
              appendProviderFailureActivity({
                threadId: event.payload.threadId,
                kind: "provider.turn.interrupt.failed",
                summary: "Provider turn interrupt failed",
                detail: `The turn was sent and could not be stopped afterwards: ${formatFailureDetail(cause)}`,
                turnId: turn.turnId,
                createdAt: event.payload.createdAt,
              }),
            ),
            // The activity append is the last line of defence; if it also fails
            // there is nothing left to try, and taking down the turn-start fiber
            // over a failed log entry would help no one.
            Effect.catchCause((appendCause) =>
              Effect.logError("provider command reactor failed to report an undeliverable stop", {
                threadId: event.payload.threadId,
                messageId: event.payload.messageId,
                turnId: turn.turnId,
                cause: Cause.pretty(appendCause),
              }),
            ),
          ),
        ),
      );
  const regenerateThreadTitle = Effect.fn("regenerateThreadTitle")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>,
    requestId: CommandId,
  ) {
    if (event.payload.regenerateTitle !== true) {
      return { _tag: "Superseded" } as const;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread || thread.titleRegeneration?.requestId !== requestId) {
      return { _tag: "Superseded" } as const;
    }

    const { message, attachments } = formatThreadTitleContext(thread.messages);
    if (message.length === 0) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const previousTitle = event.payload.previousTitle ?? thread.title;
    if (thread.title !== previousTitle) {
      return { _tag: "Superseded" } as const;
    }
    const project = yield* resolveProject(thread.projectId);
    const cwd =
      resolveThreadWorkspaceCwd({
        thread,
        projects: project ? [project] : [],
      }) ?? process.cwd();
    const { textGenerationModelSelection: modelSelection } =
      yield* serverSettingsService.getSettings;
    const generated = yield* textGeneration.generateThreadTitle({
      cwd,
      message,
      previousTitle,
      ...(attachments.length > 0 ? { attachments } : {}),
      modelSelection,
    });
    if (generated.title === DEFAULT_THREAD_TITLE || generated.title === previousTitle) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const latestThread = yield* resolveThread(event.payload.threadId);
    if (
      !latestThread ||
      latestThread.titleRegeneration?.requestId !== requestId ||
      latestThread.title !== previousTitle
    ) {
      return { _tag: "Superseded" } as const;
    }

    return { _tag: "Completed", title: generated.title } as const;
  });
  const dispatchThreadTitleRegenerationCompletion = Effect.fn(
    "dispatchThreadTitleRegenerationCompletion",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly title?: string;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.title.regeneration.complete",
      commandId: yield* serverCommandId("thread-title-regeneration-complete"),
      threadId: input.threadId,
      requestId: input.requestId,
      ...(input.title !== undefined ? { title: input.title } : {}),
    });
  });
  const findInterruptedThreadTitleRegenerations = Effect.fn(
    "findInterruptedThreadTitleRegenerations",
  )(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    return readModel.threads.flatMap((thread) => {
      const requestId = thread.titleRegeneration?.requestId;
      return requestId === undefined ? [] : [{ threadId: thread.id, requestId }];
    });
  });
  const clearInterruptedThreadTitleRegenerations = Effect.fn(
    "clearInterruptedThreadTitleRegenerations",
  )(function* (
    interrupted: ReadonlyArray<{ readonly threadId: ThreadId; readonly requestId: CommandId }>,
  ) {
    yield* Effect.forEach(
      interrupted,
      ({ threadId, requestId }) => {
        return dispatchThreadTitleRegenerationCompletion({
          threadId,
          requestId,
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.interrupt;
            }
            return Effect.logWarning(
              "provider command reactor failed to clear interrupted title regeneration",
              {
                threadId,
                cause: Cause.pretty(cause),
              },
            );
          }),
        );
      },
      { discard: true },
    );
  });
  const processThreadTitleRegenerationSafely = Effect.fn("processThreadTitleRegenerationSafely")(
    function* (event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>) {
      if (event.payload.regenerateTitle !== true) {
        return;
      }

      const requestId = event.payload.titleRegeneration?.requestId ?? event.commandId;
      if (requestId === null) {
        return;
      }
      const result = yield* regenerateThreadTitle(event, requestId).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning("provider command reactor failed to regenerate thread title", {
            threadId: event.payload.threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as({ _tag: "Completed", title: undefined } as const));
        }),
      );
      if (result._tag === "Superseded") {
        return;
      }

      const completion = {
        threadId: event.payload.threadId,
        requestId,
        ...(result.title !== undefined ? { title: result.title } : {}),
      };
      yield* dispatchThreadTitleRegenerationCompletion(completion).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning(
            "provider command reactor retrying title regeneration completion",
            {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            },
          ).pipe(Effect.andThen(dispatchThreadTitleRegenerationCompletion(completion)));
        }),
      );
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning(
            "provider command reactor failed to complete title regeneration",
            {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            },
          );
        }),
      ),
  );
  const threadTitleRegenerationWorker = yield* makeDrainableWorker(
    processThreadTitleRegenerationSafely,
  );

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) {
      return;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    // Supersession guard, read from the append-only event log.
    //
    // Session-exit auto-resume re-issues the *same* user message with a fresh
    // commandId (which bypasses turn-start dedup), so a crash landing after this
    // reactor already consumed the original turn-start-requested would otherwise
    // double-drive the same prompt. The guard skips a request once a LATER
    // turn-start for the same message exists, or once the user interrupted the
    // thread after it.
    //
    // Both facts come from `orchestration_events`, not from the pending
    // turn-start projection rows, and that distinction is the fix rather than a
    // refactor. Those rows are CONSUMED: `turn.started` deletes the placeholder
    // it adopts. A row-based guard therefore has nothing left to compare against
    // once the original turn has begun — it finds no row, concludes "not
    // superseded", and sends the stale original AND its resume to the provider:
    // the same prompt driven twice. The consumed row also takes
    // `pendingInterruptRequested` with it, so a stop the user issued while this
    // reactor lagged is silently forgotten and the canceled prompt is sent
    // anyway. The event log is never consumed: a re-request is permanently
    // observable at its own sequence, whatever arrives afterwards.
    //
    // Scoping is by thread stream and by `sequence > event.sequence`, so a
    // request never supersedes itself (a normal single turn-start sees no later
    // events and drives), rapid multi-send of DISTINCT messages is untouched,
    // and the scan is bounded by that thread's tail.
    //
    // Checked twice. This first read is an early-out that avoids the side effects
    // below (title and worktree-branch generation) for a request already known to
    // be dead. It is NOT sufficient on its own: those side effects and the
    // session binding that follows are slow — they can spawn a model call and
    // start a provider session — and a re-issue or an interrupt can land during
    // that window. The read is therefore repeated immediately before `sendTurn`,
    // which is the point the decision actually governs.
    const readTurnStartClaim = orchestrationEventStore.getThreadTurnStartClaim({
      threadId: event.payload.threadId,
      messageId: event.payload.messageId,
      afterSequence: event.sequence,
    });

    const initialTurnStartClaim = yield* readTurnStartClaim;
    if (initialTurnStartClaim.supersededBySameMessage || initialTurnStartClaim.interruptedAfter) {
      return;
    }

    const project = yield* resolveProject(thread.projectId);
    const legacyCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project ? [project] : [],
    });
    const executionTarget = yield* ensureExecutionTarget(thread, legacyCwd);
    // Provisioning can take long enough for a stop or a replacement request to
    // land. Re-check before any cwd-dependent or provider side effect.
    const postReadyClaim = yield* readTurnStartClaim;
    if (postReadyClaim.supersededBySameMessage || postReadyClaim.interruptedAfter) {
      return;
    }
    const isFirstUserMessageTurn =
      thread.messages.filter((entry) => entry.role === "user").length === 1;
    if (isFirstUserMessageTurn) {
      // Title generation runs a text-generation CLI on the HOST, so it needs a
      // host path -- not the execution target's cwd, which for a sandboxed
      // thread is the in-container `/workspace/repo` and makes the spawn die
      // with ENOENT on every first turn of an isolated thread. The branch-name
      // generation below already uses the host worktree for the same reason.
      const generationCwd = legacyCwd ?? process.cwd();
      const generationInput = {
        messageText: message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
      };

      yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
        threadId: event.payload.threadId,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        ...generationInput,
      }).pipe(Effect.forkScoped);

      if (canReplaceThreadTitle(thread.title, event.payload.titleSeed)) {
        yield* maybeGenerateThreadTitleForFirstTurn({
          threadId: event.payload.threadId,
          cwd: generationCwd,
          ...generationInput,
        }).pipe(Effect.forkScoped);
      }
    }

    const handleTurnStartFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      const detail = formatFailureDetail(cause);
      return Effect.logError("Provider turn start failed.", { cause }).pipe(
        Effect.andThen(
          setThreadSessionErrorOnTurnStartFailure({
            threadId: event.payload.threadId,
            detail,
            createdAt: event.payload.createdAt,
          }),
        ),
        Effect.flatMap(() =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            detail,
            turnId: null,
            createdAt: event.payload.createdAt,
          }),
        ),
        Effect.asVoid,
      );
    };

    const recoverTurnStartFailure = (cause: Cause.Cause<unknown>) =>
      handleTurnStartFailure(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.logWarning("provider command reactor failed to recover turn start failure", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(recoveryCause),
            originalCause: Cause.pretty(cause),
          }),
        ),
      );

    const sendTurnRequest = yield* buildSendTurnRequestForThread({
      threadId: event.payload.threadId,
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      interactionMode: event.payload.interactionMode,
      createdAt: event.payload.createdAt,
      executionTarget,
      turnRequestSequence: event.sequence,
    }).pipe(
      Effect.map(Option.some),
      Effect.catchCause((cause) => handleTurnStartFailure(cause).pipe(Effect.as(Option.none()))),
    );

    if (Option.isNone(sendTurnRequest)) {
      return;
    }

    // Revalidate at the point of no return. `buildSendTurnRequestForThread` binds
    // (and may start or restart) the provider session, and the title/branch
    // generation forked above runs concurrently — a re-issued turn-start or a
    // user interrupt can land anywhere in that window. Re-reading the durable
    // claim here is what keeps a superseded prompt from reaching the provider;
    // the earlier read only saves work. The session binding is deliberately left
    // in place: a resume will use it, and a stopped session is settled by the
    // interrupt path, not here.
    //
    // The read is sequenced INSIDE the fork, immediately upstream of `sendTurn`,
    // rather than on the worker before forking. Reading on the worker leaves the
    // fork's own scheduling delay between the decision and the send, and an
    // interrupt appended in that gap is missed.
    //
    // The event-log read alone still cannot close the window: a read followed by
    // a write is not atomic however little sits between them, so an interrupt
    // committed in between passes a check that already succeeded. The durable
    // send-claim below removes that window rather than narrowing it. The log read
    // is kept as the cheap first test — it is the only one that can see a
    // supersession by a request that has not itself tried to send yet — and the
    // claim is the authority.
    //
    // A failed read or a failed acquire is handled as a failed turn start
    // (`recoverTurnStartFailure` below), not as permission to send: if we cannot
    // tell whether the user stopped this turn, sending it anyway is the one
    // outcome that cannot be taken back.
    yield* readTurnStartClaim.pipe(
      Effect.flatMap((finalTurnStartClaim) =>
        finalTurnStartClaim.supersededBySameMessage || finalTurnStartClaim.interruptedAfter
          ? Effect.logDebug("provider-command-reactor.turn-start.superseded-before-send", {
              threadId: event.payload.threadId,
              messageId: event.payload.messageId,
              supersededBySameMessage: finalTurnStartClaim.supersededBySameMessage,
              interruptedAfter: finalTurnStartClaim.interruptedAfter,
            })
          : // The acquire tests "already claimed by another request for this
            // message" and "canceled by a stop at or above my sequence" in one
            // statement, so nothing can interleave between the decision and the
            // claim, and only the holder sends. It does NOT make the send
            // itself atomic — no database write spans an RPC to another
            // process — so a stop landing during `sendTurn` is caught after the
            // fact by the fence below rather than prevented here.
            providerTurnSendClaimRepository
              .acquire({
                threadId: event.payload.threadId,
                messageId: event.payload.messageId,
                requestSequence: event.sequence,
                claimedAt: event.payload.createdAt,
              })
              .pipe(
                Effect.flatMap((outcome) =>
                  outcome._tag === "acquired"
                    ? providerService.sendTurn(sendTurnRequest.value).pipe(
                        Effect.flatMap((turn) =>
                          // Stamp delivery BEFORE folding or fencing. The stamp
                          // is what lets either successful claimant reconcile
                          // a distinct stale turn; neither the consumed pending
                          // row nor claim ownership can prove replacement.
                          //
                          // Fold still precedes the stop fence. It records a fact that
                          // is already true — the provider has the message —
                          // and the fence can interrupt, which does not make
                          // it any less true. Ordering it after would leave
                          // the placeholder stranded on exactly the paths
                          // (stop mid-send, interrupt failure) where a wrong
                          // "never sent" reading is most damaging.
                          reconcileDeliveredSendAgainstSupersession(event, turn).pipe(
                            Effect.flatMap(() =>
                              turn.steered === true
                                ? foldSteeredTurnStart(event, turn)
                                : Effect.void,
                            ),
                            Effect.flatMap(() => fenceSendAgainstLateStop(event, turn)),
                          ),
                        ),
                      )
                    : Effect.logDebug(
                        "provider-command-reactor.turn-start.send-claim-not-acquired",
                        {
                          threadId: event.payload.threadId,
                          messageId: event.payload.messageId,
                          requestSequence: event.sequence,
                          reason: outcome._tag,
                        },
                      ),
                ),
              ),
      ),
      Effect.catchCause(recoverTurnStartFailure),
      Effect.forkScoped,
    );
  });

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    // Raise the cancel barrier FIRST, before any of the checks below, and on the
    // worker rather than in a fork.
    //
    // This is the half of the send-claim that stops undriven work. A turn-start
    // being processed concurrently acquires its claim in a statement that tests
    // this barrier, so SQLite's write serialization decides the outcome: barrier
    // first and the send never happens; claim first and the turn is on its way
    // to the provider, which the `interruptTurn` call below handles.
    //
    // Those two are not exhaustive, and pretending otherwise was the earlier
    // mistake here. The barrier can also land while `sendTurn` is in flight —
    // after the claim was read, before the provider has a session to interrupt —
    // so this call finds nothing to stop. That third case is covered on the
    // other side, by `fenceSendAgainstLateStop` re-reading the claim after the
    // send and interrupting there. Neither half is sufficient alone.
    //
    // Ordering matters twice over. It precedes the no-session early return
    // because a turn-start that has not reached the provider yet is exactly the
    // case with no session bound — returning first would drop the stop for the
    // only turns this barrier can still save. And it runs unforked so the barrier
    // is durable before this event is considered handled; a fork could be
    // scheduled after the send it was meant to cancel.
    //
    // A failed write must not be swallowed: if we cannot record the stop, the
    // turn-start still holds its claim, so this is reported as an interrupt
    // failure rather than logged and forgotten.
    //
    // Unlike the session-stop path, a failure here does NOT abandon the rest of
    // the handler. The two halves of an interrupt are independent: the barrier
    // stops work not yet sent, and `interruptTurn` below stops the turn already
    // running. Losing the first is no reason to skip the second — that would
    // turn one unstopped queued prompt into a running turn left running too.
    // Nothing here can resurrect a session, which is what makes the asymmetry
    // with session-stop correct rather than inconsistent.
    yield* raiseCancelBarrier({
      threadId: event.payload.threadId,
      canceledThroughSequence: event.sequence,
      updatedAt: event.payload.createdAt,
      failureKind: "provider.turn.interrupt.failed",
      failureSummary: "Provider turn interrupt failed",
      failureDetailPrefix: "Failed to record the stop before interrupting",
      turnId: event.payload.turnId ?? null,
    });

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    //
    // This call used to be bare, and a failure went nowhere but the reactor's
    // generic warning logger. That is the one outcome the projection cannot
    // tolerate: `thread.turn-interrupt-requested` has ALREADY marked the turn
    // interrupted by the time this runs, so a swallowed failure leaves the UI
    // showing a stopped turn while the provider keeps running it — side effects
    // and all — with nothing retrying and nobody told. It gets the same ladder
    // the post-send fence uses, and the same interrupt-failure activity when
    // every rung of it is exhausted.
    yield* interruptTurnOrEscalateToSessionStop({
      threadId: event.payload.threadId,
      turnId: null,
      // The interrupt's OWN sequence, which is the cutoff the user chose and the
      // one already raised above. The escalation is only allowed to widen what
      // is stopped, never when: a message submitted during the retry delay sits
      // above this line and is work the user asked for AFTER pressing stop.
      canceledThroughSequence: event.sequence,
      createdAt: event.payload.createdAt,
      escalationTag: "interrupt-escalated-session-stop",
      logContext: {},
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to deliver a turn interrupt", {
          threadId: event.payload.threadId,
          turnId: event.payload.turnId ?? null,
          cause: Cause.pretty(cause),
        }).pipe(
          Effect.flatMap(() =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.turn.interrupt.failed",
              summary: "Provider turn interrupt failed",
              detail: `The turn was marked stopped but the provider could not be told: ${formatFailureDetail(cause)}`,
              turnId: event.payload.turnId ?? null,
              createdAt: event.payload.createdAt,
            }),
          ),
          // Last line of defence. If reporting also fails there is nothing
          // further to try, and failing this handler over a log entry would
          // only requeue an interrupt that already ran its whole ladder.
          Effect.catchCause((appendCause) =>
            Effect.logError("provider command reactor failed to report an undelivered interrupt", {
              threadId: event.payload.threadId,
              turnId: event.payload.turnId ?? null,
              cause: Cause.pretty(appendCause),
            }),
          ),
        ),
      ),
    );
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            detail: isUnknownPendingApprovalRequestError(cause)
              ? stalePendingRequestDetail("approval", event.payload.requestId)
              : Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      yield* providerService
        .respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
        })
        .pipe(
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.user-input.respond.failed",
              summary: "Provider user input response failed",
              detail: isUnknownPendingUserInputRequestError(cause)
                ? stalePendingRequestDetail("user-input", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            }),
          ),
        );
    },
  );

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    // Raise the cancel barrier FIRST, for the same reasons and in the same
    // order as the turn-interrupt path — see the long comment there.
    //
    // Stopping the session is a broader stop than interrupting a turn, so it
    // cannot be the weaker one. Without this a turn-start fiber delayed past
    // this handler passes every guard, acquires its claim, and calls `sendTurn`,
    // which resolves with `allowRecovery: true` and therefore does not just fail
    // — it recovers the persisted binding and RESURRECTS the session the user
    // just shut down, delivering a prompt to a provider they had finished with.
    //
    // It precedes the `resolveThread` early return deliberately: a thread whose
    // session is already gone is exactly the case where an undriven turn-start
    // is still queued, so returning first would skip the barrier for the only
    // requests it can still stop.
    //
    // The cutoff is the payload's when it declares one, and this event's own
    // sequence otherwise. A user-pressed stop declares none and cancels
    // everything queued as of its position, which is what its sequence means.
    // An ESCALATED stop declares the sequence of the interrupt it is widening,
    // because it is dispatched only after that interrupt's retries ran out —
    // strictly later than the failure it reports and later, therefore, than
    // anything the user submitted in that window. Raising at this event's
    // sequence would date the stop to when the reactor gave up rather than to
    // what the user stopped, silently canceling a replacement prompt they typed
    // after pressing stop. Lower is the safe direction here regardless: the
    // barrier is monotonic, so a raise below an existing one changes nothing.
    const barrierRaised = yield* raiseCancelBarrier({
      threadId: event.payload.threadId,
      canceledThroughSequence: event.payload.canceledThroughSequence ?? event.sequence,
      updatedAt: event.payload.createdAt,
      failureKind: "provider.session.stop.failed",
      failureSummary: "Provider session stop failed",
      failureDetailPrefix: "Failed to record the stop before stopping the session",
      turnId: null,
    });

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    // An unraised barrier makes the rest of this handler actively harmful.
    //
    // Stopping the provider and marking the projection `stopped` is the half of
    // the stop the user can see; the barrier is the half that stops work not
    // yet sent. With only the visible half done, a queued turn-start still
    // passes its claim guard, calls `sendTurn`, and — because a send to a
    // stopped session resolves with `allowRecovery: true` — recovers the
    // persisted binding and RESURRECTS the session, delivering a prompt to a
    // provider the user had finished with, against a thread the UI now shows as
    // stopped.
    //
    // So this stops here rather than completing a stop it cannot enforce. The
    // failure was already reported on the thread by `raiseCancelBarrier`, and a
    // session that is still visibly running is a state the user can act on by
    // pressing stop again; one that reads as stopped while accepting new turns
    // is not.
    if (!barrierRaised) {
      return;
    }

    const now = event.payload.createdAt;
    if (thread.session && thread.session.status !== "stopped") {
      const stopped = yield* Effect.suspend(() =>
        providerService.stopSession({ threadId: thread.id }),
      ).pipe(
        // Match the turn-interrupt ladder: one bounded exponential retry. A
        // duplicate session stop is safe, while a transient transport failure
        // must not leave a provider running behind a generic warning.
        Effect.retry({ times: 1, schedule: Schedule.exponential(100) }),
        Effect.as(true),
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: thread.id,
            kind: "provider.session.stop.failed",
            summary: "Provider session stop failed",
            detail: `The cancel barrier was recorded, but the provider session could not be stopped: ${formatFailureDetail(cause)}`,
            turnId: null,
            createdAt: now,
          }).pipe(
            Effect.catchCause((appendCause) =>
              Effect.logError("provider command reactor failed to report a session stop failure", {
                threadId: thread.id,
                cause: Cause.pretty(appendCause),
                originalStopCause: Cause.pretty(cause),
              }),
            ),
            Effect.as(false),
          ),
        ),
      );

      // A failed provider stop leaves the runtime and projection live. Marking
      // the projection stopped would lie to the user; redriving requests spared
      // by the cutoff would then send still more work into the session that
      // failed to stop. The visible failure activity above is the terminal
      // result for this attempt.
      if (!stopped) {
        return;
      }
    }

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        ...(thread.session?.providerInstanceId !== undefined
          ? { providerInstanceId: thread.session.providerInstanceId }
          : {}),
        // Preserved for the same reason as the instance id: this write ends the
        // session, it does not re-identify it. A stopped binding that has
        // forgotten its generation cannot recognize the stopped runtime's own
        // late events as stale.
        ...(thread.session?.sessionGeneration !== undefined
          ? { sessionGeneration: thread.session.sessionGeneration }
          : {}),
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });

    yield* redriveTurnStartsSparedByStop(event);
  });

  /**
   * Re-issue the turn-starts an escalated stop's narrowed cutoff spared but its
   * teardown destroyed anyway.
   *
   * The cutoff and the teardown do not have the same reach. The cutoff decides
   * which QUEUED requests the barrier refuses, and an escalated stop narrows it
   * deliberately so a prompt the user typed AFTER pressing stop survives. The
   * teardown has no cutoff at all: it kills the provider session outright. So a
   * spared request that already won the race to `sendTurn` is delivered into a
   * session that is torn down moments later, and the user loses the very
   * instruction the narrowing existed to protect — silently, and only on the
   * scheduler interleavings where the send happened to go first. Narrowing the
   * cutoff without this turns "reliably suppressed" into "suppressed at random",
   * which is worse to debug and no better to live with.
   *
   * Re-driving through `thread.turn.resume` rather than trying to keep the
   * session alive, because the session genuinely has to die: this handler is
   * only reached after an interrupt could not be delivered, and the teardown is
   * the last remaining way to stop the turn that ignored it. So the session goes,
   * and the spared requests are re-appended above the barrier where the ordinary
   * turn-start path can start a fresh session and drive them normally.
   *
   * Skipped entirely for a stop the user pressed. That stop declares no cutoff,
   * means "everything queued as of now", and must keep tearing down without
   * resurrecting anything.
   */
  const redriveTurnStartsSparedByStop = (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) =>
    Effect.gen(function* () {
      const canceledThroughSequence = event.payload.canceledThroughSequence;
      // `undefined` is a user-pressed stop; `>= event.sequence` is a stop whose
      // cutoff already covers everything below it, so it spared nothing and
      // there is nothing to re-drive.
      if (canceledThroughSequence === undefined || canceledThroughSequence >= event.sequence) {
        return;
      }

      const spared = yield* orchestrationEventStore
        .listThreadTurnStartsAboveCutoff({
          threadId: event.payload.threadId,
          canceledThroughSequence: NonNegativeInt.make(canceledThroughSequence),
          stopSequence: NonNegativeInt.make(event.sequence),
        })
        .pipe(
          Effect.retry({ times: 2, schedule: Schedule.exponential(100) }),
          // A failed read must not fail the stop: the stop itself already
          // landed and is the half the user asked for. But it must not pass
          // silently either — an empty list here is indistinguishable from "the
          // stop spared nothing", and the difference is a prompt the user typed
          // and will never see run. So the thread gets an error activity naming
          // the loss, and the caller continues with nothing to re-drive.
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.session.stop.failed",
              summary: "Messages sent while stopping may not have been recovered",
              detail: `The session was stopped, but the reactor could not read which queued messages the stop spared, so any of them are lost and must be re-sent: ${Cause.pretty(cause)}`,
              turnId: null,
              createdAt: event.payload.createdAt,
            }).pipe(
              Effect.catchCause((appendCause) =>
                Effect.logError(
                  "provider command reactor could not report an unrecovered spared turn-start",
                  {
                    threadId: event.payload.threadId,
                    canceledThroughSequence,
                    stopSequence: event.sequence,
                    readCause: Cause.pretty(cause),
                    cause: Cause.pretty(appendCause),
                  },
                ),
              ),
              Effect.as([] as ReadonlyArray<ThreadTurnStartAboveCutoff>),
            ),
          ),
        );

      // One re-drive per message, carrying the LATEST request for it.
      //
      // The log can hold several turn-starts for the same message in this window
      // (an auto-resume re-issue, say), and they all name the same prompt — so
      // re-driving each would deliver it twice. Keeping the newest rather than
      // the first is what makes the collapse lossless: a re-issue exists
      // precisely because it corrects the one before it, and its model selection
      // and source plan are the ones the user last chose. `spared` is ordered
      // oldest-first, so a later entry overwrites an earlier one here while
      // `redriveOrder` preserves the position the message first appeared at.
      const redriveOrder: Array<MessageId> = [];
      const latestByMessageId = new Map<MessageId, ThreadTurnStartAboveCutoff>();
      for (const entry of spared) {
        if (!latestByMessageId.has(entry.messageId)) {
          redriveOrder.push(entry.messageId);
        }
        latestByMessageId.set(entry.messageId, entry);
      }

      for (const messageId of redriveOrder) {
        const entry = latestByMessageId.get(messageId);
        if (entry === undefined) {
          continue;
        }

        yield* orchestrationEngine
          .dispatch({
            type: "thread.turn.resume",
            commandId: yield* serverCommandId("escalated-stop-redrive"),
            threadId: event.payload.threadId,
            messageId: entry.messageId,
            // The request's own selections, not the thread's cache. The cache
            // holds whichever model was sent last on this thread, which for two
            // spared requests on different models is the wrong answer for at
            // least one of them; and it holds no plan reference at all, so a
            // plan-implementation turn re-driven from it could never mark its
            // plan implemented.
            ...(entry.modelSelection !== undefined ? { modelSelection: entry.modelSelection } : {}),
            ...(entry.sourceProposedPlan !== undefined
              ? { sourceProposedPlan: entry.sourceProposedPlan }
              : {}),
            reason: "re-drive after an escalated session stop tore down a spared turn",
            createdAt: event.payload.createdAt,
          })
          .pipe(
            // The decider returns no events when the message is gone or is not a
            // user message, which surfaces as this invariant error. That is the
            // correct outcome, not a failure: there is nothing to resume.
            //
            // Only THAT invariant, though. The tag is shared: the engine raises
            // it for genuine failures too — a failed event-id generation, a
            // source plan that no longer resolves — and swallowing those would
            // put the prompt back on the exact silent-loss path this re-drive
            // exists to close, with a debug log as the only trace. So the empty
            // decision is matched by its own detail and everything else falls
            // through to the report below.
            Effect.catchIf(
              (error) =>
                error._tag === "OrchestrationCommandInvariantError" &&
                error.detail === COMMAND_PRODUCED_NO_EVENTS_DETAIL,
              (error) =>
                Effect.logDebug("provider-command-reactor.escalated-stop-redrive.noop", {
                  threadId: event.payload.threadId,
                  messageId: entry.messageId,
                  reason: error.message,
                }),
            ),
            // Same reasoning as the read above: the stop stands either way, but
            // the dropped prompt is reported on the thread rather than only in
            // the server log, because the user is the only one who can recover
            // it and they cannot do that without knowing it happened.
            Effect.catchCause((cause) =>
              appendProviderFailureActivity({
                threadId: event.payload.threadId,
                kind: "provider.session.stop.failed",
                summary: "A message sent while stopping was not recovered",
                detail: `The session was stopped, but re-sending the message queued just before it failed, so it must be re-sent manually: ${Cause.pretty(cause)}`,
                turnId: null,
                createdAt: event.payload.createdAt,
              }).pipe(
                Effect.catchCause((appendCause) =>
                  Effect.logError(
                    "provider command reactor could not report an unrecovered spared turn-start",
                    {
                      threadId: event.payload.threadId,
                      messageId: entry.messageId,
                      redriveCause: Cause.pretty(cause),
                      cause: Cause.pretty(appendCause),
                    },
                  ),
                ),
              ),
            ),
          );
      }
    });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      "orchestration.thread_id": event.payload.threadId,
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });
    switch (event.type) {
      case "thread.meta-updated":
        yield* threadTitleRegenerationWorker.enqueue(event);
        return;
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThread(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
        yield* ensureSessionForThread(
          event.payload.threadId,
          event.occurredAt,
          cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
        );
        return;
      }
      case "thread.turn-start-requested":
        yield* processTurnStartRequested(event);
        return;
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    const interruptedTitleRegenerations = yield* findInterruptedThreadTitleRegenerations().pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(
          "provider command reactor failed to find interrupted title regenerations",
          { cause: Cause.pretty(cause) },
        ).pipe(Effect.as([]));
      }),
    );
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        (event.type === "thread.meta-updated" && event.payload.regenerateTitle === true) ||
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested"
      ) {
        return yield* worker.enqueue(event);
      }
    });

    yield* forkParked(Stream.runForEach(orchestrationEngine.streamDomainEvents, processEvent));

    // The domain event stream is hot, so work pending before this reactor
    // starts cannot be resumed. Correlated completions only clear the request
    // captured here, leaving any newer request untouched.
    const clearInterrupted = clearInterruptedThreadTitleRegenerations(
      interruptedTitleRegenerations,
    ).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(
          "provider command reactor failed to clear interrupted title regenerations",
          {
            cause: Cause.pretty(cause),
          },
        );
      }),
    );
    const activation = yield* ServerActivation;
    if (activation === undefined) {
      yield* clearInterrupted;
    } else {
      yield* forkParked(clearInterrupted);
    }
  });

  return {
    start,
    drain: Effect.gen(function* () {
      yield* worker.drain;
      yield* threadTitleRegenerationWorker.drain;
    }),
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make).pipe(
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(ProviderTurnSendClaimRepositoryLive),
  Layer.provide(T3ProjectFileLoaderLive),
);
