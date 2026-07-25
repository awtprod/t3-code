import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
  type OrchestrationLatestTurn,
  type OrchestrationSession,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ProviderValidationError } from "../../provider/Errors.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { StalledTurnWatchdog } from "../Services/StalledTurnWatchdog.ts";
import { makeStalledTurnWatchdogLive } from "./StalledTurnWatchdog.ts";

type DispatchedCommand = Parameters<OrchestrationEngineShape["dispatch"]>[0];

const defaultModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

const projectId = ProjectId.make("project-stalled-turn-watchdog");
const staticNow = "2026-01-01T00:00:00.000Z";

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };
  return poll();
}

const drainFibers = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, {
  discard: true,
});

const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;

function makeRunningSession(threadId: ThreadId, activeTurnId: TurnId | null): OrchestrationSession {
  return {
    threadId,
    status: "running",
    providerName: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: "full-access",
    activeTurnId,
    lastError: null,
    updatedAt: staticNow,
  };
}

function makeRunningTurn(turnId: TurnId): OrchestrationLatestTurn {
  return {
    turnId,
    state: "running",
    requestedAt: staticNow,
    startedAt: staticNow,
    completedAt: null,
    assistantMessageId: null,
  };
}

function makeShell(
  overrides: Partial<OrchestrationThreadShell> & { readonly id: ThreadId },
): OrchestrationThreadShell {
  return {
    projectId,
    title: `Thread ${overrides.id}`,
    modelSelection: defaultModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: staticNow,
    updatedAt: staticNow,
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function makeShellSnapshot(
  threads: ReadonlyArray<OrchestrationThreadShell>,
): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 0,
    updatedAt: staticNow,
    projects: [],
    threads,
  };
}

