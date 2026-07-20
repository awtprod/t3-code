import type { ProviderAvailability, RunId } from "@command-center/core";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as OrchestrationCommandDispatcher from "../orchestration/CommandDispatcher.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import { commandCenterProviderAvailability } from "./ProviderAvailability.ts";
import * as RunDispatcher from "./RunDispatcher.ts";
import * as CommandCenterService from "./Service.ts";

const DEFAULT_POLL_INTERVAL = Duration.seconds(5);
const DEFAULT_BATCH_LIMIT = 50;

export interface RecoverableRunCandidate {
  readonly runId: RunId;
  readonly state: "queued" | "waiting_approval";
}

export interface RunRecoveryFailure {
  readonly runId: string;
  readonly stage: "configuration" | "list" | "preflight" | "reconcile" | "dispatch";
  readonly reason: string;
}

export interface RunRecoveryReport {
  readonly scanned: number;
  readonly recovered: number;
  readonly duplicates: number;
  readonly reconciled: number;
  readonly deferred: number;
  readonly failures: ReadonlyArray<RunRecoveryFailure>;
}

export interface RunRecoveryCoordinatorShape {
  readonly tick: () => Effect.Effect<RunRecoveryReport, never>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class RunRecoveryCoordinator extends Context.Service<
  RunRecoveryCoordinator,
  RunRecoveryCoordinatorShape
>()("t3/command-center/RunRecoveryCoordinator") {}

export interface RunRecoveryDependencies {
  readonly syncConfiguration: Effect.Effect<void, Error>;
  readonly listCandidates: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<RecoverableRunCandidate>, Error>;
  readonly providerAvailability: Effect.Effect<ReadonlyArray<ProviderAvailability>, Error>;
  readonly inspectRecovery: RunDispatcher.RunDispatcherShape["inspectRecovery"];
  readonly reconcileApproved: RunDispatcher.RunDispatcherShape["reconcileApproved"];
  readonly dispatch: (
    runId: RunId,
  ) => Effect.Effect<RunDispatcher.RunDispatchResult, RunDispatcher.RunDispatcherError>;
}

const failureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const attempt = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => ({ ok: false as const, error }),
      onSuccess: (value) => ({ ok: true as const, value }),
    }),
  );

const emptyReport = (): RunRecoveryReport => ({
  scanned: 0,
  recovered: 0,
  duplicates: 0,
  reconciled: 0,
  deferred: 0,
  failures: [],
});

function providerSupports(
  authorization: RunDispatcher.RunRecoveryAuthorization,
  providers: ReadonlyArray<ProviderAvailability>,
): boolean {
  const provider = providers.find(
    (candidate) => String(candidate.providerId) === authorization.providerId,
  );
  if (provider === undefined || !provider.healthy) return false;
  if (!provider.modelIds.some((modelId) => String(modelId) === authorization.modelId)) return false;
  const capabilities = new Set(provider.capabilities);
  return authorization.capabilities.every((capability) => capabilities.has(capability));
}

