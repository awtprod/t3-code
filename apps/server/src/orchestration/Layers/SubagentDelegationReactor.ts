import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  SUBAGENT_FAILED_ACTIVITY_KIND,
  SUBAGENT_PARENT_ACTIVITY_KIND,
  SUBAGENT_REPORTED_ACTIVITY_KIND,
  SUBAGENT_STARTED_ACTIVITY_KIND,
  type ThreadId,
  ThreadSubagentDelegation,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { truncate } from "@t3tools/shared/String";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { forkParked } from "../../serverActivation.ts";
import { OrchestrationCommandDispatcher } from "../CommandDispatcher.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  SubagentDelegationReactor,
  type SubagentDelegationReactorShape,
} from "../Services/SubagentDelegationReactor.ts";

type ActivityAppendedEvent = Extract<OrchestrationEvent, { type: "thread.activity-appended" }>;
/** Events that can settle a child's turn: the session going idle, or the
 * turn's checkpoint landing after it did. */
type ChildTurnEvent = Extract<
  OrchestrationEvent,
  { type: "thread.session-set" | "thread.turn-diff-completed" }
>;

const decodeDelegation = Schema.decodeUnknownOption(ThreadSubagentDelegation);

/** Parent messages handed to a new subagent as context, newest last. */
const CONTEXT_MESSAGE_LIMIT = 8;
const CONTEXT_MESSAGE_CHARS = 1_500;
/** Longest subagent reply posted back into the parent. */
const REPORT_CHARS = 8_000;
/** Longest slice of the parent title a subagent thread's title keeps. */
const TITLE_CHARS = 80;

/**
 * The first message of a new subagent: who handed the task over, the recent
 * parent conversation it cannot otherwise see, and the task itself.
 */
export function buildSubagentHandoffText(input: {
  readonly parent: OrchestrationThread;
  readonly delegatedMessageId: MessageId;
  readonly task: string;
}): string {
  const history = input.parent.messages
    .filter(
      (message) =>
        message.id !== input.delegatedMessageId &&
        !message.streaming &&
        (message.role === "user" || message.role === "assistant") &&
        message.text.trim().length > 0,
    )
    .slice(-CONTEXT_MESSAGE_LIMIT)
    .map((message) => `--- ${message.role} ---\n${truncate(message.text, CONTEXT_MESSAGE_CHARS)}`);
  return [
    `[Subagent handoff] Command Center routed this turn from the thread "${input.parent.title}" (on ${input.parent.modelSelection.model}) to you. Do the task below; your final reply is posted back to that thread.`,
    ...(history.length === 0 ? [] : ["Recent conversation in that thread:", ...history]),
    `Task:\n${input.task}`,
  ].join("\n\n");
}

/**
 * The subagent's reply to its latest turn: the last completed assistant
 * message of that turn, or undefined when the turn is still running or
 * predates the delegation.
 */
