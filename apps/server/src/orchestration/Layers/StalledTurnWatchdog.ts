import { CommandId, EventId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  StalledTurnWatchdog,
  type StalledTurnWatchdogShape,
} from "../Services/StalledTurnWatchdog.ts";

// A turn is considered wedged after this long with no provider activity. The
// heartbeat is the thread shell's `updatedAt`, which every `thread.activity-appended`
// bumps — it tracks the provider stream precisely and freezes the instant the
// stream goes silent (unlike `provider_session_runtime.last_seen_at`, which only
// bumps on session-lifecycle changes and reads stale during a healthy long turn).
const DEFAULT_STALL_THRESHOLD_MS = 20 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 2 * 60 * 1000;

export interface StalledTurnWatchdogLiveOptions {
  readonly stallThresholdMs?: number;
  readonly sweepIntervalMs?: number;
}

const makeStalledTurnWatchdog = (options?: StalledTurnWatchdogLiveOptions) =>
  Effect.gen(function* () {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const providerService = yield* ProviderService;
    const crypto = yield* Crypto.Crypto;

    const stallThresholdMs = Math.max(1, options?.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS);
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const stallMinutes = Math.max(1, Math.round(stallThresholdMs / 60_000));

    const serverCommandId = (tag: string) =>
      crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
    const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));

    const sweep = Effect.gen(function* () {
      const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
      const now = yield* Clock.currentTimeMillis;
      let failedCount = 0;

      for (const thread of snapshot.threads) {
        const session = thread.session;
        const latestTurn = thread.latestTurn;

        // Only act on a turn that is genuinely running with a live provider
        // session pinned to the same turn.
        if (session === null || session.status !== "running" || session.activeTurnId === null) {
          continue;
        }
        if (
          latestTurn === null ||
          latestTurn.state !== "running" ||
          latestTurn.turnId !== session.activeTurnId
        ) {
          continue;
        }

        // Never auto-fail a turn that is correctly parked on a human decision —
        // an approval or a user-input request also freezes `updatedAt`, and the
        // user may legitimately be away longer than the stall threshold.
        if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
          continue;
        }

        const updatedAtMs = Date.parse(thread.updatedAt);
        if (Number.isNaN(updatedAtMs)) {
          yield* Effect.logWarning("stalled-turn.watchdog.invalid-updated-at", {
            threadId: thread.id,
            updatedAt: thread.updatedAt,
          });
          continue;
        }

        const silentDurationMs = now - updatedAtMs;
        if (silentDurationMs < stallThresholdMs) {
          continue;
        }

        const activeTurnId = session.activeTurnId;
        const nowIso = DateTime.formatIso(yield* DateTime.now);

        // 1. Append a visible reason to the thread so the auto-fail is explained
        //    in the UI, mirroring ProviderCommandReactor's failure activities.
        const [activityCommandId, activityEventId] = yield* Effect.all([
          serverCommandId("stalled-turn-activity"),
          serverEventId(),
        ]);
        yield* orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: activityCommandId,
          threadId: thread.id,
          activity: {
            id: activityEventId,
            tone: "error",
            kind: "provider.turn.stalled",
            summary: `Turn auto-failed: no provider activity for ${stallMinutes}m`,
            payload: {
              detail:
                `The provider stream produced no activity for ${stallMinutes} minutes ` +
                `while the turn was running. The watchdog failed the turn and interrupted ` +
                `the provider so the thread can be resumed.`,
              silentDurationMs,
              stallThresholdMs,
            },
            turnId: activeTurnId,
            createdAt: nowIso,
          },
          createdAt: nowIso,
        });

        // 2. Settle the running turn: the projector maps session `status:"error"`
        //    to turn state `error` and clears the active turn. Same dispatch shape
        //    reconcileOrphanedTurns uses.
        const sessionCommandId = yield* serverCommandId("stalled-turn-session-set");
        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: sessionCommandId,
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: "error",
            providerName: session.providerName,
            ...(session.providerInstanceId !== undefined
              ? { providerInstanceId: session.providerInstanceId }
              : {}),
            // Carry the generation forward: this write changes the session's
            // STATUS, not its identity. Dropping it would blank the value the
            // ingestion guard compares lifecycle events against, silently
            // disarming stale-runtime detection for the rest of the binding.
            ...(session.sessionGeneration !== undefined
              ? { sessionGeneration: session.sessionGeneration }
              : {}),
            runtimeMode: session.runtimeMode,
            activeTurnId: null,
            lastError: `Stalled: no provider activity for ${stallMinutes}m; auto-failed by watchdog`,
            updatedAt: nowIso,
          },
          createdAt: nowIso,
        });

        // 3. Best-effort interrupt the provider-side turn WITHOUT tearing the
        //    session down (interrupt-only recovery). If the provider is truly
        //    dead this no-ops; if alive it stops cleanly. Any late terminal event
        //    it emits is harmless — the active turn is already cleared.
        yield* providerService.interruptTurn({ threadId: thread.id, turnId: activeTurnId }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("stalled-turn.watchdog.interrupt-failed", {
              threadId: thread.id,
              turnId: activeTurnId,
              cause: Cause.pretty(cause),
            }),
          ),
        );

        yield* Effect.logInfo("stalled-turn.watchdog.failed-turn", {
          threadId: thread.id,
          turnId: activeTurnId,
          silentDurationMs,
          stallThresholdMs,
        });
        failedCount += 1;
      }

      if (failedCount > 0) {
        yield* Effect.logInfo("stalled-turn.watchdog.sweep-complete", {
          failedCount,
          totalThreads: snapshot.threads.length,
        });
      }
    });

    const start: StalledTurnWatchdogShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("stalled-turn.watchdog.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("stalled-turn.watchdog.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("stalled-turn.watchdog.started", {
          stallThresholdMs,
          sweepIntervalMs,
        });
      });

    return {
      start,
    } satisfies StalledTurnWatchdogShape;
  });

export const makeStalledTurnWatchdogLive = (options?: StalledTurnWatchdogLiveOptions) =>
  Layer.effect(StalledTurnWatchdog, makeStalledTurnWatchdog(options));

export const StalledTurnWatchdogLive = makeStalledTurnWatchdogLive();
