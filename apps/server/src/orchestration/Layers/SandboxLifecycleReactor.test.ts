import {
  CommandId,
  EventId,
  GitCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import { afterEach } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as Crypto from "effect/Crypto";

import { decideOrchestrationCommand } from "../decider.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { T3ProjectFileLoader } from "../../project/T3ProjectFileLoader.ts";
import { SandboxManagerError, SandboxRuntimeManager } from "../../sandbox/SandboxRuntimeManager.ts";
import type { SandboxRuntimeManagerShape } from "../../sandbox/SandboxRuntimeManager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { SandboxLifecycleReactor } from "../Services/SandboxLifecycleReactor.ts";
import { make } from "./SandboxLifecycleReactor.ts";

const NOW = "2026-08-16T00:00:00.000Z";
const threadId = ThreadId.make("thread-manual");
const projectId = ProjectId.make("project-manual");

const snapshot: OrchestrationReadModel = {
  snapshotSequence: 1,
  projects: [
    {
      id: projectId,
      title: "Project",
      workspaceRoot: "/tmp/manual-sandbox-project",
      defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    },
  ],
  threads: [
    {
      id: threadId,
      projectId,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      sandbox: null,
      latestTurn: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
  updatedAt: NOW,
};

const request: OrchestrationEvent = {
  sequence: 1,
  eventId: EventId.make("manual-request"),
  commandId: CommandId.make("manual-command"),
  aggregateKind: "thread",
  aggregateId: threadId,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "sandbox.provision-requested",
  payload: { threadId, config: { runtime: "podman" } },
  occurredAt: NOW,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

it.layer(NodeServices.layer)("manual sandbox lifecycle provisioning", (it) => {
  it.effect("resolves immutable provenance and invokes the sandbox runtime", () =>
    Effect.gen(function* () {
      vi.stubEnv("T3_SANDBOX_PREVIEW_PROXY_IMAGE", `preview@sha256:${"e".repeat(64)}`);
      const provisioned = yield* Deferred.make<void>();
      const events = yield* PubSub.unbounded<OrchestrationEvent>();
      const dispatched: OrchestrationCommand[] = [];
      const provision = vi.fn((input: Parameters<SandboxRuntimeManagerShape["provision"]>[0]) =>
        Deferred.succeed(provisioned, undefined).pipe(
          Effect.as({
            sandboxId: "sandbox-manual",
            runtime: "podman" as const,
            containerName: "t3-thread-manual",
            desktopSessionId: "desktop-manual",
            desktopStreamPath: "/desktop/manual",
            services: [],
          }),
        ),
      );
      const layer = Layer.effect(SandboxLifecycleReactor, make).pipe(
        Layer.provide(NodeServices.layer),
        Layer.provide(
          Layer.mock(GitWorkflowService)({
            localStatus: () => Effect.succeed({ isRepo: true, refName: "main" } as never),
            resolveRemoteTrackingCommit: () =>
              Effect.succeed({
                commitSha: "0123456789abcdef0123456789abcdef01234567",
                remoteRefName: "origin/main",
              }),
          }),
        ),
        Layer.provide(Layer.mock(ProviderService)({ listSessions: () => Effect.succeed([]) })),
        Layer.provide(
          Layer.succeed(T3ProjectFileLoader, {
            load: () =>
              Effect.succeed(
                Option.some({
                  sandbox: {
                    image:
                      "registry.example/t3-desktop@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  },
                } as never),
              ),
          }),
        ),
        Layer.provide(
          Layer.succeed(SandboxRuntimeManager, {
            sweepExpiredArtifacts: () => Effect.succeed(0),
            provision,
            reconcile: () =>
              Effect.succeed({ activeThreadIds: [], missingThreadIds: [], orphanThreadIds: [] }),
          } as never),
        ),
        Layer.provide(
          Layer.mock(ProjectionSnapshotQuery)({
            getSnapshot: () => Effect.succeed(snapshot),
            getThreadDetailById: (id) =>
              Effect.succeed(id === threadId ? Option.some(snapshot.threads[0]!) : Option.none()),
          }),
        ),
        Layer.provide(
          Layer.mock(OrchestrationEngineService)({
            dispatch: (command) =>
              Effect.gen(function* () {
                dispatched.push(command);
                if (command.type === "sandbox.provision") {
                  yield* PubSub.publish(events, {
                    ...request,
                    sequence: 2,
                    eventId: EventId.make("manual-provisioning"),
                    commandId: command.commandId,
                    type: "sandbox.provisioning-started",
                    payload: {
                      threadId,
                      event: { type: "sandbox.provisioning-started", threadId, occurredAt: NOW },
                      sandbox: {
                        lifecycle: "provisioning",
                        runtime: "podman",
                        branch: command.branch!,
                        limits: {
                          cpuCount: 2,
                          memoryBytes: 4_294_967_296,
                          diskBytes: 21_474_836_480,
                          processCount: 512,
                          idleTimeoutSeconds: 3600,
                          maximumLifetimeSeconds: 28_800,
                        },
                        desktop: {
                          status: "starting",
                          resolution: { width: 1440, height: 900, webRtcEnabled: true },
                        },
                        services: [],
                        controller: { kind: "none" },
                        createdAt: NOW,
                        lastActiveAt: NOW,
                      },
                    },
                  });
                }
                return { sequence: dispatched.length };
              }),
            streamDomainEvents: Stream.concat(Stream.make(request), Stream.fromPubSub(events)),
          }),
        ),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const reactor = yield* SandboxLifecycleReactor;
          yield* reactor.start();
          yield* Deferred.await(provisioned);
          yield* reactor.drain;
        }).pipe(Effect.provide(layer)),
      );

      expect(provision).toHaveBeenCalledTimes(1);
      expect(provision.mock.calls[0]?.[0]).toMatchObject({
        bootstrap: {
          threadId,
          projectId,
          baseCommit: "0123456789abcdef0123456789abcdef01234567",
          branchName: `t3/thread/${threadId}`,
        },
        config: { runtime: "podman" },
      });
      expect(dispatched.map((command) => command.type)).toEqual([
        "sandbox.provision",
        "sandbox.provision.ready",
      ]);
    }),
  );

  it.effect(
    "disables sandboxing and notifies the thread instead of failing when no image is configured",
    () =>
      Effect.gen(function* () {
        const notified = yield* Deferred.make<void>();
        const events = yield* PubSub.unbounded<OrchestrationEvent>();
        const dispatched: OrchestrationCommand[] = [];
        const layer = Layer.effect(SandboxLifecycleReactor, make).pipe(
          Layer.provide(NodeServices.layer),
          Layer.provide(
            Layer.mock(GitWorkflowService)({
              localStatus: () => Effect.succeed({ isRepo: true, refName: "main" } as never),
              resolveRemoteTrackingCommit: () =>
                Effect.succeed({
                  commitSha: "0123456789abcdef0123456789abcdef01234567",
                  remoteRefName: "origin/main",
                }),
            }),
          ),
          Layer.provide(Layer.mock(ProviderService)({ listSessions: () => Effect.succeed([]) })),
          Layer.provide(
            Layer.succeed(T3ProjectFileLoader, { load: () => Effect.succeed(Option.none()) }),
          ),
          Layer.provide(
            Layer.succeed(SandboxRuntimeManager, {
              sweepExpiredArtifacts: () => Effect.succeed(0),
              provision: () => Effect.die("runtime must not run without an image"),
              reconcile: () =>
                Effect.succeed({ activeThreadIds: [], missingThreadIds: [], orphanThreadIds: [] }),
            } as never),
          ),
          Layer.provide(
            Layer.mock(ProjectionSnapshotQuery)({
              getSnapshot: () => Effect.succeed(snapshot),
              getThreadDetailById: (id) =>
                Effect.succeed(id === threadId ? Option.some(snapshot.threads[0]!) : Option.none()),
            }),
          ),
          Layer.provide(
            Layer.mock(OrchestrationEngineService)({
              dispatch: (command) =>
                Effect.gen(function* () {
                  dispatched.push(command);
                  if (command.type === "thread.activity.append") {
                    yield* Deferred.succeed(notified, undefined);
                  }
                  return { sequence: dispatched.length };
                }),
              streamDomainEvents: Stream.concat(Stream.make(request), Stream.fromPubSub(events)),
            }),
          ),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const reactor = yield* SandboxLifecycleReactor;
            yield* reactor.start();
            yield* Deferred.await(notified).pipe(Effect.timeout("5 seconds"));
            yield* reactor.drain;
          }).pipe(Effect.provide(layer)),
        );

        expect(dispatched.map((command) => command.type)).toEqual(["thread.activity.append"]);
        const notice = dispatched[0];
        if (notice?.type !== "thread.activity.append") throw new Error("expected notice command");
        expect(notice.activity.kind).toBe("sandbox.disabled");
      }),
  );

  it.effect("carries the archived store digest onto the export result", () =>
    Effect.gen(function* () {
      // The digest is what a later re-provision checks the archive against and
      // what tells the provider reactor the resume cursor is still good, so it
      // has to survive the hop from the runtime manager onto the command --
      // dropping it here would silently downgrade every restore to a cold start.
      const exported = yield* Deferred.make<void>();
      const dispatched: OrchestrationCommand[] = [];
      const sandboxThread = {
        ...snapshot.threads[0]!,
        sandbox: {
          lifecycle: "ready" as const,
          runtime: "podman" as const,
          branch: { branchName: `t3/thread/${threadId}`, baseCommit: "a".repeat(40) },
          limits: {
            cpuCount: 2,
            memoryBytes: 4_294_967_296,
            diskBytes: 21_474_836_480,
            processCount: 512,
            idleTimeoutSeconds: 3600,
            maximumLifetimeSeconds: 28_800,
          },
          desktop: { status: "unavailable" as const },
          services: [],
          controller: { kind: "none" as const },
          createdAt: NOW,
          lastActiveAt: NOW,
        },
      };
      const exportRequest: OrchestrationEvent = {
        ...request,
        eventId: EventId.make("manual-export-request"),
        type: "sandbox.branch-export-requested",
        payload: { threadId },
      };
      const layer = Layer.effect(SandboxLifecycleReactor, make).pipe(
        Layer.provide(NodeServices.layer),
        Layer.provide(
          Layer.mock(GitWorkflowService)({
            localStatus: () => Effect.succeed({ isRepo: true, refName: "main" } as never),
          }),
        ),
        Layer.provide(Layer.mock(ProviderService)({ listSessions: () => Effect.succeed([]) })),
        Layer.provide(
          Layer.succeed(T3ProjectFileLoader, { load: () => Effect.succeed(Option.none()) }),
        ),
        Layer.provide(
          Layer.succeed(SandboxRuntimeManager, {
            sweepExpiredArtifacts: () => Effect.succeed(0),
            exportBranch: () =>
              Effect.succeed({
                commit: "b".repeat(40),
                patch: "",
                artifactId: "c".repeat(64),
                bundleSha256: "d".repeat(64),
                storeSha256: "e".repeat(64),
              }),
          } as never),
        ),
        Layer.provide(
          Layer.mock(ProjectionSnapshotQuery)({
            getSnapshot: () => Effect.succeed(snapshot),
            getThreadDetailById: (id) =>
              Effect.succeed(id === threadId ? Option.some(sandboxThread) : Option.none()),
          }),
        ),
        Layer.provide(
          Layer.mock(OrchestrationEngineService)({
            dispatch: (command) =>
              Effect.gen(function* () {
                dispatched.push(command);
                if (command.type === "sandbox.branch-export.result")
                  yield* Deferred.succeed(exported, undefined);
                return { sequence: dispatched.length };
              }),
            streamDomainEvents: Stream.make(exportRequest),
          }),
        ),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const reactor = yield* SandboxLifecycleReactor;
          yield* reactor.start();
          yield* Deferred.await(exported).pipe(Effect.timeout("5 seconds"));
          yield* reactor.drain;
        }).pipe(Effect.provide(layer)),
      );

      const result = dispatched.find((command) => command.type === "sandbox.branch-export.result");
      if (result?.type !== "sandbox.branch-export.result")
        throw new Error("expected an export result command");
      expect(result.storeSha256).toBe("e".repeat(64));
      expect(result.bundleSha256).toBe("d".repeat(64));
    }),
  );

  it.effect("completes a stop even when the sandbox never recorded a runtime", () =>
    Effect.gen(function* () {
      // The decider accepts `sandbox.stop` from every non-terminal lifecycle --
      // including `unprovisioned` and `failed`, which never recorded a runtime
      // -- and moves the thread to `stopping` unconditionally. The reactor
      // used to return early for those threads without dispatching
      // `sandbox.stop.complete`, wedging them in `stopping` forever, where
      // every `thread.turn.start` is rejected.
      const completed = yield* Deferred.make<void>();
      const dispatched: OrchestrationCommand[] = [];
      const unprovisionedStopping = {
        ...snapshot.threads[0]!,
        sandbox: {
          lifecycle: "stopping" as const,
          branch: { branchName: `t3/thread/${threadId}`, baseCommit: "a".repeat(40) },
          limits: {
            cpuCount: 2,
            memoryBytes: 4_294_967_296,
            diskBytes: 21_474_836_480,
            processCount: 512,
            idleTimeoutSeconds: 3600,
            maximumLifetimeSeconds: 28_800,
          },
          desktop: { status: "unavailable" as const },
          services: [],
          controller: { kind: "none" as const },
          createdAt: NOW,
          lastActiveAt: NOW,
        },
      };
      const stoppingEvent: OrchestrationEvent = {
        ...request,
        eventId: EventId.make("stop-unprovisioned"),
        type: "sandbox.stopping",
        payload: {
          threadId,
          event: { type: "sandbox.stopping", threadId, occurredAt: NOW, expired: false },
          sandbox: unprovisionedStopping.sandbox,
        },
      };
      const layer = Layer.effect(SandboxLifecycleReactor, make).pipe(
        Layer.provide(NodeServices.layer),
        Layer.provide(
          Layer.mock(GitWorkflowService)({
            localStatus: () => Effect.succeed({ isRepo: true, refName: "main" } as never),
          }),
        ),
        Layer.provide(Layer.mock(ProviderService)({ listSessions: () => Effect.succeed([]) })),
        Layer.provide(
          Layer.succeed(T3ProjectFileLoader, { load: () => Effect.succeed(Option.none()) }),
        ),
        Layer.provide(
          Layer.succeed(SandboxRuntimeManager, {
            sweepExpiredArtifacts: () => Effect.succeed(0),
            stop: () => Effect.die("no container exists for an unprovisioned sandbox"),
            exportBranch: () => Effect.die("nothing to export without a container"),
          } as never),
        ),
        Layer.provide(
          Layer.mock(ProjectionSnapshotQuery)({
            getSnapshot: () => Effect.succeed(snapshot),
            getThreadDetailById: (id) =>
              Effect.succeed(id === threadId ? Option.some(unprovisionedStopping) : Option.none()),
          }),
        ),
        Layer.provide(
          Layer.mock(OrchestrationEngineService)({
            dispatch: (command) =>
              Effect.gen(function* () {
                dispatched.push(command);
                if (command.type === "sandbox.stop.complete")
                  yield* Deferred.succeed(completed, undefined);
                return { sequence: dispatched.length };
              }),
            streamDomainEvents: Stream.make(stoppingEvent),
          }),
        ),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const reactor = yield* SandboxLifecycleReactor;
          yield* reactor.start();
          yield* Deferred.await(completed).pipe(Effect.timeout("5 seconds"));
          yield* reactor.drain;
        }).pipe(Effect.provide(layer)),
      );

      const complete = dispatched.find((command) => command.type === "sandbox.stop.complete");
      if (complete?.type !== "sandbox.stop.complete")
        throw new Error("expected a stop completion command");
      expect(complete.threadId).toBe(threadId);
      expect(complete.expired).toBe(false);
      // Nothing was torn down and nothing failed: completion is the only
      // lifecycle command this stop produces.
      expect(dispatched.map((command) => command.type)).toEqual(["sandbox.stop.complete"]);
    }),
  );

  it.effect("fails the stop instead of wedging when container teardown throws", () =>
    Effect.gen(function* () {
      // `runtimes.stop` failing used to propagate out of the reactor with the
      // provider session already stopped and no completion dispatched -- the
      // decider stayed in `stopping` with nothing left to move it. The worker
      // converts the failure into `sandbox.operation.fail` (stage `teardown`,
      // carrying the runtime's own message), which the decider accepts from
      // `stopping` and resolves to `failed` -- a re-provisionable state.
      const failed = yield* Deferred.make<void>();
      const dispatched: OrchestrationCommand[] = [];
      const stoppingThread = {
        ...snapshot.threads[0]!,
        sandbox: {
          lifecycle: "stopping" as const,
          runtime: "podman" as const,
          branch: { branchName: `t3/thread/${threadId}`, baseCommit: "a".repeat(40) },
          limits: {
            cpuCount: 2,
            memoryBytes: 4_294_967_296,
            diskBytes: 21_474_836_480,
            processCount: 512,
            idleTimeoutSeconds: 3600,
            maximumLifetimeSeconds: 28_800,
          },
          desktop: { status: "unavailable" as const },
          services: [],
          controller: { kind: "none" as const },
          createdAt: NOW,
          lastActiveAt: NOW,
        },
      };
      const stoppingEvent: OrchestrationEvent = {
        ...request,
        eventId: EventId.make("stop-teardown-failure"),
        type: "sandbox.stopping",
        payload: {
          threadId,
          event: { type: "sandbox.stopping", threadId, occurredAt: NOW, expired: false },
          sandbox: stoppingThread.sandbox,
        },
      };
      const layer = Layer.effect(SandboxLifecycleReactor, make).pipe(
        Layer.provide(NodeServices.layer),
        Layer.provide(
          Layer.mock(GitWorkflowService)({
            localStatus: () => Effect.succeed({ isRepo: true, refName: "main" } as never),
          }),
        ),
        Layer.provide(Layer.mock(ProviderService)({ listSessions: () => Effect.succeed([]) })),
        Layer.provide(
          Layer.succeed(T3ProjectFileLoader, { load: () => Effect.succeed(Option.none()) }),
        ),
        Layer.provide(
          Layer.succeed(SandboxRuntimeManager, {
            sweepExpiredArtifacts: () => Effect.succeed(0),
            exportBranch: () =>
              Effect.succeed({
                commit: "b".repeat(40),
                patch: "",
                artifactId: "c".repeat(64),
                bundleSha256: "d".repeat(64),
              }),
            stop: () =>
              Effect.fail(
                new SandboxManagerError({
                  message: "podman rm failed: container is in use by another process",
                }),
              ),
          } as never),
        ),
        Layer.provide(
          Layer.mock(ProjectionSnapshotQuery)({
            getSnapshot: () => Effect.succeed(snapshot),
            getThreadDetailById: (id) =>
              Effect.succeed(id === threadId ? Option.some(stoppingThread) : Option.none()),
          }),
        ),
        Layer.provide(
          Layer.mock(OrchestrationEngineService)({
            dispatch: (command) =>
              Effect.gen(function* () {
                dispatched.push(command);
                if (command.type === "sandbox.operation.fail")
                  yield* Deferred.succeed(failed, undefined);
                return { sequence: dispatched.length };
              }),
            streamDomainEvents: Stream.make(stoppingEvent),
          }),
        ),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const reactor = yield* SandboxLifecycleReactor;
          yield* reactor.start();
          yield* Deferred.await(failed).pipe(Effect.timeout("5 seconds"));
          yield* reactor.drain;
        }).pipe(Effect.provide(layer)),
      );

      const failure = dispatched.find((command) => command.type === "sandbox.operation.fail");
      if (failure?.type !== "sandbox.operation.fail") throw new Error("expected failure command");
      expect(failure.failure.stage).toBe("teardown");
      // The real runtime error, not a swallowed or re-wrapped one.
      expect(failure.failure.message).toBe(
        "podman rm failed: container is in use by another process",
      );
      // A completion after the failure would fail the decider's `stopping`
      // guard (the failure already moved the sandbox to `failed`); the export
      // that ran before the teardown attempt is recorded as usual.
      expect(dispatched.map((command) => command.type)).toEqual([
        "sandbox.branch-export.result",
        "sandbox.operation.fail",
      ]);
    }),
  );

  it.effect("reports the underlying runtime error when a lifecycle event fails", () =>
    Effect.gen(function* () {
      // `String(cause)` renders an Effect Cause as `Cause([Fail(Error: ...)])`,
      // which is what the thread's failure notice used to carry -- the operator
      // saw the wrapper, not the sentence naming what the runtime refused.
      vi.stubEnv("T3_SANDBOX_PREVIEW_PROXY_IMAGE", `preview@sha256:${"e".repeat(64)}`);
      const failed = yield* Deferred.make<void>();
      const events = yield* PubSub.unbounded<OrchestrationEvent>();
      const dispatched: OrchestrationCommand[] = [];
      const layer = Layer.effect(SandboxLifecycleReactor, make).pipe(
        Layer.provide(NodeServices.layer),
        Layer.provide(
          Layer.mock(GitWorkflowService)({
            localStatus: () => Effect.succeed({ isRepo: true, refName: "main" } as never),
            resolveRemoteTrackingCommit: () =>
              Effect.fail(
                new GitCommandError({
                  operation: "resolveRemoteTrackingCommit",
                  command: "git",
                  cwd: "/tmp/project",
                  detail: "git rev-parse failed: no upstream for 'main'",
                }),
              ),
          }),
        ),
        Layer.provide(Layer.mock(ProviderService)({ listSessions: () => Effect.succeed([]) })),
        Layer.provide(
          Layer.succeed(T3ProjectFileLoader, {
            load: () =>
              Effect.succeed(
                Option.some({
                  sandbox: {
                    image:
                      "registry.example/t3-desktop@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  },
                } as never),
              ),
          }),
        ),
        Layer.provide(
          Layer.succeed(SandboxRuntimeManager, {
            sweepExpiredArtifacts: () => Effect.succeed(0),
            provision: () => Effect.die("provisioning is not reached on this path"),
            reconcile: () =>
              Effect.succeed({ activeThreadIds: [], missingThreadIds: [], orphanThreadIds: [] }),
          } as never),
        ),
        Layer.provide(
          Layer.mock(ProjectionSnapshotQuery)({
            getSnapshot: () => Effect.succeed(snapshot),
            getThreadDetailById: (id) =>
              Effect.succeed(id === threadId ? Option.some(snapshot.threads[0]!) : Option.none()),
          }),
        ),
        Layer.provide(
          Layer.mock(OrchestrationEngineService)({
            dispatch: (command) =>
              Effect.gen(function* () {
                dispatched.push(command);
                if (command.type === "sandbox.operation.fail") {
                  yield* Deferred.succeed(failed, undefined);
                }
                return { sequence: dispatched.length };
              }),
            streamDomainEvents: Stream.concat(Stream.make(request), Stream.fromPubSub(events)),
          }),
        ),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const reactor = yield* SandboxLifecycleReactor;
          yield* reactor.start();
          yield* Deferred.await(failed).pipe(Effect.timeout("5 seconds"));
          yield* reactor.drain;
        }).pipe(Effect.provide(layer)),
      );

      const failure = dispatched.find((command) => command.type === "sandbox.operation.fail");
      if (failure?.type !== "sandbox.operation.fail") throw new Error("expected failure command");
      expect(failure.failure.message).toBe(
        "Git command failed in resolveRemoteTrackingCommit (/tmp/project): git rev-parse failed: no upstream for 'main'",
      );
    }),
  );

  it.effect("tears down the container of a deleted thread's stop", () =>
    Effect.gen(function* () {
      // The thread-detail query hides deleted threads (`deleted_at IS NULL`),
      // but their sandbox projection -- and the running container -- survive.
      // A deletion-triggered `sandbox.stopping` must fall back to the full
      // snapshot, tear the container down, skip the branch export (transcripts
      // must not outlive the thread), and complete the stop.
      const completed = yield* Deferred.make<void>();
      const dispatched: OrchestrationCommand[] = [];
      const stopped: Array<string> = [];
      const deletedThread = {
        ...snapshot.threads[0]!,
        deletedAt: NOW,
        sandbox: {
          lifecycle: "stopping" as const,
          runtime: "podman" as const,
          branch: { branchName: `t3/thread/${threadId}`, baseCommit: "a".repeat(40) },
          limits: {
            cpuCount: 2,
            memoryBytes: 4_294_967_296,
            diskBytes: 21_474_836_480,
            processCount: 512,
            idleTimeoutSeconds: 3600,
            maximumLifetimeSeconds: 28_800,
          },
          desktop: { status: "unavailable" as const },
          services: [],
          controller: { kind: "none" as const },
          createdAt: NOW,
          lastActiveAt: NOW,
        },
      };
      const stoppingEvent: OrchestrationEvent = {
        ...request,
        eventId: EventId.make("stop-deleted-thread"),
        type: "sandbox.stopping",
        payload: {
          threadId,
          event: { type: "sandbox.stopping", threadId, occurredAt: NOW, expired: false },
          sandbox: deletedThread.sandbox,
        },
      };
      const layer = Layer.effect(SandboxLifecycleReactor, make).pipe(
        Layer.provide(NodeServices.layer),
        Layer.provide(
          Layer.mock(GitWorkflowService)({
            localStatus: () => Effect.succeed({ isRepo: true, refName: "main" } as never),
          }),
        ),
        Layer.provide(Layer.mock(ProviderService)({ listSessions: () => Effect.succeed([]) })),
        Layer.provide(
          Layer.succeed(T3ProjectFileLoader, { load: () => Effect.succeed(Option.none()) }),
        ),
        Layer.provide(
          Layer.succeed(SandboxRuntimeManager, {
            sweepExpiredArtifacts: () => Effect.succeed(0),
            stop: (_runtime: string, id: string) =>
              Effect.sync(() => {
                stopped.push(id);
              }),
            exportBranch: () => Effect.die("a deleted thread's transcripts must not be exported"),
          } as never),
        ),
        Layer.provide(
          Layer.mock(ProjectionSnapshotQuery)({
            getSnapshot: () =>
              Effect.succeed({ ...snapshot, threads: [deletedThread] } as typeof snapshot),
            // The detail query behaves exactly as production does for a
            // deleted thread: not found.
            getThreadDetailById: () => Effect.succeed(Option.none()),
          }),
        ),
        Layer.provide(
          Layer.mock(OrchestrationEngineService)({
            dispatch: (command) =>
              Effect.gen(function* () {
                dispatched.push(command);
                if (command.type === "sandbox.stop.complete")
                  yield* Deferred.succeed(completed, undefined);
                return { sequence: dispatched.length };
              }),
            streamDomainEvents: Stream.make(stoppingEvent),
          }),
        ),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const reactor = yield* SandboxLifecycleReactor;
          yield* reactor.start();
          yield* Deferred.await(completed).pipe(Effect.timeout("5 seconds"));
          yield* reactor.drain;
        }).pipe(Effect.provide(layer)),
      );

      // The container was actually stopped, not skipped as "no thread".
      expect(stopped).toEqual([threadId]);
      // No export result: only the completion.
      expect(dispatched.map((command) => command.type)).toEqual(["sandbox.stop.complete"]);
    }),
  );

  it.effect(
    "the periodic pass sweeps expired artifacts, shields active threads, and survives a sweep failure",
    () =>
      Effect.gen(function* () {
        // The sweep rides the same periodic pass as expiry. Threads whose
        // sandbox is in a non-terminal lifecycle must arrive in the protected
        // set (their artifact set may seed a re-provision), terminal ones must
        // not -- and a failing sweep must not stall the rest of the pass.
        const swept = yield* Deferred.make<ReadonlySet<string>>();
        const continued = yield* Deferred.make<void>();
        const dispatched: OrchestrationCommand[] = [];
        const OLD = "2026-08-15T00:00:00.000Z";
        const sandboxOf = (lifecycle: "ready" | "stopped") => ({
          lifecycle,
          runtime: "podman" as const,
          branch: { branchName: "t3/thread/x", baseCommit: "a".repeat(40) },
          limits: {
            cpuCount: 2,
            memoryBytes: 4_294_967_296,
            diskBytes: 21_474_836_480,
            processCount: 512,
            idleTimeoutSeconds: 60,
            maximumLifetimeSeconds: 60,
          },
          desktop: { status: "unavailable" as const },
          services: [],
          controller: { kind: "none" as const },
          createdAt: OLD,
          lastActiveAt: OLD,
        });
        const activeThread = { ...snapshot.threads[0]!, sandbox: sandboxOf("ready") };
        const stoppedThread = {
          ...snapshot.threads[0]!,
          id: ThreadId.make("thread-stopped"),
          sandbox: sandboxOf("stopped"),
        };
        const layer = Layer.effect(SandboxLifecycleReactor, make).pipe(
          Layer.provide(NodeServices.layer),
          Layer.provide(
            Layer.mock(GitWorkflowService)({
              localStatus: () => Effect.succeed({ isRepo: true, refName: "main" } as never),
            }),
          ),
          Layer.provide(Layer.mock(ProviderService)({ listSessions: () => Effect.succeed([]) })),
          Layer.provide(
            Layer.succeed(T3ProjectFileLoader, { load: () => Effect.succeed(Option.none()) }),
          ),
          Layer.provide(
            Layer.succeed(SandboxRuntimeManager, {
              sweepExpiredArtifacts: (protectedThreadIds: ReadonlySet<string>) =>
                Deferred.succeed(swept, protectedThreadIds).pipe(
                  Effect.andThen(
                    Effect.fail(new SandboxManagerError({ message: "artifact directory io" })),
                  ),
                ),
              // Called for every ready/paused thread right after the sweep --
              // reaching it proves the sweep failure was contained.
              sampleUsage: () =>
                Deferred.succeed(continued, undefined).pipe(
                  Effect.andThen(Effect.fail(new SandboxManagerError({ message: "no container" }))),
                ),
              reconcile: () =>
                Effect.succeed({ activeThreadIds: [], missingThreadIds: [], orphanThreadIds: [] }),
            } as never),
          ),
          Layer.provide(
            Layer.mock(ProjectionSnapshotQuery)({
              getSnapshot: () =>
                Effect.succeed({
                  ...snapshot,
                  threads: [activeThread, stoppedThread],
                } as typeof snapshot),
              getThreadDetailById: () => Effect.succeed(Option.none()),
            }),
          ),
          Layer.provide(
            Layer.mock(OrchestrationEngineService)({
              dispatch: (command) =>
                Effect.gen(function* () {
                  dispatched.push(command);
                  return { sequence: dispatched.length };
                }),
              streamDomainEvents: Stream.empty,
            }),
          ),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const reactor = yield* SandboxLifecycleReactor;
            yield* reactor.start();
            const protectedIds = yield* Deferred.await(swept).pipe(Effect.timeout("5 seconds"));
            // The ready thread is shielded; the stopped one is fair game.
            expect([...protectedIds]).toEqual([threadId]);
            // The pass reached per-thread work after the sweep failed: the
            // failure was logged and contained, not propagated.
            yield* Deferred.await(continued).pipe(Effect.timeout("5 seconds"));
            yield* reactor.drain;
          }).pipe(Effect.provide(layer)),
        );
      }),
  );

  it.effect("provisions a spawned worker exactly once, through the inline path", () =>
    Effect.gen(function* () {
      // The worker spawn dispatched `sandbox.provision` without a branch and
      // without `provisionsInline`, then provisioned inline anyway. The decider
      // read that as a request rather than an inline claim: it emitted
      // `sandbox.provision-requested` -- which THIS reactor consumes -- so the
      // worker was provisioned a second time, and the inline
      // `sandbox.provision.ready` that followed was rejected because the
      // sandbox had never entered `provisioning`. The dispatch runs through the
      // real decider here so the assertion is about the event actually emitted,
      // not about the fields the reactor happens to set.
      vi.stubEnv("T3_SANDBOX_PREVIEW_PROXY_IMAGE", `preview@sha256:${"e".repeat(64)}`);
      const childThreadId = ThreadId.make("thread-worker");
      const inheritedCommit = "1".repeat(40);
      const ran = yield* Deferred.make<void>();
      const events = yield* PubSub.unbounded<OrchestrationEvent>();
      const dispatched: OrchestrationCommand[] = [];
      const decidedTypes: string[] = [];
      const crypto = yield* Crypto.Crypto;
      const childThread = {
        ...snapshot.threads[0]!,
        id: childThreadId,
        title: "Worker",
        sandbox: null,
      };
      const workerReadModel: OrchestrationReadModel = {
        ...snapshot,
        threads: [snapshot.threads[0]!, childThread],
      };
      const provision = vi.fn((_input: Parameters<SandboxRuntimeManagerShape["provision"]>[0]) =>
        Effect.succeed({
          sandboxId: "sandbox-worker",
          runtime: "podman" as const,
          containerName: "t3-thread-worker",
          services: [],
        }),
      );
      const spawnRequest: OrchestrationEvent = {
        ...request,
        eventId: EventId.make("worker-spawn-request"),
        type: "sandbox.worker-spawn-requested",
        payload: {
          parentThreadId: threadId,
          childThreadId,
          task: "ship the worker",
          inheritedCommit,
          config: { runtime: "podman" },
          branchName: `t3/thread/${childThreadId}`,
        },
      };
      const layer = Layer.effect(SandboxLifecycleReactor, make).pipe(
        Layer.provide(NodeServices.layer),
        Layer.provide(
          Layer.mock(GitWorkflowService)({
            localStatus: () => Effect.succeed({ isRepo: true, refName: "main" } as never),
            resolveRemoteTrackingCommit: () =>
              Effect.succeed({
                commitSha: "0123456789abcdef0123456789abcdef01234567",
                remoteRefName: "origin/main",
              }),
          }),
        ),
        Layer.provide(Layer.mock(ProviderService)({ listSessions: () => Effect.succeed([]) })),
        Layer.provide(
          Layer.succeed(T3ProjectFileLoader, {
            load: () =>
              Effect.succeed(
                Option.some({
                  sandbox: {
                    image: `registry.example/t3-desktop@sha256:${"a".repeat(64)}`,
                  },
                } as never),
              ),
          }),
        ),
        Layer.provide(
          Layer.succeed(SandboxRuntimeManager, {
            sweepExpiredArtifacts: () => Effect.succeed(0),
            provision,
            reconcile: () =>
              Effect.succeed({ activeThreadIds: [], missingThreadIds: [], orphanThreadIds: [] }),
          } as never),
        ),
        Layer.provide(
          Layer.mock(ProjectionSnapshotQuery)({
            getSnapshot: () => Effect.succeed(workerReadModel),
            getThreadDetailById: (id) =>
              Effect.succeed(
                id === threadId
                  ? Option.some(snapshot.threads[0]!)
                  : id === childThreadId
                    ? Option.some(childThread)
                    : Option.none(),
              ),
          }),
        ),
        Layer.provide(
          Layer.mock(OrchestrationEngineService)({
            dispatch: (command) =>
              Effect.gen(function* () {
                dispatched.push(command);
                if (command.type === "thread.turn.start") yield* Deferred.succeed(ran, undefined);
                if (command.type !== "sandbox.provision") return { sequence: dispatched.length };
                // Run the real decider so the emitted event -- and the reactor's
                // reaction to it -- is the thing under test.
                const decided = yield* decideOrchestrationCommand({
                  readModel: workerReadModel,
                  command,
                }).pipe(Effect.provideService(Crypto.Crypto, crypto), Effect.orDie);
                for (const base of Array.isArray(decided) ? decided : [decided]) {
                  decidedTypes.push(base.type);
                  yield* PubSub.publish(events, {
                    ...base,
                    sequence: dispatched.length,
                  } as OrchestrationEvent);
                }
                return { sequence: dispatched.length };
              }),
            streamDomainEvents: Stream.concat(Stream.make(spawnRequest), Stream.fromPubSub(events)),
          }),
        ),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const reactor = yield* SandboxLifecycleReactor;
          yield* reactor.start();
          yield* Deferred.await(ran).pipe(Effect.timeout("10 seconds"));
          yield* reactor.drain;
        }).pipe(Effect.provide(layer)),
      );

      // The inline path, not the request path: `sandbox.provision-requested`
      // here is what re-enters this reactor and provisions a second container.
      expect(decidedTypes).toEqual(["sandbox.provisioning-started"]);
      expect(provision).toHaveBeenCalledTimes(1);
      expect(dispatched.filter((command) => command.type === "sandbox.provision")).toHaveLength(1);
      const provisionCommand = dispatched.find((command) => command.type === "sandbox.provision");
      if (provisionCommand?.type !== "sandbox.provision")
        throw new Error("expected a provision command");
      expect(provisionCommand.provisionsInline).toBe(true);
      expect(provisionCommand.branch).toMatchObject({
        branchName: `t3/thread/${childThreadId}`,
        baseCommit: inheritedCommit,
        parentThreadId: threadId,
      });
      // The inline readiness is accepted rather than rejected for "sandbox is
      // not provisioning", so the worker reaches a running turn.
      expect(dispatched.map((command) => command.type)).toContain("sandbox.provision.ready");
    }),
  );
});
