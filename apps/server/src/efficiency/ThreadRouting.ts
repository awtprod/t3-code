/**
 * Per-thread efficiency routing state and per-run routing decisions for
 * orchestration V2, stored in fork-owned tables (migration 103) next to the
 * V2 projection instead of on upstream's thread shell or start-turn commands.
 *
 * Clients read and change a thread's routing through
 * `efficiency.threadRouting.{get,set,subscribe}`; the client-turn router
 * ({@link ./ClientTurnRouting.ts}) reads it on every client turn and records
 * the decision it made for the run.
 *
 * @module ThreadRouting
 */
import {
  EfficiencyDecision,
  EfficiencyModelSelection,
  type EfficiencyThreadDelegation,
  type EfficiencyThreadRouting,
  EfficiencyThreadRoutingError,
  type EfficiencyTier,
  type EfficiencyRunDecision,
  MessageId,
  RunId,
  ThreadId,
  type ThreadRoutingMode,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

/** Newest delegations exposed on a parent's routing state. */
const ROUTING_STATE_DELEGATION_LIMIT = 20;

const decodeDecisionJson = Schema.decodeUnknownOption(Schema.fromJsonString(EfficiencyDecision));
const encodeDecisionJson = Schema.encodeSync(Schema.fromJsonString(EfficiencyDecision));
const decodeSelectionJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(EfficiencyModelSelection),
);
const encodeSelectionJson = Schema.encodeSync(Schema.fromJsonString(EfficiencyModelSelection));

export interface StoredThreadRouting {
  readonly threadId: ThreadId;
  readonly routingMode: ThreadRoutingMode;
  readonly efficiencyTier: EfficiencyTier | null;
  readonly pendingRetryOfTurnId: TurnId | null;
  readonly updatedAt: string;
}

