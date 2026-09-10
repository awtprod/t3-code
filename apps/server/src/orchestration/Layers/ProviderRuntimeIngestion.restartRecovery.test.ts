// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type ProviderSession,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { ProviderRestartRecoveryRepositoryLive } from "../../persistence/Layers/ProviderRestartRecovery.ts";
import { ProviderTurnSendClaimRepositoryLive } from "../../persistence/Layers/ProviderTurnSendClaims.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProviderRestartRecoveryRepository } from "../../persistence/Services/ProviderRestartRecovery.ts";
import { ProviderTurnSendClaimRepository } from "../../persistence/Services/ProviderTurnSendClaims.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";

const at = (second: number) => `2026-09-09T00:00:${String(second).padStart(2, "0")}.000Z` as const;

const providerService: ProviderServiceShape = {
  startSession: () => Effect.die(new Error("provider calls are forbidden in restart tests")),
  sendTurn: () => Effect.die(new Error("provider calls are forbidden in restart tests")),
  interruptTurn: () => Effect.die(new Error("provider calls are forbidden in restart tests")),
  respondToRequest: () => Effect.die(new Error("provider calls are forbidden in restart tests")),
  respondToUserInput: () => Effect.die(new Error("provider calls are forbidden in restart tests")),
  stopSession: () => Effect.die(new Error("provider calls are forbidden in restart tests")),
  listSessions: () => Effect.succeed([] as ReadonlyArray<ProviderSession>),
  getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
  getInstanceInfo: (instanceId) => {
    const driverKind = ProviderDriverKind.make(String(instanceId));
    return Effect.succeed({
      instanceId,
      driverKind,
      displayName: undefined,
      enabled: true,
      continuationIdentity: {
        driverKind,
        continuationKey: `${driverKind}:instance:${instanceId}`,
      },
    });
  },
  rollbackConversation: () =>
    Effect.die(new Error("provider calls are forbidden in restart tests")),
  streamEvents: Stream.empty,
};

function makeTestLayer(dbPath: string, workspaceRoot: string) {
  const persistenceLayer = makeSqlitePersistenceLive(dbPath).pipe(
    Layer.provide(NodeServices.layer),
  );
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
  );
  const snapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(RepositoryIdentityResolver.layer),
  );
  const ingestionLayer = ProviderRuntimeIngestionLive.pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(snapshotLayer),
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(ThreadPlanProgress.layer),
    Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
    Layer.provideMerge(
      Layer.mock(ProviderSessionDirectory)({
        getBinding: () => Effect.succeed(Option.none()),
      }),
    ),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(ServerConfig.layerTest(workspaceRoot, workspaceRoot)),
    Layer.provideMerge(NodeServices.layer),
  );

  return Layer.mergeAll(
    ingestionLayer,
    orchestrationLayer,
    snapshotLayer,
    ProviderRestartRecoveryRepositoryLive,
    ProviderTurnSendClaimRepositoryLive,
    ProjectionTurnRepositoryLive,
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(ThreadPlanProgress.layer),
    Layer.provideMerge(ServerConfig.layerTest(workspaceRoot, workspaceRoot)),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(persistenceLayer),
  );
}

const services = Effect.all({
  engine: Effect.service(OrchestrationEngineService),
  ingestion: Effect.service(ProviderRuntimeIngestionService),
  snapshots: Effect.service(ProjectionSnapshotQuery),
  turns: Effect.service(ProjectionTurnRepository),
  claims: Effect.service(ProviderTurnSendClaimRepository),
  recoveries: Effect.service(ProviderRestartRecoveryRepository),
  sql: Effect.service(SqlClient.SqlClient),
});

