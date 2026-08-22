import { CommandId, type OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { SandboxRuntimeManager } from "../../sandbox/SandboxRuntimeManager.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";
import { forkParked } from "../../serverActivation.ts";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;

/**
 * Sandbox lifecycles a deletion can drive to `stopping`. Mirrors the decider's
 * own `sandbox.stop` guard: terminal lifecycles have nothing left to stop, and
 * every other state holds -- or is about to hold -- real container resources.
 */
const TERMINAL_SANDBOX_LIFECYCLES = new Set(["stopped", "expired", "deleted"]);

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

export const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const snapshots = yield* ProjectionSnapshotQuery;
  const sandboxManager = yield* SandboxRuntimeManager;
  const crypto = yield* Crypto.Crypto;

  const stopProviderSession = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: providerService.stopSession({ threadId }),
      message: "thread deletion cleanup skipped provider session stop",
      threadId,
    });

  const closeThreadTerminals = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: terminalManager.close({ threadId, deleteHistory: true }),
      message: "thread deletion cleanup skipped terminal close",
      threadId,
    });

  /**
   * Deleting a thread must also reclaim its sandbox: without this the
   * container, its network, and its volumes keep running -- and reconcile
   * keeps them as `expected` forever, so nothing else ever removes them.
   * Dispatched rather than torn down inline so the sandbox lifecycle reactor
   * owns the teardown exactly as it does for settle and expiry; it completes
   * stops safely even for sandboxes that never provisioned a container.
   */
  const stopThreadSandbox = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: Effect.gen(function* () {
        // The detail query excludes deleted threads, so the sandbox has to be
        // read from the full snapshot, which retains them.
        const snapshot = yield* snapshots.getSnapshot();
        const sandbox = snapshot.threads.find((thread) => thread.id === threadId)?.sandbox;
        if (sandbox == null || TERMINAL_SANDBOX_LIFECYCLES.has(sandbox.lifecycle)) return;
        const id = yield* crypto.randomUUIDv4;
        yield* orchestrationEngine.dispatch({
          type: "sandbox.stop",
          commandId: CommandId.make(`server:thread-deletion-sandbox-stop:${id}`),
          threadId,
          // A plain stop is refused while a human holds the desktop takeover
          // lease. For a deleted thread that refusal is permanent: nothing
          // resumes it, nothing releases the lease, and reconcile still counts
          // it as expected so orphan removal skips the container -- it runs
          // forever. Deletion revokes the lease instead.
          force: true,
          createdAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
        });
      }),
      message: "thread deletion cleanup skipped sandbox stop",
      threadId,
    });

  /**
   * Exported sandbox artifacts hold the thread's transcripts and commits;
   * data retention says they must not outlive the thread. Best-effort like
   * the other cleanup steps, but the failure is logged with its cause.
   */
  const removeSandboxArtifacts = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: sandboxManager.removeThreadArtifacts(threadId),
      message: "thread deletion cleanup skipped sandbox artifact removal",
      threadId,
    });

  const processThreadDeleted = Effect.fn("processThreadDeleted")(function* (
    event: ThreadDeletedEvent,
  ) {
    const { threadId } = event.payload;
    yield* stopProviderSession(threadId);
    yield* closeThreadTerminals(threadId);
    yield* stopThreadSandbox(threadId);
    yield* removeSandboxArtifacts(threadId);
  });

  const processThreadDeletedSafely = (event: ThreadDeletedEvent) =>
    processThreadDeleted(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread deletion reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadDeletedSafely);

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.deleted") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);
