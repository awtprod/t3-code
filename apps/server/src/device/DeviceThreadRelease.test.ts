import { describe, expect, it } from "@effect/vitest";
import {
  DeviceId,
  ThreadId,
  type DeviceSession,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as DeviceService from "./DeviceService.ts";
import * as DeviceThreadRelease from "./DeviceThreadRelease.ts";

const threadId = ThreadId.make("thread-with-device");
const session: DeviceSession = {
  threadId,
  hostId: "local",
  deviceId: DeviceId.make("emulator-5554"),
  platform: "android",
  openedAt: "2026-11-01T00:00:00.000Z",
};

const setup = Effect.fn("setup")(function* (
  runs: ReadonlyArray<OrchestrationV2RunStatus>,
  sessions: ReadonlyArray<DeviceSession> = [session],
) {
  const closed: Array<ThreadId> = [];
  const reads: Array<ThreadId> = [];
  const closedOnce = yield* Deferred.make<void>();
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const layer = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.fromQueue(events) }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadRecords: <K extends ProjectionStore.ProjectionRecordField>(id: ThreadId) =>
        Effect.sync(() => {
          reads.push(id);
          return {
            thread: { settledAt: "2026-11-01T01:00:00.000Z" },
            runs: runs.map((status) => ({ status })),
          } as unknown as ProjectionStore.ProjectionRecords<K>;
        }),
    }),
    Layer.mock(DeviceService.DeviceService)({
      sessionsForThread: () => Effect.succeed(sessions),
      close: (input) =>
        Effect.gen(function* () {
          closed.push(input.threadId);
          yield* Deferred.succeed(closedOnce, undefined);
          return { unreleased: [] };
        }),
    }),
  );
  const service = yield* DeviceThreadRelease.make.pipe(Effect.provide(layer));
  return { service, closed, reads, closedOnce, events };
});

describe("DeviceThreadRelease", () => {
  it.effect("closes a settled thread's devices once it has no turn running or queued", () =>
    Effect.gen(function* () {
      const { service, closed } = yield* setup(["completed", "interrupted"]);
      yield* service.release(threadId, "thread.settled");
      expect(closed).toEqual([threadId]);
    }),
  );

  it.effect.each(["running", "queued", "starting", "waiting"] as const)(
    "keeps the devices of a settled thread with a %s turn",
    (status) =>
      Effect.gen(function* () {
        const { service, closed, reads } = yield* setup(["completed", status]);
        yield* service.release(threadId, "thread.settled");
        expect(reads).toEqual([threadId]);
        expect(closed).toEqual([]);
      }),
  );

  it.effect.each(["thread.archived", "thread.deleted"] as const)(
    "closes the devices of a %s thread whatever its runs show",
    (trigger) =>
      Effect.gen(function* () {
        const { service, closed } = yield* setup(["running"]);
        yield* service.release(threadId, trigger);
        expect(closed).toEqual([threadId]);
      }),
  );

  it.effect("reads nothing for a thread with no device open", () =>
    Effect.gen(function* () {
      const { service, closed, reads } = yield* setup([], []);
      yield* service.release(threadId, "thread.settled");
      expect(reads).toEqual([]);
      expect(closed).toEqual([]);
    }),
  );

  it.effect("follows thread.settled events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { service, closed, closedOnce, events } = yield* setup(["completed"]);
        yield* service.start();
        yield* Queue.offer(events, {
          type: "thread.settled",
          threadId,
        } as OrchestrationV2DomainEvent);
        yield* Deferred.await(closedOnce);
        expect(closed).toEqual([threadId]);
      }),
    ),
  );
});
