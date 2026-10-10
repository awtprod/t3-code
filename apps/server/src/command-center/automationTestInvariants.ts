import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeCommandCenterAuditLog } from "./AuditLog.ts";
import { canonicalAutomationRunState } from "./Service.ts";

/**
 * Test-only invariants checked when an automation scenario's layer closes: the
 * audit chain verifies and every canonical Run projection agrees with its
 * durable runtime execution (no projection left behind or moved backwards).
 */
const automationInvariants = Effect.gen(function* () {
  const audit = yield* makeCommandCenterAuditLog;
  const verification = yield* audit.verify;
  if (!verification.valid) {
    return yield* Effect.die(
      new Error(
        `Audit chain invalid at sequence ${String(verification.invalidSequence)} (${String(verification.reason)})`,
      ),
    );
  }
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly id: string;
    readonly runtimeState: Parameters<typeof canonicalAutomationRunState>[0];
    readonly projectedState: string | null;
  }>`
    SELECT execution.id, execution.state AS "runtimeState", run.state AS "projectedState"
    FROM command_center_automation_executions execution
    LEFT JOIN command_center_runs run ON run.id = execution.id
  `;
  for (const row of rows) {
    const expected = canonicalAutomationRunState(row.runtimeState);
    if (row.projectedState !== expected) {
      return yield* Effect.die(
        new Error(
          `Run ${row.id} projects ${String(row.projectedState)} but its runtime is ${row.runtimeState}`,
        ),
      );
    }
  }
});

/** Adds the invariants as a finalizer of the scenario's layer. */
export const withAutomationInvariants = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  Layer.effectDiscard(Effect.addFinalizer(() => automationInvariants.pipe(Effect.orDie))).pipe(
    Layer.provideMerge(layer),
  );
