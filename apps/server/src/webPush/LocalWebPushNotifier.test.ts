import {
  type CommandCenterEventEnvelope,
  type EnvironmentId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { CommandCenterEventStream } from "../command-center/EventStream.ts";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OrchestrationBridge from "../command-center/OrchestrationBridge.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { make as makeNotifier } from "./LocalWebPushNotifier.ts";
import { WebPushConfig } from "./WebPushConfig.ts";
import type { WebPushDeliveryResult, WebPushSendInput } from "./WebPushSender.ts";
import { WebPushSender } from "./WebPushSender.ts";
import {
  layer as webPushSubscriptionsLayer,
  WebPushSubscriptions,
} from "./WebPushSubscriptions.ts";

const ENV_ID = "env-1" as EnvironmentId;
const THREAD_ID = ThreadId.make("thread-1");
const PROJECT_ID = ProjectId.make("project-1");

const PROJECT = {
  id: "project-1",
  title: "Command Center",
} as unknown as OrchestrationProjectShell;

// Non-terminal phases are used in these tests, so a fixed updatedAt keeps
// terminal-freshness out of the picture while staying deterministic.
const FIXED_UPDATED_AT = "2026-01-01T00:00:00.000Z";

function threadForPhase(phase: "approval" | "completed" | "running"): OrchestrationV2ThreadShell {
  const at = DateTime.makeUnsafe(FIXED_UPDATED_AT);
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Fix the widget",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "opus" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: phase === "completed" ? "completed" : "running",
    activityRunStatus: null,
    pendingRuntimeRequest:
      phase === "approval"
        ? { id: RuntimeRequestId.make("request-1"), kind: "command", createdAt: at }
        : null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
  };
}

const PREFERENCES = {
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
} as const;

const SUBSCRIPTION = {
  deviceId: "device-a",
  endpoint: "https://fcm.googleapis.com/fcm/send/a",
  p256dh: "p256dh-a",
  auth: "auth-a",
  preferences: PREFERENCES,
};

interface Harness {
  readonly threadRef: Ref.Ref<Option.Option<OrchestrationV2ThreadShell>>;
  readonly sends: Ref.Ref<ReadonlyArray<WebPushSendInput>>;
  readonly resultRef: Ref.Ref<WebPushDeliveryResult>;
}

const okResult: WebPushDeliveryResult = { ok: true, status: 201, permanentFailure: false };

// `seedThreads` overrides what getShellSnapshot returns for the startup seed;
// when omitted the seed reflects the current threadRef (used by the transition
// tests). Passing an explicit list lets a test seed a baseline that differs
// from the live thread state, modelling boot-time transitions.
const makeHarness = Effect.fn(function* (seedThreads?: readonly OrchestrationV2ThreadShell[]) {
  const threadRef = yield* Ref.make(Option.some(threadForPhase("running")));
  const sends = yield* Ref.make<ReadonlyArray<WebPushSendInput>>([]);
  const resultRef = yield* Ref.make<WebPushDeliveryResult>(okResult);
  const harness: Harness = { threadRef, sends, resultRef };

  const shellThreads = () =>
    seedThreads !== undefined
      ? Effect.succeed(seedThreads)
      : Ref.get(threadRef).pipe(
          Effect.map((thread) => (Option.isSome(thread) ? [thread.value] : [])),
        );

  const depsLayer = Layer.mergeAll(
    Layer.succeed(WebPushConfig, {
      config: Option.some({
        subject: "mailto:ops@example.com",
        publicKey: "vapid-public",
        privateKey: Redacted.make("pem"),
      }),
    }),
    Layer.succeed(WebPushSender, {
      send: (input) =>
        Ref.update(sends, (all) => [...all, input]).pipe(Effect.andThen(Ref.get(resultRef))),
    }),
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(ENV_ID),
      getDescriptor: Effect.die("unused"),
    }),
    Layer.mock(OrchestrationBridge.OrchestrationBridge)({
      getThreadShellById: () => Ref.get(threadRef),
      getProjectShellById: () => Effect.succeed(Option.some(PROJECT)),
      getShellSnapshot: () =>
        shellThreads().pipe(
          Effect.map((threads) => ({
            snapshotSequence: 0,
            projects: [PROJECT],
            threads,
          })),
        ),
      streamThreadEvents: Stream.empty,
    }),
    Layer.mock(CommandCenterEventStream)({ changes: () => Stream.empty }),
  ).pipe(
    Layer.provideMerge(webPushSubscriptionsLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

  return { harness, depsLayer };
});

