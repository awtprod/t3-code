import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { ClientOrchestrationCommand } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-08-15T12:00:00.000Z";
const BRANCH = {
  branchName: "t3/thread-1",
  baseCommit: "0123456789abcdef0123456789abcdef01234567",
};

function readModel(
  sandbox: OrchestrationReadModel["threads"][number]["sandbox"] = null,
): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        sandbox,
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
}

it.layer(NodeServices.layer)("sandbox decider", (it) => {
  it.effect("lazily provisions a historical thread with no sandbox state", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        readModel: readModel(),
        command: {
          type: "sandbox.provision",
          commandId: CommandId.make("provision"),
          threadId: ThreadId.make("thread-1"),
          branch: BRANCH,
          provisionsInline: true,
          createdAt: NOW,
        },
      });
      expect(Array.isArray(event)).toBe(false);
      const provisioned = event as Omit<
        Extract<OrchestrationEvent, { type: "sandbox.provisioning-started" }>,
        "sequence"
      >;
      expect(provisioned.type).toBe("sandbox.provisioning-started");
      expect(provisioned.payload.sandbox.lifecycle).toBe("provisioning");
      expect(provisioned.payload.sandbox.branch).toEqual(BRANCH);
      expect(provisioned.payload.sandbox.limits.cpuCount).toBe(2);
    }),
  );

  it.effect("durably requests provenance resolution for manual provisioning", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        readModel: readModel(),
        command: {
          type: "sandbox.provision",
          commandId: CommandId.make("manual-provision"),
          threadId: ThreadId.make("thread-1"),
          config: { runtime: "podman" },
          createdAt: NOW,
        },
      });
      expect(Array.isArray(event)).toBe(false);
      const requested = event as Omit<
        Extract<OrchestrationEvent, { type: "sandbox.provision-requested" }>,
        "sequence"
      >;
      expect(requested.type).toBe("sandbox.provision-requested");
      expect(requested.payload).toEqual({
        threadId: ThreadId.make("thread-1"),
        config: { runtime: "podman" },
      });
    }),
  );

  it.effect("rejects simultaneous human takeover leases", () => {
    const sandbox = {
      lifecycle: "paused" as const,
      branch: BRANCH,
      limits: {
        cpuCount: 2,
        memoryBytes: 4_294_967_296,
        diskBytes: 21_474_836_480,
        processCount: 512,
        idleTimeoutSeconds: 3600,
        maximumLifetimeSeconds: 28800,
      },
      desktop: { status: "ready" as const },
      services: [],
      controller: {
        kind: "human" as const,
        leaseId: "first",
        sessionId: "viewer-1",
        acquiredAt: NOW,
      },
      pauseReason: "human-takeover" as const,
      createdAt: NOW,
      lastActiveAt: NOW,
    };
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decideOrchestrationCommand({
          readModel: readModel(sandbox),
          command: {
            type: "sandbox.takeover",
            commandId: CommandId.make("second"),
            threadId: ThreadId.make("thread-1"),
            sessionId: "viewer-2",
            createdAt: NOW,
          },
        }),
      );
      expect(exit._tag).toBe("Failure");
    });
  });

  it.effect("does not grant a takeover lease until provider drain completes", () =>
    Effect.gen(function* () {
      const ready = {
        lifecycle: "ready" as const,
        branch: BRANCH,
        limits: {
          cpuCount: 2,
          memoryBytes: 4_294_967_296,
          diskBytes: 21_474_836_480,
          processCount: 512,
          idleTimeoutSeconds: 3600,
          maximumLifetimeSeconds: 28800,
        },
        desktop: { status: "ready" as const },
        services: [],
        controller: { kind: "none" as const },
        createdAt: NOW,
        lastActiveAt: NOW,
      };
      const requestedResult = yield* decideOrchestrationCommand({
        readModel: readModel(ready),
        command: {
          type: "sandbox.takeover",
          commandId: CommandId.make("request"),
          threadId: ThreadId.make("thread-1"),
          sessionId: "viewer",
          createdAt: NOW,
        },
      });
      expect(Array.isArray(requestedResult)).toBe(false);
      const requested = requestedResult as unknown as OrchestrationEvent;
      expect(requested.type).toBe("sandbox.takeover-requested");
      if (requested.type !== "sandbox.takeover-requested") return;
      expect(requested.payload.sandbox.lifecycle).toBe("pausing");
      expect(requested.payload.sandbox.controller.kind).toBe("none");
      const acquiredResult = yield* decideOrchestrationCommand({
        readModel: readModel(requested.payload.sandbox),
        command: {
          type: "sandbox.takeover.complete",
          commandId: CommandId.make("complete"),
          threadId: ThreadId.make("thread-1"),
          sessionId: "viewer",
          createdAt: NOW,
        },
      });
      expect(Array.isArray(acquiredResult)).toBe(false);
      const acquired = acquiredResult as unknown as OrchestrationEvent;
      expect(acquired.type).toBe("sandbox.takeover-acquired");
      if (acquired.type !== "sandbox.takeover-acquired") return;
      expect(acquired.payload.sandbox.controller.kind).toBe("human");
    }),
  );

  it.effect("rejects new agent turns while a human holds the desktop lease", () => {
    const sandbox = {
      lifecycle: "paused" as const,
      branch: BRANCH,
      limits: {
        cpuCount: 2,
        memoryBytes: 4_294_967_296,
        diskBytes: 21_474_836_480,
        processCount: 512,
        idleTimeoutSeconds: 3600,
        maximumLifetimeSeconds: 28800,
      },
      desktop: { status: "ready" as const },
      services: [],
      controller: {
        kind: "human" as const,
        leaseId: "lease",
        sessionId: "viewer",
        acquiredAt: NOW,
      },
      pauseReason: "human-takeover" as const,
      createdAt: NOW,
      lastActiveAt: NOW,
    };
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decideOrchestrationCommand({
          readModel: readModel(sandbox),
          command: {
            type: "thread.turn.start",
            commandId: CommandId.make("turn"),
            threadId: ThreadId.make("thread-1"),
            message: {
              messageId: "message-1" as never,
              role: "user",
              text: "continue",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: NOW,
          },
        }),
      );
      expect(exit._tag).toBe("Failure");
    });
  });

  it.effect("accepts new turns on a failed sandbox so execution can fall back", () => {
    const sandbox = {
      lifecycle: "failed" as const,
      branch: BRANCH,
      limits: {
        cpuCount: 2,
        memoryBytes: 4_294_967_296,
        diskBytes: 21_474_836_480,
        processCount: 512,
        idleTimeoutSeconds: 3600,
        maximumLifetimeSeconds: 28800,
      },
      desktop: { status: "unavailable" as const },
      services: [],
      controller: { kind: "none" as const },
      failure: {
        stage: "provision" as const,
        code: "sandbox_provision_failed",
        message: "T3_SANDBOX_IMAGE must name a digest-pinned desktop sandbox image.",
        retryable: true,
        occurredAt: NOW,
      },
      createdAt: NOW,
      lastActiveAt: NOW,
    };
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decideOrchestrationCommand({
          readModel: readModel(sandbox),
          command: {
            type: "thread.turn.start",
            commandId: CommandId.make("turn-after-failure"),
            threadId: ThreadId.make("thread-1"),
            message: {
              messageId: "message-1" as never,
              role: "user",
              text: "try again",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: NOW,
          },
        }),
      );
      expect(exit._tag).toBe("Success");
    });
  });

  it.effect("requires the active human lease to resume", () => {
    const sandbox = {
      lifecycle: "paused" as const,
      branch: BRANCH,
      limits: {
        cpuCount: 2,
        memoryBytes: 4_294_967_296,
        diskBytes: 21_474_836_480,
        processCount: 512,
        idleTimeoutSeconds: 3600,
        maximumLifetimeSeconds: 28800,
      },
      desktop: { status: "ready" as const },
      services: [],
      controller: {
        kind: "human" as const,
        leaseId: "lease-1",
        sessionId: "viewer-1",
        acquiredAt: NOW,
      },
      pauseReason: "human-takeover" as const,
      createdAt: NOW,
      lastActiveAt: NOW,
    };
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decideOrchestrationCommand({
          readModel: readModel(sandbox),
          command: {
            type: "sandbox.resume",
            commandId: CommandId.make("resume"),
            threadId: ThreadId.make("thread-1"),
            leaseId: "wrong",
            createdAt: NOW,
          },
        }),
      );
      expect(exit._tag).toBe("Failure");
    });
  });

  it.effect("records explicit child branch and inherited commit in worker spawn requests", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        readModel: readModel(),
        command: {
          type: "sandbox.worker.spawn",
          commandId: CommandId.make("spawn-worker"),
          parentThreadId: ThreadId.make("thread-1"),
          childThreadId: ThreadId.make("thread-child"),
          branchName: "t3/thread-child",
          inheritedCommit: BRANCH.baseCommit,
          task: "Implement child task",
          createdAt: NOW,
        },
      });

      expect(Array.isArray(event)).toBe(false);
      const requested = event as Omit<
        Extract<OrchestrationEvent, { type: "sandbox.worker-spawn-requested" }>,
        "sequence"
      >;
      expect(requested.type).toBe("sandbox.worker-spawn-requested");
      if (requested.type === "sandbox.worker-spawn-requested") {
        expect(requested.payload).toMatchObject({
          parentThreadId: "thread-1",
          childThreadId: "thread-child",
          branchName: "t3/thread-child",
          inheritedCommit: BRANCH.baseCommit,
        });
      }
    }),
  );

  it.effect("keeps stop non-terminal until export and teardown complete", () =>
    Effect.gen(function* () {
      const ready = {
        lifecycle: "ready" as const,
        sandboxId: "sandbox-1" as never,
        runtime: "docker" as const,
        runtimeRef: "container-1",
        branch: BRANCH,
        limits: {
          cpuCount: 2,
          memoryBytes: 4_294_967_296,
          diskBytes: 21_474_836_480,
          processCount: 512,
          idleTimeoutSeconds: 3600,
          maximumLifetimeSeconds: 28800,
        },
        desktop: { status: "ready" as const },
        services: [],
        controller: { kind: "none" as const },
        createdAt: NOW,
        lastActiveAt: NOW,
      };
      const stoppingEvent = (yield* decideOrchestrationCommand({
        readModel: readModel(ready),
        command: {
          type: "sandbox.stop",
          commandId: CommandId.make("stop"),
          threadId: ThreadId.make("thread-1"),
          createdAt: NOW,
        },
      })) as Omit<Extract<OrchestrationEvent, { type: "sandbox.stopping" }>, "sequence">;
      expect(stoppingEvent.type).toBe("sandbox.stopping");
      expect(stoppingEvent.payload.sandbox.lifecycle).toBe("stopping");

      const completed = (yield* decideOrchestrationCommand({
        readModel: readModel(stoppingEvent.payload.sandbox),
        command: {
          type: "sandbox.stop.complete",
          commandId: CommandId.make("complete"),
          threadId: ThreadId.make("thread-1"),
          expired: false,
          createdAt: NOW,
        },
      })) as Omit<Extract<OrchestrationEvent, { type: "sandbox.stopped" }>, "sequence">;
      expect(completed.type).toBe("sandbox.stopped");
      expect(completed.payload.sandbox.lifecycle).toBe("stopped");
    }),
  );

  it.effect("refuses automatic expiry while a provider turn is active", () =>
    Effect.gen(function* () {
      const ready = {
        lifecycle: "ready" as const,
        sandboxId: "sandbox-1" as never,
        runtime: "podman" as const,
        runtimeRef: "container-1",
        branch: BRANCH,
        limits: {
          cpuCount: 2,
          memoryBytes: 4_294_967_296,
          diskBytes: 21_474_836_480,
          processCount: 512,
          idleTimeoutSeconds: 3600,
          maximumLifetimeSeconds: 28800,
        },
        desktop: { status: "unavailable" as const },
        services: [],
        controller: { kind: "none" as const },
        createdAt: NOW,
        lastActiveAt: NOW,
      };
      const base = readModel(ready);
      const active = {
        ...base,
        threads: [
          {
            ...base.threads[0]!,
            session: {
              threadId: ThreadId.make("thread-1"),
              status: "running" as const,
              providerName: "claudeAgent" as const,
              runtimeMode: "full-access" as const,
              activeTurnId: TurnId.make("turn-1"),
              lastError: null,
              updatedAt: NOW,
            },
          },
        ],
      };

      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel: active,
          command: {
            type: "sandbox.expire",
            commandId: CommandId.make("expire"),
            threadId: ThreadId.make("thread-1"),
            createdAt: NOW,
          },
        }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag !== "OrchestrationCommandInvariantError")
        throw new Error("expected an orchestration invariant error");
      expect(error.detail).toContain("active provider session");

      const manualStop = (yield* decideOrchestrationCommand({
        readModel: active,
        command: {
          type: "sandbox.stop",
          commandId: CommandId.make("stop"),
          threadId: ThreadId.make("thread-1"),
          createdAt: NOW,
        },
      })) as Omit<Extract<OrchestrationEvent, { type: "sandbox.stopping" }>, "sequence">;
      expect(manualStop.type).toBe("sandbox.stopping");
    }),
  );

  it.effect("resolves a failed teardown from stopping to failed, not a permanent wedge", () =>
    Effect.gen(function* () {
      // The lifecycle reactor leans on this transition: when container
      // teardown throws after the provider session is already gone, it
      // dispatches `sandbox.operation.fail` instead of `sandbox.stop.complete`
      // so the thread lands in `failed` -- a re-provisionable lifecycle --
      // rather than staying in `stopping`, where turn starts are rejected
      // forever.
      const stopping = {
        lifecycle: "stopping" as const,
        sandboxId: "sandbox-1" as never,
        runtime: "docker" as const,
        runtimeRef: "container-1",
        branch: BRANCH,
        limits: {
          cpuCount: 2,
          memoryBytes: 4_294_967_296,
          diskBytes: 21_474_836_480,
          processCount: 512,
          idleTimeoutSeconds: 3600,
          maximumLifetimeSeconds: 28800,
        },
        desktop: { status: "unavailable" as const },
        services: [],
        controller: { kind: "none" as const },
        createdAt: NOW,
        lastActiveAt: NOW,
      };
      const failure = {
        stage: "teardown" as const,
        code: "sandbox_lifecycle_failed",
        message: "podman rm failed: container is in use by another process",
        retryable: true,
        occurredAt: NOW,
      };
      const failedEvent = (yield* decideOrchestrationCommand({
        readModel: readModel(stopping),
        command: {
          type: "sandbox.operation.fail",
          commandId: CommandId.make("teardown-failed"),
          threadId: ThreadId.make("thread-1"),
          failure,
          createdAt: NOW,
        },
      })) as Omit<Extract<OrchestrationEvent, { type: "sandbox.failed" }>, "sequence">;
      expect(failedEvent.type).toBe("sandbox.failed");
      expect(failedEvent.payload.sandbox.lifecycle).toBe("failed");
      expect(failedEvent.payload.sandbox.failure).toEqual(failure);
    }),
  );

  const provisioning = {
    lifecycle: "provisioning" as const,
    branch: BRANCH,
    limits: {
      cpuCount: 2,
      memoryBytes: 4_294_967_296,
      diskBytes: 21_474_836_480,
      processCount: 512,
      idleTimeoutSeconds: 3600,
      maximumLifetimeSeconds: 28800,
    },
    desktop: {
      status: "starting" as const,
      resolution: { width: 1440, height: 900, webRtcEnabled: true },
    },
    services: [],
    controller: { kind: "none" as const },
    createdAt: NOW,
    lastActiveAt: NOW,
  };

  it.effect("reports the desktop unavailable when a headless runtime started none", () =>
    Effect.gen(function* () {
      // A headless deployment (`T3_SANDBOX_DESKTOP=disabled`) provisions with no
      // desktop session. Calling it "ready" anyway pointed every client at a
      // viewer that the desktop routes answer with 409.
      const event = (yield* decideOrchestrationCommand({
        readModel: readModel(provisioning),
        command: {
          type: "sandbox.provision.ready",
          commandId: CommandId.make("headless-ready"),
          threadId: ThreadId.make("thread-1"),
          sandboxId: "sandbox-1" as never,
          runtime: "podman",
          runtimeRef: "t3-thread-abc",
          createdAt: NOW,
        },
      })) as Omit<Extract<OrchestrationEvent, { type: "sandbox.ready" }>, "sequence">;

      expect(event.payload.sandbox.lifecycle).toBe("ready");
      expect(event.payload.sandbox.desktop.status).toBe("unavailable");
      expect(event.payload.sandbox.desktop.sessionId).toBeUndefined();
      // The requested resolution survives so a later desktop-enabled restart
      // still knows what geometry the thread asked for.
      expect(event.payload.sandbox.desktop.resolution?.width).toBe(1440);
    }),
  );

  it.effect("reports the desktop ready when the runtime started one", () =>
    Effect.gen(function* () {
      const event = (yield* decideOrchestrationCommand({
        readModel: readModel(provisioning),
        command: {
          type: "sandbox.provision.ready",
          commandId: CommandId.make("desktop-ready"),
          threadId: ThreadId.make("thread-1"),
          sandboxId: "sandbox-1" as never,
          runtime: "podman",
          runtimeRef: "t3-thread-abc",
          desktopSessionId: "desktop-1",
          desktopStreamPath: "/sandbox/desktop/thread-1",
          createdAt: NOW,
        },
      })) as Omit<Extract<OrchestrationEvent, { type: "sandbox.ready" }>, "sequence">;

      expect(event.payload.sandbox.desktop.status).toBe("ready");
      expect(event.payload.sandbox.desktop.sessionId).toBe("desktop-1");
      expect(event.payload.sandbox.desktop.streamPath).toBe("/sandbox/desktop/thread-1");
      expect(event.payload.sandbox.desktop.readyAt).toBe(NOW);
    }),
  );

  const LIMITS = {
    cpuCount: 2,
    memoryBytes: 4_294_967_296,
    diskBytes: 21_474_836_480,
    processCount: 512,
    idleTimeoutSeconds: 3600,
    maximumLifetimeSeconds: 28800,
  };

  const stopped = {
    lifecycle: "stopped" as const,
    sandboxId: "sandbox-1" as never,
    runtime: "podman" as const,
    runtimeRef: "t3-thread-abc",
    branch: BRANCH,
    limits: LIMITS,
    usage: {
      cpuPercent: 4,
      memoryBytes: 1024,
      diskBytes: 2048,
      processCount: 3,
      sampledAt: NOW,
    },
    desktop: { status: "unavailable" as const },
    services: [],
    controller: { kind: "none" as const },
    lastExport: {
      branchName: BRANCH.branchName,
      headCommit: "89abcdef0123456789abcdef0123456789abcdef",
      artifactId: "a".repeat(64),
      bundleSha256: "b".repeat(64),
      exportedAt: NOW,
    },
    createdAt: NOW,
    lastActiveAt: NOW,
  };

  it.effect("asks the reactor to re-provision a stopped sandbox the UI button hit", () =>
    Effect.gen(function* () {
      // The Provision button sends `{ threadId }` and no branch
      // (ChatView.tsx). Keying the fast path on the RESOLVED branch used to
      // route this straight to `sandbox.provisioning-started` -- projector-only
      // -- so the thread went to `provisioning` with nothing provisioning it.
      const requested = (yield* decideOrchestrationCommand({
        readModel: readModel(stopped),
        command: {
          type: "sandbox.provision",
          commandId: CommandId.make("reprovision-from-client"),
          threadId: ThreadId.make("thread-1"),
          createdAt: NOW,
        },
      })) as Omit<Extract<OrchestrationEvent, { type: "sandbox.provision-requested" }>, "sequence">;
      expect(requested.type).toBe("sandbox.provision-requested");
      expect(requested.payload.threadId).toBe(ThreadId.make("thread-1"));
    }),
  );

  it.effect("re-provisions a stopped sandbox instead of leaving a one-way door", () =>
    Effect.gen(function* () {
      // The reactor's own follow-up dispatch carries the branch it resolved.
      const event = (yield* decideOrchestrationCommand({
        readModel: readModel(stopped),
        command: {
          type: "sandbox.provision",
          commandId: CommandId.make("reprovision"),
          threadId: ThreadId.make("thread-1"),
          branch: BRANCH,
          provisionsInline: true,
          createdAt: NOW,
        },
      })) as Omit<
        Extract<OrchestrationEvent, { type: "sandbox.provisioning-started" }>,
        "sequence"
      >;

      expect(event.payload.sandbox.lifecycle).toBe("provisioning");
      // The branch and the recorded export survive -- they are what the new
      // container gets seeded from.
      expect(event.payload.sandbox.branch).toEqual(BRANCH);
      expect(event.payload.sandbox.lastExport?.artifactId).toBe("a".repeat(64));
      // Everything describing the destroyed container does not.
      expect(event.payload.sandbox.runtimeRef).toBeUndefined();
      expect(event.payload.sandbox.sandboxId).toBeUndefined();
      expect(event.payload.sandbox.usage).toBeUndefined();
    }),
  );

  it.effect("accepts a new turn on a stopped sandbox", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decideOrchestrationCommand({
          readModel: readModel({ ...stopped, lifecycle: "expired" as const }),
          command: {
            type: "thread.turn.start",
            commandId: CommandId.make("turn-after-settle"),
            threadId: ThreadId.make("thread-1"),
            message: {
              messageId: "message-1" as never,
              role: "user",
              text: "back to it",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: NOW,
          },
        }),
      );
      expect(exit._tag).toBe("Success");
    }),
  );

  it.effect("still refuses to provision on top of an in-flight sandbox", () =>
    Effect.gen(function* () {
      for (const lifecycle of ["provisioning", "ready", "stopping", "pausing"] as const) {
        const exit = yield* Effect.exit(
          decideOrchestrationCommand({
            readModel: readModel({ ...stopped, lifecycle }),
            command: {
              type: "sandbox.provision",
              commandId: CommandId.make(`reprovision-${lifecycle}`),
              threadId: ThreadId.make("thread-1"),
              createdAt: NOW,
            },
          }),
        );
        expect(exit._tag, lifecycle).toBe("Failure");
      }
    }),
  );

  it.effect("records the exported bundle so a re-provision can seed from it", () =>
    Effect.gen(function* () {
      // Strip rather than set `undefined`: `lastExport` is an optional key, so
      // this fixture has to be a sandbox that has never exported at all.
      const { lastExport: _never, ...withoutExport } = stopped;
      const ready = { ...withoutExport, lifecycle: "ready" as const };
      const event = (yield* decideOrchestrationCommand({
        readModel: readModel(ready),
        command: {
          type: "sandbox.branch-export.result",
          commandId: CommandId.make("exported"),
          threadId: ThreadId.make("thread-1"),
          branchName: BRANCH.branchName,
          headCommit: "89abcdef0123456789abcdef0123456789abcdef",
          artifactId: "c".repeat(64),
          bundleSha256: "d".repeat(64),
          createdAt: NOW,
        },
      })) as Omit<Extract<OrchestrationEvent, { type: "sandbox.branch-exported" }>, "sequence">;

      expect(event.payload.sandbox.lastExport).toEqual({
        branchName: BRANCH.branchName,
        headCommit: "89abcdef0123456789abcdef0123456789abcdef",
        artifactId: "c".repeat(64),
        bundleSha256: "d".repeat(64),
        exportedAt: NOW,
      });
    }),
  );

  it.effect("lets a forced stop revoke a takeover lease, but only from the server", () =>
    Effect.gen(function* () {
      // Deleting a thread while someone holds the desktop takeover used to
      // leave the container running forever: the plain `sandbox.stop` the
      // deletion reactor dispatches was refused for the lease, and nothing
      // else ever removed the sandbox -- reconcile still counts a deleted
      // thread as expected, so orphan removal skips it too.
      const leased = {
        lifecycle: "ready" as const,
        runtime: "podman" as const,
        branch: BRANCH,
        limits: {
          cpuCount: 2,
          memoryBytes: 4_294_967_296,
          diskBytes: 21_474_836_480,
          processCount: 512,
          idleTimeoutSeconds: 3600,
          maximumLifetimeSeconds: 28800,
        },
        desktop: { status: "ready" as const },
        services: [],
        controller: {
          kind: "human" as const,
          leaseId: "lease-1",
          sessionId: "viewer-1",
          acquiredAt: NOW,
        },
        createdAt: NOW,
        lastActiveAt: NOW,
      };

      const unforced = yield* Effect.exit(
        decideOrchestrationCommand({
          readModel: readModel(leased),
          command: {
            type: "sandbox.stop",
            commandId: CommandId.make("unforced-stop"),
            threadId: ThreadId.make("thread-1"),
            createdAt: NOW,
          },
        }),
      );
      expect(unforced._tag).toBe("Failure");

      const stopping = (yield* decideOrchestrationCommand({
        readModel: readModel(leased),
        command: {
          type: "sandbox.stop",
          commandId: CommandId.make("forced-stop"),
          threadId: ThreadId.make("thread-1"),
          force: true,
          createdAt: NOW,
        },
      })) as Omit<Extract<OrchestrationEvent, { type: "sandbox.stopping" }>, "sequence">;
      expect(stopping.type).toBe("sandbox.stopping");
      expect(stopping.payload.sandbox.lifecycle).toBe("stopping");
      // The lease is revoked with the stop; leaving it would keep the desktop
      // gateway believing a human still drives a container that is going away.
      expect(stopping.payload.sandbox.controller.kind).toBe("none");
      expect(stopping.payload.event).toMatchObject({ expired: false });

      // The security property, end to end: `force` is server-only, so the wire
      // form a hostile client would send loses the flag at the client schema
      // and the decider still refuses the stop. Without this the takeover lease
      // stops meaning anything -- anyone with a socket could close the desktop
      // session out from under the person using it.
      const fromClient = yield* Schema.decodeUnknownEffect(ClientOrchestrationCommand)({
        type: "sandbox.stop",
        commandId: "client-forced-stop",
        threadId: "thread-1",
        force: true,
        createdAt: NOW,
      });
      expect(Object.hasOwn(fromClient, "force")).toBe(false);
      if (fromClient.type !== "sandbox.stop") throw new Error("expected a client stop command");
      const clientForced = yield* Effect.exit(
        decideOrchestrationCommand({ readModel: readModel(leased), command: fromClient }),
      );
      expect(clientForced._tag).toBe("Failure");
    }),
  );

  it.effect("records the runtime the inline provision command carries", () =>
    Effect.gen(function* () {
      // The decider is pure, so an absent `config.runtime` can only fall back
      // to docker -- but the runtime manager honours `T3_SANDBOX_RUNTIME`. On a
      // podman deployment the projection therefore claimed docker for the whole
      // provisioning window, and a stop or delete landing in that window
      // addressed a backend that was never used. The server callers now resolve
      // the runtime before dispatching; this pins the decider's half of that
      // contract: whatever the command says is what gets recorded.
      const provisioned = (yield* decideOrchestrationCommand({
        readModel: readModel(),
        command: {
          type: "sandbox.provision",
          commandId: CommandId.make("provision-podman"),
          threadId: ThreadId.make("thread-1"),
          config: { runtime: "podman" },
          branch: BRANCH,
          provisionsInline: true,
          createdAt: NOW,
        },
      })) as Omit<
        Extract<OrchestrationEvent, { type: "sandbox.provisioning-started" }>,
        "sequence"
      >;
      expect(provisioned.payload.sandbox.runtime).toBe("podman");

      // The fallback is still docker, so a caller that forgets to resolve keeps
      // the old behaviour rather than producing an invalid projection.
      const defaulted = (yield* decideOrchestrationCommand({
        readModel: readModel(),
        command: {
          type: "sandbox.provision",
          commandId: CommandId.make("provision-default"),
          threadId: ThreadId.make("thread-1"),
          branch: BRANCH,
          provisionsInline: true,
          createdAt: NOW,
        },
      })) as Omit<
        Extract<OrchestrationEvent, { type: "sandbox.provisioning-started" }>,
        "sequence"
      >;
      expect(defaulted.payload.sandbox.runtime).toBe("docker");
    }),
  );
});
