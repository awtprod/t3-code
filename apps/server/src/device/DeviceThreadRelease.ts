import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as DeviceService from "./DeviceService.ts";

type ThreadEndEvent = "thread.settled" | "thread.archived" | "thread.deleted";

const BUSY_RUN_STATUSES = new Set(["queued", "preparing", "starting", "running", "waiting"]);

/**
 * Closes a thread's devices when it settles, is archived or is deleted, which ends their
 * agent-device sessions and so their claims on the devices. Settling refuses a busy thread;
 * a settled thread that took a new turn since keeps its devices.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const devices = yield* DeviceService.DeviceService;

  const stillIdle = (threadId: ThreadId) =>
    projections
      .getThreadRecords(threadId, ["runs"])
      .pipe(
        Effect.map(
          (records) =>
            records.thread.settledAt !== null &&
            !records.runs.some((run) => BUSY_RUN_STATUSES.has(run.status)),
        ),
      );

  const release = Effect.fn("DeviceThreadRelease.release")(
    function* (threadId: ThreadId, trigger: ThreadEndEvent) {
      if ((yield* devices.sessionsForThread(threadId)).length === 0) return;
      if (trigger === "thread.settled" && !(yield* stillIdle(threadId))) return;
      const { unreleased } = yield* devices.close({ threadId });
      if (unreleased.length > 0) {
        yield* Effect.logWarning("Devices may still be claimed after their thread ended", {
          threadId,
          trigger,
          unreleased,
        });
      }
    },
    (effect, threadId, trigger) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not close a finished thread's devices", {
            threadId,
            trigger,
            cause,
          }),
        ),
      ),
  );

  const start = Effect.fn("DeviceThreadRelease.start")(function* () {
    // Keyed by thread so a slow agent-device close does not hold up other threads.
    const closing = yield* FiberMap.make<ThreadId>();
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "thread.settled" ||
        event.type === "thread.archived" ||
        event.type === "thread.deleted"
          ? FiberMap.run(closing, event.threadId, release(event.threadId, event.type))
          : Effect.void,
      ),
    );
  });
  return { start, release };
});