export function subagentReport(
  child: OrchestrationThread,
  since: string,
):
  | {
      readonly turnId: string;
      readonly state: "completed" | "interrupted" | "error";
      readonly text: string | undefined;
    }
  | undefined {
  const turn = child.latestTurn;
  if (turn === null || turn.state === "running" || turn.requestedAt < since) return undefined;
  const reply = child.messages.findLast(
    (message) => message.role === "assistant" && message.turnId === turn.turnId,
  );
  return { turnId: turn.turnId, state: turn.state, text: reply?.text };
}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const dispatcher = yield* OrchestrationCommandDispatcher;
  const crypto = yield* Crypto.Crypto;

  /**
   * Children with a delegated turn in flight, keyed by child thread. In memory
   * only: a server restart mid-turn drops the report-back, while the parent's
   * `routing.subagent-started` activity still names the child thread.
   */
  const pendingReports = new Map<
    ThreadId,
    { readonly parentThreadId: ThreadId; readonly since: string; readonly model: string }
  >();

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((id) => CommandId.make(`server:${tag}:${id}`)));

  const appendActivity = (
    threadId: ThreadId,
    activity: Omit<OrchestrationThreadActivity, "id" | "createdAt" | "turnId">,
  ) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: yield* commandId("subagent-activity"),
        threadId,
        activity: {
          ...activity,
          id: EventId.make(yield* crypto.randomUUIDv4),
          turnId: null,
          createdAt,
        },
        createdAt,
      });
    });

  const startSubagentTurn = Effect.fn("startSubagentTurn")(function* (
    parentThreadId: ThreadId,
    delegation: ThreadSubagentDelegation,
  ) {
    const parent = Option.getOrUndefined(yield* snapshots.getThreadDetailById(parentThreadId));
    if (parent === undefined) return;
    const message = parent.messages.find((entry) => entry.id === delegation.messageId);
    if (message === undefined) return;
    const { childThreadId, efficiencyDecision, modelSelection } = delegation;
    const reuse =
      delegation.reuseChild && Option.isSome(yield* snapshots.getThreadShellById(childThreadId));
    const createdAt = yield* nowIso;
    const turn = {
      type: "thread.turn.start" as const,
      commandId: yield* commandId("subagent-turn"),
      threadId: childThreadId,
      message: {
        messageId: MessageId.make(yield* crypto.randomUUIDv4),
        role: "user" as const,
        text: reuse
          ? message.text
          : buildSubagentHandoffText({
              parent,
              delegatedMessageId: delegation.messageId,
              task: message.text,
            }),
        attachments: message.attachments ?? [],
      },
      modelSelection,
      efficiencyTier: efficiencyDecision.tier,
      efficiencyDecision,
      runtimeMode: parent.runtimeMode,
      interactionMode: delegation.interactionMode,
      createdAt,
    };
    pendingReports.set(childThreadId, {
      parentThreadId,
      since: createdAt,
      model: modelSelection.model,
    });
    yield* dispatcher
      .dispatchNormalized(
        reuse
          ? turn
          : {
              ...turn,
              bootstrap: {
                createThread: {
                  projectId: parent.projectId,
                  title: `${parent.title.slice(0, TITLE_CHARS)} (subagent)`,
                  modelSelection,
                  // Pinned to the routed model: a subagent is that model's
                  // worker, and a pinned child is what reuse matches on.
                  routingMode: "manual",
                  efficiencyTier: efficiencyDecision.tier,
                  runtimeMode: parent.runtimeMode,
                  interactionMode: delegation.interactionMode,
                  branch: parent.branch,
                  worktreePath: parent.worktreePath,
                  createdAt,
                },
              },
            },
      )
      .pipe(Effect.tapError(() => Effect.sync(() => pendingReports.delete(childThreadId))));
    if (!reuse) {
      yield* appendActivity(childThreadId, {
        tone: "info",
        kind: SUBAGENT_PARENT_ACTIVITY_KIND,
        summary: `Subagent of "${parent.title}"`,
        payload: {
          parentThreadId,
          detail: `Started by auto routing from thread ${parentThreadId}; the reply to each delegated turn is posted back there.`,
        },
      });
    }
  });

  const processSubagentStarted = Effect.fn("processSubagentStarted")(function* (
    event: ActivityAppendedEvent,
  ) {
    const parentThreadId = event.payload.threadId;
    const delegation = Option.getOrUndefined(decodeDelegation(event.payload.activity.payload));
    if (delegation === undefined) {
      return yield* Effect.logWarning("subagent delegation payload did not decode", {
        threadId: parentThreadId,
      });
    }
    yield* startSubagentTurn(parentThreadId, delegation).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : appendActivity(parentThreadId, {
              tone: "error",
              kind: SUBAGENT_FAILED_ACTIVITY_KIND,
              summary: `Could not start the ${delegation.modelSelection.model} subagent`,
              payload: {
                childThreadId: delegation.childThreadId,
                detail: Cause.pretty(cause),
              },
            }),
      ),
    );
  });

  const processChildTurnEvent = Effect.fn("processChildTurnEvent")(function* (
    event: ChildTurnEvent,
  ) {
    const childThreadId = event.payload.threadId;
    const pending = pendingReports.get(childThreadId);
    if (pending === undefined) return;
    const child = Option.getOrUndefined(yield* snapshots.getThreadDetailById(childThreadId));
    if (child === undefined) {
      pendingReports.delete(childThreadId);
      return;
    }
    const report = subagentReport(child, pending.since);
    if (report === undefined) return;
    pendingReports.delete(childThreadId);
    const outcome =
      report.state === "completed"
        ? "finished"
        : report.state === "error"
          ? "failed"
          : "was interrupted";
    yield* appendActivity(pending.parentThreadId, {
      tone: report.state === "error" ? "error" : "info",
      kind: SUBAGENT_REPORTED_ACTIVITY_KIND,
      summary: `${pending.model} subagent ${outcome}`,
      payload: {
        childThreadId,
        turnId: report.turnId,
        state: report.state,
        detail:
          report.text === undefined || report.text.trim().length === 0
            ? `No reply. See subagent thread ${childThreadId}.`
            : truncate(report.text, REPORT_CHARS),
      },
    });
  });

  const processEvent = (event: ActivityAppendedEvent | ChildTurnEvent) =>
    (event.type === "thread.activity-appended"
      ? processSubagentStarted(event)
      : processChildTurnEvent(event)
    ).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("subagent delegation reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processEvent);

  const start: SubagentDelegationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        if (
          event.type === "thread.activity-appended" &&
          event.payload.activity.kind === SUBAGENT_STARTED_ACTIVITY_KIND
        ) {
          return worker.enqueue(event);
        }
        if (
          (event.type === "thread.session-set" || event.type === "thread.turn-diff-completed") &&
          pendingReports.has(event.payload.threadId)
        ) {
          return worker.enqueue(event);
        }
        return Effect.void;
      }),
    );
  });

  return { start, drain: worker.drain } satisfies SubagentDelegationReactorShape;
});

export const SubagentDelegationReactorLive = Layer.effect(SubagentDelegationReactor, make);
