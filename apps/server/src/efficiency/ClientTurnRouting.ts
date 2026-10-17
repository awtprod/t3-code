/**
 * Token-efficiency routing for client turns on orchestration V2: the V2
 * equivalent of the fork's V1 `OrchestrationCommandDispatcher.resolve`.
 *
 * The WebSocket `dispatchCommand` and `launchThread` handlers pass every
 * client command through {@link dispatchClientCommand} /
 * {@link launchClientThread} before `ThreadMessageIntake`. A user
 * `message.dispatch` on a thread whose side-channel routing mode
 * ({@link ./ThreadRouting.ts}) is `auto` gets the routed model selection; the
 * decision is recorded per V2 run. Everything else, and every command while
 * `settings.efficiency.enabled` is false (the default), is dispatched as the
 * exact same object, untouched.
 *
 * Delegation: when the routed selection is one the thread's bound provider
 * cannot serve in place ({@link routedSelectionNeedsSubagent}), the turn runs
 * in a child thread instead, built from upstream primitives: `thread.fork`
 * (native context transfer) and a `message.dispatch` into the child on the
 * routed model. A recent idle child on the same selection is reused, with a
 * bounded handoff of the parent's newer conversation. Children never delegate
 * again, and plan acceptances and retries stay on the parent.
 *
 * @module ClientTurnRouting
 */
import {
  CommandId,
  type EfficiencyDecision,
  type ServerSettings,
  type MessageId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type { OrchestratorV2DispatchResult } from "../orchestration-v2/Orchestrator.ts";
import type {
  ThreadLaunchInput,
  ThreadLaunchResult,
} from "../orchestration-v2/ThreadLaunchService.ts";
import { isForkableSourceRunStatus } from "../orchestration-v2/ThreadForkService.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  interactiveTurnMatchesRule,
  resolveInteractiveEfficiency,
  routedSelectionNeedsSubagent,
  type TierJudgmentInput,
  type TurnStartCommand,
} from "./EfficiencyRouting.ts";
import { Judge } from "./Judge.ts";
import {
  buildTierJudgmentRequest,
  findRouteContext,
  tierJudgmentFromAnswers,
} from "./TierJudgment.ts";
import { type StoredThreadRouting, ThreadRoutingService } from "./ThreadRouting.ts";

/** Every bound of the delegation trigger, in one place. */
export const DELEGATION_BOUNDS = {
  /** Most recent distinct routed children of a parent considered for reuse. */
  reusableChildLookback: 5,
  /** Delegation rows read to find those children. */
  delegationRowsRead: 50,
  /** Parent messages handed to a reused child, newest last. */
  handoffMessageLimit: 8,
  /** Longest slice of each handed-off message. */
  handoffMessageChars: 1_500,
  /** Longest slice of the parent title a child thread's title keeps. */
  childTitleChars: 80,
} as const;

/** A message that is a provider slash command such as `/compact` or `/review base`. */
const PROVIDER_SLASH_COMMAND = /^\s*\/[A-Za-z][\w:-]*(?:\s|$)/u;

/** Routing decisions read for sticky routing and the route's task message. */
const ROUTE_CONTEXT_DECISIONS = 50;

type MessageDispatchCommand = Extract<
  OrchestrationV2Command,
  { readonly type: "message.dispatch" }
>;
type ThreadForkCommand = Extract<OrchestrationV2Command, { readonly type: "thread.fork" }>;

/** A V2 run that blocks a new turn from starting immediately. */
const isActiveRun = (run: Pick<OrchestrationV2Run, "status">): boolean =>
  run.status === "preparing" ||
  run.status === "starting" ||
  run.status === "running" ||
  run.status === "waiting";

export interface RoutingThreadSnapshot {
  readonly thread: OrchestrationV2AppThread;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
}

