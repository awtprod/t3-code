// @effect-diagnostics nodeBuiltinImport:off - validates inherited Git patch content before container handoff.
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  EventId,
  MessageId,
  SandboxId,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import {
  SandboxManagerError,
  SandboxRuntimeManager,
  resolveSandboxImage,
  resolveSandboxPreviewProxyImage,
  resolveSandboxRuntime,
} from "../../sandbox/SandboxRuntimeManager.ts";
import type { SandboxAdoptionHint } from "../../sandbox/types.ts";
import { reconcileProviderStoreCursor } from "../../sandbox/providerStoreCursor.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  SandboxLifecycleReactor,
  type SandboxLifecycleReactorShape,
} from "../Services/SandboxLifecycleReactor.ts";
import {
  T3ProjectFileLoader,
  layer as T3ProjectFileLoaderLive,
} from "../../project/T3ProjectFileLoader.ts";
import { desktopGateway } from "../../sandbox/DesktopGatewayService.ts";

type SandboxRequestEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "sandbox.branch-export-requested"
      | "sandbox.provision-requested"
      | "sandbox.worker-spawn-requested"
      | "sandbox.worker-status-requested"
      | "sandbox.worker-message-requested"
      | "sandbox.worker-stop-requested"
      | "sandbox.stopping"
      | "sandbox.takeover-requested"
      | "sandbox.takeover-acquired"
      | "sandbox.resumed";
  }