export const makeWithDependencies = Effect.fn("RunRecoveryCoordinator.makeWithDependencies")(
  function* (deps: RunRecoveryDependencies) {
    const tickLock = yield* Semaphore.make(1);

    const tick: RunRecoveryCoordinatorShape["tick"] = () =>
      tickLock.withPermits(1)(
        Effect.gen(function* () {
          const report = {
            scanned: 0,
            recovered: 0,
            duplicates: 0,
            reconciled: 0,
            deferred: 0,
            failures: [] as RunRecoveryFailure[],
          };

          const candidatesResult = yield* attempt(deps.listCandidates(DEFAULT_BATCH_LIMIT));
          if (!candidatesResult.ok) {
            report.failures.push({
              runId: "list",
              stage: "list",
              reason: failureMessage(candidatesResult.error),
            });
            return report;
          }
          report.scanned = candidatesResult.value.length;
          if (report.scanned === 0) return report;

          // Config reconciliation can touch disk and inspect the private
          // checkout. Do it only when durable work actually needs recovery,
          // but always before authorization so stale policies fail closed.
          const configuration = yield* attempt(deps.syncConfiguration);
          if (!configuration.ok) {
            report.failures.push({
              runId: "configuration",
              stage: "configuration",
              reason: failureMessage(configuration.error),
            });
            return report;
          }

          const providersResult = yield* attempt(deps.providerAvailability);
          if (!providersResult.ok) {
            report.failures.push({
              runId: "providers",
              stage: "preflight",
              reason: failureMessage(providersResult.error),
            });
            return report;
          }

          const providers = providersResult.value;
          for (const candidate of candidatesResult.value) {
            const authorizationResult = yield* attempt(
              candidate.state === "waiting_approval"
                ? deps.reconcileApproved(candidate.runId)
                : deps.inspectRecovery(candidate.runId),
            );
            if (!authorizationResult.ok) {
              report.deferred += 1;
              report.failures.push({
                runId: candidate.runId,
                stage: candidate.state === "waiting_approval" ? "reconcile" : "preflight",
                reason: authorizationResult.error.message,
              });
              continue;
            }
            if (candidate.state === "waiting_approval") report.reconciled += 1;

            if (!providerSupports(authorizationResult.value, providers)) {
              report.deferred += 1;
              continue;
            }

            const dispatched = yield* attempt(deps.dispatch(candidate.runId));
            if (!dispatched.ok) {
              report.failures.push({
                runId: candidate.runId,
                stage: "dispatch",
                reason: dispatched.error.message,
              });
              continue;
            }
            if (dispatched.value.duplicate) report.duplicates += 1;
            else report.recovered += 1;
          }
          return report;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("command-center.run-recovery-tick-defect", { cause }).pipe(
              Effect.as({
                ...emptyReport(),
                failures: [
                  {
                    runId: "coordinator",
                    stage: "dispatch" as const,
                    reason: "The recovery coordinator encountered an unexpected defect.",
                  },
                ],
              }),
            ),
          ),
        ),
      );

    const start: RunRecoveryCoordinatorShape["start"] = () =>
      Effect.gen(function* () {
        const observedTick = tick().pipe(
          Effect.tap((report) =>
            report.scanned === 0 && report.failures.length === 0
              ? Effect.void
              : Effect.logInfo("command-center.run-recovery-tick", {
                  scanned: report.scanned,
                  recovered: report.recovered,
                  duplicates: report.duplicates,
                  reconciled: report.reconciled,
                  deferred: report.deferred,
                  failures: report.failures.length,
                }),
          ),
        );
        yield* Effect.forkScoped(
          observedTick.pipe(Effect.repeat(Schedule.spaced(DEFAULT_POLL_INTERVAL))),
        );
        yield* Effect.logInfo("command-center.run-recovery-coordinator-started", {
          pollIntervalMs: Duration.toMillis(DEFAULT_POLL_INTERVAL),
          batchLimit: DEFAULT_BATCH_LIMIT,
        });
      });

    return RunRecoveryCoordinator.of({ tick, start });
  },
);

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const commandCenter = yield* CommandCenterService.CommandCenterService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const runDispatcher = yield* RunDispatcher.RunDispatcher;
  const commandDispatcher = yield* OrchestrationCommandDispatcher.OrchestrationCommandDispatcher;

  const listCandidates: RunRecoveryDependencies["listCandidates"] = (limit) =>
    sql<{ readonly runId: string; readonly state: RecoverableRunCandidate["state"] }>`
      SELECT run.id AS "runId", run.state
      FROM command_center_runs run
      WHERE run.kind = 'agent'
        AND run.thread_id IS NULL
        AND run.execution_authorized_at IS NOT NULL
        AND (
          run.state = 'queued'
          OR (
            run.state = 'waiting_approval'
            AND EXISTS (
              SELECT 1
              FROM command_center_approvals approval
              WHERE approval.run_id = run.id
                AND approval.status = 'approved'
                AND approval.id = (
                  SELECT latest.id
                  FROM command_center_approvals latest
                  WHERE latest.run_id = run.id
                  ORDER BY latest.requested_at DESC, latest.id DESC
                  LIMIT 1
                )
            )
          )
        )
      ORDER BY run.started_at ASC, run.id ASC
      LIMIT ${limit}
    `.pipe(
      Effect.map((rows) => rows.map((row) => ({ runId: row.runId as RunId, state: row.state }))),
    );

  return yield* makeWithDependencies({
    syncConfiguration: commandCenter.querySpaces({}).pipe(Effect.asVoid),
    listCandidates,
    providerAvailability: providerRegistry.getProviders.pipe(
      Effect.map(commandCenterProviderAvailability),
    ),
    inspectRecovery: runDispatcher.inspectRecovery,
    reconcileApproved: runDispatcher.reconcileApproved,
    dispatch: (runId) =>
      runDispatcher.dispatch({
        runId,
        dispatchCommand: commandDispatcher.dispatch,
      }),
  });
});

export const layer = Layer.effect(RunRecoveryCoordinator, make);