export interface ConversationLine {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/** The V2 reads routing needs; the live layer reads the V2 projection read-only. */
export interface ClientTurnRoutingReads {
  readonly thread: (threadId: ThreadId) => Effect.Effect<RoutingThreadSnapshot | undefined>;
  readonly messageText: (messageId: MessageId) => Effect.Effect<string | undefined>;
  /** Newest-last settled user/assistant messages, at most `limit`. */
  readonly recentConversation: (
    threadId: ThreadId,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<ConversationLine>>;
}

export class ClientTurnRoutingReadsService extends Context.Service<
  ClientTurnRoutingReadsService,
  ClientTurnRoutingReads
>()("@awtprod/command-center/efficiency/ClientTurnRouting/ClientTurnRoutingReadsService") {}

export type ClientDispatchPlan =
  | { readonly type: "unrouted"; readonly reason: string }
  | {
      readonly type: "routed";
      readonly command: MessageDispatchCommand;
      readonly decision: EfficiencyDecision;
      readonly consumedRetry: boolean;
    }
  | {
      readonly type: "delegated";
      readonly parentThreadId: ThreadId;
      readonly childThreadId: ThreadId;
      readonly reusedChild: boolean;
      /** Absent when an existing child is reused. */
      readonly fork?: ThreadForkCommand;
      /** The turn, addressed to the child on the routed model. */
      readonly command: MessageDispatchCommand;
      readonly decision: EfficiencyDecision;
      readonly consumedRetry: boolean;
    };

export type ClientLaunchPlan =
  | { readonly type: "unrouted"; readonly reason: string }
  | {
      readonly type: "routed";
      readonly input: ThreadLaunchInput;
      readonly decision: EfficiencyDecision;
      readonly consumedRetry: boolean;
    };

export interface ClientTurnRouterShape {
  readonly planDispatch: (command: OrchestrationV2Command) => Effect.Effect<ClientDispatchPlan>;
  readonly planLaunch: (input: ThreadLaunchInput) => Effect.Effect<ClientLaunchPlan>;
  /** Persists a routed run's decision (and clears a consumed retry marker). */
  readonly recordRouted: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly runId: OrchestrationV2Run["id"] | undefined;
    readonly decision: EfficiencyDecision;
    readonly consumedRetry: boolean;
  }) => Effect.Effect<void>;
  /** Pins a new child to manual routing at the routed tier before its first turn. */
  readonly prepareChild: (input: {
    readonly childThreadId: ThreadId;
    readonly decision: EfficiencyDecision;
  }) => Effect.Effect<void>;
  readonly recordDelegation: (input: {
    readonly parentThreadId: ThreadId;
    readonly childThreadId: ThreadId;
    readonly messageId: MessageId;
    readonly modelSelection: ModelSelection;
    readonly reusedChild: boolean;
  }) => Effect.Effect<void>;
}

export class ClientTurnRouter extends Context.Service<ClientTurnRouter, ClientTurnRouterShape>()(
  "@awtprod/command-center/efficiency/ClientTurnRouting/ClientTurnRouter",
) {}

const unrouted = (reason: string) => ({ type: "unrouted", reason }) as const;

/** The first message a reused child gets: the parent's newer conversation, then the task. */
export function buildDelegationHandoffText(input: {
  readonly parentTitle: string;
  readonly parentModel: string;
  readonly conversation: ReadonlyArray<ConversationLine>;
  readonly task: string;
}): string {
  const history = input.conversation
    .filter((line) => line.text.trim().length > 0)
    .slice(-DELEGATION_BOUNDS.handoffMessageLimit)
    .map(
      (line) =>
        `--- ${line.role} ---\n${
          line.text.length > DELEGATION_BOUNDS.handoffMessageChars
            ? `${line.text.slice(0, DELEGATION_BOUNDS.handoffMessageChars)}…`
            : line.text
        }`,
    );
  return [
    `[Routed turn] Command Center routed this turn from the thread "${input.parentTitle}" (on ${input.parentModel}) to this thread.`,
    ...(history.length === 0 ? [] : ["Recent conversation in that thread:", ...history]),
    `Task:\n${input.task}`,
  ].join("\n\n");
}

function childThreadTitle(parentTitle: string, model: string): string {
  const base =
    parentTitle.length > DELEGATION_BOUNDS.childTitleChars
      ? `${parentTitle.slice(0, DELEGATION_BOUNDS.childTitleChars)}…`
      : parentTitle;
  return `${base} · ${model}`;
}

function sameSelection(left: ModelSelection, right: ModelSelection): boolean {
  return left.instanceId === right.instanceId && left.model === right.model;
}

