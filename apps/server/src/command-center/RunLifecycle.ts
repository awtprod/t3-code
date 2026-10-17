import {
  COMMAND_CENTER_EVENT_ACTIONS,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { isCommandCenterThreadId } from "../provider/security/CommandCenterProviderIsolation.ts";
import { makeCommandCenterAuditLog } from "./AuditLog.ts";
import * as OrchestrationBridge from "./OrchestrationBridge.ts";

type TerminalRunStatus = "succeeded" | "failed" | "canceled";
type PersistedRunStatus = "queued" | "running" | "waiting_approval" | "waiting" | TerminalRunStatus;

interface LifecycleRunRow {
  readonly id: string;
  readonly spaceId: string;
  readonly projectId: string | null;
  readonly threadId: string | null;
  readonly state: PersistedRunStatus;
}

export interface RunTransition {
  readonly runId: string;
  readonly spaceId: string;
  readonly threadId: string | null;
  readonly status: "running" | TerminalRunStatus;
}

interface TransitionInput {
  readonly runId?: string;
  readonly threadId?: string;
  readonly sourceEventId: string;
  readonly status: "running" | TerminalRunStatus;
  readonly actorKind: "agent" | "system";
  readonly occurredAt: string;
  readonly error?: string;
  readonly failure?: {
    readonly reason: string;
    readonly message: string;
    readonly retryable: boolean;
  };
  readonly allowedPreviousStates?: ReadonlyArray<"queued" | "running">;
}

export class RunLifecycleError extends Schema.TaggedError<RunLifecycleError>()(
  "RunLifecycleError",
  {
    reason: Schema.Literals(["persistence", "projection"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isRunLifecycleError = Schema.is(RunLifecycleError);
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const lifecycleError = (reason: RunLifecycleError["reason"], message: string, cause?: unknown) =>
  new RunLifecycleError({
    reason,
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const nonEmptyMessage = (value: string | null | undefined, fallback: string): string => {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized.slice(0, 4_000) : fallback;
};

export interface RunEventTransition {
  readonly status: "running" | TerminalRunStatus;
  /** Set for failed runs: the failure text is read from the V2 projection. */
  readonly needsFailureMessage?: true;
  readonly error?: string;
}

/**
 * Maps a V2 run status onto the Command Center Run lifecycle. Active states
 * mean the Run is executing; terminal states end it. `queued` and `preparing`
 * change nothing: the Run is already `running` once its thread is dispatched.
 */
export const transitionForRunStatus = (
  status: OrchestrationV2Run["status"],
): RunEventTransition | undefined => {
  switch (status) {
    case "starting":
    case "running":
    case "waiting":
      return { status: "running" };
    case "completed":
      return { status: "succeeded" };
    case "interrupted":
      return { status: "canceled", error: "The provider turn was interrupted." };
    case "cancelled":
      return { status: "canceled", error: "The provider turn was canceled." };
    case "failed":
    case "rolled_back":
      return { status: "failed", needsFailureMessage: true };
    case "queued":
    case "preparing":
      return undefined;
  }
};

export interface RunLifecyclePersistence {
  readonly transition: (
    input: TransitionInput,
  ) => Effect.Effect<RunTransition | undefined, RunLifecycleError>;
  readonly listRunning: Effect.Effect<ReadonlyArray<LifecycleRunRow>, RunLifecycleError>;
}

/**
 * Owns the Run row, audit events, and Needs You failure Item in one transaction.
 * The deterministic event IDs and compare-and-set Run update make provider replay idempotent.
 */
export const makeRunLifecyclePersistence = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const auditLog = yield* makeCommandCenterAuditLog;
  const appendAudit = auditLog.append;

  const loadCandidate = Effect.fn("RunLifecycle.loadCandidate")(function* (input: TransitionInput) {
    if (input.runId !== undefined) {
      const rows = yield* sql<LifecycleRunRow>`
        SELECT id, space_id AS "spaceId", project_id AS "projectId",
          thread_id AS "threadId", state
        FROM command_center_runs
        WHERE id = ${input.runId}
        LIMIT 1
      `;
      return rows[0];
    }
    if (input.threadId === undefined) return undefined;
    const rows = yield* sql<LifecycleRunRow>`
      SELECT id, space_id AS "spaceId", project_id AS "projectId",
        thread_id AS "threadId", state
      FROM command_center_runs
      WHERE thread_id = ${input.threadId}
      ORDER BY started_at DESC
      LIMIT 1
    `;
    return rows[0];
  });

  const transition = Effect.fn("RunLifecycle.transition")(
    function* (input: TransitionInput) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const run = yield* loadCandidate(input);
          if (run === undefined) return undefined;
          const allowed = input.allowedPreviousStates ?? ["running"];
          if (!allowed.includes(run.state as "queued" | "running")) return undefined;

          if (input.status === "running") {
            if (run.state !== "running") return undefined;
            const eventId = `cc:run:${run.id}:provider:${input.sourceEventId}:running`;
            // V2 reports starting, running and waiting for one run, each with its
            // own timestamp. The first records the Run as running; the rest are
            // no-ops, not audit replays bound to different content.
            const recorded = yield* sql<{ readonly present: number }>`
              SELECT 1 AS present FROM command_center_audit_events
              WHERE event_id = ${eventId}
              LIMIT 1
            `;
            if (recorded.length > 0) return undefined;
            const appended = yield* appendAudit({
              eventId,
              actorKind: input.actorKind,
              action: COMMAND_CENTER_EVENT_ACTIONS.runStateChanged,
              spaceId: run.spaceId,
              runId: run.id,
              payload: {
                status: "running",
                previousStatus: "queued",
                ...(run.projectId === null ? {} : { projectId: run.projectId }),
                ...(run.threadId === null ? {} : { threadId: run.threadId }),
              },
              occurredAt: input.occurredAt,
            });
            return appended
              ? {
                  runId: run.id,
                  spaceId: run.spaceId,
                  threadId: run.threadId,
                  status: "running" as const,
                }
              : undefined;
          }

          const updated = yield* sql<{ readonly id: string }>`
            UPDATE command_center_runs
            SET state = ${input.status}, error = ${input.error ?? null},
              finished_at = ${input.occurredAt}
            WHERE id = ${run.id} AND state = ${run.state}
            RETURNING id
          `;
          if (updated.length === 0) return undefined;

          yield* appendAudit({
            eventId: `cc:run:${run.id}:provider:${input.sourceEventId}:${input.status}`,
            actorKind: input.actorKind,
            action: COMMAND_CENTER_EVENT_ACTIONS.runStateChanged,
            spaceId: run.spaceId,
            runId: run.id,
            payload: {
              status: input.status,
              previousStatus: run.state,
              ...(run.projectId === null ? {} : { projectId: run.projectId }),
              ...(run.threadId === null ? {} : { threadId: run.threadId }),
              ...(input.error === undefined ? {} : { error: input.error }),
            },
            occurredAt: input.occurredAt,
          });

          if (input.status === "failed" && input.failure !== undefined) {
            const failureItemId = `run-failure-${run.id}`;
            const sourceRef = run.threadId ?? `run:${run.id}`;
            yield* appendAudit({
              eventId: `cc:run:${run.id}:provider:${input.sourceEventId}:failure`,
              actorKind: input.actorKind,
              action: COMMAND_CENTER_EVENT_ACTIONS.failureRecorded,
              spaceId: run.spaceId,
              runId: run.id,
              payload: {
                scope: "run",
                reason: input.failure.reason,
                message: input.failure.message,
                retryable: input.failure.retryable,
              },
              occurredAt: input.occurredAt,
            });
            yield* sql`
              INSERT INTO command_center_items (
                id, space_id, kind, status, title, body, priority,
                source_json, links_json, metadata_json, created_at, updated_at
              ) VALUES (
                ${failureItemId}, ${run.spaceId}, 'alert', 'review', 'Run needs attention',
                ${input.failure.message}, 'urgent',
                ${encodeJson({
                  kind: "agent",
                  sourceRef,
                  capturedAt: input.occurredAt,
                })},
                '[]',
                ${encodeJson({
                  runId: run.id,
                  reason: input.failure.reason,
                  retryable: input.failure.retryable,
                })},
                ${input.occurredAt}, ${input.occurredAt}
              )
              ON CONFLICT(id) DO UPDATE SET
                status = 'review', body = excluded.body, priority = 'urgent',
                metadata_json = excluded.metadata_json, updated_at = excluded.updated_at
            `;
            yield* appendAudit({
              eventId: `cc:run:${run.id}:provider:${input.sourceEventId}:failure-item`,
              actorKind: input.actorKind,
              action: COMMAND_CENTER_EVENT_ACTIONS.itemChanged,
              spaceId: run.spaceId,
              runId: run.id,
              payload: {
                itemId: failureItemId,
                change: "created",
                kind: "alert",
                status: "review",
              },
              occurredAt: input.occurredAt,
            });
          }

          return {
            runId: run.id,
            spaceId: run.spaceId,
            threadId: run.threadId,
            status: input.status,
          } satisfies RunTransition;
        }),
      );
    },
    Effect.mapError((cause) =>
      isRunLifecycleError(cause)
        ? cause
        : lifecycleError("persistence", "The Run lifecycle transition could not be stored.", cause),
    ),
  );

  const listRunning = sql<LifecycleRunRow>`
    SELECT id, space_id AS "spaceId", project_id AS "projectId",
      thread_id AS "threadId", state
    FROM command_center_runs
    WHERE state = 'running'
    ORDER BY started_at ASC
  `.pipe(
    Effect.mapError((cause) =>
      lifecycleError("persistence", "In-flight Runs could not be loaded.", cause),
    ),
  );

  return { transition, listRunning } satisfies RunLifecyclePersistence;
});

export interface RunLifecycleShape {
  /** Applies one V2 domain event; only `run.updated` on a `cc:` thread can change a Run. */
  readonly handleThreadEvent: (
    event: OrchestrationV2DomainEvent,
  ) => Effect.Effect<RunTransition | undefined, RunLifecycleError>;
  readonly reconcile: Effect.Effect<ReadonlyArray<RunTransition>, RunLifecycleError>;
  readonly failRun: (input: {
    readonly runId: string;
    readonly reason: string;
    readonly message: string;
    readonly occurredAt: string;
    readonly retryable?: boolean;
  }) => Effect.Effect<RunTransition | undefined, RunLifecycleError>;
}

export class RunLifecycle extends Context.Service<RunLifecycle, RunLifecycleShape>()(
  "@awtprod/command-center/command-center/RunLifecycle",
) {}

interface RuntimeDependencies {
  readonly persistence: RunLifecyclePersistence;
  readonly getThread: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadShell | undefined, RunLifecycleError>;
  /** The recorded failure text of a V2 run, or undefined. */
  readonly getRunFailureMessage: (input: {
    readonly threadId: ThreadId;
    readonly runId: string;
  }) => Effect.Effect<string | undefined, RunLifecycleError>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
}

/** The V1 latestTurn states, derived from a V2 shell's latest run status. */
const latestRunOutcome = (
  thread: OrchestrationV2ThreadShell | undefined,
): "completed" | "interrupted" | "error" | "running" | undefined => {
  if (thread === undefined || thread.latestRunId === null) return undefined;
  switch (thread.status) {
    case "completed":
      return "completed";
    case "interrupted":
    case "cancelled":
      return "interrupted";
    case "failed":
    case "rolled_back":
      return "error";
    case "idle":
      return undefined;
    default:
      return "running";
  }
};

export const makeWithDependencies = (deps: RuntimeDependencies): RunLifecycleShape => {
  const revokeTerminal = Effect.fn("RunLifecycle.revokeTerminal")(function* (
    transition: RunTransition | undefined,
  ) {
    if (
      transition !== undefined &&
      transition.status !== "running" &&
      transition.threadId !== null
    ) {
      yield* deps.revokeThread(ThreadId.make(transition.threadId));
    }
    return transition;
  });

  const handleThreadEvent = Effect.fn("RunLifecycle.handleThreadEvent")(function* (
    event: OrchestrationV2DomainEvent,
  ) {
    if (event.type !== "run.updated" || !isCommandCenterThreadId(event.threadId)) {
      return undefined;
    }
    const run = event.payload;
    const selected = transitionForRunStatus(run.status);
    if (selected === undefined) return undefined;
    const occurredAt = DateTime.formatIso(event.occurredAt);
    // One audit row per V2 run and outcome: repeated run.updated events with
    // the same status (checkpoint, attempt bookkeeping) replay idempotently.
    const sourceEventId = `v2-run:${run.id}`;
    if (selected.status === "failed") {
      const message = nonEmptyMessage(
        yield* deps.getRunFailureMessage({ threadId: event.threadId, runId: run.id }),
        "The provider turn failed.",
      );
      return yield* revokeTerminal(
        yield* deps.persistence.transition({
          threadId: event.threadId,
          sourceEventId,
          status: "failed",
          actorKind: "agent",
          occurredAt,
          error: message,
          failure: { reason: "provider-turn-failed", message, retryable: true },
        }),
      );
    }
    return yield* revokeTerminal(
      yield* deps.persistence.transition({
        threadId: event.threadId,
        sourceEventId,
        status: selected.status,
        actorKind: "agent",
        occurredAt,
        ...(selected.error === undefined ? {} : { error: selected.error }),
      }),
    );
  });

  const failRun: RunLifecycleShape["failRun"] = Effect.fn("RunLifecycle.failRun")(
    function* (input) {
      const transition = yield* deps.persistence.transition({
        runId: input.runId,
        sourceEventId: `failure:${input.reason}`,
        status: "failed",
        actorKind: "system",
        occurredAt: input.occurredAt,
        error: nonEmptyMessage(input.message, "The Run failed."),
        failure: {
          reason: nonEmptyMessage(input.reason, "run-failed"),
          message: nonEmptyMessage(input.message, "The Run failed."),
          retryable: input.retryable ?? true,
        },
        allowedPreviousStates: ["queued", "running"],
      });
      return yield* revokeTerminal(transition);
    },
  );

  /**
   * Startup: settle Runs whose V2 run finished while the server was down, and
   * fail Runs whose thread or V2 run never came to exist. A V2 run that is
   * still active is left alone: V2's own restart recovery continues or ends it,
   * and its terminal `run.updated` reaches `handleThreadEvent`.
   */
  const reconcile: RunLifecycleShape["reconcile"] = Effect.gen(function* () {
    const runs = yield* deps.persistence.listRunning;
    const reconciliationTime = DateTime.formatIso(yield* DateTime.now);
    const transitions: Array<RunTransition> = [];
    for (const run of runs) {
      const sourceEventId = `restart:${run.id}`;
      let transition: RunTransition | undefined;
      if (run.threadId === null) {
        transition = yield* deps.persistence.transition({
          runId: run.id,
          sourceEventId: `${sourceEventId}:missing-thread`,
          status: "failed",
          actorKind: "system",
          occurredAt: reconciliationTime,
          error: "The server restarted before this Run was linked to a provider thread.",
          failure: {
            reason: "restart-missing-thread",
            message: "The server restarted before this Run was linked to a provider thread.",
            retryable: true,
          },
        });
      } else {
        const thread = yield* deps.getThread(ThreadId.make(run.threadId));
        // V2 shells carry the latest run's status rather than V1's latestTurn.
        const latestRun = latestRunOutcome(thread);
        const latestRunId = thread?.latestRunId ?? undefined;
        const occurredAt =
          (thread?.latestRunCompletedAt
            ? DateTime.formatIso(thread.latestRunCompletedAt)
            : undefined) ??
          (thread ? DateTime.formatIso(thread.updatedAt) : undefined) ??
          reconciliationTime;
        switch (latestRun) {
          case "completed":
            transition = yield* deps.persistence.transition({
              runId: run.id,
              sourceEventId: `v2-run:${latestRunId}`,
              status: "succeeded",
              actorKind: "system",
              occurredAt,
            });
            break;
          case "interrupted":
            transition = yield* deps.persistence.transition({
              runId: run.id,
              sourceEventId: `v2-run:${latestRunId}`,
              status: "canceled",
              actorKind: "system",
              occurredAt,
              error: "The provider turn was interrupted before the server restarted.",
            });
            break;
          case "error": {
            const message = nonEmptyMessage(
              latestRunId === undefined
                ? thread?.lastError
                : yield* deps.getRunFailureMessage({
                    threadId: ThreadId.make(run.threadId),
                    runId: latestRunId,
                  }),
              "The provider turn failed before the server restarted.",
            );
            transition = yield* deps.persistence.transition({
              runId: run.id,
              sourceEventId: `v2-run:${latestRunId}`,
              status: "failed",
              actorKind: "system",
              occurredAt,
              error: message,
              failure: {
                reason: "restart-provider-turn-error",
                message,
                retryable: true,
              },
            });
            break;
          }
          case "running":
            break;
          case undefined: {
            const message =
              thread === undefined
                ? "The server restarted before this Run's thread was created."
                : "The server restarted before this Run's thread started any work.";
            transition = yield* deps.persistence.transition({
              runId: run.id,
              sourceEventId: `${sourceEventId}:no-run:orphaned`,
              status: "failed",
              actorKind: "system",
              occurredAt,
              error: message,
              failure: {
                reason: "restart-orphaned-run",
                message,
                retryable: true,
              },
            });
            break;
          }
        }
      }
      const revoked = yield* revokeTerminal(transition);
      if (revoked !== undefined) transitions.push(revoked);
    }
    return transitions;
  });

  return RunLifecycle.of({ handleThreadEvent, reconcile, failRun });
};

const make = Effect.gen(function* () {
  const persistence = yield* makeRunLifecyclePersistence;
  const orchestration = yield* OrchestrationBridge.OrchestrationBridge;
  const projectionError = (message: string) => (cause: unknown) =>
    lifecycleError("projection", message, cause);
  const service = makeWithDependencies({
    persistence,
    getThread: (threadId) =>
      orchestration
        .getThreadShellById(threadId)
        .pipe(
          Effect.map(Option.getOrUndefined),
          Effect.mapError(projectionError("The linked provider thread could not be inspected.")),
        ),
    getRunFailureMessage: (input) =>
      orchestration
        .getRunFailureMessage(input)
        .pipe(Effect.mapError(projectionError("The run failure could not be read."))),
    revokeThread: McpSessionRegistry.revokeActiveMcpThread,
  });

  // Subscribe before reconciling so a run that ends meanwhile is not missed;
  // both paths settle a Run with the same compare-and-set and audit ids.
  yield* Stream.runForEach(orchestration.streamThreadEvents, (event) =>
    service.handleThreadEvent(event).pipe(
      Effect.catch((error) =>
        Effect.logError("command-center.run-lifecycle.thread-event-failed", {
          eventId: event.id,
          threadId: event.threadId,
          reason: error.reason,
        }),
      ),
    ),
  ).pipe(
    Effect.catch((cause) =>
      Effect.logError("command-center.run-lifecycle.thread-events-unavailable", {
        message: cause.message,
      }),
    ),
    Effect.forkScoped,
  );

  yield* service.reconcile.pipe(
    Effect.tap((transitions) =>
      transitions.length === 0
        ? Effect.void
        : Effect.logInfo("command-center.run-lifecycle.reconciled", {
            transitionCount: transitions.length,
          }),
    ),
    Effect.catch((error) =>
      Effect.logError("command-center.run-lifecycle.reconcile-failed", {
        reason: error.reason,
      }),
    ),
  );

  return service;
});

export const layer = Layer.effect(RunLifecycle, make);
