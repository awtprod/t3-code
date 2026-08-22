import { CommandId, type OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  SandboxSettleCleanupReactor,
  type SandboxSettleCleanupReactorShape,
} from "../Services/SandboxSettleCleanupReactor.ts";

type ThreadSettledEvent = Extract<OrchestrationEvent, { type: "thread.settled" }>;

/**
 * Lifecycles a settle may tear down.
 *
 * Deliberately narrow. `sandbox.stop` passes the decider's guard for an
 * `unprovisioned` sandbox and drives it to `stopping`, but the lifecycle
 * reactor then returns early without ever dispatching `sandbox.stop.complete`
 * -- wedging the thread in `stopping` forever. The in-flight states are absent
 * for the same reason a re-provision refuses them: they race an operation the
 * lifecycle reactor is already running.
 */
const RECLAIMABLE_SANDBOX_LIFECYCLES = new Set(["ready", "paused"]);

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const processThreadSettled = Effect.fn("processThreadSettled")(function* (
    event: ThreadSettledEvent,
  ) {
    const { threadId } = event.payload;
    // `thread.settled` carries only the thread id and timestamps, so the
    // sandbox has to be re-read rather than taken from the payload.
    const thread = Option.getOrUndefined(yield* snapshots.getThreadDetailById(threadId));
    const sandbox = thread?.sandbox;
    if (!sandbox || !RECLAIMABLE_SANDBOX_LIFECYCLES.has(sandbox.lifecycle)) return;
    // A human holding the sandbox is driving it directly; the decider rejects
    // `sandbox.stop` under that lease, and the takeover is theirs to end.
    if (sandbox.controller.kind === "human") return;
    const id = yield* crypto.randomUUIDv4;
    // The lifecycle reactor exports the thread's branch before it tears the
    // container down, so settling reclaims the sandbox without stranding the
    // work -- and the recorded export lets a returning user re-provision onto
    // their own commits.
    //
    // Ignored because this is silent housekeeping: an unignored failure inside
    // the worker is converted into a `sandbox.operation.fail` with stage
    // `teardown`, i.e. a red failure notice on a thread the user just finished.
    yield* engine
      .dispatch({
        type: "sandbox.stop",
        commandId: CommandId.make(`server:sandbox-settle-cleanup:${id}`),
        threadId,
        createdAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
      })
      .pipe(Effect.ignore);
  });

  const processThreadSettledSafely = (event: ThreadSettledEvent) =>
    processThreadSettled(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("sandbox settle cleanup reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadSettledSafely);

  const start: SandboxSettleCleanupReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        if (event.type !== "thread.settled") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return { start, drain: worker.drain } satisfies SandboxSettleCleanupReactorShape;
});

export const SandboxSettleCleanupReactorLive = Layer.effect(SandboxSettleCleanupReactor, make);
