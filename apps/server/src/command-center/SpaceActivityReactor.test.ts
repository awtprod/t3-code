import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { RunId as CommandCenterRunId, SpaceId } from "@command-center/core";
import {
  type CommandCenterEventEnvelope,
  EventId,
  type OrchestrationProjectShell,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { CommandCenterEventStream } from "./EventStream.ts";
import { OrchestrationBridge } from "./OrchestrationBridge.ts";
import { layer as spaceActivityLayer, SpaceActivity } from "./SpaceActivity.ts";
import {
  CATCH_UP_EVENT_LIMIT,
  catchUpStartSequence,
  layer as reactorLayer,
  SpaceActivityReactor,
  terminalThreadOutcome,
} from "./SpaceActivityReactor.ts";

const NOW = "2026-10-09T12:00:00.000Z";
const LATER = "2026-10-09T12:01:00.000Z";
const MUCH_LATER = "2026-10-09T13:00:00.000Z";

const EXAMPLE_PROJECT = ProjectId.make("p-example");
const HOME_PROJECT = ProjectId.make("p-home");

const projects: Record<string, OrchestrationProjectShell> = {
  [EXAMPLE_PROJECT]: {
    id: EXAMPLE_PROJECT,
    title: "example",
    workspaceRoot: "/work/example",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  },
  [HOME_PROJECT]: {
    id: HOME_PROJECT,
    title: "home",
    workspaceRoot: "/home/someone",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  },
} as unknown as Record<string, OrchestrationProjectShell>;

// A fork: the project's primary remote is upstream, the Space binding is the fork.
const remoteKeysByRoot: Record<string, ReadonlyArray<string>> = {
  "/work/example": ["github.com/acme/upstream-example", "github.com/acme/example"],
};

const threadShell = (id: string, projectId: ProjectId, title: string) =>
  ({ id: ThreadId.make(id), projectId, title }) as unknown as OrchestrationV2ThreadShell;

const threads: Record<string, OrchestrationV2ThreadShell> = Object.fromEntries(
  [
    threadShell("t-feed", EXAMPLE_PROJECT, "Build the activity feed"),
    threadShell("t-home", HOME_PROJECT, "Personal errand"),
    threadShell("t-run", EXAMPLE_PROJECT, "Run thread"),
    threadShell("cc-space-agent-command-center", EXAMPLE_PROJECT, "Command Center agent"),
  ].map((thread) => [thread.id, thread]),
);

let sequence = 100;
const stored = (event: unknown, at = ++sequence): OrchestrationV2StoredEvent =>
  ({
    sequence: at,
    commandId: null,
    event: event as OrchestrationV2DomainEvent,
  }) as OrchestrationV2StoredEvent;

const runUpdated = (
  threadId: string,
  runId: string,
  status: string,
  completedAt: string | null,
  options: { readonly sequence?: number; readonly occurredAt?: string } = {},
) =>
  stored(
    {
      id: EventId.make(`event-${runId}-${status}-${completedAt ?? "none"}-${sequence}`),
      type: "run.updated",
      threadId: ThreadId.make(threadId),
      runId: RunId.make(runId),
      occurredAt: DateTime.makeUnsafe(options.occurredAt ?? completedAt ?? NOW),
      payload: {
        id: RunId.make(runId),
        threadId: ThreadId.make(threadId),
        status,
        completedAt: completedAt === null ? null : DateTime.makeUnsafe(completedAt),
      },
    },
    options.sequence,
  );

const threadSettled = (threadId: string, occurredAt: string, at?: number) =>
  stored(
    {
      id: EventId.make(`event-settled-${threadId}-${occurredAt}-${sequence}`),
      type: "thread.settled",
      threadId: ThreadId.make(threadId),
      occurredAt: DateTime.makeUnsafe(occurredAt),
      payload: { threadId: ThreadId.make(threadId) },
    },
    at,
  );

let auditSequence = 1_000;
const runFinished = (
  runId: string,
  status: "succeeded" | "failed" | "running",
): CommandCenterEventEnvelope => {
  auditSequence += 1;
  return {
    _tag: "RunStateChanged",
    sequence: auditSequence,
    eventId: `audit-${auditSequence}`,
    previousHash: null,
    eventHash: `hash-${auditSequence}`,
    actorKind: "system",
    spaceId: SpaceId.make("command-center"),
    runId: CommandCenterRunId.make(runId),
    occurredAt: LATER,
    payload: { status },
  } as unknown as CommandCenterEventEnvelope;
};

type StreamCall = { readonly afterSequence: number; readonly eventType: string | undefined };

const makeHarness = (
  options: {
    readonly catchUp?: ReadonlyArray<OrchestrationV2StoredEvent>;
    readonly head?: number;
  } = {},
) =>
  Effect.gen(function* () {
    const catchUp = options.catchUp ?? [];
    // One live queue per event type: both followers read the same bridge, and a
    // shared queue would hand an event to the follower that filters it out.
    const liveByType = {
      "run.updated": yield* Queue.unbounded<OrchestrationV2StoredEvent>(),
      "thread.settled": yield* Queue.unbounded<OrchestrationV2StoredEvent>(),
    };
    const runEvents = yield* Queue.unbounded<CommandCenterEventEnvelope>();
    const streamCalls: Array<StreamCall> = [];
    const services = spaceActivityLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
    const layer = reactorLayer.pipe(
      Layer.provide(
        Layer.mock(OrchestrationBridge)({
          getThreadShellById: (threadId) => Effect.succeed(Option.fromNullishOr(threads[threadId])),
          getProjectShellById: (projectId) =>
            Effect.succeed(Option.fromNullishOr(projects[projectId])),
          latestEventSequence: Effect.succeed(options.head ?? 0),
          streamStoredEventsFrom: ({ afterSequence, eventType }) => {
            streamCalls.push({ afterSequence, eventType });
            const matches = (item: OrchestrationV2StoredEvent) =>
              eventType === undefined || item.event.type === eventType;
            const live =
              eventType === "run.updated" || eventType === "thread.settled"
                ? liveByType[eventType]
                : liveByType["run.updated"];
            return Stream.concat(
              Stream.fromIterable(
                catchUp.filter((item) => item.sequence > afterSequence && matches(item)),
              ),
              Stream.fromQueue(live).pipe(Stream.filter(matches)),
            );
          },
        }),
      ),
      Layer.provide(
        Layer.mock(CommandCenterEventStream)({ changes: () => Stream.fromQueue(runEvents) }),
      ),
      Layer.provide(
        Layer.mock(RepositoryIdentityResolver)({
          resolveRemoteKeys: (cwd) => Effect.succeed(remoteKeysByRoot[cwd] ?? []),
        }),
      ),
      Layer.provideMerge(services),
      Layer.provideMerge(NodeServices.layer),
    );
    return { liveByType, runEvents, streamCalls, layer };
  });

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repositories =
    '[{"id":"example","displayName":"Example","aliases":[],"remoteRef":"https://github.com/acme/example.git"}]';
  yield* sql`
    INSERT INTO command_center_spaces (id, slug, name, kind, repositories_json, created_at, updated_at)
    VALUES
      ('command-center', 'command-center', 'Command Center', 'system', ${repositories}, ${NOW}, ${NOW}),
      ('personal', 'personal', 'Personal', 'personal', '[]', ${NOW}, ${NOW})
  `;
  yield* sql`
    INSERT INTO command_center_runs (id, command_id, space_id, project_id, thread_id, kind, state,
      route_json, input_json, started_at)
    VALUES ('run-1', 'cmd-run-1', 'command-center', 'p-example', 't-run', 'agent', 'succeeded',
      '{}', '{"text":"Ship the feed"}', ${NOW})
  `;
  // Assistant text lives in the V2 message projection, keyed by the V2 run.
  const messages = [
    ["m-feed", "t-feed", "v2-run-feed", "Done. Opened https://github.com/acme/example/pull/321"],
    ["m-run", "t-run", "v2-run-run", "Run finished cleanly."],
    ["m-agent", "cc-space-agent-command-center", "v2-run-agent", "Woke up, nothing to do."],
  ] as const;
  for (const [id, threadId, runId, text] of messages) {
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, node_id,
        role, streaming, created_at, updated_at, payload_json)
      VALUES (${id}, ${threadId}, ${runId}, NULL, 'assistant', 0, ${NOW}, ${NOW},
        ${JSON.stringify({ text })})
    `;
  }
});

/** Offers events, lets the stream fibers forward them, then drains the worker. */
const deliver = (
  harness: Harness,
  input: {
    readonly events?: ReadonlyArray<OrchestrationV2StoredEvent>;
    readonly runs?: ReadonlyArray<CommandCenterEventEnvelope>;
  },
) =>
  Effect.gen(function* () {
    const reactor = yield* SpaceActivityReactor;
    for (const item of input.events ?? []) {
      const type = item.event.type;
      if (type === "run.updated" || type === "thread.settled") {
        yield* Queue.offer(harness.liveByType[type], item);
      }
    }
    yield* Queue.offerAll(harness.runEvents, input.runs ?? []);
    for (let step = 0; step < 10; step += 1) yield* Effect.yieldNow;
    // Wait for the followers to take everything, then for the worker to finish.
    for (let step = 0; step < 200; step += 1) {
      const pending =
        (yield* Queue.size(harness.liveByType["run.updated"])) +
        (yield* Queue.size(harness.liveByType["thread.settled"])) +
        (yield* Queue.size(harness.runEvents));
      if (pending === 0) break;
      yield* Effect.yieldNow;
    }
    for (let step = 0; step < 10; step += 1) yield* Effect.yieldNow;
    yield* reactor.drain;
  });

const rows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly spaceId: string;
    readonly sourceKind: string;
    readonly sourceId: string;
    readonly status: string;
    readonly title: string;
    readonly summary: string;
    readonly url: string | null;
  }>`
    SELECT space_id AS "spaceId", source_kind AS "sourceKind", source_id AS "sourceId",
      status, title, summary, url
    FROM command_center_space_activity
    ORDER BY id
  `;
});

const withReactor = <A, E, R>(harness: Harness, body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* seed;
    const reactor = yield* SpaceActivityReactor;
    yield* reactor.start();
    return yield* body;
  }).pipe(Effect.scoped, Effect.provide(harness.layer));

describe("terminalThreadOutcome", () => {
  it("maps terminal run statuses and uses the run's completion time", () => {
    expect(
      terminalThreadOutcome(runUpdated("t", "r", "completed", LATER, { occurredAt: NOW })),
    ).toEqual({
      status: "completed",
      runId: "r",
      occurredAt: LATER,
      lowSignal: false,
    });
    const expected: Record<string, string> = {
      completed: "completed",
      interrupted: "interrupted",
      cancelled: "interrupted",
      failed: "failed",
      rolled_back: "failed",
    };
    for (const [status, outcome] of Object.entries(expected)) {
      expect(terminalThreadOutcome(runUpdated("t", "r", status, NOW))?.status).toBe(outcome);
    }
  });

  it("falls back to the event time when a terminal run has no completion time", () => {
    expect(
      terminalThreadOutcome(runUpdated("t", "r", "failed", null, { occurredAt: LATER })),
    ).toMatchObject({ status: "failed", occurredAt: LATER });
  });

  it("ignores non-terminal run statuses and unrelated events", () => {
    for (const status of ["running", "waiting", "queued", "starting"]) {
      expect(terminalThreadOutcome(runUpdated("t", "r", status, null))).toBeUndefined();
    }
    expect(
      terminalThreadOutcome(
        stored({ type: "thread.created", occurredAt: DateTime.makeUnsafe(NOW), payload: {} }),
      ),
    ).toBeUndefined();
  });

  it("reads a settle as a low-signal outcome without a run", () => {
    expect(terminalThreadOutcome(threadSettled("t", LATER))).toEqual({
      status: "settled",
      occurredAt: LATER,
      lowSignal: true,
    });
  });
});

describe("catchUpStartSequence", () => {
  it("starts at the head when nothing was recorded", () => {
    expect(catchUpStartSequence({ recordedCursor: undefined, headSequence: 900 })).toBe(900);
  });

  it("starts at the head for a cursor beyond it (a pre-cutover V1 sequence)", () => {
    expect(catchUpStartSequence({ recordedCursor: 70_000, headSequence: 900 })).toBe(900);
  });

  it("resumes at the recorded cursor inside the replay window", () => {
    expect(catchUpStartSequence({ recordedCursor: 800, headSequence: 900 })).toBe(800);
    expect(catchUpStartSequence({ recordedCursor: 900, headSequence: 900 })).toBe(900);
  });

  it(`replays at most ${CATCH_UP_EVENT_LIMIT} events`, () => {
    const head = CATCH_UP_EVENT_LIMIT * 3;
    expect(catchUpStartSequence({ recordedCursor: 5, headSequence: head })).toBe(
      head - CATCH_UP_EVENT_LIMIT,
    );
    expect(
      catchUpStartSequence({ recordedCursor: head - CATCH_UP_EVENT_LIMIT, headSequence: head }),
    ).toBe(head - CATCH_UP_EVENT_LIMIT);
    expect(
      catchUpStartSequence({ recordedCursor: head - CATCH_UP_EVENT_LIMIT + 1, headSequence: head }),
    ).toBe(head - CATCH_UP_EVENT_LIMIT + 1);
  });
});

it.layer(NodeServices.layer)("SpaceActivityReactor", (it) => {
  it.effect("records a finished run and a failed run in the bound Space only", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const recorded = yield* withReactor(
        harness,
        Effect.gen(function* () {
          yield* deliver(harness, {
            events: [
              runUpdated("t-feed", "v2-run-feed", "completed", NOW),
              runUpdated("t-feed", "v2-run-feed-2", "failed", LATER),
              runUpdated("t-home", "v2-run-home", "completed", NOW),
            ],
          });
          return yield* rows;
        }),
      );
      expect(recorded).toEqual([
        {
          spaceId: "command-center",
          sourceKind: "thread",
          sourceId: "t-feed",
          status: "completed",
          title: "Build the activity feed",
          summary: "Done. Opened https://github.com/acme/example/pull/321",
          url: "https://github.com/acme/example/pull/321",
        },
        expect.objectContaining({
          spaceId: "command-center",
          sourceId: "t-feed",
          status: "failed",
          summary: "",
          url: null,
        }),
      ]);
    }),
  );

  it.effect("logs a Run once and never logs its thread or a Space agent thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const recorded = yield* withReactor(
        harness,
        Effect.gen(function* () {
          yield* deliver(harness, {
            events: [
              runUpdated("t-run", "v2-run-run", "completed", NOW),
              runUpdated("cc-space-agent-command-center", "v2-run-agent", "completed", NOW),
            ],
            runs: [runFinished("run-1", "running"), runFinished("run-1", "succeeded")],
          });
          return yield* rows;
        }),
      );
      expect(recorded).toEqual([
        {
          spaceId: "command-center",
          sourceKind: "run",
          sourceId: "run-1",
          status: "completed",
          title: "Run thread",
          summary: "Run finished cleanly.",
          url: null,
        },
      ]);
    }),
  );

  it.effect("records a run reaching a terminal status twice once", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const recorded = yield* withReactor(
        harness,
        Effect.gen(function* () {
          yield* deliver(harness, {
            events: [
              runUpdated("t-feed", "v2-run-feed", "completed", NOW),
              runUpdated("t-feed", "v2-run-feed", "completed", NOW),
            ],
          });
          return yield* rows;
        }),
      );
      expect(recorded.map((row) => row.status)).toEqual(["completed"]);
    }),
  );

  it.effect("skips a settle that echoes a recent turn end and keeps a later one", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const recorded = yield* withReactor(
        harness,
        Effect.gen(function* () {
          yield* deliver(harness, {
            events: [
              runUpdated("t-feed", "v2-run-feed", "completed", NOW),
              threadSettled("t-feed", LATER),
            ],
          });
          yield* deliver(harness, { events: [threadSettled("t-feed", MUCH_LATER)] });
          return yield* rows;
        }),
      );
      expect(recorded.map((row) => row.status)).toEqual(["completed", "settled"]);
    }),
  );

  it.effect("records nothing for non-terminal run statuses", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const { before, after } = yield* withReactor(
        harness,
        Effect.gen(function* () {
          yield* deliver(harness, {
            events: [
              runUpdated("t-feed", "v2-run-feed", "running", null),
              runUpdated("t-feed", "v2-run-feed", "waiting", null),
              runUpdated("t-feed", "v2-run-feed", "queued", null),
            ],
          });
          const before = yield* rows;
          // The followers are still alive: a terminal event after them is recorded.
          yield* deliver(harness, {
            events: [runUpdated("t-feed", "v2-run-feed", "completed", NOW)],
          });
          return { before, after: yield* rows };
        }),
      );
      expect(before).toEqual([]);
      expect(after.map((row) => row.status)).toEqual(["completed"]);
    }),
  );

  it.effect("resumes after the newest recorded thread row on start", () =>
    Effect.gen(function* () {
      const missed = runUpdated("t-feed", "v2-run-feed", "completed", LATER, { sequence: 9 });
      const alreadySeen = runUpdated("t-feed", "v2-run-feed-old", "completed", NOW, {
        sequence: 5,
      });
      const harness = yield* makeHarness({ catchUp: [alreadySeen, missed], head: 10 });
      const recorded = yield* Effect.gen(function* () {
        yield* seed;
        const activity = yield* SpaceActivity;
        yield* activity.record({
          spaceId: "command-center",
          occurredAt: NOW,
          sourceKind: "thread",
          sourceId: "t-feed",
          projectId: "p-example",
          title: "Earlier turn",
          status: "completed",
          text: null,
          eventSequence: 7,
        });
        const reactor = yield* SpaceActivityReactor;
        yield* reactor.start();
        yield* deliver(harness, {});
        return yield* rows;
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
      expect([...harness.streamCalls].map((call) => call.eventType).toSorted()).toEqual([
        "run.updated",
        "thread.settled",
      ]);
      expect(harness.streamCalls.map((call) => call.afterSequence)).toEqual([7, 7]);
      expect(recorded.map((row) => row.title)).toEqual(["Earlier turn", "Build the activity feed"]);
    }),
  );

  it.effect("starts at the V2 head when the recorded cursor is a pre-cutover V1 sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ head: 10 });
      yield* Effect.gen(function* () {
        yield* seed;
        const activity = yield* SpaceActivity;
        yield* activity.record({
          spaceId: "command-center",
          occurredAt: NOW,
          sourceKind: "thread",
          sourceId: "t-feed",
          projectId: "p-example",
          title: "Legacy turn",
          status: "completed",
          text: null,
          eventSequence: 70_000,
        });
        const reactor = yield* SpaceActivityReactor;
        yield* reactor.start();
        yield* deliver(harness, {});
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
      expect(harness.streamCalls.map((call) => call.afterSequence)).toEqual([10, 10]);
    }),
  );
});