it.effect("does not notify for state already present at startup (no restart flood)", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { harness, depsLayer } = yield* makeHarness();
      yield* Ref.set(harness.threadRef, Option.some(threadForPhase("approval")));
      yield* Effect.gen(function* () {
        const store = yield* WebPushSubscriptions;
        yield* store.upsert(SUBSCRIPTION);
        const notifier = yield* makeNotifier;
        // Seed from the snapshot: the thread is already waiting for approval.
        yield* notifier.seedFromSnapshot;
        yield* notifier.processThread(THREAD_ID);
        assert.equal((yield* Ref.get(harness.sends)).length, 0);
      }).pipe(Effect.provide(depsLayer));
    }),
  ),
);

it.effect("notifies once on a transition into an attention phase and dedupes repeats", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { harness, depsLayer } = yield* makeHarness();
      yield* Effect.gen(function* () {
        const store = yield* WebPushSubscriptions;
        yield* store.upsert(SUBSCRIPTION);
        const notifier = yield* makeNotifier;
        // Seed with the running state, then transition into approval.
        yield* notifier.seedFromSnapshot;
        yield* Ref.set(harness.threadRef, Option.some(threadForPhase("approval")));
        yield* notifier.processThread(THREAD_ID);
        yield* notifier.processThread(THREAD_ID);
        const sends = yield* Ref.get(harness.sends);
        assert.equal(sends.length, 1);
        assert.equal(sends[0]?.payload.body, "Approval: Command Center");
        assert.equal(sends[0]?.payload.deepLink, "/threads/env-1/thread-1");
      }).pipe(Effect.provide(depsLayer));
    }),
  ),
);

it.effect("respects per-subscription preferences", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { harness, depsLayer } = yield* makeHarness();
      yield* Effect.gen(function* () {
        const store = yield* WebPushSubscriptions;
        yield* store.upsert({
          ...SUBSCRIPTION,
          preferences: { ...PREFERENCES, notifyOnApproval: false },
        });
        const notifier = yield* makeNotifier;
        yield* notifier.seedFromSnapshot;
        yield* Ref.set(harness.threadRef, Option.some(threadForPhase("approval")));
        yield* notifier.processThread(THREAD_ID);
        assert.equal((yield* Ref.get(harness.sends)).length, 0);
      }).pipe(Effect.provide(depsLayer));
    }),
  ),
);

it.effect("deletes the subscription when a delivery reports a permanent failure (410)", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { harness, depsLayer } = yield* makeHarness();
      yield* Effect.gen(function* () {
        const store = yield* WebPushSubscriptions;
        yield* store.upsert(SUBSCRIPTION);
        yield* Ref.set(harness.resultRef, { ok: false, status: 410, permanentFailure: true });
        const notifier = yield* makeNotifier;
        yield* notifier.seedFromSnapshot;
        yield* Ref.set(harness.threadRef, Option.some(threadForPhase("approval")));
        yield* notifier.processThread(THREAD_ID);
        assert.equal((yield* Ref.get(harness.sends)).length, 1);
        assert.equal((yield* store.listAll()).length, 0);
      }).pipe(Effect.provide(depsLayer));
    }),
  ),
);

it.effect("delivers a transition that lands during seeding (event not lost)", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // Seed snapshot is empty: this thread enters waiting_for_approval right as
      // the server boots, so it is NOT in the seed baseline.
      const { harness, depsLayer } = yield* makeHarness([]);
      yield* Ref.set(harness.threadRef, Option.some(threadForPhase("approval")));
      yield* Effect.gen(function* () {
        const store = yield* WebPushSubscriptions;
        yield* store.upsert(SUBSCRIPTION);
        const notifier = yield* makeNotifier;
        // The event is processed before the seed opens the gate; processThread
        // must block until seeding completes, then still deliver.
        const fiber = yield* Effect.forkScoped(notifier.processThread(THREAD_ID));
        assert.equal((yield* Ref.get(harness.sends)).length, 0);
        yield* notifier.seedFromSnapshot;
        yield* Fiber.join(fiber);
        assert.equal((yield* Ref.get(harness.sends)).length, 1);
      }).pipe(Effect.provide(depsLayer));
    }),
  ),
);