function seedProjectAndThread(threadId = ThreadId.make("thread-restart")) {
  return Effect.gen(function* () {
    const { engine, snapshots } = yield* services;
    const dispatch = (command: OrchestrationCommand) => engine.dispatch(command);
    const projectId = ProjectId.make("project-restart");
    const existing = yield* snapshots.getSnapshot();
    if (!existing.projects.some((project) => project.id === projectId)) {
      yield* dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-restart"),
        projectId,
        title: "Restart project",
        workspaceRoot: NodePath.dirname(NodePath.dirname(NodePath.resolve("."))),
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt: at(0),
      });
    }
    yield* dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-create-${threadId}`),
      threadId,
      projectId,
      title: `Restart ${threadId}`,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: at(0),
    });
    return { dispatch, threadId };
  });
}

function seedPending(
  threadId = ThreadId.make("thread-restart"),
  messageId = MessageId.make(`message-${threadId}`),
) {
  return Effect.gen(function* () {
    const { dispatch } = yield* seedProjectAndThread(threadId);
    yield* dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`cmd-start-${threadId}`),
      threadId,
      message: {
        messageId,
        role: "user",
        text: "Preserve this exact request",
        attachments: [
          {
            type: "image",
            id: `image-${threadId}`,
            name: "proof.png",
            mimeType: "image/png",
            sizeBytes: 17,
          },
        ],
      },
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-codex",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: at(1),
    });
    const { turns } = yield* services;
    const pending = yield* turns.listPendingTurnStartsByThreadId({ threadId });
    expect(pending).toHaveLength(1);
    return { threadId, messageId, pending: pending[0]! };
  });
}

function linkCommandCenterRun(
  threadId: ThreadId,
  runId: string,
  state: "failed" | "canceled" | "succeeded" | "running",
) {
  return Effect.gen(function* () {
    const { sql } = yield* services;
    yield* sql`
    INSERT OR IGNORE INTO command_center_spaces (
      id, slug, name, kind, created_at, updated_at
    ) VALUES (
      'restart-recovery-space',
      'restart-recovery-space',
      'Restart recovery',
      'system',
      ${at(0)},
      ${at(0)}
    )
    `;
    yield* sql`
    INSERT INTO command_center_runs (
      id, command_id, space_id, thread_id, kind, state, route_json, input_json,
      started_at, execution_authorized_at
    ) VALUES (
      ${runId},
      ${`command-${runId}`},
      'restart-recovery-space',
      ${threadId},
      'agent',
      ${state},
      '{}',
      '{}',
      ${at(0)},
      NULL
    )
    `;
  });
}

interface TestState {
  readonly dir: string;
  readonly dbPath: string;
}

const withTempState = <A, E, R>(use: (state: TestState) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-restart-recovery-"));
      NodeFS.mkdirSync(NodePath.join(dir, ".git"));
      return { dir, dbPath: NodePath.join(dir, "state.sqlite") };
    }),
    use,
    ({ dir }) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

const inFreshContext = <A, E, R>(state: TestState, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(makeTestLayer(state.dbPath, state.dir)));

describe("ProviderRuntimeIngestion restart recovery", () => {
  it.effect(
    "recovers never-claimed pending work twice across reconstructed contexts, then stops",
    () =>
      withTempState((state) =>
        Effect.gen(function* () {
          const seeded = yield* inFreshContext(
            state,
            Effect.gen(function* () {
              const seeded = yield* seedPending();
              const { ingestion, snapshots, turns } = yield* services;
              yield* ingestion.reconcileOrphanedTurns;
              const snapshot = yield* snapshots.getSnapshot();
              const thread = snapshot.threads.find((entry) => entry.id === seeded.threadId)!;
              expect(thread.messages).toHaveLength(1);
              expect(thread.messages[0]).toMatchObject({
                id: seeded.messageId,
                text: "Preserve this exact request",
                attachments: [{ id: `image-${seeded.threadId}`, name: "proof.png" }],
              });
              const pending = yield* turns.listPendingTurnStartsByThreadId({
                threadId: seeded.threadId,
              });
              expect(pending).toHaveLength(1);
              expect(pending[0]?.modelSelection).toEqual({
                instanceId: "codex",
                model: "gpt-5.6-codex",
                options: [{ id: "reasoningEffort", value: "high" }],
              });
              return seeded;
            }),
          );

          yield* inFreshContext(
            state,
            Effect.flatMap(services, ({ ingestion }) => ingestion.reconcileOrphanedTurns),
          );

          yield* inFreshContext(
            state,
            Effect.gen(function* () {
              const { ingestion, snapshots, sql, turns } = yield* services;
              yield* ingestion.reconcileOrphanedTurns;
              const snapshot = yield* snapshots.getSnapshot();
              const thread = snapshot.threads.find((entry) => entry.id === seeded.threadId)!;
              const pending = yield* turns.listPendingTurnStartsByThreadId({
                threadId: seeded.threadId,
              });
              const ledger = yield* sql<{
                readonly attempt: number;
                readonly rootRequestSequence: number;
                readonly replacementRequestSequence: number | null;
              }>`
                SELECT
                  attempt,
                  root_request_sequence AS "rootRequestSequence",
                  replacement_request_sequence AS "replacementRequestSequence"
                FROM provider_restart_recoveries
                WHERE thread_id = ${seeded.threadId}
                  AND message_id = ${seeded.messageId}
                ORDER BY attempt
              `;
              expect(pending).toEqual([]);
              expect(ledger).toHaveLength(2);
              expect(ledger.map((row) => row.rootRequestSequence)).toEqual([
                seeded.pending.requestSequence,
                seeded.pending.requestSequence,
              ]);
              expect(ledger.every((row) => row.replacementRequestSequence !== null)).toBe(true);
              expect(thread.messages).toHaveLength(1);
              expect(
                thread.activities.some(
                  (activity) => activity.kind === "provider.turn.start.orphaned",
                ),
              ).toBe(true);
            }),
          );
        }),
      ),
  );

  it.effect(
    "reuses a concurrent pre-dispatch reservation after restart without duplicating work",
    () =>
      withTempState((state) =>
        Effect.gen(function* () {
          const seeded = yield* inFreshContext(
            state,
            Effect.gen(function* () {
              const seeded = yield* seedPending();
              const { recoveries, turns } = yield* services;
              const reserve = () =>
                recoveries.reserve({
                  threadId: seeded.threadId,
                  messageId: seeded.messageId,
                  originalRequestSequence: seeded.pending.requestSequence,
                  reservedAt: at(2),
                });
              const reservations = yield* Effect.all([reserve(), reserve()], {
                concurrency: "unbounded",
              });
              expect(reservations[0]).toEqual(reservations[1]);
              const pending = yield* turns.listPendingTurnStartsByThreadId({
                threadId: seeded.threadId,
              });
              expect(pending.map((row) => row.requestSequence)).toEqual([
                seeded.pending.requestSequence,
              ]);
              return seeded;
            }),
          );

          yield* inFreshContext(
            state,
            Effect.gen(function* () {
              const { ingestion, snapshots, sql, turns } = yield* services;
              yield* ingestion.reconcileOrphanedTurns;
              const snapshot = yield* snapshots.getSnapshot();
              const thread = snapshot.threads.find((entry) => entry.id === seeded.threadId)!;
              const pending = yield* turns.listPendingTurnStartsByThreadId({
                threadId: seeded.threadId,
              });
              const ledger = yield* sql<{ readonly count: number }>`
                SELECT COUNT(*) AS count FROM provider_restart_recoveries
                WHERE thread_id = ${seeded.threadId} AND message_id = ${seeded.messageId}
              `;
              expect(ledger[0]?.count).toBe(1);
              expect(pending).toHaveLength(1);
              expect(thread.messages).toHaveLength(1);
            }),
          );
        }),
      ),
  );

  it.effect("excludes terminal and unauthorized running Command Center Run threads", () =>
    withTempState((state) =>
      inFreshContext(
        state,
        Effect.gen(function* () {
          const { ingestion, sql, turns } = yield* services;
          const runStates = ["failed", "canceled", "succeeded", "running"] as const;

          for (const runState of runStates) {
            const threadId = ThreadId.make(`thread-linked-run-${runState}`);
            const seeded = yield* seedPending(
              threadId,
              MessageId.make(`message-linked-run-${runState}`),
            );
            yield* linkCommandCenterRun(threadId, `linked-run-${runState}`, runState);
            yield* ingestion.reconcileOrphanedTurns;
            const pending = yield* turns.listPendingTurnStartsByThreadId({ threadId });
            const reservations = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count
              FROM provider_restart_recoveries
              WHERE thread_id = ${threadId}
            `;
            expect(
              pending.some((row) => row.requestSequence !== seeded.pending.requestSequence),
              `linked Run state ${runState} must not receive a replacement turn`,
            ).toBe(false);
            expect(reservations[0]?.count, `linked Run state ${runState}`).toBe(0);
          }
        }),
      ),
    ),
  );

  it.effect(
    "fences a reserved recovery when a Command Center Run is linked before reuse or send",
    () =>
      withTempState((state) =>
        inFreshContext(
          state,
          Effect.gen(function* () {
            const seeded = yield* seedPending();
            const { claims, engine, recoveries } = yield* services;
            const reservation = yield* recoveries.reserve({
              threadId: seeded.threadId,
              messageId: seeded.messageId,
              originalRequestSequence: seeded.pending.requestSequence,
              reservedAt: at(2),
            });
            expect(reservation._tag).toBe("reserved");
            if (reservation._tag !== "reserved") return;

            yield* linkCommandCenterRun(seeded.threadId, "intervening-linked-run", "running");
            const reused = yield* recoveries.reserve({
              threadId: seeded.threadId,
              messageId: seeded.messageId,
              originalRequestSequence: seeded.pending.requestSequence,
              reservedAt: at(3),
            });
            expect(reused).toEqual({ _tag: "ineligible" });

            const replacement = yield* engine.dispatch({
              type: "thread.turn.start",
              commandId: reservation.reservation.commandId,
              threadId: seeded.threadId,
              message: {
                messageId: seeded.messageId,
                role: "user",
                text: "Preserve this exact request",
                attachments: [],
              },
              ...(seeded.pending.modelSelection !== null
                ? { modelSelection: seeded.pending.modelSelection }
                : {}),
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              runtimeMode: "approval-required",
              createdAt: reservation.reservation.reservedAt,
            });
            const claim = yield* claims.acquire({
              threadId: seeded.threadId,
              messageId: seeded.messageId,
              requestSequence: replacement.sequence,
              claimedAt: at(4),
            });
            expect(claim._tag).not.toBe("acquired");
          }),
        ),
      ),
  );

  it.effect("carries a stop barrier across recovery generations", () =>
    withTempState((state) =>
      inFreshContext(
        state,
        Effect.gen(function* () {
          const seeded = yield* seedPending();
          const { claims, engine, ingestion, recoveries, sql, turns } = yield* services;
          const first = yield* recoveries.reserve({
            threadId: seeded.threadId,
            messageId: seeded.messageId,
            originalRequestSequence: seeded.pending.requestSequence,
            reservedAt: at(2),
          });
          expect(first._tag).toBe("reserved");
          if (first._tag !== "reserved") return;

          yield* claims.cancel({
            threadId: seeded.threadId,
            canceledThroughSequence: NonNegativeInt.make(seeded.pending.requestSequence + 1),
            updatedAt: at(3),
          });
          const replacement = yield* engine.dispatch({
            type: "thread.turn.start",
            commandId: first.reservation.commandId,
            threadId: seeded.threadId,
            message: {
              messageId: seeded.messageId,
              role: "user",
              text: "Preserve this exact request",
              attachments: [],
            },
            ...(seeded.pending.modelSelection !== null
              ? { modelSelection: seeded.pending.modelSelection }
              : {}),
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: first.reservation.reservedAt,
          });
          yield* recoveries.complete({
            threadId: seeded.threadId,
            messageId: seeded.messageId,
            originalRequestSequence: seeded.pending.requestSequence,
            replacementRequestSequence: replacement.sequence,
            dispatchedAt: at(3),
          });
          yield* turns.deletePendingTurnStart({
            threadId: seeded.threadId,
            requestSequence: seeded.pending.requestSequence,
          });

          yield* ingestion.reconcileOrphanedTurns;
          const pending = yield* turns.listPendingTurnStartsByThreadId({
            threadId: seeded.threadId,
          });
          const ledger = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM provider_restart_recoveries
        WHERE thread_id = ${seeded.threadId} AND message_id = ${seeded.messageId}
          `;
          const claim = yield* claims.acquire({
            threadId: seeded.threadId,
            messageId: seeded.messageId,
            requestSequence: replacement.sequence,
            claimedAt: at(4),
          });

          expect(pending).toEqual([]);
          expect(ledger[0]?.count).toBe(1);
          expect(claim).toEqual({ _tag: "canceled" });
        }),
      ),
    ),
  );

  it.effect("does not let a reserved recovery take over a late original send claim", () =>
    withTempState((state) =>
      inFreshContext(
        state,
        Effect.gen(function* () {
          const seeded = yield* seedPending();
          const { claims, engine, recoveries } = yield* services;
          const reservation = yield* recoveries.reserve({
            threadId: seeded.threadId,
            messageId: seeded.messageId,
            originalRequestSequence: seeded.pending.requestSequence,
            reservedAt: at(2),
          });
          expect(reservation._tag).toBe("reserved");
          if (reservation._tag !== "reserved") return;

          const originalClaim = yield* claims.acquire({
            threadId: seeded.threadId,
            messageId: seeded.messageId,
            requestSequence: seeded.pending.requestSequence,
            claimedAt: at(3),
          });
          const replacement = yield* engine.dispatch({
            type: "thread.turn.start",
            commandId: reservation.reservation.commandId,
            threadId: seeded.threadId,
            message: {
              messageId: seeded.messageId,
              role: "user",
              text: "Preserve this exact request",
              attachments: [],
            },
            ...(seeded.pending.modelSelection !== null
              ? { modelSelection: seeded.pending.modelSelection }
              : {}),
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: reservation.reservation.reservedAt,
          });
          const recoveryClaim = yield* claims.acquire({
            threadId: seeded.threadId,
            messageId: seeded.messageId,
            requestSequence: replacement.sequence,
            claimedAt: at(4),
          });

          expect(originalClaim).toEqual({ _tag: "acquired" });
          expect(recoveryClaim).toEqual({
            _tag: "superseded",
            heldBySequence: seeded.pending.requestSequence,
          });
        }),
      ),
    ),
  );

  it.effect("does not restart claimed or uncertain pending work", () =>
    withTempState((state) =>
      inFreshContext(
        state,
        Effect.gen(function* () {
          const seeded = yield* seedPending();
          const { claims, ingestion, sql, turns } = yield* services;
          yield* claims.acquire({
            threadId: seeded.threadId,
            messageId: seeded.messageId,
            requestSequence: seeded.pending.requestSequence,
            claimedAt: at(2),
          });

          yield* ingestion.reconcileOrphanedTurns;
          const pending = yield* turns.listPendingTurnStartsByThreadId({
            threadId: seeded.threadId,
          });
          const ledger = yield* sql<{
            readonly count: number;
          }>`SELECT COUNT(*) AS count FROM provider_restart_recoveries`;
          expect(pending).toEqual([]);
          expect(ledger[0]?.count).toBe(0);
        }),
      ),
    ),
  );

  it.effect("retains malformed persisted message evidence instead of recovering it", () =>
    withTempState((state) =>
      inFreshContext(
        state,
        Effect.gen(function* () {
          const seeded = yield* seedPending();
          const { ingestion, sql, turns } = yield* services;
          yield* sql`
      UPDATE projection_thread_messages
      SET attachments_json = '{'
      WHERE message_id = ${seeded.messageId}
          `;

          yield* ingestion.reconcileOrphanedTurns;
          const pending = yield* turns.listPendingTurnStartsByThreadId({
            threadId: seeded.threadId,
          });
          const rows = yield* sql<{
            readonly recoveryCount: number;
            readonly orphanCount: number;
          }>`
        SELECT
          (SELECT COUNT(*) FROM provider_restart_recoveries) AS "recoveryCount",
          (
            SELECT COUNT(*)
            FROM projection_thread_activities
            WHERE thread_id = ${seeded.threadId}
              AND kind = 'provider.turn.start.orphaned'
          ) AS "orphanCount"
          `;
          expect(pending).toHaveLength(1);
          expect(rows[0]).toEqual({ recoveryCount: 0, orphanCount: 0 });
        }),
      ),
    ),
  );

  it.effect("interrupts an actual running orphan without replaying it", () =>
    withTempState((state) =>
      inFreshContext(
        state,
        Effect.gen(function* () {
          const seeded = yield* seedPending();
          const { engine, ingestion, sql, turns } = yield* services;
          const turnId = TurnId.make("running-orphan-turn");
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-running-orphan"),
            threadId: seeded.threadId,
            session: {
              threadId: seeded.threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: turnId,
              lastError: null,
              updatedAt: at(2),
            },
            pendingTurnStartAdoption: "exact",
            turnRequestSequence: seeded.pending.requestSequence,
            createdAt: at(2),
          });

          yield* ingestion.reconcileOrphanedTurns;
          const turn = yield* turns.getByTurnId({ threadId: seeded.threadId, turnId });
          const ledger = yield* sql<{
            readonly count: number;
          }>`SELECT COUNT(*) AS count FROM provider_restart_recoveries`;
          expect(Option.getOrUndefined(turn)?.state).toBe("interrupted");
          expect(ledger[0]?.count).toBe(0);
        }),
      ),
    ),
  );

  it.effect(
    "keeps a reserved recovery behind an intervening cancel or same-message replacement",
    () =>
      withTempState((state) =>
        inFreshContext(
          state,
          Effect.gen(function* () {
            const canceled = yield* seedPending(
              ThreadId.make("thread-reserved-cancel"),
              MessageId.make("message-reserved-cancel"),
            );
            const superseded = yield* seedPending(
              ThreadId.make("thread-reserved-supersede"),
              MessageId.make("message-reserved-supersede"),
            );
            const { claims, engine, recoveries } = yield* services;

            const canceledReservation = yield* recoveries.reserve({
              threadId: canceled.threadId,
              messageId: canceled.messageId,
              originalRequestSequence: canceled.pending.requestSequence,
              reservedAt: at(2),
            });
            expect(canceledReservation._tag).toBe("reserved");
            if (canceledReservation._tag !== "reserved") return;
            yield* claims.cancel({
              threadId: canceled.threadId,
              canceledThroughSequence: canceled.pending.requestSequence,
              updatedAt: at(3),
            });
            const canceledDispatch = yield* engine.dispatch({
              type: "thread.turn.start",
              commandId: canceledReservation.reservation.commandId,
              threadId: canceled.threadId,
              message: {
                messageId: canceled.messageId,
                role: "user",
                text: "Preserve this exact request",
                attachments: [],
              },
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              runtimeMode: "approval-required",
              createdAt: at(2),
            });
            const canceledClaim = yield* claims.acquire({
              threadId: canceled.threadId,
              messageId: canceled.messageId,
              requestSequence: canceledDispatch.sequence,
              claimedAt: at(4),
            });

            const supersededReservation = yield* recoveries.reserve({
              threadId: superseded.threadId,
              messageId: superseded.messageId,
              originalRequestSequence: superseded.pending.requestSequence,
              reservedAt: at(2),
            });
            expect(supersededReservation._tag).toBe("reserved");
            if (supersededReservation._tag !== "reserved") return;
            const supersededDispatch = yield* engine.dispatch({
              type: "thread.turn.start",
              commandId: supersededReservation.reservation.commandId,
              threadId: superseded.threadId,
              message: {
                messageId: superseded.messageId,
                role: "user",
                text: "Preserve this exact request",
                attachments: [],
              },
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              runtimeMode: "approval-required",
              createdAt: at(2),
            });
            const initiallyAcquired = yield* claims.acquire({
              threadId: superseded.threadId,
              messageId: superseded.messageId,
              requestSequence: supersededDispatch.sequence,
              claimedAt: at(3),
            });
            yield* engine.dispatch({
              type: "thread.turn.start",
              commandId: CommandId.make("cmd-newer-same-message"),
              threadId: superseded.threadId,
              message: {
                messageId: superseded.messageId,
                role: "user",
                text: "Newer explicit request",
                attachments: [],
              },
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              runtimeMode: "approval-required",
              createdAt: at(3),
            });
            const supersededClaim = yield* claims.acquire({
              threadId: superseded.threadId,
              messageId: superseded.messageId,
              requestSequence: supersededDispatch.sequence,
              claimedAt: at(4),
            });

            expect(canceledClaim).toEqual({ _tag: "canceled" });
            expect(initiallyAcquired).toEqual({ _tag: "acquired" });
            expect(supersededClaim).toEqual({ _tag: "superseded" });
          }),
        ),
      ),
  );

  it.effect("keeps cancellation, archive/delete, and human holds out of automatic recovery", () =>
    withTempState((state) =>
      inFreshContext(
        state,
        Effect.gen(function* () {
          const canceled = yield* seedPending(
            ThreadId.make("thread-canceled"),
            MessageId.make("message-canceled"),
          );
          const archived = yield* seedPending(
            ThreadId.make("thread-archived"),
            MessageId.make("message-archived"),
          );
          const approval = yield* seedPending(
            ThreadId.make("thread-approval"),
            MessageId.make("message-approval"),
          );
          const userInput = yield* seedPending(
            ThreadId.make("thread-user-input"),
            MessageId.make("message-user-input"),
          );
          const deleted = yield* seedPending(
            ThreadId.make("thread-deleted"),
            MessageId.make("message-deleted"),
          );
          const { engine, ingestion, sql, turns } = yield* services;

          yield* engine.dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.make("cmd-cancel-pending"),
            threadId: canceled.threadId,
            createdAt: at(2),
          });
          yield* engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make("cmd-user-input-pending"),
            threadId: userInput.threadId,
            activity: {
              id: EventId.make("activity-user-input-pending"),
              tone: "approval",
              kind: "user-input.requested",
              summary: "User input required",
              payload: { requestId: ApprovalRequestId.make("request-user-input-pending") },
              turnId: null,
              createdAt: at(2),
            },
            createdAt: at(2),
          });
          yield* engine.dispatch({
            type: "thread.delete",
            commandId: CommandId.make("cmd-delete-pending"),
            threadId: deleted.threadId,
          });
          yield* engine.dispatch({
            type: "thread.archive",
            commandId: CommandId.make("cmd-archive-pending"),
            threadId: archived.threadId,
          });
          yield* engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make("cmd-approval-pending"),
            threadId: approval.threadId,
            activity: {
              id: EventId.make("activity-approval-pending"),
              tone: "approval",
              kind: "approval.requested",
              summary: "Approval required",
              payload: { requestId: ApprovalRequestId.make("request-approval-pending") },
              turnId: null,
              createdAt: at(2),
            },
            createdAt: at(2),
          });

          yield* ingestion.reconcileOrphanedTurns;
          const canceledPending = yield* turns.listPendingTurnStartsByThreadId({
            threadId: canceled.threadId,
          });
          const archivedPending = yield* turns.listPendingTurnStartsByThreadId({
            threadId: archived.threadId,
          });
          const approvalPending = yield* turns.listPendingTurnStartsByThreadId({
            threadId: approval.threadId,
          });
          const userInputPending = yield* turns.listPendingTurnStartsByThreadId({
            threadId: userInput.threadId,
          });
          const deletedPending = yield* turns.listPendingTurnStartsByThreadId({
            threadId: deleted.threadId,
          });
          const ledger = yield* sql<{
            readonly count: number;
          }>`SELECT COUNT(*) AS count FROM provider_restart_recoveries`;

          expect(canceledPending).toEqual([]);
          expect(approvalPending).toEqual([]);
          expect(userInputPending).toEqual([]);
          expect(archivedPending).toHaveLength(1);
          expect(deletedPending).toHaveLength(1);
          expect(ledger[0]?.count).toBe(0);
        }),
      ),
    ),
  );
});
