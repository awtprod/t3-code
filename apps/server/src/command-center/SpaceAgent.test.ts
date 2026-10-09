import * as NodeServices from "@effect/platform-node/NodeServices";
import { Space, type Space as SpaceType } from "@command-center/core";
import { describe, expect, it } from "@effect/vitest";
import {
  type ClientOrchestrationCommand,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as OrchestrationCommandDispatcher from "../orchestration/CommandDispatcher.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CommandCenterConfig, type LoadedCommandCenterConfig } from "./Config.ts";
import * as ConnectionHealth from "./ConnectionHealth.ts";
import { layer as commandCenterServiceLayer } from "./Service.ts";
import * as SpaceAgent from "./SpaceAgent.ts";
import * as SpaceAgentWaker from "./SpaceAgentWaker.ts";

const decodeSpace = Schema.decodeUnknownSync(Space);
const fixtureTimestamp = "2026-01-01T00:00:00.000Z";

const makeSpace = (id: string, agent?: { readonly enabled: boolean }) =>
  decodeSpace({
    id,
    slug: id,
    displayName: id === "agent-space" ? "Agent Space" : "Quiet Space",
    kind: "system",
    instructions: "Keep the lights on.",
    policy: {
      allowedCapabilities: ["cc.items.read", "cc.memory.read", "cc.memory.propose"],
      autoRunRiskLevels: ["low"],
    },
    ...(agent === undefined
      ? {}
      : { agent: { ...agent, dailyWakeLimit: 12, debounceMinutes: 10 } }),
    connectionIds: [],
    repositories: [],
    aliases: [],
    lifecycle: "active",
    createdAt: fixtureTimestamp,
    updatedAt: fixtureTimestamp,
  });

const configWith = (spaces: ReadonlyArray<SpaceType>): LoadedCommandCenterConfig => ({
  spaces,
  connections: [],
  automations: [],
  timezone: "Etc/UTC",
  routing: {
    mode: "auto",
    showPreview: true,
    explicitSelectionWins: true,
    providerFallback: "first-healthy-compatible",
  },
  health: { status: "loaded", configDirectory: "runtime-config" },
});

const agentThreadId = ThreadId.make("cc-space-agent-agent-space");

const makeHarness = (
  config: LoadedCommandCenterConfig = configWith([
    makeSpace("agent-space", { enabled: true }),
    makeSpace("quiet-space"),
  ]),
) => {
  const dispatched: Array<ClientOrchestrationCommand> = [];
  const threads = new Map<string, OrchestrationThreadShell>();
  const layer = SpaceAgentWaker.layer.pipe(
    Layer.provideMerge(SpaceAgent.layer),
    Layer.provideMerge(commandCenterServiceLayer),
    Layer.provide(
      Layer.succeed(
        CommandCenterConfig,
        CommandCenterConfig.of({
          configDirectory: "runtime-config",
          load: Effect.succeed(config),
          resolveGoogleAccount: () => Effect.die("unused"),
        }),
      ),
    ),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getThreadShellById: (threadId) =>
          Effect.succeed(Option.fromNullishOr(threads.get(threadId))),
        getShellSnapshot: () =>
          Effect.succeed({ projects: [], threads: [] } as unknown as OrchestrationShellSnapshot),
        getProjectShellById: () => Effect.succeed(Option.none()),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
      }),
    ),
    Layer.provide(
      Layer.mock(OrchestrationCommandDispatcher.OrchestrationCommandDispatcher)({
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
      }),
    ),
    Layer.provide(ConnectionHealth.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "space-agent-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  const seedThread = (overrides: Partial<OrchestrationThreadShell> = {}) => {
    threads.set(agentThreadId, {
      id: agentThreadId,
      runtimeMode: "approval-required",
      interactionMode: "default",
      session: null,
      ...overrides,
    } as OrchestrationThreadShell);
  };
  return { layer, dispatched, seedThread };
};