it.effect(
  "does not notify for a state unchanged since the seed even if queued during seeding",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Seed baseline already has this thread in waiting_for_approval.
        const { harness, depsLayer } = yield* makeHarness([threadForPhase("approval")]);
        yield* Ref.set(harness.threadRef, Option.some(threadForPhase("approval")));
        yield* Effect.gen(function* () {
          const store = yield* WebPushSubscriptions;
          yield* store.upsert(SUBSCRIPTION);
          const notifier = yield* makeNotifier;
          const fiber = yield* Effect.forkScoped(notifier.processThread(THREAD_ID));
          yield* notifier.seedFromSnapshot;
          yield* Fiber.join(fiber);
          assert.equal((yield* Ref.get(harness.sends)).length, 0);
        }).pipe(Effect.provide(depsLayer));
      }),
    ),
);

const insertAgentItem = (input: {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly metadataJson: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO command_center_spaces (id, slug, name, kind, created_at, updated_at)
      VALUES ('acme', 'acme', 'Acme', 'business', ${FIXED_UPDATED_AT}, ${FIXED_UPDATED_AT})
      ON CONFLICT (id) DO NOTHING
    `;
    yield* sql`
      INSERT INTO command_center_items (
        id, space_id, kind, status, title, metadata_json, created_at, updated_at
      ) VALUES (
        ${input.id}, 'acme', ${input.kind}, ${input.status}, 'Which example vendor?',
        ${input.metadataJson}, ${FIXED_UPDATED_AT}, ${FIXED_UPDATED_AT}
      )
    `;
  });

const itemCreated = (
  itemId: string,
  actorKind = "agent",
  change: "created" | "updated" = "created",
): CommandCenterEventEnvelope =>
  ({
    _tag: "ItemChanged",
    sequence: 1,
    eventId: `event-${itemId}`,
    previousHash: null,
    eventHash: "hash",
    actorKind,
    spaceId: "acme",
    runId: null,
    occurredAt: FIXED_UPDATED_AT,
    payload: { itemId, change, kind: "decision", status: "captured" },
  }) as unknown as CommandCenterEventEnvelope;

it.effect("pushes a Space agent question to the agent thread, gated by notifyOnInput", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { harness, depsLayer } = yield* makeHarness();
      yield* Effect.gen(function* () {
        const store = yield* WebPushSubscriptions;
        yield* store.upsert(SUBSCRIPTION);
        yield* store.upsert({
          ...SUBSCRIPTION,
          deviceId: "device-b",
          endpoint: "https://fcm.googleapis.com/fcm/send/b",
          preferences: { ...PREFERENCES, notifyOnInput: false },
        });
        yield* insertAgentItem({
          id: "question",
          kind: "decision",
          status: "captured",
          metadataJson: `{"spaceAgent":true}`,
        });
        const notifier = yield* makeNotifier;
        yield* notifier.processItemEvent(itemCreated("question"));
        const sends = yield* Ref.get(harness.sends);
        assert.equal(sends.length, 1);
        assert.equal(sends[0]?.endpoint, SUBSCRIPTION.endpoint);
        assert.deepStrictEqual(sends[0]?.payload, {
          title: "Which example vendor?",
          body: "Needs you: your Space agent has a question",
          environmentId: ENV_ID,
          threadId: "cc-space-agent-acme",
          deepLink: "/threads/env-1/cc-space-agent-acme",
        });
      }).pipe(Effect.provide(depsLayer));
    }),
  ),
);

it.effect("stays quiet for the agent's non-decision Items, user Items, and updates", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { harness, depsLayer } = yield* makeHarness();
      yield* Effect.gen(function* () {
        const store = yield* WebPushSubscriptions;
        yield* store.upsert(SUBSCRIPTION);
        yield* insertAgentItem({
          id: "agent-task",
          kind: "task",
          status: "captured",
          metadataJson: `{"spaceAgent":true}`,
        });
        yield* insertAgentItem({
          id: "unmarked-decision",
          kind: "decision",
          status: "captured",
          metadataJson: "{}",
        });
        yield* insertAgentItem({
          id: "agent-decision",
          kind: "decision",
          status: "review",
          metadataJson: `{"spaceAgent":true}`,
        });
        const notifier = yield* makeNotifier;
        yield* notifier.processItemEvent(itemCreated("agent-task"));
        yield* notifier.processItemEvent(itemCreated("unmarked-decision"));
        yield* notifier.processItemEvent(itemCreated("agent-decision", "user"));
        yield* notifier.processItemEvent(itemCreated("agent-decision", "agent", "updated"));
        yield* notifier.processItemEvent(itemCreated("missing"));
        assert.equal((yield* Ref.get(harness.sends)).length, 0);
      }).pipe(Effect.provide(depsLayer));
    }),
  ),
);