export interface ThreadRoutingServiceShape {
  /** The thread's stored routing row; none when the client never set one. */
  readonly getStored: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<StoredThreadRouting>, EfficiencyThreadRoutingError>;
  readonly get: (
    threadId: ThreadId,
  ) => Effect.Effect<EfficiencyThreadRouting, EfficiencyThreadRoutingError>;
  readonly set: (input: {
    readonly threadId: ThreadId;
    readonly routingMode: ThreadRoutingMode;
    readonly efficiencyTier: EfficiencyTier | null;
    readonly retryOfTurnId?: TurnId;
  }) => Effect.Effect<EfficiencyThreadRouting, EfficiencyThreadRoutingError>;
  /** Clears a consumed "retry one tier higher" marker. */
  readonly clearPendingRetry: (
    threadId: ThreadId,
  ) => Effect.Effect<void, EfficiencyThreadRoutingError>;
  readonly recordRunDecision: (
    input: EfficiencyRunDecision,
  ) => Effect.Effect<void, EfficiencyThreadRoutingError>;
  /** Newest-first routing decisions of a thread, bounded by `limit`. */
  readonly listRunDecisions: (
    threadId: ThreadId,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<EfficiencyRunDecision>, EfficiencyThreadRoutingError>;
  readonly recordDelegation: (
    input: EfficiencyThreadDelegation,
  ) => Effect.Effect<void, EfficiencyThreadRoutingError>;
  /** Newest-first delegations of a parent thread, bounded by `limit`. */
  readonly listDelegations: (
    parentThreadId: ThreadId,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<EfficiencyThreadDelegation>, EfficiencyThreadRoutingError>;
  /** The delegation that created `childThreadId`, when it is a routed child. */
  readonly delegationForChild: (
    childThreadId: ThreadId,
  ) => Effect.Effect<Option.Option<EfficiencyThreadDelegation>, EfficiencyThreadRoutingError>;
  /** Current state, then the new state on every change of this thread. */
  readonly subscribe: (
    threadId: ThreadId,
  ) => Stream.Stream<EfficiencyThreadRouting, EfficiencyThreadRoutingError>;
}

export class ThreadRoutingService extends Context.Service<
  ThreadRoutingService,
  ThreadRoutingServiceShape
>()("@awtprod/command-center/efficiency/ThreadRouting/ThreadRoutingService") {}

const RoutingRow = Schema.Struct({
  threadId: Schema.String,
  routingMode: Schema.Literals(["manual", "auto"]),
  efficiencyTier: Schema.NullOr(Schema.Literals(["economy", "balanced", "quality"])),
  pendingRetryOfTurnId: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
const decodeRoutingRow = Schema.decodeUnknownEffect(RoutingRow);

interface DecisionRow {
  readonly runId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly decisionJson: string;
  readonly createdAt: string;
}

interface DelegationRow {
  readonly parentThreadId: string;
  readonly childThreadId: string;
  readonly messageId: string;
  readonly modelSelectionJson: string;
  readonly reusedChild: number;
  readonly createdAt: string;
}

const toRunDecision = (row: DecisionRow): Option.Option<EfficiencyRunDecision> =>
  decodeDecisionJson(row.decisionJson).pipe(
    Option.map((decision) => ({
      runId: RunId.make(row.runId),
      threadId: ThreadId.make(row.threadId),
      messageId: MessageId.make(row.messageId),
      decision,
      createdAt: row.createdAt,
    })),
  );

const toDelegation = (row: DelegationRow): Option.Option<EfficiencyThreadDelegation> =>
  decodeSelectionJson(row.modelSelectionJson).pipe(
    Option.map((modelSelection) => ({
      parentThreadId: ThreadId.make(row.parentThreadId),
      childThreadId: ThreadId.make(row.childThreadId),
      messageId: MessageId.make(row.messageId),
      modelSelection,
      reusedChild: row.reusedChild === 1,
      createdAt: row.createdAt,
    })),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.unbounded<ThreadId>();

  const fail =
    (threadId: ThreadId, message: string) =>
    (cause: unknown): EfficiencyThreadRoutingError =>
      new EfficiencyThreadRoutingError({ threadId, message, cause });

  const getStored: ThreadRoutingServiceShape["getStored"] = (threadId) =>
    sql<Record<string, unknown>>`
      SELECT thread_id AS "threadId", routing_mode AS "routingMode",
        efficiency_tier AS "efficiencyTier",
        pending_retry_of_turn_id AS "pendingRetryOfTurnId", updated_at AS "updatedAt"
      FROM efficiency_thread_routing
      WHERE thread_id = ${threadId}
    `.pipe(
      Effect.flatMap((rows) =>
        rows.length === 0
          ? Effect.succeed(Option.none<StoredThreadRouting>())
          : decodeRoutingRow(rows[0]).pipe(
              Effect.map((row) =>
                Option.some<StoredThreadRouting>({
                  threadId: ThreadId.make(row.threadId),
                  routingMode: row.routingMode,
                  efficiencyTier: row.efficiencyTier,
                  pendingRetryOfTurnId:
                    row.pendingRetryOfTurnId === null
                      ? null
                      : TurnId.make(row.pendingRetryOfTurnId),
                  updatedAt: row.updatedAt,
                }),
              ),
            ),
      ),
      Effect.mapError(fail(threadId, "Thread routing could not be read.")),
    );

  const listRunDecisions: ThreadRoutingServiceShape["listRunDecisions"] = (threadId, limit) =>
    sql<DecisionRow>`
      SELECT run_id AS "runId", thread_id AS "threadId", message_id AS "messageId",
        decision_json AS "decisionJson", created_at AS "createdAt"
      FROM efficiency_run_decisions
      WHERE thread_id = ${threadId}
      ORDER BY created_at DESC, rowid DESC
      LIMIT ${Math.max(1, Math.floor(limit))}
    `.pipe(
      Effect.map((rows) => rows.flatMap((row) => Option.toArray(toRunDecision(row)))),
      Effect.mapError(fail(threadId, "Routing decisions could not be read.")),
    );

  const listDelegations: ThreadRoutingServiceShape["listDelegations"] = (parentThreadId, limit) =>
    sql<DelegationRow>`
      SELECT parent_thread_id AS "parentThreadId", child_thread_id AS "childThreadId",
        message_id AS "messageId", model_selection_json AS "modelSelectionJson",
        reused_child AS "reusedChild", created_at AS "createdAt"
      FROM efficiency_delegations
      WHERE parent_thread_id = ${parentThreadId}
      ORDER BY created_at DESC, rowid DESC
      LIMIT ${Math.max(1, Math.floor(limit))}
    `.pipe(
      Effect.map((rows) => rows.flatMap((row) => Option.toArray(toDelegation(row)))),
      Effect.mapError(fail(parentThreadId, "Routing delegations could not be read.")),
    );

  const delegationForChild: ThreadRoutingServiceShape["delegationForChild"] = (childThreadId) =>
    sql<DelegationRow>`
      SELECT parent_thread_id AS "parentThreadId", child_thread_id AS "childThreadId",
        message_id AS "messageId", model_selection_json AS "modelSelectionJson",
        reused_child AS "reusedChild", created_at AS "createdAt"
      FROM efficiency_delegations
      WHERE child_thread_id = ${childThreadId}
      ORDER BY created_at ASC, rowid ASC
      LIMIT 1
    `.pipe(
      Effect.map((rows) => (rows.length === 0 ? Option.none() : toDelegation(rows[0]!))),
      Effect.mapError(fail(childThreadId, "Routing delegation could not be read.")),
    );

  const get: ThreadRoutingServiceShape["get"] = (threadId) =>
    Effect.gen(function* () {
      const stored = yield* getStored(threadId);
      const [latestDecision] = yield* listRunDecisions(threadId, 1);
      const delegations = yield* listDelegations(threadId, ROUTING_STATE_DELEGATION_LIMIT);
      const delegatedFrom = yield* delegationForChild(threadId);
      return {
        threadId,
        routingMode: Option.match(stored, {
          onNone: () => "manual" as const,
          onSome: (row) => row.routingMode,
        }),
        efficiencyTier: Option.getOrNull(Option.map(stored, (row) => row.efficiencyTier)),
        pendingRetryOfTurnId: Option.getOrNull(
          Option.map(stored, (row) => row.pendingRetryOfTurnId),
        ),
        stored: Option.isSome(stored),
        latestDecision: latestDecision ?? null,
        delegations,
        delegatedFrom: Option.getOrNull(delegatedFrom),
      } satisfies EfficiencyThreadRouting;
    });

  const publish = (threadId: ThreadId) => PubSub.publish(changes, threadId).pipe(Effect.asVoid);

  const set: ThreadRoutingServiceShape["set"] = (input) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO efficiency_thread_routing (
          thread_id, routing_mode, efficiency_tier, pending_retry_of_turn_id, updated_at
        ) VALUES (
          ${input.threadId}, ${input.routingMode}, ${input.efficiencyTier},
          ${input.retryOfTurnId ?? null}, ${now}
        )
        ON CONFLICT (thread_id) DO UPDATE SET
          routing_mode = excluded.routing_mode,
          efficiency_tier = excluded.efficiency_tier,
          pending_retry_of_turn_id = excluded.pending_retry_of_turn_id,
          updated_at = excluded.updated_at
      `.pipe(Effect.mapError(fail(input.threadId, "Thread routing could not be saved.")));
      yield* publish(input.threadId);
      return yield* get(input.threadId);
    });

  const clearPendingRetry: ThreadRoutingServiceShape["clearPendingRetry"] = (threadId) =>
    sql`
      UPDATE efficiency_thread_routing SET pending_retry_of_turn_id = NULL
      WHERE thread_id = ${threadId} AND pending_retry_of_turn_id IS NOT NULL
    `.pipe(
      Effect.mapError(fail(threadId, "Thread routing could not be saved.")),
      Effect.andThen(publish(threadId)),
    );

  const recordRunDecision: ThreadRoutingServiceShape["recordRunDecision"] = (input) =>
    sql`
      INSERT INTO efficiency_run_decisions (
        run_id, thread_id, message_id, decision_json, created_at
      ) VALUES (
        ${input.runId}, ${input.threadId}, ${input.messageId},
        ${encodeDecisionJson(input.decision)}, ${input.createdAt}
      )
      ON CONFLICT (run_id) DO NOTHING
    `.pipe(
      Effect.mapError(fail(input.threadId, "Routing decision could not be saved.")),
      Effect.andThen(publish(input.threadId)),
    );

  const recordDelegation: ThreadRoutingServiceShape["recordDelegation"] = (input) =>
    sql`
      INSERT INTO efficiency_delegations (
        message_id, parent_thread_id, child_thread_id, model_selection_json, reused_child,
        created_at
      ) VALUES (
        ${input.messageId}, ${input.parentThreadId}, ${input.childThreadId},
        ${encodeSelectionJson(input.modelSelection)}, ${input.reusedChild ? 1 : 0},
        ${input.createdAt}
      )
      ON CONFLICT (message_id) DO NOTHING
    `.pipe(
      Effect.mapError(fail(input.parentThreadId, "Routing delegation could not be saved.")),
      Effect.andThen(publish(input.parentThreadId)),
      Effect.andThen(publish(input.childThreadId)),
    );

  const subscribe: ThreadRoutingServiceShape["subscribe"] = (threadId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before the first read so a change in between is not lost.
        const subscription = yield* PubSub.subscribe(changes);
        const updates = Stream.fromSubscription(subscription).pipe(
          Stream.filter((changed) => changed === threadId),
          Stream.mapEffect(() => get(threadId)),
        );
        return Stream.concat(Stream.fromEffect(get(threadId)), updates);
      }),
    );

  return ThreadRoutingService.of({
    getStored,
    get,
    set,
    clearPendingRetry,
    recordRunDecision,
    listRunDecisions,
    recordDelegation,
    listDelegations,
    delegationForChild,
    subscribe,
  });
});

export const layer = Layer.effect(ThreadRoutingService, make);