function latestRun(runs: ReadonlyArray<OrchestrationV2Run>): OrchestrationV2Run | undefined {
  return runs.reduce<OrchestrationV2Run | undefined>(
    (latest, run) => (latest === undefined || run.ordinal > latest.ordinal ? run : latest),
    undefined,
  );
}

/** The run a dispatch or launch created for `messageId`. */
function runIdForMessage(
  storedEvents: OrchestratorV2DispatchResult["storedEvents"],
  messageId: MessageId,
): OrchestrationV2Run["id"] | undefined {
  for (const { event } of storedEvents) {
    if (event.type === "run.updated" && event.payload.userMessageId === messageId) {
      return event.payload.id;
    }
  }
  return undefined;
}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry;
  const judge = yield* Judge;
  const routing = yield* ThreadRoutingService;
  const reads = yield* ClientTurnRoutingReadsService;
  const crypto = yield* Crypto.Crypto;

  /** Routing is an optimization: a failed step logs and falls back, never fails the turn. */
  const logged =
    <A>(operation: string, fallback: NoInfer<A>) =>
    <E>(effect: Effect.Effect<A, E>): Effect.Effect<A> =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`efficiency routing: ${operation} failed`, { cause }).pipe(
            Effect.as(fallback),
          ),
        ),
      );

  /** Judge the turn; any judge failure (or a disabled judge) yields undefined. */
  const judgeTurn = (input: {
    readonly threadId: ThreadId;
    readonly text: string;
    readonly attachmentCount: number;
    readonly interactionMode: "default" | "plan";
    readonly projectId: string;
    readonly threadTitle: string | undefined;
    readonly priorTurnCount: number;
    readonly taskMessage: string | undefined;
  }): Effect.Effect<TierJudgmentInput | undefined> =>
    judge
      .ask(
        buildTierJudgmentRequest({
          message: input.text,
          attachmentCount: input.attachmentCount,
          interactionMode: input.interactionMode,
          projectId: input.projectId,
          priorTurnCount: input.priorTurnCount,
          ...(input.threadTitle === undefined ? {} : { threadTitle: input.threadTitle }),
          ...(input.taskMessage === undefined ? {} : { taskMessage: input.taskMessage }),
        }),
        { threadId: input.threadId },
      )
      .pipe(
        Effect.map((result) => tierJudgmentFromAnswers(result.answers, result.model)),
        Effect.catchTag("JudgeError", (error) =>
          Effect.logDebug("tier judgment skipped", { reason: error.reason }).pipe(
            Effect.as(undefined),
          ),
        ),
      );

  /**
   * The thread's current route for sticky routing: the latest run's decision
   * (only when that run was routed) and the message that started the route.
   */
  const routeContext = (snapshot: RoutingThreadSnapshot) =>
    Effect.gen(function* () {
      const latest = latestRun(snapshot.runs);
      if (latest === undefined) return { priorDecision: undefined, taskMessage: undefined };
      const decisions = yield* routing.listRunDecisions(
        snapshot.thread.id,
        ROUTE_CONTEXT_DECISIONS,
      );
      const context = findRouteContext(
        decisions.map((row) => ({
          turnId: row.runId,
          pendingMessageId: row.messageId,
          requestedAt: row.createdAt,
          requestSequence: null,
          efficiencyDecision: row.decision,
        })),
        latest.id,
      );
      const taskMessage =
        context.taskMessageId === undefined
          ? undefined
          : yield* reads.messageText(context.taskMessageId as MessageId);
      return { priorDecision: context.priorDecision, taskMessage };
    }).pipe(
      logged<{
        readonly priorDecision: EfficiencyDecision | undefined;
        readonly taskMessage: string | undefined;
      }>("route context", { priorDecision: undefined, taskMessage: undefined }),
    );

  /** Routes one turn; undefined when routing does not apply or produced no decision. */
  const decide = (input: {
    readonly settings: ServerSettings;
    readonly stored: StoredThreadRouting;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
    readonly messageId: MessageId;
    readonly text: string;
    readonly attachmentCount: number;
    readonly modelSelection: ModelSelection | undefined;
    readonly runtimeMode: OrchestrationV2AppThread["runtimeMode"];
    readonly interactionMode: "default" | "plan";
    readonly projectId: OrchestrationV2AppThread["projectId"];
    readonly snapshot: RoutingThreadSnapshot | undefined;
    readonly title: string | undefined;
  }) =>
    Effect.gen(function* () {
      const efficiency = input.settings.efficiency;
      const ruleMatches = interactiveTurnMatchesRule({
        settings: efficiency,
        projectId: input.projectId,
        interactionMode: input.interactionMode,
        attachmentCount: input.attachmentCount,
      });
      // An explicit rule always wins over a judgment, so skip the judge
      // round-trip when one matches.
      const judging = !ruleMatches && efficiency.tierJudgment.enabled && judge.enabled;
      const route =
        judging && input.snapshot !== undefined
          ? yield* routeContext(input.snapshot)
          : { priorDecision: undefined, taskMessage: undefined };
      const tierJudgment = judging
        ? yield* judgeTurn({
            threadId: input.threadId,
            text: input.text,
            attachmentCount: input.attachmentCount,
            interactionMode: input.interactionMode,
            projectId: input.projectId,
            threadTitle: input.title,
            priorTurnCount: Math.max(
              input.snapshot === undefined ? 0 : 1,
              input.snapshot?.runs.length ?? 0,
            ),
            taskMessage: route.taskMessage,
          })
        : undefined;
      const fallback = input.modelSelection ?? input.snapshot?.thread.modelSelection;
      const command: TurnStartCommand = {
        type: "thread.turn.start",
        commandId: input.commandId,
        threadId: input.threadId,
        message: {
          messageId: input.messageId,
          role: "user",
          text: input.text,
          attachments: Array.from({ length: input.attachmentCount }),
        },
        ...(fallback === undefined ? {} : { modelSelection: fallback }),
        routingMode: "auto",
        ...(input.stored.efficiencyTier === null
          ? {}
          : { efficiencyTier: input.stored.efficiencyTier }),
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        ...(input.stored.pendingRetryOfTurnId === null
          ? {}
          : { retryOfTurnId: input.stored.pendingRetryOfTurnId }),
        createdAt: DateTime.formatIso(yield* DateTime.now),
      };
      return resolveInteractiveEfficiency({
        command,
        ...(input.snapshot === undefined
          ? {}
          : {
              thread: {
                projectId: input.snapshot.thread.projectId,
                modelSelection: input.snapshot.thread.modelSelection,
              },
            }),
        projectIdOverride: input.projectId,
        settings: efficiency,
        providers: input.providers,
        ...(tierJudgment === undefined ? {} : { tierJudgment }),
        ...(route.priorDecision === undefined ? {} : { priorDecision: route.priorDecision }),
      }).decision;
    });

  /** Settings + stored routing when routing applies to this thread; else the reason it does not. */
  const routingGate = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings;
      if (!settings.efficiency.enabled) return { skip: "efficiency-disabled" } as const;
      const stored = Option.getOrUndefined(yield* routing.getStored(threadId));
      if (stored === undefined || stored.routingMode !== "auto") {
        return { skip: "manual-routing" } as const;
      }
      return { settings, stored } as const;
    });

  /** The most recent idle routed child of `parent` already on `selection`. */
  const findReusableChild = (parentThreadId: ThreadId, selection: ModelSelection) =>
    Effect.gen(function* () {
      const rows = yield* routing.listDelegations(
        parentThreadId,
        DELEGATION_BOUNDS.delegationRowsRead,
      );
      const childIds = [...new Set(rows.map((row) => row.childThreadId))].slice(
        0,
        DELEGATION_BOUNDS.reusableChildLookback,
      );
      for (const childId of childIds) {
        const child = yield* reads.thread(childId);
        if (child === undefined) continue;
        if (child.thread.archivedAt !== null || child.thread.deletedAt !== null) continue;
        if (child.runs.some(isActiveRun)) continue;
        if (sameSelection(child.thread.modelSelection, selection)) return childId;
      }
      return undefined;
    }).pipe(logged<ThreadId | undefined>("child reuse lookup", undefined));

  const planDispatch: ClientTurnRouterShape["planDispatch"] = (command) =>
    Effect.gen(function* () {
      if (command.type !== "message.dispatch") return unrouted("not-a-message");
      if (command.createdBy !== "user") return unrouted("not-a-user-message");
      // Steering lands in a run that already has its model; continuations,
      // wakes and deliveries keep the run they continue.
      if (
        command.dispatchMode.type !== "start_immediately" &&
        command.dispatchMode.type !== "queue_after_active"
      ) {
        return unrouted("steer-or-deferred");
      }
      if (
        command.manualContinuationOfRunId !== undefined ||
        command.restartContinuationOfRunId !== undefined ||
        command.usageLimitContinuationOfRunId !== undefined ||
        command.delegatedCompletion !== undefined ||
        command.notification !== undefined
      ) {
        return unrouted("continuation");
      }
      // A provider slash command (`/compact`) belongs to the thread's own session.
      if (PROVIDER_SLASH_COMMAND.test(command.text)) return unrouted("slash-command");
      const gate = yield* routingGate(command.threadId);
      if ("skip" in gate) return unrouted(gate.skip);
      const snapshot = yield* reads.thread(command.threadId);
      if (snapshot === undefined) return unrouted("thread-not-found");
      // Starting into an active run steers (or restarts) it on the server.
      if (
        command.dispatchMode.type === "start_immediately" &&
        command.deliveryIntent !== "restart" &&
        snapshot.runs.some(isActiveRun)
      ) {
        return unrouted("active-run");
      }
      const providers = yield* providerRegistry.getProviders;
      const decision = yield* decide({
        settings: gate.settings,
        stored: gate.stored,
        providers,
        threadId: command.threadId,
        commandId: command.commandId,
        messageId: command.messageId,
        text: command.text,
        attachmentCount: command.attachments.length,
        modelSelection: command.modelSelection,
        runtimeMode: snapshot.thread.runtimeMode,
        interactionMode: snapshot.thread.interactionMode,
        projectId: snapshot.thread.projectId,
        snapshot,
        title: snapshot.thread.title,
      });
      if (decision === undefined) return unrouted("no-decision");
      const consumedRetry = gate.stored.pendingRetryOfTurnId !== null;

      const delegationBlocked =
        // A plan lives in this thread's session; a retry retries this thread's turn.
        command.sourcePlanRef !== undefined ||
        decision.retryOfTurnId !== undefined ||
        // Children (routed or provider subagents) never delegate again.
        snapshot.thread.lineage.relationshipToParent === "subagent" ||
        Option.isSome(yield* routing.delegationForChild(command.threadId)) ||
        // thread.fork needs a provider-finished run to copy.
        !snapshot.runs.some((run) => isForkableSourceRunStatus(run.status));
      const needsChild =
        !delegationBlocked &&
        routedSelectionNeedsSubagent({
          thread: {
            providerInstanceId: snapshot.thread.providerInstanceId,
            modelSelection: snapshot.thread.modelSelection,
            bound: snapshot.thread.activeProviderThreadId !== null,
          },
          selection: decision.modelSelection,
          providers,
        });
      if (!needsChild) {
        return {
          type: "routed",
          command: { ...command, modelSelection: decision.modelSelection },
          decision,
          consumedRetry,
        } as const;
      }

      const reusable = yield* findReusableChild(command.threadId, decision.modelSelection);
      const childThreadId =
        reusable ?? ThreadId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
      const text =
        reusable === undefined
          ? command.text
          : buildDelegationHandoffText({
              parentTitle: snapshot.thread.title,
              parentModel: snapshot.thread.modelSelection.model,
              conversation: yield* reads
                .recentConversation(command.threadId, DELEGATION_BOUNDS.handoffMessageLimit)
                .pipe(logged<ReadonlyArray<ConversationLine>>("handoff read", [])),
              task: command.text,
            });
      const { titleSeed: _titleSeed, deliveryIntent: _deliveryIntent, ...rest } = command;
      const childCommand: MessageDispatchCommand = {
        ...rest,
        commandId: CommandId.make(`${command.commandId}:routed-child`),
        threadId: childThreadId,
        text,
        modelSelection: decision.modelSelection,
        dispatchMode: { type: "start_immediately" },
      };
      return {
        type: "delegated",
        parentThreadId: command.threadId,
        childThreadId,
        reusedChild: reusable !== undefined,
        ...(reusable === undefined
          ? {
              fork: {
                type: "thread.fork",
                commandId: CommandId.make(`${command.commandId}:routed-fork`),
                createdBy: command.createdBy,
                creationSource: command.creationSource,
                sourceThreadId: command.threadId,
                targetThreadId: childThreadId,
                sourcePoint: { type: "latest_stable" },
                title: childThreadTitle(snapshot.thread.title, decision.modelSelection.model),
              } satisfies ThreadForkCommand,
            }
          : {}),
        command: childCommand,
        decision,
        consumedRetry,
      } as const;
    }).pipe(logged<ClientDispatchPlan>("dispatch planning", unrouted("routing-error")));

  const planLaunch: ClientTurnRouterShape["planLaunch"] = (input) =>
    Effect.gen(function* () {
      const message = input.initialMessage;
      if (message === undefined) return unrouted("no-initial-message");
      if (input.createdBy !== "user") return unrouted("not-a-user-message");
      if (input.threadId === undefined) return unrouted("no-thread-id");
      if (input.importedNativeThread !== undefined) return unrouted("imported-thread");
      const gate = yield* routingGate(input.threadId);
      if ("skip" in gate) return unrouted(gate.skip);
      const snapshot =
        input.reuseExistingThread === true ? yield* reads.thread(input.threadId) : undefined;
      if (snapshot?.runs.some(isActiveRun) === true) return unrouted("active-run");
      const providers = yield* providerRegistry.getProviders;
      const decision = yield* decide({
        settings: gate.settings,
        stored: gate.stored,
        providers,
        threadId: input.threadId,
        commandId: input.commandId,
        messageId: message.messageId ?? (`${input.commandId}:initial` as MessageId),
        text: message.text,
        attachmentCount: message.attachments.length,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        projectId: input.projectId,
        snapshot,
        title: input.title,
      });
      if (decision === undefined) return unrouted("no-decision");
      return {
        type: "routed",
        input: { ...input, modelSelection: decision.modelSelection },
        decision,
        consumedRetry: gate.stored.pendingRetryOfTurnId !== null,
      } as const;
    }).pipe(logged<ClientLaunchPlan>("launch planning", unrouted("routing-error")));

  const recordRouted: ClientTurnRouterShape["recordRouted"] = (input) =>
    Effect.gen(function* () {
      if (input.runId === undefined) {
        yield* Effect.logWarning("efficiency routing: routed run not found after dispatch", {
          threadId: input.threadId,
          messageId: input.messageId,
        });
      } else {
        yield* routing.recordRunDecision({
          runId: input.runId,
          threadId: input.threadId,
          messageId: input.messageId,
          decision: input.decision,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
      }
      if (input.consumedRetry) yield* routing.clearPendingRetry(input.threadId);
    }).pipe(logged<void>("decision record", undefined));

  const prepareChild: ClientTurnRouterShape["prepareChild"] = (input) =>
    routing
      .set({
        threadId: input.childThreadId,
        routingMode: "manual",
        efficiencyTier: input.decision.tier,
      })
      .pipe(Effect.asVoid, logged<void>("child routing", undefined));

  const recordDelegation: ClientTurnRouterShape["recordDelegation"] = (input) =>
    Effect.gen(function* () {
      yield* routing.recordDelegation({
        parentThreadId: input.parentThreadId,
        childThreadId: input.childThreadId,
        messageId: input.messageId,
        modelSelection: input.modelSelection,
        reusedChild: input.reusedChild,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      });
    }).pipe(logged<void>("delegation record", undefined));

  return ClientTurnRouter.of({
    planDispatch,
    planLaunch,
    recordRouted,
    prepareChild,
    recordDelegation,
  });
});

