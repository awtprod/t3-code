import type { OrchestrationProjectShell, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { projectThreadAwareness } from "@t3tools/shared/agentAwareness";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  agentAwarenessPublishIdentity,
  eventThreadId,
  resolveAgentAwarenessRelayPublishSnapshot,
  sanitizeRelayAgentActivityState,
  shouldPublishAgentAwarenessEvent,
} from "../relay/AgentAwarenessRelay.ts";
import { forkParked } from "../serverActivation.ts";
import { buildThreadNotificationPayload } from "./notificationPayload.ts";
import {
  decidePublishAction,
  isNotificationFreshEnough,
  notificationAllowedForPreferences,
} from "./notifierDecision.ts";
import { WebPushConfig } from "./WebPushConfig.ts";
import { WebPushSender } from "./WebPushSender.ts";
import { WebPushSubscriptions } from "./WebPushSubscriptions.ts";

// Bounded fan-out per notification: enough to clear a handful of a user's
// devices promptly without hammering push services in lockstep.
const DELIVERY_CONCURRENCY = 4;

export class LocalWebPushNotifier extends Context.Service<
  LocalWebPushNotifier,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    // Exposed for the drainable worker and for deterministic tests.
    readonly processThread: (threadId: ThreadId) => Effect.Effect<void>;
    // Seeds the last-seen identity for every thread in the current snapshot
    // WITHOUT delivering, so a restart never floods devices with catch-up
    // notifications. Exposed for tests.
    readonly seedFromSnapshot: Effect.Effect<void>;
  }
>()("@awtprod/command-center/webPush/LocalWebPushNotifier") {}

