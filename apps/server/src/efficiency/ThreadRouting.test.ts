import { assert, it } from "@effect/vitest";
import { MessageId, ProviderInstanceId, RunId, ThreadId, TurnId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { runMigrations } from "../persistence/Migrations.ts";
import { ThreadRoutingService, layer as threadRoutingLayer } from "./ThreadRouting.ts";

const layer = it.layer(
  threadRoutingLayer.pipe(
    Layer.provideMerge(Layer.effectDiscard(runMigrations())),
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  ),
);

const threadId = ThreadId.make("thread:acme-routing");

layer("ThreadRoutingService", (it) => {
  it.effect("defaults to manual for a thread with no row, then stores what the client set", () =>
    Effect.gen(function* () {
      const routing = yield* ThreadRoutingService;
      const initial = yield* routing.get(threadId);
      assert.strictEqual(initial.routingMode, "manual");
      assert.isFalse(initial.stored);
      assert.isNull(initial.efficiencyTier);

      const saved = yield* routing.set({
        threadId,
        routingMode: "auto",
        efficiencyTier: "balanced",
        retryOfTurnId: TurnId.make("run:acme:1"),
      });
      assert.strictEqual(saved.routingMode, "auto");
      assert.strictEqual(saved.efficiencyTier, "balanced");
      assert.strictEqual(saved.pendingRetryOfTurnId, "run:acme:1");
      assert.isTrue(saved.stored);

      yield* routing.clearPendingRetry(threadId);
      assert.isNull((yield* routing.get(threadId)).pendingRetryOfTurnId);
      assert.isTrue(Option.isSome(yield* routing.getStored(threadId)));
    }),
  );

  it.effect("streams the current state, then every change of that thread only", () =>
    Effect.gen(function* () {
      const routing = yield* ThreadRoutingService;
      const watched = ThreadId.make("thread:acme-watched");
      const fiber = yield* routing
        .subscribe(watched)
        .pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* routing.set({
        threadId: ThreadId.make("thread:other"),
        routingMode: "auto",
        efficiencyTier: null,
      });
      yield* routing.set({ threadId: watched, routingMode: "auto", efficiencyTier: "quality" });
      yield* routing.recordRunDecision({
        runId: RunId.make("run:acme-watched:1"),
        threadId: watched,
        messageId: MessageId.make("message:acme-watched:1"),
        decision: {
          tier: "quality",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-opus-5-5",
          },
          source: "tier-policy",
          workload: "interactive",
          contextThresholdPercent: 90,
          toolWarningThreshold: 24,
        },
        createdAt: "2026-10-17T00:00:00.000Z",
      });
      const states = Array.from(yield* Fiber.join(fiber));
      assert.deepStrictEqual(
        states.map((state) => [
          state.routingMode,
          state.efficiencyTier,
          state.latestDecision?.runId ?? null,
        ]),
        [
          ["manual", null, null],
          ["auto", "quality", null],
          ["auto", "quality", "run:acme-watched:1"],
        ],
      );
    }),
  );
});