export const layer = Layer.effect(ClientTurnRouter, make);

/**
 * Read-only V2 reads for routing: thread + runs from the orchestrator, message
 * text and recent conversation from the V2 message projection.
 */
export const readsLayer = Layer.effect(
  ClientTurnRoutingReadsService,
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sql = yield* SqlClient.SqlClient;
    return ClientTurnRoutingReadsService.of({
      thread: (threadId) =>
        orchestrator.getThreadRecords(threadId, ["runs"]).pipe(
          Effect.map((records): RoutingThreadSnapshot | undefined =>
            records.thread.deletedAt === null
              ? { thread: records.thread, runs: records.runs }
              : undefined,
          ),
          Effect.catchCause(() => Effect.succeed(undefined)),
        ),
      messageText: (messageId) =>
        sql<{ readonly text: string | null }>`
          SELECT json_extract(payload_json, '$.text') AS text
          FROM orchestration_v2_projection_messages
          WHERE message_id = ${messageId}
        `.pipe(
          Effect.map((rows) => rows[0]?.text ?? undefined),
          Effect.catchCause(() => Effect.succeed(undefined)),
        ),
      recentConversation: (threadId, limit) =>
        sql<{ readonly role: "user" | "assistant"; readonly text: string | null }>`
          SELECT role, json_extract(payload_json, '$.text') AS text
          FROM orchestration_v2_projection_messages
          WHERE thread_id = ${threadId} AND role IN ('user', 'assistant') AND streaming = 0
          ORDER BY created_at DESC, rowid DESC
          LIMIT ${Math.max(1, Math.floor(limit))}
        `.pipe(
          Effect.map((rows) =>
            rows
              .flatMap((row) => (row.text === null ? [] : [{ role: row.role, text: row.text }]))
              .toReversed(),
          ),
          Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<ConversationLine>)),
        ),
    });
  }),
);

