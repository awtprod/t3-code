/**
 * Covers `listThreadTurnStartsAboveCutoff` — the read that decides which
 * turn-starts an escalated session stop spared and still owes a re-drive.
 *
 * It lives in its own file because every case here needs a hand-built event
 * stream rather than the round-trip fixtures the sibling suite uses, and
 * because the rules it encodes (barrier-complementary bounds, later
 * cancellation, terminal settlement, per-request payload fields) are the ones a
 * future change is most likely to break silently: a wrong answer here is a
 * prompt the user typed and never sees run, or the same prompt run twice.
 */
import {
  CommandId,
  EventId,
  MessageId,
  NonNegativeInt,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-cutoff");

let eventCounter = 0;
const nextEventId = () => EventId.make(`evt-cutoff-${++eventCounter}`);

const appendTurnStart = (
  store: typeof OrchestrationEventStore.Service,
  input: {
    readonly messageId: string;
    readonly modelSelection?: { readonly instanceId: string; readonly model: string };
    readonly sourceProposedPlan?: { readonly threadId: string; readonly planId: string };
  },
) =>
  store.append({
    type: "thread.turn-start-requested",
    eventId: nextEventId(),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: NOW,
    commandId: CommandId.make(`cmd-${input.messageId}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId: THREAD_ID,
      messageId: MessageId.make(input.messageId),
      runtimeMode: "approval-required",
      interactionMode: "default",
      ...(input.modelSelection
        ? {
            modelSelection: {
              instanceId: input.modelSelection.instanceId,
              model: input.modelSelection.model,
            },
          }
        : {}),
      ...(input.sourceProposedPlan
        ? {
            sourceProposedPlan: {
              threadId: ThreadId.make(input.sourceProposedPlan.threadId),
              planId: input.sourceProposedPlan.planId,
            },
          }
        : {}),
      createdAt: NOW,
    },
  } as never);

const appendStop = (
  store: typeof OrchestrationEventStore.Service,
  input: { readonly canceledThroughSequence?: number },
) =>
  store.append({
    type: "thread.session-stop-requested",
    eventId: nextEventId(),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: NOW,
    commandId: CommandId.make(`cmd-stop-${eventCounter}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId: THREAD_ID,
      ...(input.canceledThroughSequence !== undefined
        ? { canceledThroughSequence: NonNegativeInt.make(input.canceledThroughSequence) }
        : {}),
      createdAt: NOW,
    },
  } as never);

/**
 * `status` is not decoration here. The read distinguishes the stop's own
 * teardown from a turn reaching its own end by that field alone — teardown
 * writes "stopped", a completion writes "ready"/"error"/"interrupted" — so a
 * fixture that writes the wrong one tests the opposite of what it claims.
 * Callers must therefore say which of the two they are building.
 */
const appendSessionSet = (
  store: typeof OrchestrationEventStore.Service,
  input: {
    readonly activeTurnId: string | null;
    readonly status?: "ready" | "error" | "interrupted" | "stopped";
    readonly turnRequestSequence?: number;
  },
) =>
  store.append({
    type: "thread.session-set",
    eventId: nextEventId(),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: NOW,
    commandId: CommandId.make(`cmd-session-${eventCounter}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId: THREAD_ID,
      session: {
        threadId: THREAD_ID,
        status: input.status ?? (input.activeTurnId === null ? "ready" : "running"),
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: input.activeTurnId === null ? null : TurnId.make(input.activeTurnId),
        lastError: null,
        updatedAt: NOW,
      },
      ...(input.turnRequestSequence !== undefined
        ? { turnRequestSequence: NonNegativeInt.make(input.turnRequestSequence) }
        : {}),
    },
  } as never);

layer("OrchestrationEventStore.listThreadTurnStartsAboveCutoff", (it) => {
  it.effect("returns only the turn-starts strictly between the cutoff and the stop", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;

      // Below the cutoff: the barrier already refuses it, so listing it here
      // would have the two disagree about the same request.
      const canceled = yield* appendTurnStart(store, { messageId: "msg-canceled" });
      const spared = yield* appendTurnStart(store, { messageId: "msg-spared" });
      const stop = yield* appendStop(store, {
        canceledThroughSequence: canceled.sequence,
      });
      // Above the stop: not yet processed, so it will drive itself.
      yield* appendTurnStart(store, { messageId: "msg-after-stop" });

      const result = yield* store.listThreadTurnStartsAboveCutoff({
        threadId: THREAD_ID,
        canceledThroughSequence: NonNegativeInt.make(canceled.sequence),
        stopSequence: NonNegativeInt.make(stop.sequence),
      });

      assert.deepEqual(
        result.map((entry) => entry.messageId),
        ["msg-spared"],
      );
      assert.equal(result[0]?.sequence, spared.sequence);
    }),
  );

  it.effect("excludes a spared request a later stop canceled", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;

      // The interleaving codex named: interrupt A → replacement start B → the
      // user presses stop → the escalation for A finally lands. The escalation's
      // cutoff spares B, but the user already canceled it, and re-appending it
      // above that stop's barrier would restart the session they shut down.
      const interrupted = yield* appendTurnStart(store, { messageId: "msg-a" });
      const replacement = yield* appendTurnStart(store, { messageId: "msg-b" });
      yield* appendStop(store, {});
      const escalation = yield* appendStop(store, {
        canceledThroughSequence: interrupted.sequence,
      });

      const result = yield* store.listThreadTurnStartsAboveCutoff({
        threadId: THREAD_ID,
        canceledThroughSequence: NonNegativeInt.make(interrupted.sequence),
        stopSequence: NonNegativeInt.make(escalation.sequence),
      });

      assert.deepEqual(result, []);
      // Pin the premise: the excluded request really was in the spared window,
      // so this asserts the cancellation guard rather than the outer bounds.
      assert.ok(replacement.sequence > interrupted.sequence);
      assert.ok(replacement.sequence < escalation.sequence);
    }),
  );

  it.effect("excludes a spared request whose turn already settled", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;

      const interrupted = yield* appendTurnStart(store, { messageId: "msg-a" });
      const replacement = yield* appendTurnStart(store, { messageId: "msg-b" });
      // Adopted by a turn that names it, then settled: the session goes quiet
      // with no active turn while the escalation is still retrying.
      yield* appendSessionSet(store, {
        activeTurnId: "turn-b",
        turnRequestSequence: replacement.sequence,
      });
      yield* appendSessionSet(store, { activeTurnId: null });
      const escalation = yield* appendStop(store, {
        canceledThroughSequence: interrupted.sequence,
      });

      const result = yield* store.listThreadTurnStartsAboveCutoff({
        threadId: THREAD_ID,
        canceledThroughSequence: NonNegativeInt.make(interrupted.sequence),
        stopSequence: NonNegativeInt.make(escalation.sequence),
      });

      assert.deepEqual(result, []);
    }),
  );

  it.effect("keeps a spared request whose turn started but never settled", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;

      // The case the whole re-drive exists for: the request reached the session
      // and is still running when the teardown kills it. Adoption alone must not
      // exclude it — only adoption FOLLOWED by the session going quiet.
      const interrupted = yield* appendTurnStart(store, { messageId: "msg-a" });
      const replacement = yield* appendTurnStart(store, { messageId: "msg-b" });
      yield* appendSessionSet(store, {
        activeTurnId: "turn-b",
        turnRequestSequence: replacement.sequence,
      });
      const escalation = yield* appendStop(store, {
        canceledThroughSequence: interrupted.sequence,
      });
      // The stop's own teardown, appended exactly where the reactor appends it:
      // `processSessionStopRequested` writes the stopped session BEFORE calling
      // this read. It clears `activeTurnId` for whatever was running, so a
      // settlement check that counted it would exclude every candidate on every
      // call and quietly turn this read into a no-op. `status: "stopped"` is
      // what makes it the teardown and not a completion — the reactor hardcodes
      // that status at the one site that performs this write.
      yield* appendSessionSet(store, { activeTurnId: null, status: "stopped" });

      const result = yield* store.listThreadTurnStartsAboveCutoff({
        threadId: THREAD_ID,
        canceledThroughSequence: NonNegativeInt.make(interrupted.sequence),
        stopSequence: NonNegativeInt.make(escalation.sequence),
      });

      assert.deepEqual(
        result.map((entry) => entry.messageId),
        ["msg-b"],
      );
    }),
  );

  it.effect("excludes a spared request that completed after the stop was appended", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;

      // The ordering that a sequence bound gets wrong. The stop event commits,
      // and the provider's `turn.completed` for an already-running spared turn
      // is ingested in the window BEFORE the stop handler performs this read.
      // That completion is a genuine settlement — the user has the answer — but
      // it sits above the stop, so a guard that only looked below would miss it
      // and re-drive the prompt a second time.
      const interrupted = yield* appendTurnStart(store, { messageId: "msg-a" });
      const replacement = yield* appendTurnStart(store, { messageId: "msg-b" });
      yield* appendSessionSet(store, {
        activeTurnId: "turn-b",
        turnRequestSequence: replacement.sequence,
      });
      const escalation = yield* appendStop(store, {
        canceledThroughSequence: interrupted.sequence,
      });
      // Above the stop, and "ready" rather than "stopped": ingestion's mapping
      // for a `turn.completed` that did not fail.
      yield* appendSessionSet(store, { activeTurnId: null, status: "ready" });

      const result = yield* store.listThreadTurnStartsAboveCutoff({
        threadId: THREAD_ID,
        canceledThroughSequence: NonNegativeInt.make(interrupted.sequence),
        stopSequence: NonNegativeInt.make(escalation.sequence),
      });

      assert.deepEqual(result, []);
    }),
  );

  it.effect("excludes a spared request whose turn was interrupted after the stop", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;

      // Same ordering, the other terminal status a live runtime can report.
      // Guarding by an allowlist of "ready"/"error" would re-drive this one:
      // `session.state.changed` maps runtime state "interrupted" straight
      // through, so settlement is anything that is NOT the stop's teardown.
      const interrupted = yield* appendTurnStart(store, { messageId: "msg-a" });
      const replacement = yield* appendTurnStart(store, { messageId: "msg-b" });
      yield* appendSessionSet(store, {
        activeTurnId: "turn-b",
        turnRequestSequence: replacement.sequence,
      });
      const escalation = yield* appendStop(store, {
        canceledThroughSequence: interrupted.sequence,
      });
      yield* appendSessionSet(store, { activeTurnId: null, status: "interrupted" });

      const result = yield* store.listThreadTurnStartsAboveCutoff({
        threadId: THREAD_ID,
        canceledThroughSequence: NonNegativeInt.make(interrupted.sequence),
        stopSequence: NonNegativeInt.make(escalation.sequence),
      });

      assert.deepEqual(result, []);
    }),
  );

  it.effect("carries each request's own model selection and source plan", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;

      const interrupted = yield* appendTurnStart(store, { messageId: "msg-a" });
      yield* appendTurnStart(store, {
        messageId: "msg-model",
        modelSelection: { instanceId: "codex", model: "gpt-5" },
      });
      yield* appendTurnStart(store, {
        messageId: "msg-plan",
        sourceProposedPlan: { threadId: "thread-plan-source", planId: "plan-1" },
      });
      yield* appendTurnStart(store, { messageId: "msg-bare" });
      const escalation = yield* appendStop(store, {
        canceledThroughSequence: interrupted.sequence,
      });

      const result = yield* store.listThreadTurnStartsAboveCutoff({
        threadId: THREAD_ID,
        canceledThroughSequence: NonNegativeInt.make(interrupted.sequence),
        stopSequence: NonNegativeInt.make(escalation.sequence),
      });

      const byMessageId = new Map(result.map((entry) => [entry.messageId, entry]));
      assert.deepEqual(byMessageId.get(MessageId.make("msg-model"))?.modelSelection, {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5",
      });
      assert.deepEqual(byMessageId.get(MessageId.make("msg-plan"))?.sourceProposedPlan, {
        threadId: ThreadId.make("thread-plan-source"),
        planId: "plan-1",
      });
      // Absent on the payload must stay absent, not become `null`: a caller
      // spreading these into a resume command would otherwise turn "no model
      // named" into an explicit null selection.
      const bare = byMessageId.get(MessageId.make("msg-bare"));
      assert.equal(bare?.modelSelection, undefined);
      assert.equal(bare?.sourceProposedPlan, undefined);
      assert.ok(bare !== undefined && !("modelSelection" in bare));
    }),
  );

  it.effect("scopes the scan to one thread", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;
      const otherThreadId = ThreadId.make("thread-other");

      const interrupted = yield* appendTurnStart(store, { messageId: "msg-a" });
      yield* store.append({
        type: "thread.turn-start-requested",
        eventId: nextEventId(),
        aggregateKind: "thread",
        aggregateId: otherThreadId,
        occurredAt: NOW,
        commandId: CommandId.make("cmd-other-thread"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId: otherThreadId,
          messageId: MessageId.make("msg-other-thread"),
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt: NOW,
        },
      } as never);
      const escalation = yield* appendStop(store, {
        canceledThroughSequence: interrupted.sequence,
      });

      const result = yield* store.listThreadTurnStartsAboveCutoff({
        threadId: THREAD_ID,
        canceledThroughSequence: NonNegativeInt.make(interrupted.sequence),
        stopSequence: NonNegativeInt.make(escalation.sequence),
      });

      assert.deepEqual(result, []);
    }),
  );
});
