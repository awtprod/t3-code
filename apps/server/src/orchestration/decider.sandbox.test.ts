import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

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
});