describe("StalledTurnWatchdog", () => {
  let runtime: ManagedRuntime.ManagedRuntime<StalledTurnWatchdog, unknown> | null = null;
  let scope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  function createHarness(input: {
    readonly snapshot: OrchestrationShellSnapshot;
    readonly stallThresholdMs?: number;
    readonly interruptTurnImplementation?: ProviderServiceShape["interruptTurn"];
    // When true, build the layer with no options at all so the assertions
    // exercise the production defaults rather than injected test values.
    readonly useProductionDefaults?: boolean;
  }) {
    const dispatched: DispatchedCommand[] = [];
    const dispatch = vi.fn<OrchestrationEngineShape["dispatch"]>((command) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: dispatched.length };
      }),
    );

    const interruptTurn = vi.fn<ProviderServiceShape["interruptTurn"]>(
      (request) =>
        (input.interruptTurnImplementation
          ? input.interruptTurnImplementation(request)
          : Effect.void) as ReturnType<ProviderServiceShape["interruptTurn"]>,
    );

    const providerService: ProviderServiceShape = {
      startSession: () => unsupported(),
      sendTurn: () => unsupported(),
      interruptTurn,
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      stopSession: () => unsupported(),
      listSessions: () => Effect.succeed([]),
      getCapabilities: () => unsupported(),
      getInstanceInfo: () => unsupported(),
      rollbackConversation: () => unsupported(),
      streamEvents: Stream.empty,
    };

    const layer = makeStalledTurnWatchdogLive(
      input.useProductionDefaults === true
        ? undefined
        : {
            // Large sweep interval so exactly one sweep runs during the test window.
            stallThresholdMs: input.stallThresholdMs ?? 1_000,
            sweepIntervalMs: 60_000,
          },
    ).pipe(
      Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
      Layer.provideMerge(
        Layer.succeed(OrchestrationEngineService, {
          readEvents: () => Stream.empty,
          dispatch,
          streamDomainEvents: Stream.empty,
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.die("unused"),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.succeed(input.snapshot),
          getArchivedShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () => Effect.die("unused"),
          getCounts: () => Effect.die("unused"),
          getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
          getProjectShellById: () => Effect.die("unused"),
          getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
          getThreadCheckpointContext: () => Effect.die("unused"),
          getFullThreadDiffContext: () => Effect.die("unused"),
          getThreadShellById: () => Effect.die("unused"),
          getThreadDetailById: () => Effect.die("unused"),
          getThreadDetailSnapshot: () => Effect.die("unused"),
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    return { dispatched, dispatch, interruptTurn };
  }

  async function startWatchdog() {
    const watchdog = await runtime!.runPromise(Effect.service(StalledTurnWatchdog));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(watchdog.start().pipe(Scope.provide(scope)));
  }

  it("auto-fails a running turn whose updatedAt is stale", async () => {
    const threadId = ThreadId.make("thread-watchdog-stale");
    const turnId = TurnId.make("turn-watchdog-stale");
    const harness = createHarness({
      snapshot: makeShellSnapshot([
        makeShell({
          id: threadId,
          session: makeRunningSession(threadId, turnId),
          latestTurn: makeRunningTurn(turnId),
          // Far in the past → definitely past the 1s threshold.
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      ]),
    });

    await startWatchdog();
    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);

    const activity = harness.dispatched.find((c) => c.type === "thread.activity.append");
    expect(activity).toBeDefined();
    if (activity?.type === "thread.activity.append") {
      expect(activity.activity.kind).toBe("provider.turn.stalled");
      expect(activity.activity.tone).toBe("error");
      expect(activity.activity.turnId).toBe(turnId);
    }

    const sessionSet = harness.dispatched.find((c) => c.type === "thread.session.set");
    expect(sessionSet).toBeDefined();
    if (sessionSet?.type === "thread.session.set") {
      expect(sessionSet.session.status).toBe("error");
      expect(sessionSet.session.activeTurnId).toBe(null);
      expect(sessionSet.session.lastError).toContain("Stalled");
    }

    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({ threadId, turnId });
  });

  it("does not touch a running turn whose updatedAt is fresh", async () => {
    const threadId = ThreadId.make("thread-watchdog-fresh");
    const turnId = TurnId.make("turn-watchdog-fresh");
    const freshNow = DateTime.formatIso(DateTime.nowUnsafe());
    const harness = createHarness({
      // 20-minute threshold; the turn was just active → healthy long turn.
      stallThresholdMs: 20 * 60 * 1000,
      snapshot: makeShellSnapshot([
        makeShell({
          id: threadId,
          session: makeRunningSession(threadId, turnId),
          latestTurn: makeRunningTurn(turnId),
          updatedAt: freshNow,
        }),
      ]),
    });

    await startWatchdog();
    await Effect.runPromise(drainFibers);

    expect(harness.interruptTurn).not.toHaveBeenCalled();
    expect(harness.dispatched).toHaveLength(0);
  });

  it("still settles the turn when interruptTurn fails", async () => {
    const threadId = ThreadId.make("thread-watchdog-interrupt-fail");
    const turnId = TurnId.make("turn-watchdog-interrupt-fail");
    const harness = createHarness({
      snapshot: makeShellSnapshot([
        makeShell({
          id: threadId,
          session: makeRunningSession(threadId, turnId),
          latestTurn: makeRunningTurn(turnId),
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      ]),
      interruptTurnImplementation: () =>
        Effect.fail(
          new ProviderValidationError({
            operation: "StalledTurnWatchdog.test",
            issue: "simulated interrupt failure",
          }),
        ),
    });

    await startWatchdog();
    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    await Effect.runPromise(drainFibers);

    // The turn is still settled even though interrupt failed.
    const sessionSet = harness.dispatched.find((c) => c.type === "thread.session.set");
    expect(sessionSet).toBeDefined();
    if (sessionSet?.type === "thread.session.set") {
      expect(sessionSet.session.status).toBe("error");
      expect(sessionSet.session.activeTurnId).toBe(null);
    }
  });

  it("does not touch a thread with no active turn", async () => {
    const threadId = ThreadId.make("thread-watchdog-no-turn");
    const harness = createHarness({
      snapshot: makeShellSnapshot([
        makeShell({
          id: threadId,
          session: {
            ...makeRunningSession(threadId, null),
            status: "ready",
          },
          latestTurn: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      ]),
    });

    await startWatchdog();
    await Effect.runPromise(drainFibers);

    expect(harness.interruptTurn).not.toHaveBeenCalled();
    expect(harness.dispatched).toHaveLength(0);
  });

  // The suite above always injects a threshold, so it cannot catch a regression
  // in the production defaults. These two pin them from both sides. The 10m value
  // is derived from measured provider logs (see the comment on
  // DEFAULT_STALL_THRESHOLD_MS): the worst legitimate intra-turn silence observed
  // across 60 healthy turns was 7.2m, so 9m must survive and 11m must not.
  it("leaves a turn alone at 9m of silence under production defaults", async () => {
    const threadId = ThreadId.make("thread-watchdog-defaults-under");
    const turnId = TurnId.make("turn-watchdog-defaults-under");
    const silentFor9m = DateTime.formatIso(DateTime.subtract(DateTime.nowUnsafe(), { minutes: 9 }));
    const harness = createHarness({
      useProductionDefaults: true,
      snapshot: makeShellSnapshot([
        makeShell({
          id: threadId,
          session: makeRunningSession(threadId, turnId),
          latestTurn: makeRunningTurn(turnId),
          updatedAt: silentFor9m,
        }),
      ]),
    });

    await startWatchdog();
    await Effect.runPromise(drainFibers);

    expect(harness.interruptTurn).not.toHaveBeenCalled();
    expect(harness.dispatched).toHaveLength(0);
  });

  it("auto-fails a turn at 11m of silence under production defaults", async () => {
    const threadId = ThreadId.make("thread-watchdog-defaults-over");
    const turnId = TurnId.make("turn-watchdog-defaults-over");
    const silentFor11m = DateTime.formatIso(
      DateTime.subtract(DateTime.nowUnsafe(), { minutes: 11 }),
    );
    const harness = createHarness({
      useProductionDefaults: true,
      snapshot: makeShellSnapshot([
        makeShell({
          id: threadId,
          session: makeRunningSession(threadId, turnId),
          latestTurn: makeRunningTurn(turnId),
          updatedAt: silentFor11m,
        }),
      ]),
    });

    await startWatchdog();
    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);

    const activity = harness.dispatched.find((c) => c.type === "thread.activity.append");
    expect(activity).toBeDefined();
    if (activity?.type === "thread.activity.append") {
      // Message is rendered from the threshold, so it also pins the 10m value.
      expect(activity.activity.summary).toContain("10m");
    }
  });

  it("does not auto-fail a turn parked on a pending approval", async () => {
    const threadId = ThreadId.make("thread-watchdog-pending-approval");
    const turnId = TurnId.make("turn-watchdog-pending-approval");
    const harness = createHarness({
      snapshot: makeShellSnapshot([
        makeShell({
          id: threadId,
          session: makeRunningSession(threadId, turnId),
          latestTurn: makeRunningTurn(turnId),
          updatedAt: "2026-01-01T00:00:00.000Z",
          hasPendingApprovals: true,
        }),
      ]),
    });

    await startWatchdog();
    await Effect.runPromise(drainFibers);

    expect(harness.interruptTurn).not.toHaveBeenCalled();
    expect(harness.dispatched).toHaveLength(0);
  });

  it("does not auto-fail a turn parked on pending user input", async () => {
    const threadId = ThreadId.make("thread-watchdog-pending-input");
    const turnId = TurnId.make("turn-watchdog-pending-input");
    const harness = createHarness({
      snapshot: makeShellSnapshot([
        makeShell({
          id: threadId,
          session: makeRunningSession(threadId, turnId),
          latestTurn: makeRunningTurn(turnId),
          updatedAt: "2026-01-01T00:00:00.000Z",
          hasPendingUserInput: true,
        }),
      ]),
    });

    await startWatchdog();
    await Effect.runPromise(drainFibers);

    expect(harness.interruptTurn).not.toHaveBeenCalled();
    expect(harness.dispatched).toHaveLength(0);
  });
});
