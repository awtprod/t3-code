import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { RunId, SpaceId } from "@command-center/core";
import {
  type CommandCenterEventEnvelope,
  CommandId,
  EventId,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CommandCenterEventStream } from "../../command-center/EventStream.ts";
import { layer as spaceActivityLayer, SpaceActivity } from "../../command-center/SpaceActivity.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolver } from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { SpaceActivityReactor } from "../Services/SpaceActivityReactor.ts";
import { SpaceActivityReactorLive, terminalThreadOutcome } from "./SpaceActivityReactor.ts";

const NOW = "2026-10-09T12:00:00.000Z";
const LATER = "2026-10-09T12:01:00.000Z";
const MUCH_LATER = "2026-10-09T13:00:00.000Z";

const T3_PROJECT = ProjectId.make("p-t3");
const HOME_PROJECT = ProjectId.make("p-home");

const projects: Record<string, OrchestrationProjectShell> = {
  [T3_PROJECT]: {
    id: T3_PROJECT,
    title: "t3-code",
    workspaceRoot: "/work/t3-code",
    // A fork: dispatch's primary identity is upstream, the binding is origin.
    repositoryIdentity: {
      canonicalKey: "github.com/pingdotgg/t3code",
      locator: {
        source: "git-remote",
        remoteName: "upstream",
        remoteUrl: "https://github.com/pingdotgg/t3code.git",
      },
    },
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
};

const remoteKeysByRoot: Record<string, ReadonlyArray<string>> = {
  "/work/t3-code": ["github.com/pingdotgg/t3code", "github.com/awtprod/t3-code"],
};

const threadShell = (id: string, projectId: ProjectId, title: string) =>
  ({
    id: ThreadId.make(id),
    projectId,
    title,
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
  }) as unknown as OrchestrationThreadShell;

const threads: Record<string, OrchestrationThreadShell> = Object.fromEntries(
  [
    threadShell("t-feed", T3_PROJECT, "Build the activity feed"),
    threadShell("t-home", HOME_PROJECT, "Personal errand"),
    threadShell("t-run", T3_PROJECT, "Run thread"),
    threadShell("cc-space-agent-command-center", T3_PROJECT, "Command Center agent"),
  ].map((thread) => [thread.id, thread]),
);

let sequence = 0;
const eventBase = (threadId: string, occurredAt: string) => {
  sequence += 1;
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    commandId: CommandId.make(`cmd-${sequence}`),
    aggregateKind: "thread" as const,
    aggregateId: ThreadId.make(threadId),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    occurredAt,
  };
};

const turnEnded = (
  threadId: string,
  state: "completed" | "interrupted" | "error",
  occurredAt = NOW,
): OrchestrationEvent => ({
  ...eventBase(threadId, occurredAt),
  type: "thread.session-set",
  payload: {
    threadId: ThreadId.make(threadId),
    session: {
      threadId: ThreadId.make(threadId),
      status: state === "completed" ? "ready" : state === "error" ? "error" : "interrupted",
      providerName: "claudeAgent",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: occurredAt,
    },
    terminalTurnTransition: { turnId: TurnId.make(`${threadId}-turn`), state },
  },
});

const settled = (threadId: string, occurredAt: string): OrchestrationEvent => ({
  ...eventBase(threadId, occurredAt),
  type: "thread.settled",
  payload: { threadId: ThreadId.make(threadId), settledAt: occurredAt, updatedAt: occurredAt },
});

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
    runId: RunId.make(runId),
    occurredAt: LATER,
    payload: { status },
  } as unknown as CommandCenterEventEnvelope;
};

