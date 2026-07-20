import {
  CAPABILITY_NAMES,
  ModelId,
  ProviderId,
  RunId,
  SpaceId,
  type ProviderAvailability,
} from "@command-center/core";
import { expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  makeWithDependencies,
  type RecoverableRunCandidate,
  type RunRecoveryDependencies,
} from "./RunRecoveryCoordinator.ts";
import {
  RunDispatcherError,
  type RunDispatchResult,
  type RunRecoveryAuthorization,
} from "./RunDispatcher.ts";

const runId = RunId.make("recovery-run");
const spaceId = SpaceId.make("recovery-space");

const authorization: RunRecoveryAuthorization = {
  runId,
  spaceId,
  providerId: "provider-example",
  modelId: "model-example",
  capabilities: ["cc.items.read", "cc.runs.start"],
};

const healthyProvider: ProviderAvailability = {
  providerId: ProviderId.make("provider-example"),
  healthy: true,
  priority: 0,
  modelIds: [ModelId.make("model-example")],
  defaultModelId: ModelId.make("model-example"),
  capabilities: CAPABILITY_NAMES,
};

const recoveryError = (candidateId: RunId, reason: RunDispatcherError["reason"], message: string) =>
  new RunDispatcherError({ runId: candidateId, reason, message });

function fixture(input?: {
  readonly initialState?: "queued" | "waiting_approval" | "running";
  readonly approved?: boolean;
  readonly authorized?: boolean;
  readonly inspectError?: RunDispatcherError;
  readonly syncError?: Error;
  readonly providers?: ReadonlyArray<ProviderAvailability>;
}) {
  let state = input?.initialState ?? "queued";
  let authorized = input?.authorized ?? true;
  let providers = input?.providers ?? [healthyProvider];
  let dispatchCount = 0;
  let reconcileCount = 0;

  const listCandidates = (): ReadonlyArray<RecoverableRunCandidate> => {
    if (!authorized) return [];
    if (state === "queued") return [{ runId, state }];
    if (state === "waiting_approval" && input?.approved === true) {
      return [{ runId, state }];
    }
    return [];
  };

  const dispatchResult = (duplicate: boolean): RunDispatchResult => ({
    runId,
    projectId: ProjectId.make("recovery-project"),
    threadId: ThreadId.make("recovery-thread"),
    state: "running",
    sequence: duplicate ? 0 : 42,
    duplicate,
  });

  const dependencies: RunRecoveryDependencies = {
    syncConfiguration: input?.syncError === undefined ? Effect.void : Effect.fail(input.syncError),
    listCandidates: () => Effect.succeed(listCandidates()),
    providerAvailability: Effect.sync(() => providers),
    inspectRecovery: () =>
      input?.inspectError === undefined
        ? Effect.succeed(authorization)
        : Effect.fail(input.inspectError),
    reconcileApproved: () => {
      reconcileCount += 1;
      if (state !== "waiting_approval" || input?.approved !== true) {
        return Effect.fail(recoveryError(runId, "not-ready", "Approval is not ready."));
      }
      state = "queued";
      return Effect.succeed(authorization);
    },
    dispatch: () => {
      if (state === "running") return Effect.succeed(dispatchResult(true));
      if (state !== "queued") {
        return Effect.fail(recoveryError(runId, "not-ready", "Run is not queued."));
      }
      state = "running";
      dispatchCount += 1;
      return Effect.succeed(dispatchResult(false));
    },
  };

  return {
    makeCoordinator: () => makeWithDependencies(dependencies),
    setProviders: (next: ReadonlyArray<ProviderAvailability>) => {
      providers = next;
    },
    authorize: () => {
      authorized = true;
    },
    read: () => ({ state, authorized, dispatchCount, reconcileCount }),
  };
}

it.effect("recovers a queued crash-window Run once across coordinator restarts", () =>
  Effect.gen(function* () {
    const test = fixture();
    const firstCoordinator = yield* test.makeCoordinator();
    expect(yield* firstCoordinator.tick()).toMatchObject({
      scanned: 1,
      recovered: 1,
      duplicates: 0,
    });

    const restartedCoordinator = yield* test.makeCoordinator();
    expect(yield* restartedCoordinator.tick()).toMatchObject({ scanned: 0, recovered: 0 });
    expect(test.read()).toMatchObject({ state: "running", dispatchCount: 1 });
  }),
);

