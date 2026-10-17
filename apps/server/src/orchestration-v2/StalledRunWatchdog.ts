import {
  CommandId,
  type OrchestrationV2ThreadShell,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/**
 * Stops a run wedged behind a live but silent provider session.
 *
 * A provider process that exits ends its run within seconds, but a live session
 * that simply stops streaming produces no signal at all, so without this sweep
 * the thread spins forever. The heartbeat is the thread shell's `updatedAt`,
 * which every streamed run, node and turn-item event bumps.
 *
 * The threshold comes from the fork's measurements of healthy turns: the
 * longest silence inside a turn was 7.2 minutes (p95 68 s), so 10 minutes leaves
 * headroom while bounding how long a user watches a false spinner. Worst case
 * to recovery is threshold + sweep interval. A run parked on an approval or a
 * question is never stopped: the user may legitimately be away.
 */
const STALLED_RUN_THRESHOLD = Duration.minutes(10);
const STALLED_RUN_SWEEP_INTERVAL = Duration.seconds(60);

export interface StalledRun {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly silentMs: number;
  readonly updatedAtMs: number;
}

/** Running, unblocked runs whose thread has been silent for at least `thresholdMs`. */
export function stalledRuns(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  nowMs: number,
  thresholdMs: number,
): ReadonlyArray<StalledRun> {
  const stalled: Array<StalledRun> = [];
  for (const thread of threads) {
    if (
      thread.activeRunId === null ||
      thread.status !== "running" ||
      thread.pendingRuntimeRequest !== null ||
      thread.archivedAt !== null
    ) {
      continue;
    }
    const updatedAtMs = DateTime.toEpochMillis(thread.updatedAt);
    const silentMs = nowMs - updatedAtMs;
    if (silentMs >= thresholdMs) {
      stalled.push({ threadId: thread.id, runId: thread.activeRunId, silentMs, updatedAtMs });
    }
  }
  return stalled;
}

export class StalledRunWatchdog extends Context.Service<
  StalledRunWatchdog,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One pass; returns the runs it stopped. */
    readonly sweep: Effect.Effect<ReadonlyArray<StalledRun>>;
  }
>()("@awtprod/command-center/orchestration-v2/StalledRunWatchdog") {}

export const make = (
  options: { readonly threshold?: Duration.Input; readonly interval?: Duration.Input } = {},
) =>
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const thresholdMs = Duration.toMillis(options.threshold ?? STALLED_RUN_THRESHOLD);
    const interval = options.interval ?? STALLED_RUN_SWEEP_INTERVAL;
    const minutes = Math.max(1, Math.round(thresholdMs / 60_000));

    const stop = (run: StalledRun) =>
      engine
        .dispatch({
          type: "run.interrupt",
          // One command per stall: a repeat sweep of the same silence is a receipt replay.
          commandId: CommandId.make(`server:stalled-run:${run.runId}:${run.updatedAtMs}`),
          threadId: run.threadId,
          runId: run.runId,
          reason: `No provider activity for ${minutes} minutes. Command Center stopped the turn so the thread can continue.`,
        })
        .pipe(
          Effect.tap(() =>
            Effect.logWarning("stopped a run with no provider activity", {
              threadId: run.threadId,
              runId: run.runId,
              silentMs: run.silentMs,
            }),
          ),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("stopping a stalled run failed", {
              threadId: run.threadId,
              runId: run.runId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );

    const sweep: StalledRunWatchdog["Service"]["sweep"] = Effect.gen(function* () {
      const snapshot = yield* projections.getShellSnapshot();
      const candidates = stalledRuns(snapshot.threads, yield* Clock.currentTimeMillis, thresholdMs);
      const stopped: Array<StalledRun> = [];
      for (const run of candidates) {
        if (yield* stop(run)) stopped.push(run);
      }
      return stopped;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("stalled run sweep failed", { cause }).pipe(Effect.as([])),
      ),
    );

    const start: StalledRunWatchdog["Service"]["start"] = () =>
      forkParked(Effect.repeat(sweep, Schedule.spaced(interval)).pipe(Effect.asVoid));

    return { start, sweep } satisfies StalledRunWatchdog["Service"];
  });

export const layer = Layer.effect(StalledRunWatchdog, make());
