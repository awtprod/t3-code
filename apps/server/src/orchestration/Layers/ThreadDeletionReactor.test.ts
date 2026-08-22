import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  SandboxId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { describe } from "vite-plus/test";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import {
  SandboxRuntimeManager,
  type SandboxRuntimeManagerShape,
} from "../../sandbox/SandboxRuntimeManager.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import { logCleanupCauseUnlessInterrupted, make } from "./ThreadDeletionReactor.ts";

const NOW = "2026-08-21T00:00:00.000Z";
const projectId = ProjectId.make("project-deletion");

const sandbox = (
  overrides: Partial<NonNullable<OrchestrationThread["sandbox"]>>,
): NonNullable<OrchestrationThread["sandbox"]> => ({
  lifecycle: "ready",
  sandboxId: SandboxId.make("sandbox-deletion"),
  runtime: "podman",
  runtimeRef: "t3-thread-deletion",
  branch: { branchName: "thread/deletion", baseCommit: "a".repeat(40) },
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
  settledAt: null,
  // Deleted before the reactor runs -- exactly the state the deletion event
  // leaves the projection in.
  deletedAt: NOW,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
});

const deleted = (id: string, sequence: number): OrchestrationEvent => ({
  sequence,
  eventId: EventId.make(`deleted-${id}`),
  commandId: CommandId.make(`delete-${id}`),
  aggregateKind: "thread",
  aggregateId: ThreadId.make(id),
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "thread.deleted",
  payload: { threadId: ThreadId.make(id), deletedAt: NOW },
  occurredAt: NOW,
});

const threadIdOf = (command: OrchestrationCommand) =>
  "threadId" in command ? command.threadId : undefined;

/**
 * Runs the reactor over `thread.deleted` events for every listed thread and
 * returns the dispatched commands plus the artifact-removal attempts. The
 * worker's FIFO queue plus a completion deferred (resolved by the artifact
 * removal of the LAST thread, which runs unconditionally) sequences the
 * assertion without a sleep.
 */
const runReactor = (threads: ReadonlyArray<OrchestrationThread>) =>
  Effect.gen(function* () {
    const processedLast = yield* Deferred.make<void>();
    const dispatched: OrchestrationCommand[] = [];
    const artifactRemovals: string[] = [];
    const lastId = threads.at(-1)!.id;
    const snapshot = { threads, projects: [] } as unknown as OrchestrationReadModel;
    const layer = Layer.effect(ThreadDeletionReactor, make).pipe(
      Layer.provide(NodeServices.layer),
      Layer.provide(Layer.mock(ProviderService)({ stopSession: () => Effect.void })),
      Layer.provide(
        Layer.succeed(TerminalManager.TerminalManager, {
          close: () => Effect.void,
        } as unknown as TerminalManager.TerminalManager["Service"]),
      ),
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery)({ getSnapshot: () => Effect.succeed(snapshot) }),
      ),
      Layer.provide(
        Layer.succeed(SandboxRuntimeManager, {
          removeThreadArtifacts: (threadId: string) =>
            Effect.sync(() => {
              artifactRemovals.push(threadId);
            }).pipe(
              Effect.andThen(
                threadId === lastId ? Deferred.succeed(processedLast, undefined) : Effect.void,
              ),
            ),
        } as unknown as SandboxRuntimeManagerShape),
      ),
      Layer.provide(
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: dispatched.length };
            }),
          streamDomainEvents: Stream.fromIterable(
            threads.map((item, index) => deleted(item.id, index + 1)),
          ),
        }),
      ),
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        const reactor = yield* ThreadDeletionReactor;
        yield* reactor.start();
        yield* Deferred.await(processedLast).pipe(Effect.timeout("5 seconds"));
        yield* reactor.drain;
      }).pipe(Effect.provide(layer)),
    );
    return { dispatched, artifactRemovals };
  });

it.layer(NodeServices.layer)("thread deletion sandbox cleanup", (it) => {
  it.effect("stops the sandbox and removes its artifacts when a thread is deleted", () =>
    Effect.gen(function* () {
      const { dispatched, artifactRemovals } = yield* runReactor([
        thread("thread-deleted", sandbox({})),
      ]);

      // Deletion reclaims the container exactly as settle and expiry do:
      // through `sandbox.stop`, owned by the lifecycle reactor.
      expect(dispatched.map((command) => [command.type, threadIdOf(command)])).toEqual([
        ["sandbox.stop", "thread-deleted"],
      ]);
      // ...and the exported transcripts/commits do not outlive the thread.
      expect(artifactRemovals).toEqual(["thread-deleted"]);
    }),
  );

  it.effect("dispatches nothing for threads whose sandbox has nothing left to stop", () =>
    Effect.gen(function* () {
      const { dispatched, artifactRemovals } = yield* runReactor([
        // No sandbox at all: nothing to stop, and no error either.
        thread("thread-none", null),
        // Terminal lifecycles: the decider would reject `sandbox.stop`.
        thread("thread-stopped", sandbox({ lifecycle: "stopped" })),
        thread("thread-expired", sandbox({ lifecycle: "expired" })),
      ]);

      expect(dispatched).toEqual([]);
      // Artifact removal still runs for every deleted thread: a stopped
      // sandbox's export is exactly the artifact that must not survive.
      expect(artifactRemovals).toEqual(["thread-none", "thread-stopped", "thread-expired"]);
    }),
  );
});

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});
