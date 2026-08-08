import {
  COMMAND_CENTER_EVENT_ACTIONS,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderService from "../provider/Services/ProviderService.ts";
import { makeCommandCenterAuditLog } from "./AuditLog.ts";

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

export class RunLifecycleError extends Schema.TaggedErrorClass<RunLifecycleError>()(
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

const isCancellationReason = (reason: string | undefined): boolean =>
  reason !== undefined &&
  /\b(cancel(?:led|ed)?|interrupt(?:ed)?|stop(?:ped)? by user)\b/iu.test(reason);

export interface ProviderEventTransition {
  readonly status: "running" | TerminalRunStatus;
  readonly error?: string;
  readonly failure?: {
    readonly reason: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

/** Maps only provider events that authoritatively change a Command Center Run lifecycle. */
export const transitionForProviderEvent = (
  event: ProviderRuntimeEvent,
): ProviderEventTransition | undefined => {
  switch (event.type) {
    case "turn.started":
      return { status: "running" };
    case "turn.completed": {
      switch (event.payload.state) {
        case "completed":
          return { status: "succeeded" };
        case "interrupted":
        case "cancelled":
          return {
            status: "canceled",
            error: nonEmptyMessage(event.payload.stopReason, "The provider turn was canceled."),
          };
        case "failed": {
          const message = nonEmptyMessage(
            event.payload.errorMessage ?? event.payload.stopReason,
            "The provider turn failed.",
          );
          return {
            status: "failed",
            error: message,
            failure: {
              reason: "provider-turn-failed",
              message,
              retryable: true,
            },
          };
        }
      }
    }
    case "turn.aborted":
      return {
        status: "canceled",
        error: nonEmptyMessage(event.payload.reason, "The provider turn was aborted."),
      };
    case "runtime.error": {
      const message = nonEmptyMessage(event.payload.message, "The provider runtime failed.");
      return {
        status: "failed",
        error: message,
        failure: {
          reason: event.payload.class ?? "provider-runtime-error",
          message,
          retryable: event.payload.class !== "permission_error",
        },
      };
    }
    case "session.state.changed":
      if (event.payload.state !== "error") return undefined;
      return {
        status: "failed",
        error: nonEmptyMessage(
          event.payload.reason,
          "The provider session entered an error state.",
        ),
        failure: {
          reason: "provider-session-error",
          message: nonEmptyMessage(
            event.payload.reason,
            "The provider session entered an error state.",
          ),
          retryable: true,
        },
      };
    case "thread.state.changed":
      if (event.payload.state !== "error") return undefined;
      return {
        status: "failed",
        error: "The provider thread entered an error state.",
        failure: {
          reason: "provider-thread-error",
          message: "The provider thread entered an error state.",
          retryable: true,
        },
      };
    case "session.exited": {
      if (event.payload.recoverable === true) return undefined;
      if (isCancellationReason(event.payload.reason)) {
        return {
          status: "canceled",
          error: nonEmptyMessage(event.payload.reason, "The provider session was stopped."),
        };
      }
      const message = nonEmptyMessage(
        event.payload.reason,
        event.payload.exitKind === "error"
          ? "The provider session exited with an error."
          : "The provider session exited before the Run completed.",
      );
      return {
        status: "failed",
        error: message,
        failure: {
          reason: "provider-session-exited",
          message,
          retryable: true,
        },
      };
    }
    default:
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
            const appended = yield* appendAudit({
              eventId: `cc:run:${run.id}:provider:${input.sourceEventId}:running`,
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
  readonly handleProviderEvent: (
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<RunTransition | undefined, RunLifecycleError>;
  readonly handleOrchestrationEvent: (
    event: OrchestrationEvent,
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
  ) => Effect.Effect<OrchestrationThreadShell | undefined, RunLifecycleError>;
  readonly listProviderSessions: Effect.Effect<ReadonlyArray<ProviderSession>>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
}

const isLiveProviderSession = (
  sessions: ReadonlyArray<ProviderSession>,
  threadId: string,
): boolean =>
  sessions.some(
    (session) =>
      session.threadId === threadId &&
      (session.status === "connecting" ||
        session.status === "ready" ||
        session.status === "running"),
  );

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

  const handleProviderEvent = Effect.fn("RunLifecycle.handleProviderEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    const selected = transitionForProviderEvent(event);
    if (selected === undefined) return undefined;
    const transition = yield* deps.persistence.transition({
      threadId: event.threadId,
      sourceEventId: event.eventId,
      status: selected.status,
      actorKind: "agent",
      occurredAt: event.createdAt,
      ...(selected.error === undefined ? {} : { error: selected.error }),
      ...(selected.failure === undefined ? {} : { failure: selected.failure }),
    });
    return yield* revokeTerminal(transition);
  });

  const handleOrchestrationEvent = Effect.fn("RunLifecycle.handleOrchestrationEvent")(function* (
    event: OrchestrationEvent,
  ) {
    if (event.type !== "thread.session-set" || event.payload.session.status !== "error") {
      return undefined;
    }
    const message = nonEmptyMessage(
      event.payload.session.lastError,
      "The provider session failed to start.",
    );
    const transition = yield* deps.persistence.transition({
      threadId: event.payload.threadId,
      sourceEventId: event.eventId,
      status: "failed",
      actorKind: "agent",
      occurredAt: event.occurredAt,
      error: message,
      failure: {
        reason: "provider-session-error",
        message,
        retryable: true,
      },
      allowedPreviousStates: ["queued", "running"],
    });
    return yield* revokeTerminal(transition);
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

  const reconcile: RunLifecycleShape["reconcile"] = Effect.gen(function* () {
    const [runs, sessions] = yield* Effect.all(
      [deps.persistence.listRunning, deps.listProviderSessions],
      { concurrency: 2 },
    );
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
        const latestTurn = thread?.latestTurn;
        const occurredAt = latestTurn?.completedAt ?? thread?.updatedAt ?? reconciliationTime;
        switch (latestTurn?.state) {
          case "completed":
            transition = yield* deps.persistence.transition({
              runId: run.id,
              sourceEventId: `${sourceEventId}:${latestTurn.turnId}:completed`,
              status: "succeeded",
              actorKind: "system",
              occurredAt,
            });
            break;
          case "interrupted":
            transition = yield* deps.persistence.transition({
              runId: run.id,
              sourceEventId: `${sourceEventId}:${latestTurn.turnId}:interrupted`,
              status: "canceled",
              actorKind: "system",
              occurredAt,
              error: "The provider turn was interrupted before the server restarted.",
            });
            break;
          case "error": {
            const message = nonEmptyMessage(
              thread?.session?.lastError,
              "The provider turn failed before the server restarted.",
            );
            transition = yield* deps.persistence.transition({
              runId: run.id,
              sourceEventId: `${sourceEventId}:${latestTurn.turnId}:error`,
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
          case undefined:
            if (!isLiveProviderSession(sessions, run.threadId)) {
              const message =
                "The server restarted and no live provider session can continue this Run.";
              transition = yield* deps.persistence.transition({
                runId: run.id,
                sourceEventId: `${sourceEventId}:${latestTurn?.turnId ?? "no-turn"}:orphaned`,
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
            }
            break;
        }
      }
      const revoked = yield* revokeTerminal(transition);
      if (revoked !== undefined) transitions.push(revoked);
    }
    return transitions;
  });

  return RunLifecycle.of({ handleProviderEvent, handleOrchestrationEvent, reconcile, failRun });
};

const make = Effect.gen(function* () {
  const persistence = yield* makeRunLifecyclePersistence;
  const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const provider = yield* ProviderService.ProviderService;
  const orchestration = yield* OrchestrationEngine.OrchestrationEngineService;
  const service = makeWithDependencies({
    persistence,
    getThread: (threadId) =>
      projection.getThreadShellById(threadId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError((cause) =>
          lifecycleError("projection", "The linked provider thread could not be inspected.", cause),
        ),
      ),
    listProviderSessions: provider.listSessions(),
    revokeThread: McpSessionRegistry.revokeActiveMcpThread,
  });

  yield* Stream.runForEach(provider.streamEvents, (event) =>
    service.handleProviderEvent(event).pipe(
      Effect.catch((error) =>
        Effect.logError("command-center.run-lifecycle.provider-event-failed", {
          eventId: event.eventId,
          threadId: event.threadId,
          reason: error.reason,
        }),
      ),
    ),
  ).pipe(Effect.forkScoped);

  yield* Stream.runForEach(orchestration.streamDomainEvents, (event) =>
    service.handleOrchestrationEvent(event).pipe(
      Effect.catch((error) =>
        Effect.logError("command-center.run-lifecycle.orchestration-event-failed", {
          eventId: event.eventId,
          threadId: event.aggregateKind === "thread" ? event.aggregateId : undefined,
          reason: error.reason,
        }),
      ),
    ),
  ).pipe(Effect.forkScoped);

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
