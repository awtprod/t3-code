import { assert, it } from "@effect/vitest";
import { MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProviderTurnSendClaimRepository } from "../Services/ProviderTurnSendClaims.ts";
import { ProviderTurnSendClaimRepositoryLive } from "./ProviderTurnSendClaims.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

// One in-memory database is shared by every case below, so each uses its own
// thread id rather than relying on a fresh table per test.
const layer = it.layer(
  ProviderTurnSendClaimRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const at = (seconds: number) =>
  `2026-01-01T00:00:${String(seconds).padStart(2, "0")}.000Z` as const;

layer("ProviderTurnSendClaimRepository", (it) => {
  it.effect("refuses a stale request once a newer one holds the message's claim", () =>
    Effect.gen(function* () {
      const claims = yield* ProviderTurnSendClaimRepository;
      const threadId = ThreadId.make("thread-contend");
      const messageId = MessageId.make("message-contend");

      // The original turn-start and its session-exit auto-resume are two events
      // asking to send ONE message. Only one may drive the provider, and the
      // reactor can reach them in either order — here the newer one first.
      const newer = yield* claims.acquire({
        threadId,
        messageId,
        requestSequence: 11,
        claimedAt: at(0),
      });
      const stale = yield* claims.acquire({
        threadId,
        messageId,
        requestSequence: 10,
        claimedAt: at(1),
      });

      assert.strictEqual(newer, true);
      assert.strictEqual(stale, false);
    }),
  );

  it.effect("hands the claim to a newer request and revokes it from the older one", () =>
    Effect.gen(function* () {
      const claims = yield* ProviderTurnSendClaimRepository;
      const threadId = ThreadId.make("thread-supersede");
      const messageId = MessageId.make("message-supersede");

      // Auto-resume after a session exit re-issues the SAME message at a higher
      // sequence, and it must be able to take the claim from the original it is
      // recovering. A first-wins rule would lock the resume out permanently and
      // silently disable session-exit recovery — the feature this table exists
      // to make safe, not to prevent. So the newer request wins...
      const original = yield* claims.acquire({
        threadId,
        messageId,
        requestSequence: 20,
        claimedAt: at(0),
      });
      const resume = yield* claims.acquire({
        threadId,
        messageId,
        requestSequence: 21,
        claimedAt: at(1),
      });
      // ...and the original, if it retries after losing, is now correctly told
      // it no longer holds the claim, so the prompt is still sent exactly once.
      const originalRetry = yield* claims.acquire({
        threadId,
        messageId,
        requestSequence: 20,
        claimedAt: at(2),
      });

      assert.strictEqual(original, true);
      assert.strictEqual(resume, true);
      assert.strictEqual(originalRetry, false);
    }),
  );

  it.effect("re-grants the claim to its own holder so a replay still sends", () =>
    Effect.gen(function* () {
      const claims = yield* ProviderTurnSendClaimRepository;
      const threadId = ThreadId.make("thread-replay");
      const messageId = MessageId.make("message-replay");

      // A request that already won must keep winning: the reactor can be
      // re-entered for the same event, and reading "someone holds this" as
      // "I was superseded" would drop the send entirely.
      const first = yield* claims.acquire({
        threadId,
        messageId,
        requestSequence: 20,
        claimedAt: at(0),
      });
      const replay = yield* claims.acquire({
        threadId,
        messageId,
        requestSequence: 20,
        claimedAt: at(1),
      });

      assert.strictEqual(first, true);
      assert.strictEqual(replay, true);
    }),
  );

  it.effect("refuses a request the cancel barrier already covers", () =>
    Effect.gen(function* () {
      const claims = yield* ProviderTurnSendClaimRepository;
      const threadId = ThreadId.make("thread-canceled");

      // The stop lands while the turn-start is still being prepared — the exact
      // window the old read-then-send could not see.
      yield* claims.cancel({ threadId, canceledThroughSequence: 30, updatedAt: at(0) });

      const blocked = yield* claims.acquire({
        threadId,
        messageId: MessageId.make("message-canceled"),
        requestSequence: 30,
        claimedAt: at(1),
      });
      assert.strictEqual(blocked, false);
    }),
  );

  it.effect("leaves a request issued after the stop free to send", () =>
    Effect.gen(function* () {
      const claims = yield* ProviderTurnSendClaimRepository;
      const threadId = ThreadId.make("thread-after-stop");

      yield* claims.cancel({ threadId, canceledThroughSequence: 40, updatedAt: at(0) });

      // A stop cancels the work queued before it, not the next thing the user
      // types. Over-cancelling here would silently wedge the thread.
      const allowed = yield* claims.acquire({
        threadId,
        messageId: MessageId.make("message-after-stop"),
        requestSequence: 41,
        claimedAt: at(1),
      });
      assert.strictEqual(allowed, true);
    }),
  );

  it.effect("does not lower an existing barrier when interrupts arrive out of order", () =>
    Effect.gen(function* () {
      const claims = yield* ProviderTurnSendClaimRepository;
      const threadId = ThreadId.make("thread-monotonic");

      yield* claims.cancel({ threadId, canceledThroughSequence: 60, updatedAt: at(0) });
      // An older interrupt processed late must not un-cancel work the newer one
      // already covered.
      yield* claims.cancel({ threadId, canceledThroughSequence: 50, updatedAt: at(1) });

      const stillBlocked = yield* claims.acquire({
        threadId,
        messageId: MessageId.make("message-monotonic"),
        requestSequence: 55,
        claimedAt: at(2),
      });
      assert.strictEqual(stillBlocked, false);
    }),
  );

  it.effect("scopes both the claim and the barrier to one thread", () =>
    Effect.gen(function* () {
      const claims = yield* ProviderTurnSendClaimRepository;
      const stoppedThread = ThreadId.make("thread-scope-stopped");
      const otherThread = ThreadId.make("thread-scope-other");
      const messageId = MessageId.make("message-scope");

      yield* claims.cancel({
        threadId: stoppedThread,
        canceledThroughSequence: 70,
        updatedAt: at(0),
      });

      // One thread's stop must not silence another's, and the same message id in
      // a different thread is different work.
      const blocked = yield* claims.acquire({
        threadId: stoppedThread,
        messageId,
        requestSequence: 70,
        claimedAt: at(1),
      });
      const unaffected = yield* claims.acquire({
        threadId: otherThread,
        messageId,
        requestSequence: 70,
        claimedAt: at(2),
      });

      assert.strictEqual(blocked, false);
      assert.strictEqual(unaffected, true);
    }),
  );
});