/**
 * Dispatches a client command through routing. `dispatch` is
 * `ThreadMessageIntake.dispatchCommand`; an unrouted command reaches it as the
 * very same object.
 */
export const dispatchClientCommand = <E, R>(
  router: ClientTurnRouterShape,
  command: OrchestrationV2Command,
  dispatch: (command: OrchestrationV2Command) => Effect.Effect<OrchestratorV2DispatchResult, E, R>,
): Effect.Effect<OrchestratorV2DispatchResult, E, R> =>
  Effect.gen(function* () {
    const plan = yield* router.planDispatch(command);
    switch (plan.type) {
      case "unrouted":
        return yield* dispatch(command);
      case "routed": {
        const result = yield* dispatch(plan.command);
        yield* router.recordRouted({
          threadId: plan.command.threadId,
          messageId: plan.command.messageId,
          runId: runIdForMessage(result.storedEvents, plan.command.messageId),
          decision: plan.decision,
          consumedRetry: plan.consumedRetry,
        });
        return result;
      }
      case "delegated": {
        if (plan.fork !== undefined) {
          const forked = yield* Effect.exit(dispatch(plan.fork));
          if (forked._tag === "Failure") {
            // Nothing of this turn was dispatched yet: run it on the parent unrouted.
            yield* Effect.logWarning("efficiency routing: child fork failed; turn runs unrouted", {
              threadId: plan.parentThreadId,
              cause: forked.cause,
            });
            return yield* dispatch(command);
          }
          yield* router.prepareChild({
            childThreadId: plan.childThreadId,
            decision: plan.decision,
          });
        }
        const result = yield* dispatch(plan.command);
        yield* router.recordDelegation({
          parentThreadId: plan.parentThreadId,
          childThreadId: plan.childThreadId,
          messageId: plan.command.messageId,
          modelSelection: plan.decision.modelSelection,
          reusedChild: plan.reusedChild,
        });
        yield* router.recordRouted({
          threadId: plan.childThreadId,
          messageId: plan.command.messageId,
          runId: runIdForMessage(result.storedEvents, plan.command.messageId),
          decision: plan.decision,
          consumedRetry: false,
        });
        return result;
      }
    }
  });

/** Launches a client thread through routing; `launch` is `ThreadMessageIntake.launchThread`. */
export const launchClientThread = <E, R>(
  router: ClientTurnRouterShape,
  input: ThreadLaunchInput,
  launch: (input: ThreadLaunchInput) => Effect.Effect<ThreadLaunchResult, E, R>,
): Effect.Effect<ThreadLaunchResult, E, R> =>
  Effect.gen(function* () {
    const plan = yield* router.planLaunch(input);
    if (plan.type === "unrouted") return yield* launch(input);
    const result = yield* launch(plan.input);
    const messageId = plan.input.initialMessage?.messageId;
    const run =
      (messageId === undefined
        ? undefined
        : result.projection.runs.find((candidate) => candidate.userMessageId === messageId)) ??
      latestRun(result.projection.runs);
    yield* router.recordRouted({
      threadId: result.threadId,
      messageId: run?.userMessageId ?? (messageId as MessageId),
      runId: run?.id,
      decision: plan.decision,
      consumedRetry: plan.consumedRetry,
    });
    return result;
  });