const makeHarness = (catchUp: ReadonlyArray<OrchestrationEvent> = []) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationEvent>();
    const runEvents = yield* Queue.unbounded<CommandCenterEventEnvelope>();
    const catchUpCursors: Array<number> = [];
    const services = spaceActivityLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
    const layer = SpaceActivityReactorLive.pipe(
      Layer.provide(
        Layer.mock(OrchestrationEngineService)({
          streamDomainEvents: Stream.fromQueue(events),
          readEvents: (fromSequence) => {
            catchUpCursors.push(fromSequence);
            return Stream.fromIterable(catchUp);
          },
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: (threadId) => Effect.succeed(Option.fromNullishOr(threads[threadId])),
          getProjectShellById: (projectId) =>
            Effect.succeed(Option.fromNullishOr(projects[projectId])),
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
    return { events, runEvents, catchUpCursors, layer };
  });

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repositories =
    '[{"id":"t3-code","displayName":"T3 Code","aliases":[],"remoteRef":"https://github.com/awtprod/t3-code.git"}]';
  yield* sql`
    INSERT INTO command_center_spaces (id, slug, name, kind, repositories_json, created_at, updated_at)
    VALUES
      ('command-center', 'command-center', 'Command Center', 'system', ${repositories}, ${NOW}, ${NOW}),
      ('personal', 'personal', 'Personal', 'personal', '[]', ${NOW}, ${NOW})
  `;
  yield* sql`
    INSERT INTO command_center_runs (id, command_id, space_id, project_id, thread_id, kind, state,
      route_json, input_json, started_at)
    VALUES ('run-1', 'cmd-run-1', 'command-center', 'p-t3', 't-run', 'agent', 'succeeded',
      '{}', '{"text":"Ship the feed"}', ${NOW})
  `;
  const messages = [
    ["m-feed", "t-feed", "t-feed-turn", "Done. Opened https://github.com/awtprod/t3-code/pull/321"],
    ["m-run", "t-run", "t-run-turn", "Run finished cleanly."],
    ["m-agent", "cc-space-agent-command-center", null, "Woke up, nothing to do."],
  ] as const;
  for (const [id, threadId, turnId, text] of messages) {
    yield* sql`
      INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text,
        is_streaming, created_at, updated_at)
      VALUES (${id}, ${threadId}, ${turnId}, 'assistant', ${text}, 0, ${NOW}, ${NOW})
    `;
  }
});

/** Offers events, lets the stream fibers forward them, then drains the worker. */
const deliver = (
  harness: Harness,
  input: {
    readonly events?: ReadonlyArray<OrchestrationEvent>;
    readonly runs?: ReadonlyArray<CommandCenterEventEnvelope>;
  },
) =>
  Effect.gen(function* () {
    const reactor = yield* SpaceActivityReactor;
    yield* Queue.offerAll(harness.events, input.events ?? []);
    yield* Queue.offerAll(harness.runEvents, input.runs ?? []);
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
  it("reads turn ends, bare session errors, and settles", () => {
    expect(terminalThreadOutcome(turnEnded("t", "completed"))).toMatchObject({
      status: "completed",
      lowSignal: false,
    });
    expect(terminalThreadOutcome(turnEnded("t", "error"))?.status).toBe("failed");
    expect(terminalThreadOutcome(settled("t", NOW))).toEqual({
      status: "settled",
      lowSignal: true,
    });
    const running = turnEnded("t", "completed");
    if (running.type !== "thread.session-set") throw new Error("unreachable");
    const { terminalTurnTransition: _ignored, ...payload } = running.payload;
    expect(
      terminalThreadOutcome({
        ...running,
        payload: { ...payload, session: { ...payload.session, status: "running" } },
      }),
    ).toBeUndefined();
    expect(
      terminalThreadOutcome({
        ...running,
        payload: { ...payload, session: { ...payload.session, status: "error" } },
      }),
    ).toEqual({ status: "failed", lowSignal: true });
  });
});

it.layer(NodeServices.layer)("SpaceActivityReactor", (it) => {
  it.effect("records a finished turn and a failed turn in the bound Space only", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const recorded = yield* withReactor(
        harness,
        Effect.gen(function* () {
          yield* deliver(harness, {
            events: [
              turnEnded("t-feed", "completed"),
              turnEnded("t-feed", "error", LATER),
              turnEnded("t-home", "completed"),
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
          summary: "Done. Opened https://github.com/awtprod/t3-code/pull/321",
          url: "https://github.com/awtprod/t3-code/pull/321",
        },
        expect.objectContaining({ sourceId: "t-feed", status: "failed" }),
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
              turnEnded("t-run", "completed"),
              turnEnded("cc-space-agent-command-center", "completed"),
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

  it.effect("ignores replayed events and settles that echo a recent turn end", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const finished = turnEnded("t-feed", "completed");
      const recorded = yield* withReactor(
        harness,
        Effect.gen(function* () {
          yield* deliver(harness, {
            events: [finished, finished, settled("t-feed", LATER)],
          });
          yield* deliver(harness, { events: [settled("t-feed", MUCH_LATER)] });
          return yield* rows;
        }),
      );
      expect(recorded.map((row) => row.status)).toEqual(["completed", "settled"]);
    }),
  );

  it.effect("resumes after the newest recorded thread row on start", () =>
    Effect.gen(function* () {
      const missed = turnEnded("t-feed", "completed", LATER);
      const harness = yield* makeHarness([missed]);
      const recorded = yield* Effect.gen(function* () {
        yield* seed;
        const activity = yield* SpaceActivity;
        yield* activity.record({
          spaceId: "command-center",
          occurredAt: NOW,
          sourceKind: "thread",
          sourceId: "t-feed",
          projectId: "p-t3",
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
      expect(harness.catchUpCursors).toEqual([7]);
      expect(recorded.map((row) => row.title)).toEqual(["Earlier turn", "Build the activity feed"]);
    }),
  );
});