export const make = Effect.gen(function* () {
  const webPushConfig = yield* WebPushConfig;
  const subscriptions = yield* WebPushSubscriptions;
  const sender = yield* WebPushSender;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;

  const publishedIdentityByThreadRef = yield* Ref.make(new Map<ThreadId, string>());
  // Resolved once the startup snapshot seed has recorded the last-seen identity
  // for every current thread. start() subscribes to the event stream BEFORE
  // seeding, so events that land mid-seed are buffered in the worker; each
  // processThread waits on this gate so it compares against seeded identities
  // (no restart flood) yet no mid-seed transition is dropped.
  const seedComplete = yield* Deferred.make<void>();
  // Deadlines for transitions that need confirmation. The confirming re-publish
  // is re-enqueued through the same worker, so it can never race a live update.
  const publishConfirmDeadlines = new Map<ThreadId, number>();
  let schedulePublishConfirm: (threadId: ThreadId) => Effect.Effect<void> = () => Effect.void;

  const configured = Option.isSome(webPushConfig.config);

  const deliverToSubscriptions = Effect.fn("web_push.deliver")(function* (
    state: RelayAgentActivityState,
  ) {
    const nowMs = (yield* DateTime.now).epochMilliseconds;
    if (!isNotificationFreshEnough(state, nowMs)) {
      return;
    }
    const allSubscriptions = yield* subscriptions.listAll().pipe(Effect.orElseSucceed(() => []));
    const targets = allSubscriptions.filter((subscription) =>
      notificationAllowedForPreferences(subscription.preferences, state.phase),
    );
    if (targets.length === 0) {
      return;
    }
    const payload = buildThreadNotificationPayload(state);
    yield* Effect.forEach(
      targets,
      (subscription) =>
        sender
          .send({
            endpoint: subscription.endpoint,
            p256dh: subscription.p256dh,
            auth: subscription.auth,
            payload,
          })
          .pipe(
            Effect.flatMap((result) =>
              result.permanentFailure
                ? subscriptions.deleteByEndpoint(subscription.endpoint).pipe(Effect.ignore)
                : Effect.void,
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("web push delivery failed", {
                threadId: state.threadId,
                endpointOrigin: safeOrigin(subscription.endpoint),
                cause: Cause.pretty(cause),
              }),
            ),
          ),
      { concurrency: DELIVERY_CONCURRENCY, discard: true },
    );
  });

  const processThreadUnsafe = Effect.fn("web_push.processThread")(function* (threadId: ThreadId) {
    if (!configured) {
      return;
    }
    // Hold until the startup seed has run so a thread's first comparison is
    // against its seeded identity, never an empty map (which would notify for
    // states that merely existed at boot).
    yield* Deferred.await(seedComplete);
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const thread = yield* snapshotQuery.getThreadShellById(threadId);
    const project = Option.isSome(thread)
      ? yield* snapshotQuery.getProjectShellById(thread.value.projectId)
      : Option.none<OrchestrationProjectShell>();
    const snapshot = resolveAgentAwarenessRelayPublishSnapshot({
      environmentId,
      threadId,
      thread,
      project,
    });
    const state = snapshot.state;
    const publishIdentity = agentAwarenessPublishIdentity(state);
    const published = yield* Ref.get(publishedIdentityByThreadRef);
    const nowMs = (yield* DateTime.now).epochMilliseconds;
    const action = decidePublishAction({
      state,
      publishIdentity,
      previousIdentity: published.get(threadId),
      hasPrevious: published.has(threadId),
      nowMs,
      existingDeadlineMs: publishConfirmDeadlines.get(threadId),
    });
    switch (action.kind) {
      case "unchanged":
        publishConfirmDeadlines.delete(threadId);
        return;
      case "await-deadline":
        return;
      case "defer":
        publishConfirmDeadlines.set(threadId, action.deadlineMs);
        yield* schedulePublishConfirm(threadId);
        return;
      case "proceed":
        publishConfirmDeadlines.delete(threadId);
        if (action.notify && state !== null) {
          yield* deliverToSubscriptions(state);
        }
        yield* Ref.update(publishedIdentityByThreadRef, (identities) => {
          const next = new Map(identities);
          next.set(threadId, publishIdentity);
          return next;
        });
        return;
    }
  });

  const processThread: LocalWebPushNotifier["Service"]["processThread"] = (threadId) =>
    processThreadUnsafe(threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("web push notifier thread processing failed", {
          threadId,
          cause: Cause.pretty(cause),
        }),
      ),
      Effect.withSpan("LocalWebPushNotifier.processThread"),
    );

  const seedFromSnapshot: LocalWebPushNotifier["Service"]["seedFromSnapshot"] = Effect.gen(
    function* () {
      if (!configured) {
        return;
      }
      const environmentId = yield* serverEnvironment.getEnvironmentId;
      const snapshot = yield* snapshotQuery.getShellSnapshot();
      const projectById = new Map(snapshot.projects.map((project) => [project.id, project]));
      const seeded = new Map<ThreadId, string>();
      for (const thread of snapshot.threads) {
        const project = projectById.get(thread.projectId);
        const state = project
          ? sanitizeRelayAgentActivityState(
              projectThreadAwareness({ environmentId, project, thread }),
            )
          : null;
        seeded.set(thread.id, agentAwarenessPublishIdentity(state));
      }
      yield* Ref.set(publishedIdentityByThreadRef, seeded);
    },
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("web push notifier snapshot seed failed", {
        cause: Cause.pretty(cause),
      }),
    ),
    // Always open the gate, even if seeding failed, so buffered events are not
    // stuck forever; a failed seed just means an empty baseline for this boot.
    Effect.ensuring(Deferred.succeed(seedComplete, undefined).pipe(Effect.asVoid)),
  );

  const worker = yield* makeDrainableWorker(processThread);

  schedulePublishConfirm = (threadId) =>
    Effect.forkDetach(
      Effect.sleep("5 seconds").pipe(
        Effect.andThen(worker.enqueue(threadId)),
        Effect.catchCause((cause) =>
          Effect.logWarning("web push deferred confirmation failed", {
            threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    ).pipe(Effect.asVoid);

  const start: LocalWebPushNotifier["Service"]["start"] = Effect.fn("LocalWebPushNotifier.start")(
    function* () {
      if (!configured) {
        yield* Effect.logInfo("direct Web Push notifier disabled; web push is not configured");
        return;
      }
      yield* Effect.logInfo("direct Web Push notifier enabled");
      // Subscribe to the event stream FIRST so a transition that lands during the
      // seed is buffered in the worker rather than lost; each queued processThread
      // waits on `seedComplete` (below) before comparing against the seed.
      yield* forkParked(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          const threadId = eventThreadId(event);
          if (threadId === null || !shouldPublishAgentAwarenessEvent(event)) {
            return Effect.void;
          }
          return worker.enqueue(threadId);
        }),
      );
      // Seed the last-seen identities, then open the gate. Startup catch-up never
      // notifies (seeded == current => unchanged), but a mid-seed transition is
      // still delivered once the buffered event drains.
      yield* forkParked(seedFromSnapshot);
    },
  );

  return LocalWebPushNotifier.of({ start, processThread, seedFromSnapshot });
});

function safeOrigin(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return "unknown";
  }
}

export const layer = Layer.effect(LocalWebPushNotifier, make);
