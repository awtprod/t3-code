import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  SandboxId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { SandboxSettleCleanupReactor } from "../Services/SandboxSettleCleanupReactor.ts";
import { make } from "./SandboxSettleCleanupReactor.ts";

const NOW = "2026-08-19T00:00:00.000Z";
const projectId = ProjectId.make("project-settle");

const sandbox = (
  overrides: Partial<NonNullable<OrchestrationThread["sandbox"]>>,
): NonNullable<OrchestrationThread["sandbox"]> => ({
  lifecycle: "ready",
  sandboxId: SandboxId.make("sandbox-settle"),
  runtime: "podman",
  runtimeRef: "t3-thread-settle",
  branch: { branchName: "thread/settle", baseCommit: "a".repeat(40) },
  limits: {
    cpuCount: 2,
    memoryBytes: 4_294_967_296,
    diskBytes: 21_474_836_480,
    processCount: 512,
    idleTimeoutSeconds: 3600,
    maximumLifetimeSeconds: 28_800,
  },
  desktop: { status: "unavailable" },
  services: [],
  controller: { kind: "none" },
  createdAt: NOW,
  lastActiveAt: NOW,
  ...overrides,
});

const thread = (id: string, sandboxState: OrchestrationThread["sandbox"]): OrchestrationThread => ({
  id: ThreadId.make(id),
  projectId,
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  sandbox: sandboxState,
  latestTurn: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: NOW,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
});

const settled = (id: string, sequence: number): OrchestrationEvent => ({
  sequence,
  eventId: EventId.make(`settled-${id}`),
  commandId: CommandId.make(`settle-${id}`),
  aggregateKind: "thread",
  aggregateId: ThreadId.make(id),
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "thread.settled",
  payload: { threadId: ThreadId.make(id), settledAt: NOW, updatedAt: NOW },
  occurredAt: NOW,
});

/**
 * The thread a dispatched command targets, if it targets one.
 *
 * `OrchestrationCommand` is a union and only its thread-scoped members carry a
 * `threadId`, so assertions read it through this narrowing rather than off the
 * union directly.
 */
const threadIdOf = (command: OrchestrationCommand) =>
  "threadId" in command ? command.threadId : undefined;

/**
 * Runs the reactor over `settled` events for every thread in `threads`, in
 * order, and returns the commands it dispatched.
 *
 * Sequencing rests on the worker's FIFO queue rather than a sleep: the caller
 * puts a thread that is guaranteed to dispatch last, and awaiting that dispatch
 * proves every earlier event was already processed to completion.
 */
const runReactor = (threads: ReadonlyArray<OrchestrationThread>) =>
  Effect.gen(function* () {
    const dispatchedLast = yield* Deferred.make<void>();
    const dispatched: OrchestrationCommand[] = [];
    const lastId = threads.at(-1)!.id;
    const layer = Layer.effect(SandboxSettleCleanupReactor, make).pipe(
      Layer.provide(NodeServices.layer),
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadDetailById: (id) =>
            Effect.succeed(Option.fromNullOr(threads.find((item) => item.id === id) ?? null)),
        }),
      ),
      Layer.provide(
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Effect.gen(function* () {
              dispatched.push(command);
              if (threadIdOf(command) === lastId)
                yield* Deferred.succeed(dispatchedLast, undefined);
              return { sequence: dispatched.length };
            }),
          streamDomainEvents: Stream.fromIterable(
            threads.map((item, index) => settled(item.id, index + 1)),
          ),
        }),
      ),
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        const reactor = yield* SandboxSettleCleanupReactor;
        yield* reactor.start();
        yield* Deferred.await(dispatchedLast);
        yield* reactor.drain;
      }).pipe(Effect.provide(layer)),
    );
    return dispatched;
  });

it.layer(NodeServices.layer)("sandbox settle cleanup", (it) => {
  it.effect("stops a live sandbox once its thread settles", () =>
    Effect.gen(function* () {
      const dispatched = yield* runReactor([
        thread("thread-paused", sandbox({ lifecycle: "paused" })),
        thread("thread-ready", sandbox({})),
      ]);

      // Both a running and a paused sandbox are the user's to reclaim: they
      // hold a container, a network, and volumes until something stops them.
      expect(dispatched.map((command) => [command.type, threadIdOf(command)])).toEqual([
        ["sandbox.stop", "thread-paused"],
        ["sandbox.stop", "thread-ready"],
      ]);
    }),
  );

  it.effect("leaves every sandbox it cannot safely stop alone", () =>
    Effect.gen(function* () {
      const dispatched = yield* runReactor([
        // No sandbox at all -- a legacy-host thread has nothing to reclaim.
        thread("thread-none", null),
        // `sandbox.stop` passes the decider here and drives the lifecycle to
        // `stopping`, but the lifecycle reactor then returns early without
        // dispatching `sandbox.stop.complete` -- wedged forever.
        thread("thread-unprovisioned", sandbox({ lifecycle: "unprovisioned" })),
        // Already on its way down, or already down: nothing left to do.
        thread("thread-stopping", sandbox({ lifecycle: "stopping" })),
        thread("thread-stopped", sandbox({ lifecycle: "stopped" })),
        thread("thread-expired", sandbox({ lifecycle: "expired" })),
        thread("thread-failed", sandbox({ lifecycle: "failed" })),
        // Mid-flight; stopping now would race the reactor's own provision.
        thread("thread-provisioning", sandbox({ lifecycle: "provisioning" })),
        // A human holds the lease, and the decider rejects `sandbox.stop`
        // outright under one -- ending the takeover is theirs to do.
        thread(
          "thread-human",
          sandbox({
            controller: {
              kind: "human",
              leaseId: "lease-1",
              sessionId: "session-1",
              acquiredAt: NOW,
            },
          }),
        ),
        thread("thread-ready", sandbox({})),
      ]);

      expect(dispatched.map(threadIdOf)).toEqual(["thread-ready"]);
    }),
  );
});