it.effect("never recovers a pre-ack admission but recovers after durable authorization", () =>
  Effect.gen(function* () {
    const test = fixture({ authorized: false });
    const beforeAck = yield* test.makeCoordinator();
    expect(yield* beforeAck.tick()).toMatchObject({ scanned: 0, recovered: 0 });

    const restartedBeforeAck = yield* test.makeCoordinator();
    expect(yield* restartedBeforeAck.tick()).toMatchObject({ scanned: 0, recovered: 0 });
    expect(test.read()).toMatchObject({ state: "queued", dispatchCount: 0 });

    test.authorize();
    const restartedAfterAck = yield* test.makeCoordinator();
    expect(yield* restartedAfterAck.tick()).toMatchObject({ scanned: 1, recovered: 1 });
    expect(test.read()).toMatchObject({ state: "running", dispatchCount: 1 });
  }),
);

it.effect("reconciles an approved reversible waiting Run before dispatch", () =>
  Effect.gen(function* () {
    const test = fixture({ initialState: "waiting_approval", approved: true });
    const coordinator = yield* test.makeCoordinator();

    expect(yield* coordinator.tick()).toMatchObject({
      scanned: 1,
      reconciled: 1,
      recovered: 1,
    });
    expect(test.read()).toMatchObject({
      state: "running",
      reconcileCount: 1,
      dispatchCount: 1,
    });
  }),
);

it.effect("keeps unapproved waiting Runs inert", () =>
  Effect.gen(function* () {
    const test = fixture({ initialState: "waiting_approval", approved: false });
    const coordinator = yield* test.makeCoordinator();

    expect(yield* coordinator.tick()).toMatchObject({ scanned: 0, recovered: 0 });
    expect(test.read()).toMatchObject({
      state: "waiting_approval",
      reconcileCount: 0,
      dispatchCount: 0,
    });
  }),
);

it.effect("does not dispatch blocked, protected, tampered, or stale-config candidates", () =>
  Effect.gen(function* () {
    for (const [reason, message] of [
      ["not-ready", "blocked route"],
      ["invalid-route", "protected route"],
      ["invalid-route", "tampered approval"],
      ["scope-denied", "stale Space policy"],
    ] as const) {
      const test = fixture({ inspectError: recoveryError(runId, reason, message) });
      const coordinator = yield* test.makeCoordinator();
      expect(yield* coordinator.tick()).toMatchObject({
        scanned: 1,
        recovered: 0,
        deferred: 1,
      });
      expect(test.read()).toMatchObject({ state: "queued", dispatchCount: 0 });
    }
  }),
);

it.effect("leaves a Run queued while its provider is unavailable and retries later", () =>
  Effect.gen(function* () {
    const test = fixture({ providers: [{ ...healthyProvider, healthy: false }] });
    const coordinator = yield* test.makeCoordinator();
    expect(yield* coordinator.tick()).toMatchObject({
      scanned: 1,
      recovered: 0,
      deferred: 1,
    });
    expect(test.read()).toMatchObject({ state: "queued", dispatchCount: 0 });

    test.setProviders([healthyProvider]);
    const restartedCoordinator = yield* test.makeCoordinator();
    expect(yield* restartedCoordinator.tick()).toMatchObject({ recovered: 1 });
    expect(test.read()).toMatchObject({ state: "running", dispatchCount: 1 });
  }),
);

it.effect("does not inspect or dispatch while private configuration is unavailable", () =>
  Effect.gen(function* () {
    const test = fixture({ syncError: new Error("config checkout unavailable") });
    const coordinator = yield* test.makeCoordinator();

    expect(yield* coordinator.tick()).toMatchObject({
      scanned: 1,
      recovered: 0,
      failures: [expect.objectContaining({ stage: "configuration" })],
    });
    expect(test.read()).toMatchObject({ state: "queued", dispatchCount: 0 });
  }),
);
