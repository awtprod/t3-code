import { assert, it } from "@effect/vitest";
import { MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  ProviderTurnSendClaimRepository,
  type ProviderTurnSendClaimOutcome,
} from "../Services/ProviderTurnSendClaims.ts";
import { ProviderTurnSendClaimRepositoryLive } from "./ProviderTurnSendClaims.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

// One in-memory database is shared by every case below, so each uses its own
// thread id rather than relying on a fresh table per test.
const layer = it.layer(
  ProviderTurnSendClaimRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const at = (seconds: number) =>
  `2026-01-01T00:00:${String(seconds).padStart(2, "0")}.000Z` as const;

// Assertions read the tag, not a boolean, because the two refusals are not
// interchangeable to the caller: `canceled` makes the post-send fence interrupt
// a running turn and `superseded` makes it stand down. A test that only checked
// "did not acquire" would pass with those two swapped, which is precisely the
// defect the tagged outcome exists to prevent.
const tagOf = (outcome: ProviderTurnSendClaimOutcome) => outcome._tag;

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

      assert.strictEqual(tagOf(newer), "acquired");
      // Superseded, NOT canceled — nobody stopped anything here, and the fence
      // must be able to tell the difference.
      assert.deepStrictEqual(stale, { _tag: "superseded", heldBySequence: 11 });
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
      // it no longer holds the claim.
      //
      // Note what this does and does not establish. It bounds the ORIGINAL to a
      // single send; it does not make the message as a whole exactly-once at
      // this layer, because the resume was also granted, so two acquisitions
      // returned true for one message id. That is deliberate — the resume exists
      // precisely to re-drive a prompt whose first attempt died with its session
      // — and at-most-once for the *provider* is enforced above this table, by
      // the reactor's turn-start dedup and supersession guard. This repository
      // decides who may send, not how many sends reach the provider.
      const originalRetry = yield* claims.acquire({
        threadId,
        messageId,
        requestSequence: 20,
        claimedAt: at(2),
      });

      assert.strictEqual(tagOf(original), "acquired");
      assert.strictEqual(tagOf(resume), "acquired");
      assert.deepStrictEqual(originalRetry, { _tag: "superseded", heldBySequence: 21 });
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
      //
      // So an identical retry is row-idempotent but NOT send-idempotent: both
      // calls return true, and a caller that sent on each would prompt the
      // provider twice. Suppressing the duplicate is the reactor's job (the
      // `hasHandledTurnStartRecently` key), and the reactor test
      // "does not send twice when the same turn-start is delivered twice"
      // pins that at the boundary where it actually matters.
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

      assert.strictEqual(tagOf(first), "acquired");
      assert.strictEqual(tagOf(replay), "acquired");
    }),
  );

  it.effect("records a successful delivery for the current claim holder", () =>
    Effect.gen(function* () {
      const claims = yield* ProviderTurnSendClaimRepository;
      const threadId = ThreadId.make("thread-delivery-holder");
      const messageId = MessageId.make("message-delivery-holder");

      yield* claims.acquire({
        threadId,
        messageId,
        requestSequence: 30,
        claimedAt: at(0),
      });

      const delivery = yield* claims.recordDelivery({
        threadId,
        messageId,
        requestSequence: 30,
        turnId: TurnId.make("turn-holder"),
      });

      assert.deepStrictEqual(delivery, {
        _tag: "recorded",
        heldBySequence: 30,
        deliveredTurnId: TurnId.make("turn-holder"),
        supersededDeliveredTurnId: null,
      });
    }),
  );

  it.effect("moves an older stamped delivery aside when a newer holder delivers", () =>
    Effect.gen(function* () {
      const claims = yield* ProviderTurnSendClaimRepository;
      const threadId = ThreadId.make("thread-delivery-old-first");
      const messageId = MessageId.make("message-delivery-old-first");

      // The older RPC returns while it still owns the row and stamps the
      // current slot. A later claim takeover must move that concrete delivery
      // aside and clear the current slot: until the new RPC succeeds, ownership
      // is NOT replacement evidence and the old healthy turn must remain alive.
      yield* claims.acquire({
        threadId,
        messageId,
        requestSequence: 40,
        claimedAt: at(0),
      });
      yield* claims.recordDelivery({
        threadId,
        messageId,
        requestSequence: 40,
        turnId: TurnId.make("turn-older"),
      });
      yield* claims.acquire({
        threadId,
        messageId,
        requestSequence: 41,
        claimedAt: at(1),
      });

      // A takeover by itself clears the current-delivery slot. Re-stamping the
      // ex-holder before the replacement succeeds exposes that state directly:
      // ownership 41 is durable, but there is still no delivered replacement
      // with which a caller could justify interrupting turn-older.
      const beforeReplacement = yield* claims.recordDelivery({
        threadId,
        messageId,
        requestSequence: 40,
        turnId: TurnId.make("turn-older"),
      });
      const replacement = yield* claims.recordDelivery({
        threadId,
        messageId,
        requestSequence: 41,
        turnId: TurnId.make("turn-newer"),
      });

      assert.deepStrictEqual(beforeReplacement, {
        _tag: "recorded",
        heldBySequence: 41,
        deliveredTurnId: null,
        supersededDeliveredTurnId: TurnId.make("turn-older"),
      });
      assert.deepStrictEqual(replacement, {
        _tag: "recorded",
        heldBySequence: 41,
        deliveredTurnId: TurnId.make("turn-newer"),
        supersededDeliveredTurnId: TurnId.make("turn-older"),
      });
    }),
  );

  it.effect("records a late ex-holder delivery after the newer holder already delivered", () =>
    Effect.gen(function* () {
      const claims = yield* ProviderTurnSendClaimRepository;
      const threadId = ThreadId.make("thread-delivery-new-first");
      const messageId = MessageId.make("message-delivery-new-first");

      // The opposite completion order. Both requests acquire before either RPC
      // returns; the replacement stamps first and initially sees no old
      // delivery. When the old RPC returns late it writes the superseded slot
      // and reads the replacement already present, so the stale sender has all
      // the evidence needed to interrupt itself.
      yield* claims.acquire({
        threadId,
        messageId,
        requestSequence: 50,
        claimedAt: at(0),
      });
      yield* claims.acquire({
        threadId,
        messageId,
        requestSequence: 51,
        claimedAt: at(1),
      });
      const replacementFirst = yield* claims.recordDelivery({
        threadId,
        messageId,
        requestSequence: 51,
        turnId: TurnId.make("turn-newer"),
      });
      const staleLast = yield* claims.recordDelivery({
        threadId,
        messageId,
        requestSequence: 50,
        turnId: TurnId.make("turn-older"),
      });

      assert.deepStrictEqual(replacementFirst, {
        _tag: "recorded",
        heldBySequence: 51,
        deliveredTurnId: TurnId.make("turn-newer"),
        supersededDeliveredTurnId: null,
      });
      assert.deepStrictEqual(staleLast, {
        _tag: "recorded",
        heldBySequence: 51,
        deliveredTurnId: TurnId.make("turn-newer"),
        supersededDeliveredTurnId: TurnId.make("turn-older"),
      });
    }),
  );

  it.effect("does not invent delivery evidence when no claim row owns the send", () =>
    Effect.gen(function* () {
      const claims = yield* ProviderTurnSendClaimRepository;

      const delivery = yield* claims.recordDelivery({
        threadId: ThreadId.make("thread-delivery-unowned"),
        messageId: MessageId.make("message-delivery-unowned"),
        requestSequence: 60,
        turnId: TurnId.make("turn-unowned"),
      });

      assert.deepStrictEqual(delivery, { _tag: "unowned" });
    }),
  );

  it.effect("settles on the highest sequence whatever order the writes interleave in", () =>
    Effect.gen(function* () {
      const claims = yield* ProviderTurnSendClaimRepository;
      const threadId = ThreadId.make("thread-race");
      const messageId = MessageId.make("message-race");

      // Every other case here calls `acquire` in an order this file chose, so
      // they establish the resolution RULE against a schedule the test author
      // picked. Here the schedule is the driver's: eight fibers are submitted at
      // once and land in whatever order it interleaves them.
      //
      // This is deliberately NOT billed as a concurrent-writer test, because no
      // in-process test can be one. `node:sqlite` exposes a SYNCHRONOUS
      // `DatabaseSync`, so a statement occupies the thread for its whole
      // duration; two of them cannot overlap in one process no matter how many
      // clients or fibers are involved. `NodeSqliteClient` additionally funnels
      // every caller through a one-permit semaphore (NodeSqliteClient.ts:256).
      // Real overlap needs separate processes, which is an integration test, not
      // this one. What IS covered here is the property that survives that
      // limitation and that the sequential cases cannot see: the outcome does
      // not depend on arrival order.
      const sequences = [100, 101, 102, 103, 104, 105, 106, 107];
      yield* Effect.all(
        sequences.map((requestSequence) =>
          claims.acquire({ threadId, messageId, requestSequence, claimedAt: at(0) }),
        ),
        { concurrency: "unbounded" },
      );

      // Asserted from a probe rather than from the acquire return values,
      // because who holds the claim DURING the interleaving is nondeterministic
      // by design — a fiber granted it can be superseded immediately after, so
      // its `true` was honest when returned and stale by the time it is read.
      //
      // The probe is every LOSING sequence, and it is chosen so that it cannot
      // manufacture the answer it checks for. `acquire` only rewrites the row
      // when the incoming sequence is strictly greater, so a request below the
      // settled owner is a pure read. That makes the all-`superseded` result
      // load-bearing in both directions: were the owner some X < 107, probing X
      // (a replay of the winner) or X + 1 (a supersession) would come back
      // `acquired` and this assertion would fail. All seven being superseded
      // therefore pins the owner at 107 exactly.
      //
      // `superseded` rather than merely "not acquired" is also load-bearing: no
      // barrier was ever raised on this thread, so a `canceled` here would mean
      // the repository invents stops, which would make the fence interrupt
      // healthy turns.
      //
      // Deleting the interleaved block above makes this fail rather than pass:
      // with no row at all, `acquire(100)` inserts and comes back `acquired`.
      const loserProbes = yield* Effect.all(
        sequences
          .filter((requestSequence) => requestSequence !== 107)
          .map((requestSequence) =>
            claims.acquire({ threadId, messageId, requestSequence, claimedAt: at(2) }),
          ),
      );

      assert.deepStrictEqual(loserProbes.map(tagOf), [
        "superseded",
        "superseded",
        "superseded",
        "superseded",
        "superseded",
        "superseded",
        "superseded",
      ]);
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
      assert.strictEqual(tagOf(blocked), "canceled");
    }),
  );

  it.effect("revokes a claim the stop overtakes after it was already granted", () =>
    Effect.gen(function* () {
      const claims = yield* ProviderTurnSendClaimRepository;
      const threadId = ThreadId.make("thread-revoked");
      const messageId = MessageId.make("message-revoked");

      // The other cancel tests all raise the barrier BEFORE the claim exists, so
      // they only ever exercise the insert's guard. This is the opposite order,
      // and it is the one that actually happens when a user hits stop on a turn
      // that is already being prepared: the claim row is written first and the
      // stop arrives afterwards.
      //
      // Nothing deletes or rewrites the claim row when a barrier is raised — the
      // cancel touches a different table entirely — so an owner read that
      // consulted only the claim would still name this request as holder and
      // wave through a send the user already stopped.
      const granted = yield* claims.acquire({
        threadId,
        messageId,
        requestSequence: 80,
        claimedAt: at(0),
      });
      yield* claims.cancel({ threadId, canceledThroughSequence: 80, updatedAt: at(1) });
      const afterStop = yield* claims.acquire({
        threadId,
        messageId,
        requestSequence: 80,
        claimedAt: at(2),
      });

      assert.strictEqual(tagOf(granted), "acquired");
      assert.strictEqual(tagOf(afterStop), "canceled");
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
      assert.strictEqual(tagOf(allowed), "acquired");
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
      assert.strictEqual(tagOf(stillBlocked), "canceled");
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

      assert.strictEqual(tagOf(blocked), "canceled");
      assert.strictEqual(tagOf(unaffected), "acquired");
    }),
  );

  it.effect("reports whether a message was ever cleared to reach the provider", () =>
    Effect.gen(function* () {
      const claims = yield* ProviderTurnSendClaimRepository;
      const threadId = ThreadId.make("thread-ever-claimed");
      const sent = MessageId.make("message-ever-sent");
      const neverSent = MessageId.make("message-never-sent");

      // Recovery asks this question to decide whether re-issuing a message
      // could duplicate work the provider already did. A message with no claim
      // provably never reached the adapter — the acquire is the statement
      // immediately upstream of `sendTurn`.
      assert.strictEqual(yield* claims.hasEverClaimed({ threadId, messageId: sent }), false);
      assert.strictEqual(yield* claims.hasEverClaimed({ threadId, messageId: neverSent }), false);

      yield* claims.acquire({
        threadId,
        messageId: sent,
        requestSequence: 90,
        claimedAt: at(0),
      });

      assert.strictEqual(yield* claims.hasEverClaimed({ threadId, messageId: sent }), true);
      // Scoped to the message, not the thread: a sibling message on the same
      // thread must not inherit its neighbour's send.
      assert.strictEqual(yield* claims.hasEverClaimed({ threadId, messageId: neverSent }), false);
      // And scoped to the thread: the same message id elsewhere is other work.
      assert.strictEqual(
        yield* claims.hasEverClaimed({
          threadId: ThreadId.make("thread-ever-claimed-other"),
          messageId: sent,
        }),
        false,
      );
    }),
  );

  it.effect("still reports a claimed message as sent after a later stop cancels the thread", () =>
    Effect.gen(function* () {
      const claims = yield* ProviderTurnSendClaimRepository;
      const threadId = ThreadId.make("thread-ever-claimed-stopped");
      const messageId = MessageId.make("message-ever-claimed-stopped");

      yield* claims.acquire({ threadId, messageId, requestSequence: 100, claimedAt: at(0) });
      // The user stops the thread afterwards. That raises the barrier, so a
      // fresh acquire is refused — but it does not un-send the prompt that
      // already went out, and recovery is asking about the past, not the
      // present. Filtering this read by the barrier would report delivered work
      // as never-attempted and re-run it.
      yield* claims.cancel({ threadId, canceledThroughSequence: 100, updatedAt: at(1) });

      const refused = yield* claims.acquire({
        threadId,
        messageId,
        requestSequence: 100,
        claimedAt: at(2),
      });
      assert.strictEqual(tagOf(refused), "canceled");
      assert.strictEqual(yield* claims.hasEverClaimed({ threadId, messageId }), true);
    }),
  );
});