describe("Space agent", () => {
  it.effect(
    "creates the stable agent thread once, with the role and brief in its first turn",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const spaceAgent = yield* SpaceAgent.SpaceAgent;
        const result = yield* spaceAgent.sendTurn("agent-space", {
          text: SpaceAgent.SPACE_AGENT_MANUAL_WAKE_TEXT,
          reason: "manual",
        });

        expect(result).toMatchObject({ threadId: agentThreadId, created: true });
        expect(harness.dispatched.map((command) => command.type)).toEqual([
          "project.create",
          "thread.turn.start",
        ]);
        const turn = harness.dispatched[1];
        if (turn?.type !== "thread.turn.start") throw new Error("Expected a turn start.");
        expect(turn.threadId).toBe(agentThreadId);
        expect(turn.bootstrap?.createThread).toMatchObject({
          projectId: "command-center:system",
          title: "Agent Space agent",
          runtimeMode: SpaceAgent.SPACE_AGENT_RUNTIME_MODE,
          modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
        });
        expect(turn.message.text).toContain("Command Center Space agent role");
        expect(turn.message.text).toContain("Reason: manual");
        expect(turn.message.text).toContain(SpaceAgent.SPACE_AGENT_MANUAL_WAKE_TEXT);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("sends later turns to the existing thread and keeps its runtime mode", () => {
    const harness = makeHarness();
    harness.seedThread();
    return Effect.gen(function* () {
      const spaceAgent = yield* SpaceAgent.SpaceAgent;
      const ensured = yield* spaceAgent.ensureThread("agent-space");
      const result = yield* spaceAgent.sendTurn("agent-space", { text: "Wake.", reason: "wake" });

      expect(ensured).toEqual({ threadId: agentThreadId, created: false });
      expect(result).toMatchObject({ created: false });
      expect(harness.dispatched).toHaveLength(1);
      const turn = harness.dispatched[0];
      if (turn?.type !== "thread.turn.start") throw new Error("Expected a turn start.");
      expect(turn.bootstrap).toBeUndefined();
      expect(turn.modelSelection).toBeUndefined();
      expect(turn.runtimeMode).toBe("approval-required");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("rejects disabled agents, busy threads, and unbounded text without dispatching", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const spaceAgent = yield* SpaceAgent.SpaceAgent;
      const disabled = yield* spaceAgent
        .sendTurn("quiet-space", { text: "Hello.", reason: "manual" })
        .pipe(Effect.flip);
      const unknown = yield* spaceAgent
        .sendTurn("missing-space", { text: "Hello.", reason: "manual" })
        .pipe(Effect.flip);
      const empty = yield* spaceAgent
        .sendTurn("agent-space", { text: "   ", reason: "manual" })
        .pipe(Effect.flip);
      const tooLong = yield* spaceAgent
        .sendTurn("agent-space", { text: "x".repeat(8_001), reason: "manual" })
        .pipe(Effect.flip);
      harness.seedThread({
        session: { activeTurnId: "turn-1" } as OrchestrationThreadShell["session"],
      });
      const busy = yield* spaceAgent
        .sendTurn("agent-space", { text: "Hello.", reason: "manual" })
        .pipe(Effect.flip);

      expect(disabled.reason).toBe("validation");
      expect(unknown.reason).toBe("not_found");
      expect(empty.reason).toBe("validation");
      expect(tooLong.reason).toBe("validation");
      expect(busy.reason).toBe("conflict");
      expect(harness.dispatched).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("resolves an approved-memory scope only for an enabled agent thread", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const spaceAgent = yield* SpaceAgent.SpaceAgent;
      const scope = yield* spaceAgent.resolveScope(agentThreadId);

      expect(scope).toMatchObject({
        spaceId: "agent-space",
        memoryWriteMode: "remember",
        role: "space-agent",
      });
      expect([...(scope?.capabilities ?? [])]).toEqual([
        "cc.items.read",
        "cc.memory.read",
        "cc.memory.propose",
      ]);
      expect(
        yield* spaceAgent.resolveScope(ThreadId.make("cc-space-agent-quiet-space")),
      ).toBeUndefined();
      expect(
        yield* spaceAgent.resolveScope(ThreadId.make("cc-space-agent-missing")),
      ).toBeUndefined();
      expect(yield* spaceAgent.resolveScope(ThreadId.make("ordinary-thread"))).toBeUndefined();
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("lists every Space with its agent state", () => {
    const harness = makeHarness();
    harness.seedThread();
    return Effect.gen(function* () {
      const spaceAgent = yield* SpaceAgent.SpaceAgent;
      const agents = yield* spaceAgent.list;

      expect(agents).toEqual(
        expect.arrayContaining([
          {
            spaceId: "agent-space",
            displayName: "Agent Space",
            enabled: true,
            threadId: agentThreadId,
            model: { providerId: "claudeAgent", modelId: "claude-opus-5-5" },
            paused: false,
            lastWakeAt: null,
            lastWakeReason: null,
            wakesToday: 0,
            pendingEvents: 0,
          },
          {
            spaceId: "quiet-space",
            displayName: "Quiet Space",
            enabled: false,
            threadId: null,
            model: null,
            paused: false,
            lastWakeAt: null,
            lastWakeReason: null,
            wakesToday: 0,
            pendingEvents: 0,
          },
        ]),
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("lists pause and manual-wake state set through the waker", () => {
    const harness = makeHarness();
    harness.seedThread();
    return Effect.gen(function* () {
      const spaceAgent = yield* SpaceAgent.SpaceAgent;
      const waker = yield* SpaceAgentWaker.SpaceAgentWaker;
      const agentState = Effect.map(spaceAgent.list, (agents) =>
        agents.find((agent) => agent.spaceId === "agent-space"),
      );
      // Listing projects the configured Spaces the waker reads.
      yield* spaceAgent.list;

      expect(yield* waker.setPaused("agent-space", true)).toEqual({
        spaceId: "agent-space",
        paused: true,
      });
      expect(yield* agentState).toMatchObject({ paused: true, wakesToday: 0 });

      const woke = yield* waker.deliverWake("agent-space", { kind: "manual" });
      expect(woke).toMatchObject({ threadId: agentThreadId, kind: "manual" });
      expect(harness.dispatched.at(-1)?.type).toBe("thread.turn.start");
      const listed = yield* agentState;
      expect(listed).toMatchObject({
        paused: true,
        lastWakeReason: "manual",
        wakesToday: 1,
        pendingEvents: 0,
      });
      expect(listed?.lastWakeAt).not.toBeNull();

      yield* waker.setPaused("agent-space", false);
      expect(yield* agentState).toMatchObject({ paused: false, lastWakeReason: "manual" });
    }).pipe(Effect.provide(harness.layer));
  });
});
