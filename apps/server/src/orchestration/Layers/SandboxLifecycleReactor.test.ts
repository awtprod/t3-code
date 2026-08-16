import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { T3ProjectFileLoader } from "../../project/T3ProjectFileLoader.ts";
import { SandboxRuntimeManager } from "../../sandbox/SandboxRuntimeManager.ts";
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

it.layer(NodeServices.layer)("manual sandbox lifecycle provisioning", (it) => {
  it.effect("resolves immutable provenance and invokes the sandbox runtime", () =>
    Effect.gen(function* () {
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

  it.effect("waits for provisioning projection before recording a missing-image failure", () =>
    Effect.gen(function* () {
      const failed = yield* Deferred.make<void>();
      const events = yield* PubSub.unbounded<OrchestrationEvent>();
      const dispatched: OrchestrationCommand[] = [];
      let projected = false;
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
                if (command.type === "sandbox.provision") {
                  projected = true;
                  yield* PubSub.publish(events, {
                    ...request,
                    sequence: 2,
                    eventId: EventId.make("missing-image-provisioning"),
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
                if (command.type === "sandbox.operation.fail") {
                  expect(projected).toBe(true);
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

      expect(dispatched.map((command) => command.type)).toEqual([
        "sandbox.provision",
        "sandbox.operation.fail",
      ]);
    }),
  );
});
