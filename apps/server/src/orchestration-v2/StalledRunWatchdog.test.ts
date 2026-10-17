import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadShellSnapshot,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";

import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as StalledRunWatchdog from "./StalledRunWatchdog.ts";

const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const minutesAgo = (minutes: number) => DateTime.makeUnsafe(NOW - minutes * 60_000);

const shell = (
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell =>
  ({
    id: ThreadId.make(id),
    activeRunId: RunId.make(`run:${id}`),
    status: "running",
    pendingRuntimeRequest: null,
    archivedAt: null,
    updatedAt: minutesAgo(11),
    ...overrides,
  }) as unknown as OrchestrationV2ThreadShell;

it("finds only running, unblocked runs silent for the threshold", () => {
  const stalled = StalledRunWatchdog.stalledRuns(
    [
      shell("wedged"),
      shell("recent", { updatedAt: minutesAgo(9) }),
      shell("idle", { status: "idle", activeRunId: null }),
      shell("waiting", { status: "waiting" }),
      shell("approval", {
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request:acme"),
          kind: "command",
          createdAt: minutesAgo(30),
        } as OrchestrationV2ThreadShell["pendingRuntimeRequest"],
      }),
      shell("archived", { archivedAt: minutesAgo(1) }),
    ],
    NOW,
    10 * 60_000,
  );
  assert.deepEqual(
    stalled.map((run) => String(run.threadId)),
    ["wedged"],
  );
  assert.equal(stalled[0]?.silentMs, 11 * 60_000);
});

it.effect("interrupts each stalled run once per silence with a visible reason", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    const snapshot = {
      schemaVersion: 1,
      snapshotSequence: 1,
      threads: [shell("wedged"), shell("recent", { updatedAt: minutesAgo(2) })],
      archivedThreads: [],
    } as unknown as OrchestrationV2ThreadShellSnapshot;
    const layer = Layer.effect(
      StalledRunWatchdog.StalledRunWatchdog,
      StalledRunWatchdog.make(),
    ).pipe(
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
            }) as never,
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getShellSnapshot: () => Effect.succeed(snapshot),
        }),
      ),
    );
    const stopped = yield* Effect.gen(function* () {
      const watchdog = yield* StalledRunWatchdog.StalledRunWatchdog;
      const first = yield* watchdog.sweep;
      yield* watchdog.sweep;
      return first;
    }).pipe(Effect.provide(layer));

    assert.deepEqual(
      stopped.map((run) => String(run.runId)),
      ["run:wedged"],
    );
    assert.equal(dispatched.length, 2);
    const [first, second] = dispatched as Array<
      Extract<OrchestrationV2ServerCommand, { readonly type: "run.interrupt" }>
    >;
    assert.equal(first?.type, "run.interrupt");
    assert.equal(String(first?.runId), "run:wedged");
    assert.match(first?.reason ?? "", /No provider activity for 10 minutes/);
    // The same silence maps to the same command id, so the orchestrator replays its receipt.
    assert.equal(first?.commandId, second?.commandId);
  }),
);