>;

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const providers = yield* ProviderService;
  const providerSessions = yield* ProviderSessionDirectory;
  const runtimes = yield* SandboxRuntimeManager;
  const projectFiles = yield* T3ProjectFileLoader;
  const gitWorkflow = yield* GitWorkflowService;
  const crypto = yield* Crypto.Crypto;
  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((id) => CommandId.make(`server:${tag}:${id}`)));
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  /**
   * The config to record on an inline provision, with the runtime resolved.
   *
   * The decider is pure and defaults an absent `config.runtime` to `"docker"`,
   * while the runtime manager honours `T3_SANDBOX_RUNTIME`. On a podman
   * deployment the projection therefore claimed docker for the whole
   * provisioning window, and a stop or delete landing in it addressed a backend
   * that was never used. Resolving here -- rather than teaching the decider
   * about env vars -- keeps the projection matching what actually runs.
   */
  const resolvedConfig = Effect.fn("SandboxLifecycleReactor.resolvedConfig")(function* <
    Config extends { readonly runtime?: "docker" | "podman" | "microvm" },
  >(config: Config) {
    if (config.runtime !== undefined) return config;
    const runtime = resolveSandboxRuntime();
    if (runtime !== "docker" && runtime !== "podman")
      return yield* new SandboxManagerError({
        message: `unsupported sandbox runtime: ${runtime}`,
      });
    return { ...config, runtime };
  });

  const dispatchAndAwaitProjection = Effect.fn(
    "SandboxLifecycleReactor.dispatchAndAwaitProjection",
  )(function* (command: Parameters<typeof engine.dispatch>[0]) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const pull = yield* Stream.toPull(
          engine.streamDomainEvents.pipe(
            Stream.filter((candidate) => candidate.commandId === command.commandId),
          ),
        );
        const projected = yield* pull.pipe(Effect.timeout(Duration.seconds(30)), Effect.forkScoped);
        // Let the stream fiber acquire its PubSub subscription before dispatch
        // can publish the matching committed event.
        yield* Effect.yieldNow;
        const receipt = yield* engine.dispatch(command);
        yield* Fiber.join(projected);
        return receipt;
      }),
    );
  });

  const getThread = (threadId: Parameters<typeof snapshots.getThreadDetailById>[0]) =>
    snapshots.getThreadDetailById(threadId).pipe(Effect.map(Option.getOrUndefined));

  /**
   * Everything the backend needs to re-derive a sandbox record the running
   * server never provisioned. Undefined when the project's sandbox image cannot
   * be resolved, since the image digest is part of the label signature that
   * proves the container belongs to this thread.
   */
  const adoptionHint = Effect.fn("SandboxLifecycleReactor.adoptionHint")(function* (
    thread: OrchestrationThread,
  ) {
    if (thread.sandbox == null) return undefined;
    const snapshot = yield* snapshots.getSnapshot();
    const project = snapshot.projects.find((item) => item.id === thread.projectId);
    if (!project) return undefined;
    const projectFile = Option.getOrUndefined(yield* projectFiles.load(project.workspaceRoot));
    const image = resolveSandboxImage(projectFile);
    if (!image) return undefined;
    const teardownTimeoutSeconds = thread.sandboxConfig?.teardownTimeoutSeconds;
    return {
      projectId: thread.projectId,
      image,
      baseCommit: thread.sandbox.branch.baseCommit,
      branchName: thread.sandbox.branch.branchName,
      ...(teardownTimeoutSeconds === undefined
        ? {}
        : { teardownTimeoutMs: teardownTimeoutSeconds * 1000 }),
    };
  });

  const exportBranch = Effect.fn("SandboxLifecycleReactor.exportBranch")(function* (
    threadId: Parameters<typeof getThread>[0],
  ) {
    const thread = yield* getThread(threadId);
    const runtime = thread?.sandbox?.runtime;
    if (thread?.sandbox == null || (runtime !== "docker" && runtime !== "podman")) return;
    const result = yield* runtimes.exportBranch(runtime, threadId, yield* adoptionHint(thread));
    yield* engine.dispatch({
      type: "sandbox.branch-export.result",
      commandId: yield* commandId("sandbox-export"),
      threadId,
      branchName: thread.sandbox.branch.branchName,
      headCommit: result.commit,
      createdAt: yield* nowIso,
      artifactId: result.artifactId,
      bundleSha256: result.bundleSha256,
      ...(result.storeSha256 === undefined ? {} : { storeSha256: result.storeSha256 }),
    });
  });

  const stop = Effect.fn("SandboxLifecycleReactor.stop")(function* (
    threadId: Parameters<typeof getThread>[0],
    expired: boolean,
  ) {
    const detail = yield* getThread(threadId);
    // A deleted thread is invisible to the detail query (`deleted_at IS NULL`)
    // but its projection row -- and its running sandbox -- survive. A
    // deletion-triggered stop must still find the sandbox and tear the
    // container down, or deletion strands it running forever.
    const deletedThread =
      detail !== undefined
        ? undefined
        : (yield* snapshots.getSnapshot()).threads.find(
            (item) => item.id === threadId && item.deletedAt !== null,
          );
    const thread = detail ?? deletedThread;
    // No thread, or no sandbox projection: `stopping` is a state OF the
    // sandbox projection, so a thread without one cannot be wedged in it --
    // there is nothing to tear down and nothing to complete.
    if (thread?.sandbox == null) return;
    const runtime = thread.sandbox.runtime;
    if (runtime === "docker" || runtime === "podman") {
      const sessions = yield* providers.listSessions();
      if (sessions.some((session) => session.threadId === threadId))
        yield* providers.stopSession({ threadId });
      // No export for a deleted thread: there is no returning user to restore
      // for, and the export would recreate the very artifacts the deletion
      // flow removes -- transcripts must not outlive the thread.
      if (deletedThread === undefined) yield* exportBranch(threadId);
      // A failure here propagates to the worker's catchCause, which dispatches
      // `sandbox.operation.fail` (stage `teardown`) -- the decider moves the
      // thread from `stopping` to `failed` rather than leaving it wedged.
      yield* runtimes.stop(runtime, threadId, yield* adoptionHint(thread));
    }
    // Dispatched even when there was no container to tear down. The decider
    // accepts `sandbox.stop` from every non-terminal lifecycle -- including
    // `unprovisioned`, `provisioning`, and `failed`, none of which ever
    // recorded a runtime -- and moves the thread to `stopping` unconditionally.
    // Returning early here without completing left such threads in `stopping`
    // forever, where `thread.turn.start` is rejected: a permanently unusable
    // thread.
    yield* engine.dispatch({
      type: "sandbox.stop.complete",
      commandId: yield* commandId("sandbox-stop-complete"),
      threadId,
      expired,
      createdAt: yield* nowIso,
    });
  });

  const processEvent = Effect.fn("SandboxLifecycleReactor.processEvent")(function* (
    event: SandboxRequestEvent,
  ) {
    if (event.type === "sandbox.provision-requested") {
      const thread = yield* getThread(event.payload.threadId);
      if (!thread) return;
      const snapshot = yield* snapshots.getSnapshot();
      const project = snapshot.projects.find((item) => item.id === thread.projectId);
      if (!project)
        return yield* new SandboxManagerError({
          message: `project '${thread.projectId}' was not found`,
        });
      const projectFile = Option.getOrUndefined(yield* projectFiles.load(project.workspaceRoot));
      const declaration = projectFile?.sandbox;
      const image = resolveSandboxImage(projectFile);
      const previewProxyImage = resolveSandboxPreviewProxyImage();
      if (!image || !previewProxyImage) {
        const disabledAt = yield* nowIso;
        yield* engine
          .dispatch({
            type: "thread.activity.append",
            commandId: yield* commandId("sandbox-disabled-notice"),
            threadId: thread.id,
            createdAt: disabledAt,
            activity: {
              id: EventId.make(yield* crypto.randomUUIDv4),
              tone: "info",
              kind: "sandbox.disabled",
              summary:
                "Sandbox isolation is disabled — this server has no sandbox image configured. This thread will keep running normally.",
              payload: {},
              turnId: null,
              createdAt: disabledAt,
            },
          })
          .pipe(Effect.ignore);
        return;
      }
      const branch =
        thread.sandbox?.branch ??
        thread.sandboxBranch ??
        (yield* Effect.gen(function* () {
          const local = yield* gitWorkflow.localStatus({ cwd: project.workspaceRoot });
          if (!local.isRepo || local.refName === null)
            return yield* new SandboxManagerError({
              message: "Isolated threads require a Git repository with a selected branch.",
            });
          const base = yield* gitWorkflow.resolveRemoteTrackingCommit({
            cwd: project.workspaceRoot,
            refName: local.refName,
            fallbackRemoteName: "origin",
          });
          return {
            branchName: `t3/thread/${thread.id}`,
            baseCommit: base.commitSha,
          };
        }));
      const config = yield* resolvedConfig(event.payload.config ?? thread.sandboxConfig ?? {});
      const createdAt = yield* nowIso;
      const provisionCommandId = yield* commandId("sandbox-manual-provision");
      yield* dispatchAndAwaitProjection({
        type: "sandbox.provision",
        commandId: provisionCommandId,
        threadId: thread.id,
        config,
        branch,
        // Already handling `sandbox.provision-requested`; the provision runs
        // inline below, so this must not request itself again.
        provisionsInline: true,
        createdAt,
      });
      const provision = yield* runtimes.provision({
        bootstrap: {
          threadId: thread.id,
          projectId: thread.projectId,
          repositoryUrl: project.repositoryIdentity?.locator.remoteUrl ?? project.workspaceRoot,
          baseCommit: branch.baseCommit,
          branchName: branch.branchName,
        },
        config,
        image,
        ...(thread.sandbox?.lastExport ? { restore: thread.sandbox.lastExport } : {}),
        ...(process.env.T3_SANDBOX_EGRESS_PROXY_IMAGE?.trim()
          ? { egressProxyImage: process.env.T3_SANDBOX_EGRESS_PROXY_IMAGE.trim() }
          : {}),
        ...(declaration?.caches ? { caches: declaration.caches } : {}),
        ...(declaration?.setup ? { setup: declaration.setup } : {}),
        ...(declaration?.teardown ? { teardown: declaration.teardown } : {}),
        ...(declaration?.services ? { services: declaration.services } : {}),
        ...(declaration?.previewPorts ? { previewPorts: declaration.previewPorts } : {}),
      });
      // Same shared decision every other provisioning entry point makes: a
      // container whose provider home came up without the archived
      // conversation must not keep a cursor naming it, or every following turn
      // dies on "No conversation found with session ID". This path used to
      // ignore the outcome entirely and keep a stale cursor.
      yield* reconcileProviderStoreCursor(providerSessions, thread.id, provision.providerStore);
      yield* engine.dispatch({
        type: "sandbox.provision.ready",
        commandId: yield* commandId("sandbox-manual-ready"),
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
        createdAt: yield* nowIso,
      });
      const readyThread = yield* getThread(thread.id);
      if (readyThread?.sandbox) {
        const checkedAt = yield* nowIso;
        yield* engine.dispatch({
          type: "sandbox.reconcile.result",
          commandId: yield* commandId("sandbox-manual-service-health"),
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
              checkedAt,
            })),
          },
          createdAt: checkedAt,
        });
      }
      return;
    }
    if (event.type === "sandbox.takeover-acquired") {
      desktopGateway.setHumanControl(event.payload.threadId, true);
      return;
    }
    if (event.type === "sandbox.resumed") {
      desktopGateway.setHumanControl(event.payload.threadId, false);
      return;
    }
    if (event.type === "sandbox.branch-export-requested")
      return yield* exportBranch(event.payload.threadId);
    if (event.type === "sandbox.takeover-requested") {
      const sessions = yield* providers.listSessions();
      if (sessions.some((session) => session.threadId === event.payload.threadId)) {
        yield* providers
          .stopSession({ threadId: event.payload.threadId })
          .pipe(Effect.timeout(Duration.seconds(30)));
      }
      const request = event.payload.event as Extract<
        typeof event.payload.event,
        { type: "sandbox.takeover-requested" }
      >;
      yield* engine.dispatch({
        type: "sandbox.takeover.complete",
        commandId: yield* commandId("sandbox-takeover-complete"),
        threadId: event.payload.threadId,
        sessionId: request.sessionId,
        createdAt: yield* nowIso,
      });
      return;
    }
    if (event.type === "sandbox.stopping") {
      desktopGateway.setHumanControl(event.payload.threadId, false);
      const stopping = event.payload.event as Extract<
        typeof event.payload.event,
        { type: "sandbox.stopping" }
      >;
      return yield* stop(event.payload.threadId, stopping.expired);
    }
    if (event.type === "sandbox.worker-spawn-requested") {
      const parent = yield* getThread(event.payload.parentThreadId);
      if (!parent) return;
      const createdAt = yield* nowIso;
      const inheritedPatch = event.payload.inheritedPatch;
      if (inheritedPatch && inheritedPatch.content === undefined) {
        return yield* new SandboxManagerError({
          message: "inherited worker patch metadata did not include patch content",
        });
      }
      if (inheritedPatch?.content !== undefined) {
        const bytes = Buffer.byteLength(inheritedPatch.content);
        const digest = NodeCrypto.createHash("sha256").update(inheritedPatch.content).digest("hex");
        if (bytes !== inheritedPatch.sizeBytes || digest !== inheritedPatch.sha256) {
          return yield* new SandboxManagerError({
            message: "inherited worker patch content failed size or digest validation",
          });
        }
      }
      const snapshot = yield* snapshots.getSnapshot();
      const project = snapshot.projects.find((item) => item.id === parent.projectId);
      if (!project)
        return yield* new SandboxManagerError({
          message: `project '${parent.projectId}' was not found`,
        });
      const projectFile = Option.getOrUndefined(yield* projectFiles.load(project.workspaceRoot));
      const declaration = projectFile?.sandbox;
      const image = resolveSandboxImage(projectFile);
      const previewProxyImage = resolveSandboxPreviewProxyImage();
      if (!image || !previewProxyImage) {
        const disabledAt = yield* nowIso;
        yield* engine
          .dispatch({
            type: "thread.activity.append",
            commandId: yield* commandId("sandbox-disabled-notice"),
            threadId: parent.id,
            createdAt: disabledAt,
            activity: {
              id: EventId.make(yield* crypto.randomUUIDv4),
              tone: "info",
              kind: "sandbox.disabled",
              summary:
                "Skipped spawning an isolated worker thread — sandbox isolation isn't configured on this server.",
              payload: {},
              turnId: null,
              createdAt: disabledAt,
            },
          })
          .pipe(Effect.ignore);
        return;
      }
      const workerConfig = yield* resolvedConfig(event.payload.config ?? {});
      const workerBranch = {
        branchName: event.payload.branchName,
        baseCommit: event.payload.inheritedCommit,
        parentThreadId: event.payload.parentThreadId,
        inheritedCommit: event.payload.inheritedCommit,
        ...(event.payload.inheritedPatch
          ? { inheritedPatchSha256: event.payload.inheritedPatch.sha256 }
          : {}),
      };
      yield* engine.dispatch({
        type: "thread.create",
        commandId: yield* commandId("sandbox-worker-create"),
        threadId: event.payload.childThreadId,
        projectId: parent.projectId,
        title: event.payload.task.slice(0, 120),
        modelSelection: parent.modelSelection,
        routingMode: parent.routingMode,
        efficiencyTier: parent.efficiencyTier,
        runtimeMode: parent.runtimeMode,
        interactionMode: parent.interactionMode,
        branch: null,
        worktreePath: null,
        sandboxConfig: event.payload.config,
        sandboxBranch: workerBranch,
        createdAt,
      });
      yield* dispatchAndAwaitProjection({
        type: "sandbox.provision",
        commandId: yield* commandId("sandbox-worker-provision"),
        threadId: event.payload.childThreadId,
        config: workerConfig,
        branch: workerBranch,
        // Same contract as the manual path above: this handler provisions
        // inline on the next line, so the decider must drive the sandbox to
        // `provisioning` rather than emit `sandbox.provision-requested` --
        // which this very reactor consumes, and would have provisioned the
        // worker a second time.
        provisionsInline: true,
        createdAt,
      });
      const provision = yield* runtimes.provision({
        bootstrap: {
          threadId: event.payload.childThreadId,
          projectId: parent.projectId,
          repositoryUrl: project.repositoryIdentity?.locator.remoteUrl ?? project.workspaceRoot,
          baseCommit: event.payload.inheritedCommit,
          branchName: event.payload.branchName,
          parentThreadId: event.payload.parentThreadId,
          ...(inheritedPatch?.content !== undefined
            ? { inheritedPatch: inheritedPatch.content }
            : {}),
        },
        config: workerConfig,
        image,
        ...(process.env.T3_SANDBOX_EGRESS_PROXY_IMAGE?.trim()
          ? { egressProxyImage: process.env.T3_SANDBOX_EGRESS_PROXY_IMAGE.trim() }
          : {}),
        ...(declaration?.caches ? { caches: declaration.caches } : {}),
        ...(declaration?.setup ? { setup: declaration.setup } : {}),
        ...(declaration?.teardown ? { teardown: declaration.teardown } : {}),
        ...(declaration?.services ? { services: declaration.services } : {}),
        ...(declaration?.previewPorts ? { previewPorts: declaration.previewPorts } : {}),
      });
      yield* reconcileProviderStoreCursor(
        providerSessions,
        event.payload.childThreadId,
        provision.providerStore,
      );
      yield* engine.dispatch({
        type: "sandbox.provision.ready",
        commandId: yield* commandId("sandbox-worker-ready"),
        threadId: event.payload.childThreadId,
        sandboxId: SandboxId.make(provision.sandboxId),
        runtime: provision.runtime,
        runtimeRef: provision.containerName,
        ...(provision.desktopSessionId === undefined
          ? {}
          : { desktopSessionId: provision.desktopSessionId }),
        ...(provision.desktopStreamPath === undefined
          ? {}
          : { desktopStreamPath: provision.desktopStreamPath }),
        createdAt: yield* nowIso,
      });
      const readyChild = yield* getThread(event.payload.childThreadId);
      if (readyChild?.sandbox) {
        const checkedAt = yield* nowIso;
        yield* engine.dispatch({
          type: "sandbox.reconcile.result",
          commandId: yield* commandId("worker-service-health"),
          threadId: event.payload.childThreadId,
          disposition: "matched",
          sandbox: {
            ...readyChild.sandbox,
            services: provision.services.map((service) => ({
              name: service.name,
              status: "healthy" as const,
              ...(service.internalPorts[0] === undefined
                ? {}
                : { internalPort: service.internalPorts[0] }),
              checkedAt,
            })),
          },
          createdAt: checkedAt,
        });
      }
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: yield* commandId("sandbox-worker-run"),
        threadId: event.payload.childThreadId,
        message: {
          messageId: MessageId.make(`worker:${yield* crypto.randomUUIDv4}`),
          role: "user",
          text: event.payload.task,
          attachments: [],
        },
        runtimeMode: parent.runtimeMode,
        interactionMode: parent.interactionMode,
        createdAt,
      });
      return;
    }
    if (event.type === "sandbox.worker-message-requested" && event.payload.message) {
      const child = yield* getThread(event.payload.childThreadId);
      if (!child || child.sandbox?.branch.parentThreadId !== event.payload.parentThreadId) return;
      const id = yield* crypto.randomUUIDv4;
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`server:worker-message:${id}`),
        threadId: child.id,
        message: {
          messageId: MessageId.make(`worker:${id}`),
          role: "user",
          text: event.payload.message,
          attachments: [],
        },
        runtimeMode: child.runtimeMode,
        interactionMode: child.interactionMode,
        createdAt: yield* nowIso,
      });
      return;
    }
    if (event.type === "sandbox.worker-stop-requested") {
      const child = yield* getThread(event.payload.childThreadId);
      if (!child || child.sandbox?.branch.parentThreadId !== event.payload.parentThreadId) return;
      yield* engine.dispatch({
        type: "sandbox.stop",
        commandId: yield* commandId("worker-stop"),
        threadId: child.id,
        createdAt: yield* nowIso,
      });
      return;
    }
    if (event.type === "sandbox.worker-status-requested") {
      const child = yield* getThread(event.payload.childThreadId);
      if (!child || child.sandbox?.branch.parentThreadId !== event.payload.parentThreadId) return;
      const createdAt = yield* nowIso;
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: yield* commandId("worker-status"),
        threadId: event.payload.parentThreadId,
        createdAt,
        activity: {
          id: EventId.make(yield* crypto.randomUUIDv4),
          tone: "info",
          kind: "sandbox.worker.status",
          summary: `Worker ${child.id} is ${child.sandbox.lifecycle}`,
          payload: {
            childThreadId: child.id,
            lifecycle: child.sandbox.lifecycle,
            latestTurn: child.latestTurn,
          },
          turnId: null,
          createdAt,
        },
      });
    }
  });
  /**
   * The operator-facing sentence behind a lifecycle failure.
   *
   * `String(cause)` renders as `Cause([Fail(Error: ...)])`, and the default
   * structured log of a `Cause` object collapses to `{ failures: [ [Object] ] }`
   * -- both hide the one line that says what podman actually refused to do.
   */
  const failureMessage = (cause: Cause.Cause<unknown>): string => {
    const failure = cause.reasons.find(Cause.isFailReason)?.error;
    if (failure instanceof Error && failure.message.trim().length > 0) {
      // `SandboxRuntimeError` carries the runtime's own stderr, and it is the
      // only thing that says WHY -- without it every container failure reads as
      // a bare "podman network failed" and is undiagnosable from logs alone.
      const stderr =
        "stderr" in failure && typeof failure.stderr === "string" ? failure.stderr.trim() : "";
      return stderr.length > 0 ? `${failure.message}: ${stderr}` : failure.message;
    }
    if (typeof failure === "string" && failure.trim().length > 0) return failure;
    return "The sandbox operation failed. Check the server logs for technical details.";
  };

  const worker = yield* makeDrainableWorker((event: SandboxRequestEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const threadId =
            "threadId" in event.payload ? event.payload.threadId : event.payload.childThreadId;
          const occurredAt = yield* nowIso;
          yield* engine
            .dispatch({
              type: "sandbox.operation.fail",
              commandId: yield* commandId("sandbox-lifecycle-failed"),
              threadId,
              failure: {
                stage:
                  event.type === "sandbox.branch-export-requested"
                    ? "export"
                    : event.type === "sandbox.stopping"
                      ? "teardown"
                      : "runtime",
                code: "sandbox_lifecycle_failed",
                message: failureMessage(cause),
                retryable: true,
                occurredAt,
              },
              createdAt: occurredAt,
            })
            .pipe(Effect.ignore);
          yield* Effect.logWarning("sandbox lifecycle event failed", {
            type: event.type,
            threadId,
            cause: Cause.pretty(cause),
          });
        }),
      ),
    ),
  );

  const reconcile = Effect.fn("SandboxLifecycleReactor.reconcile")(function* () {
    const snapshot = yield* snapshots.getSnapshot();
    for (const runtime of ["docker", "podman"] as const) {
      const expectedThreads = snapshot.threads.filter(
        (thread) =>
          thread.sandbox?.runtime === runtime &&
          !["stopped", "expired", "deleted"].includes(thread.sandbox.lifecycle),
      );
      const expected = new Set(expectedThreads.map((thread) => thread.id));
      // Label signatures let the backend adopt containers that survived a
      // server restart (which empties its in-memory records) instead of
      // reporting every one of them missing and failing its thread while the
      // container keeps running. Adoption is for reconcile accounting only;
      // `exec` still requires a record this generation provisioned.
      const adoptionHints = new Map<string, SandboxAdoptionHint>();
      for (const thread of expectedThreads) {
        const hint = yield* adoptionHint(thread).pipe(Effect.orElseSucceed(() => undefined));
        if (hint !== undefined) adoptionHints.set(thread.id, hint);
      }
      const result = yield* runtimes
        .reconcile(runtime, expected, adoptionHints)
        .pipe(Effect.option);
      if (Option.isNone(result)) continue;
      for (const threadId of result.value.activeThreadIds) {
        const thread = snapshot.threads.find((item) => item.id === threadId);
        desktopGateway.setServiceStatus(
          threadId,
          (thread?.sandbox?.services ?? []).map((service) => ({
            name: service.name,
            healthy: service.status === "healthy",
          })),
        );
        const project = snapshot.projects.find((item) => item.id === thread?.projectId);
        const declaration =
          project === undefined
            ? undefined
            : Option.getOrUndefined(yield* projectFiles.load(project.workspaceRoot))?.sandbox;
        if (thread?.sandbox?.runtimeRef && (declaration?.previewPorts?.length ?? 0) > 0) {
          yield* runtimes
            .recoverPreview(
              runtime,
              threadId,
              thread.sandbox.runtimeRef,
              declaration!.previewPorts!,
            )
            .pipe(Effect.ignore);
        }
      }
      // A container that survived a restart and proved its identity, but that
      // this manager generation cannot drive. It is reported as missing too,
      // so the loop below fails its thread and lets it re-provision -- but
      // doing only that leaves the container RUNNING under a `failed`
      // projection: the workload keeps burning the host, the next provision
      // can collide with the surviving sidecars, and its unwind deletes the
      // workspace volume with the user's commits still in it.
      //
      // So it is drained here first, before anything marks the thread failed.
      // Export strictly before stop: the export is what saves the work, and a
      // stop runs the teardown and destroys the volume. A failed export must
      // still be followed by the stop -- leaving the container running is the
      // outcome this exists to prevent -- but it is reported rather than
      // swallowed, because it means the thread is about to re-provision from
      // its previous export or from the base commit.
      for (const threadId of result.value.unresumableThreadIds ?? []) {
        const thread = snapshot.threads.find((item) => item.id === threadId);
        if (thread?.sandbox == null) continue;
        yield* exportBranch(thread.id).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "could not export an unresumable sandbox before stopping it; its uncommitted work is lost",
              { threadId: thread.id, cause: Cause.pretty(cause) },
            ),
          ),
        );
        yield* runtimes
          .stop(
            runtime,
            thread.id,
            yield* adoptionHint(thread).pipe(Effect.orElseSucceed(() => undefined)),
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("could not stop an unresumable sandbox", {
                threadId: thread.id,
                cause: Cause.pretty(cause),
              }),
            ),
          );
      }
      for (const threadId of result.value.missingThreadIds) {
        const thread = snapshot.threads.find((item) => item.id === threadId);
        if (!thread?.sandbox) continue;
        const createdAt = yield* nowIso;
        yield* engine
          .dispatch({
            type: "sandbox.reconcile.result",
            commandId: yield* commandId("sandbox-missing"),
            threadId: thread.id,
            disposition: "missing",
            sandbox: {
              ...thread.sandbox,
              lifecycle: "failed",
              failure: {
                stage: "reconcile",
                code: "sandbox_container_missing",
                message: "Recorded sandbox container was not found during startup reconciliation.",
                retryable: true,
                occurredAt: createdAt,
              },
              lastActiveAt: createdAt,
            },
            createdAt,
          })
          .pipe(Effect.ignore);
      }
    }
  });

  const expire = Effect.fn("SandboxLifecycleReactor.expire")(function* () {
    const snapshot = yield* snapshots.getSnapshot();
    // Piggybacks on the periodic pass rather than owning a timer: exported
    // artifact sets for threads that settled long ago (or were deleted
    // out-of-band) otherwise accumulate forever. Threads whose sandbox is
    // still in a non-terminal lifecycle are protected regardless of age --
    // their next stop overwrites the set, and deleting it early would cost a
    // re-provision its restore seed. Best-effort: a sweep failure must not
    // stall expiry.
    yield* Effect.suspend(() =>
      runtimes.sweepExpiredArtifacts(
        new Set(
          snapshot.threads
            .filter(
              (thread) =>
                thread.sandbox != null &&
                !["stopped", "expired", "deleted"].includes(thread.sandbox.lifecycle),
            )
            .map((thread) => thread.id),
        ),
      ),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("sandbox artifact sweep failed", { cause: Cause.pretty(cause) }),
      ),
    );
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const activeSessions = new Set(
      (yield* providers.listSessions()).map((session) => session.threadId),
    );
    for (const thread of snapshot.threads) {
      const sandbox = thread.sandbox;
      if (!sandbox || !["ready", "paused"].includes(sandbox.lifecycle)) continue;
      const activeAt = activeSessions.has(thread.id) ? yield* nowIso : sandbox.lastActiveAt;
      if (sandbox.runtime === "docker" || sandbox.runtime === "podman") {
        const sampledAt = yield* nowIso;
        const usage = yield* runtimes.sampleUsage(sandbox.runtime, thread.id).pipe(Effect.option);
        if (Option.isSome(usage)) {
          yield* engine
            .dispatch({
              type: "sandbox.reconcile.result",
              commandId: yield* commandId("sandbox-usage"),
              threadId: thread.id,
              disposition: "matched",
              sandbox: { ...sandbox, usage: { ...usage.value, sampledAt }, lastActiveAt: activeAt },
              createdAt: sampledAt,
            })
            .pipe(Effect.ignore);
        }
      }
      const idleAt =
        DateTime.toEpochMillis(DateTime.makeUnsafe(activeAt)) +
        sandbox.limits.idleTimeoutSeconds * 1000;
      const maxAt =
        DateTime.toEpochMillis(DateTime.makeUnsafe(sandbox.createdAt)) +
        sandbox.limits.maximumLifetimeSeconds * 1000;
      const deadline = sandbox.controller.kind === "human" ? maxAt : Math.min(idleAt, maxAt);
      if (now < deadline) continue;
      yield* engine
        .dispatch({
          type: "sandbox.expire",
          commandId: yield* commandId("sandbox-expire"),
          threadId: thread.id,
          createdAt: yield* nowIso,
        })
        .pipe(Effect.ignore);
    }
  });

  const start: SandboxLifecycleReactorShape["start"] = Effect.fn("start")(function* () {
    yield* reconcile().pipe(
      Effect.catchCause((cause) => Effect.logWarning("sandbox reconciliation failed", { cause })),
    );
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        event.type.startsWith("sandbox.") &&
        [
          "sandbox.branch-export-requested",
          "sandbox.provision-requested",
          "sandbox.worker-spawn-requested",
          "sandbox.worker-status-requested",
          "sandbox.worker-message-requested",
          "sandbox.worker-stop-requested",
          "sandbox.stopping",
          "sandbox.takeover-requested",
          "sandbox.takeover-acquired",
          "sandbox.resumed",
        ].includes(event.type)
          ? worker.enqueue(event as SandboxRequestEvent)
          : Effect.void,
      ),
    );
    yield* forkParked(expire().pipe(Effect.repeat(Schedule.spaced(Duration.minutes(1)))));
  });
  return { start, drain: worker.drain } satisfies SandboxLifecycleReactorShape;
});

export const SandboxLifecycleReactorLive = Layer.effect(SandboxLifecycleReactor, make).pipe(
  Layer.provide(T3ProjectFileLoaderLive),
);
