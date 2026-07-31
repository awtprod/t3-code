// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ModelSelection,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderTurnStartResult,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { TextGenerationError } from "@t3tools/contracts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import { TextGeneration, type TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import {
  COMMAND_PRODUCED_NO_EVENTS_DETAIL,
  OrchestrationCommandInvariantError,
} from "../Errors.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import {
  providerErrorLabel,
  providerErrorLabelFromInstanceHint,
  ProviderCommandReactorLive,
} from "./ProviderCommandReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderTurnSendClaimRepository } from "../../persistence/Services/ProviderTurnSendClaims.ts";
import { ProviderTurnSendClaimRepositoryLive } from "../../persistence/Layers/ProviderTurnSendClaims.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asApprovalRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

const deriveServerPathsSync = (baseDir: string, devUrl: URL | undefined) =>
  Effect.runSync(deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer)));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
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

describe("ProviderCommandReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | ProviderCommandReactor
    | ProjectionSnapshotQuery
    | ProviderTurnSendClaimRepository
    | OrchestrationEventStore,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const createdStateDirs = new Set<string>();
  const createdBaseDirs = new Set<string>();

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const stateDir of createdStateDirs) {
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }
    createdStateDirs.clear();
    for (const baseDir of createdBaseDirs) {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
    createdBaseDirs.clear();
  });

  describe("provider error attribution", () => {
    it("uses the current provider instance slug when current instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "codex_personal",
          modelSelectionInstanceId: "codex",
          sessionProvider: "codex",
        }),
      ).toBe("codex_personal");
    });

    it("uses the desired provider instance slug when desired instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "claude_openrouter",
        }),
      ).toBe("claude_openrouter");
    });

    it("uses the unknown driver kind when the resolved driver is not registered locally", () => {
      expect(providerErrorLabel("third_party_driver")).toBe("third_party_driver");
    });
  });

  async function createHarness(input?: {
    readonly baseDir?: string;
    readonly threadModelSelection?: ModelSelection;
    readonly sessionModelSwitch?: "unsupported" | "in-session";
    readonly requiresNewThreadForModelChange?: boolean;
  }) {
    const now = "2026-01-01T00:00:00.000Z";
    const baseDir =
      input?.baseDir ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-reactor-"));
    createdBaseDirs.add(baseDir);
    const { stateDir } = deriveServerPathsSync(baseDir, undefined);
    createdStateDirs.add(stateDir);
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    let nextSessionIndex = 1;
    const runtimeSessions: Array<ProviderSession> = [];
    const modelSelection = input?.threadModelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    };
    const startSession = vi.fn((_: unknown, input: unknown) => {
      const sessionIndex = nextSessionIndex++;
      const resumeCursor =
        typeof input === "object" && input !== null && "resumeCursor" in input
          ? input.resumeCursor
          : undefined;
      const threadId =
        typeof input === "object" &&
        input !== null &&
        "threadId" in input &&
        typeof input.threadId === "string"
          ? ThreadId.make(input.threadId)
          : ThreadId.make(`thread-${sessionIndex}`);
      const inputModelSelection =
        typeof input === "object" && input !== null && "modelSelection" in input
          ? (input.modelSelection as ModelSelection | undefined)
          : undefined;
      const providerInstanceId =
        typeof input === "object" && input !== null && "providerInstanceId" in input
          ? (input.providerInstanceId as ProviderInstanceId | undefined)
          : inputModelSelection?.instanceId;
      const provider =
        typeof input === "object" &&
        input !== null &&
        "provider" in input &&
        typeof input.provider === "string"
          ? (input.provider as ProviderSession["provider"])
          : ProviderDriverKind.make(inputModelSelection?.instanceId ?? modelSelection.instanceId);
      const session: ProviderSession = {
        provider,
        ...(providerInstanceId ? { providerInstanceId } : {}),
        status: "ready" as const,
        runtimeMode:
          typeof input === "object" &&
          input !== null &&
          "runtimeMode" in input &&
          (input.runtimeMode === "approval-required" || input.runtimeMode === "full-access")
            ? input.runtimeMode
            : "full-access",
        ...(typeof input === "object" &&
        input !== null &&
        "cwd" in input &&
        typeof input.cwd === "string"
          ? { cwd: input.cwd }
          : {}),
        ...((inputModelSelection?.model ?? modelSelection.model)
          ? { model: inputModelSelection?.model ?? modelSelection.model }
          : {}),
        threadId,
        // A distinct nonce per runtime start, as the real runtimes mint. The
        // index makes it assertable: a second start must bind a DIFFERENT
        // generation, which is the whole point of the field.
        sessionGeneration: `generation-${sessionIndex}`,
        resumeCursor: resumeCursor ?? { opaque: `resume-${sessionIndex}` },
        createdAt: now,
        updatedAt: now,
      };
      runtimeSessions.push(session);
      return Effect.succeed(session);
    });
    const sendTurn = vi.fn(
      (_: unknown): Effect.Effect<ProviderTurnStartResult, ProviderAdapterRequestError> =>
        Effect.succeed({
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-1"),
        }),
    );
    // Typed to admit a provider failure so tests can exercise the path where a
    // stop cannot be delivered; `Effect.void` alone would narrow the error
    // channel to `never` and make that unwritable.
    const interruptTurn = vi.fn(
      (_: unknown): Effect.Effect<void, ProviderAdapterRequestError> => Effect.void,
    );
    const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(() => Effect.void);
    const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(() => Effect.void);
    const stopSession = vi.fn(
      (input: unknown): Effect.Effect<void, ProviderAdapterRequestError> =>
        Effect.sync(() => {
          const threadId =
            typeof input === "object" && input !== null && "threadId" in input
              ? (input as { threadId?: ThreadId }).threadId
              : undefined;
          if (!threadId) {
            return;
          }
          const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
          if (index >= 0) {
            runtimeSessions.splice(index, 1);
          }
        }),
    );
    const renameBranch = vi.fn((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "newBranch" in input &&
          typeof input.newBranch === "string"
            ? input.newBranch
            : "renamed-branch",
      }),
    );
    const refreshStatus = vi.fn((_: string) =>
      Effect.succeed({
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: false,
        refName: "renamed-branch",
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }),
    );
    const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "disabled in test harness",
        }),
      ),
    );
    const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "disabled in test harness",
        }),
      ),
    );
    const providerSnapshots = [
      {
        instanceId: modelSelection.instanceId,
        ...(input?.requiresNewThreadForModelChange === true
          ? { requiresNewThreadForModelChange: true }
          : {}),
      },
    ];

    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      startSession: startSession as ProviderServiceShape["startSession"],
      sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
      interruptTurn: interruptTurn as ProviderServiceShape["interruptTurn"],
      respondToRequest: respondToRequest as ProviderServiceShape["respondToRequest"],
      respondToUserInput: respondToUserInput as ProviderServiceShape["respondToUserInput"],
      stopSession: stopSession as ProviderServiceShape["stopSession"],
      listSessions: () => Effect.succeed(runtimeSessions),
      getCapabilities: (_provider) =>
        Effect.succeed({
          sessionModelSwitch: input?.sessionModelSwitch ?? "in-session",
        }),
      getInstanceInfo: (instanceId) => {
        const raw = String(instanceId);
        const driverKind = ProviderDriverKind.make(
          raw.startsWith("claude") ? "claudeAgent" : raw.startsWith("codex") ? "codex" : raw,
        );
        return Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind,
            continuationKey:
              driverKind === ProviderDriverKind.make("codex")
                ? "codex:home:/shared-codex"
                : `${driverKind}:instance:${instanceId}`,
          },
        });
      },
      rollbackConversation: () => unsupported(),
      get streamEvents() {
        return Stream.fromPubSub(runtimeEventPubSub);
      },
    };

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const layer = ProviderCommandReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      // Exposed to tests so they can drive the send claim the reactor itself
      // consults. Layer memoization over the shared in-memory DB below means
      // this reads and writes the same rows the reactor sees, not a copy.
      Layer.provideMerge(ProviderTurnSendClaimRepositoryLive),
      // Same reason, for the event store: `ProviderCommandReactorLive` provides
      // `OrchestrationEventStoreLive` internally, so without this the resolved
      // instance is unreachable from a test. Merging the SAME layer value makes
      // memoization hand back the reactor's own object, which is the only way
      // to spy a read FAILURE onto it — a state no external caller can produce.
      Layer.provideMerge(OrchestrationEventStoreLive),
      // Shared in-memory DB (memoized) so the reactor's ProjectionTurnRepository
      // reads the same pending-turn-start rows the engine's projection writes.
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(makeProviderRegistryLayer(providerSnapshots as never)),
      Layer.provideMerge(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          renameBranch,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
      Layer.provideMerge(
        Layer.succeed(VcsStatusBroadcaster, {
          getStatus: () => Effect.die("getStatus should not be called in this test"),
          refreshLocalStatus: () =>
            Effect.die("refreshLocalStatus should not be called in this test"),
          refreshStatus,
          streamStatus: () => Stream.die("streamStatus should not be called in this test"),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(TextGeneration, {
          generateBranchName,
          generateThreadTitle,
        }),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );
    const managed = ManagedRuntime.make(layer);
    runtime = managed;

    const engine = await managed.runPromise(Effect.service(OrchestrationEngineService));
    // Same harness-runtime pattern as `dispatch`/`cancelSendClaims`: tests that
    // need the durable sequence a correlation must match read it from the log
    // the reactor itself read, not from a guess.
    const readEvents = (): Promise<ReadonlyArray<{ type: string; sequence: number }>> =>
      managed.runPromise(
        Stream.runCollect(engine.readEvents(0, Number.MAX_SAFE_INTEGER)).pipe(
          Effect.map((events) =>
            events.map((event) => ({ type: event.type, sequence: event.sequence })),
          ),
        ),
      );
    // The payload-carrying counterpart to `readEvents`. Kept separate so the
    // many existing callers that only need type/sequence stay unchanged, while
    // tests asserting on what an event CARRIES (e.g. which placeholder a fold
    // consumed) can read it instead of inferring it from ordering.
    const readEventsWithPayloads = (): Promise<
      ReadonlyArray<{ type: string; sequence: number; payload: unknown }>
    > =>
      managed.runPromise(
        Stream.runCollect(engine.readEvents(0, Number.MAX_SAFE_INTEGER)).pipe(
          Effect.map((events) =>
            events.map((event) => ({
              type: event.type,
              sequence: event.sequence,
              payload: (event as { payload?: unknown }).payload,
            })),
          ),
        ),
      );
    const snapshotQuery = await managed.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await managed.runPromise(Effect.service(ProviderCommandReactor));
    const sendClaims = await managed.runPromise(Effect.service(ProviderTurnSendClaimRepository));
    const eventStore = await managed.runPromise(Effect.service(OrchestrationEventStore));
    // Exposed as a promise, like `dispatch` and `readModel` above, so tests
    // drive the claim through the harness runtime rather than standing up a
    // manual runner of their own.
    const cancelSendClaims = (input: Parameters<typeof sendClaims.cancel>[0]): Promise<void> =>
      managed.runPromise(sendClaims.cancel(input));
    // The supersession counterpart to `cancelSendClaims`: lets a test hand the
    // claim to a newer request for the same message WITHOUT raising a barrier,
    // which is the state a fence must read as "stand down" rather than "stop
    // the turn".
    const acquireSendClaim = (input: Parameters<typeof sendClaims.acquire>[0]): Promise<unknown> =>
      managed.runPromise(sendClaims.acquire(input));
    // Effect-backed latches used by concurrency tests stay on the harness
    // runtime, matching every repository/service effect those tests coordinate.
    // Wrapping the runner here also keeps individual cases declarative instead
    // of constructing ad-hoc runtimes.
    const runEffect = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => managed.runPromise(effect);
    const makeLatch = (): Promise<Deferred.Deferred<void>> => runEffect(Deferred.make<void>());
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(reactor.drain);

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot: "/tmp/provider-project",
        defaultModelSelection: modelSelection,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    return {
      engine,
      dispatch: (command: Parameters<typeof engine.dispatch>[0]) =>
        Effect.runPromise(engine.dispatch(command)),
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      renameBranch,
      refreshStatus,
      generateBranchName,
      generateThreadTitle,
      runtimeSessions,
      stateDir,
      drain,
      cancelSendClaims,
      acquireSendClaim,
      // The service OBJECT, not just wrappers around it. Layer memoization
      // means this is the same instance the reactor resolved, so a spy
      // installed on it here is the one the reactor calls — the only way to
      // inject a barrier-write failure, which no amount of driving the
      // repository from outside can produce.
      sendClaims,
      // The event store OBJECT the reactor resolved, for the same reason
      // `sendClaims` is exposed: a read that FAILS cannot be produced by
      // driving the store from outside, only by spying on the instance the
      // reactor calls.
      eventStore,
      readEvents,
      readEventsWithPayloads,
      runEffect,
      makeLatch,
    };
  }

  it("reacts to thread.turn.start by ensuring session and sending provider turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-1"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[0]).toEqual(ThreadId.make("thread-1"));
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("generates a thread title on the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Please investigate reconnect failures after restar...";
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Generated title" }));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-seed"),
        threadId: ThreadId.make("thread-1"),
        title: seededTitle,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      message: "Please investigate reconnect failures after restarting the session.",
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
        "Generated title"
      );
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Generated title");
  });

  it("does not overwrite an existing custom thread title on the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Please investigate reconnect failures after restar...";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-custom"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep this custom title",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title-preserve"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-preserve"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep this custom title");
  });

  it("matches the client-seeded title even when the outgoing prompt is reformatted", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Fix reconnect spinner on resume";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({
        title: "Reconnect spinner resume bug",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-formatted-seed"),
        threadId: ThreadId.make("thread-1"),
        title: seededTitle,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title-formatted"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-formatted"),
          role: "user",
          text: "[effort:high]\\n\\nFix reconnect spinner on resume",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
        "Reconnect spinner resume bug"
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Reconnect spinner resume bug");
  });

  it("generates a worktree branch name for the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-branch"),
        threadId: ThreadId.make("thread-1"),
        branch: "t3code/1234abcd",
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );

    harness.generateBranchName.mockImplementation((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "modelSelection" in input &&
          typeof input.modelSelection === "object" &&
          input.modelSelection !== null &&
          "model" in input.modelSelection &&
          typeof input.modelSelection.model === "string"
            ? `feature/${input.modelSelection.model}`
            : "feature/generated",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-branch-model"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-branch-model"),
          role: "user",
          text: "Add a safer reconnect backoff.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateBranchName.mock.calls.length === 1);
    await waitFor(() => harness.refreshStatus.mock.calls.length === 1);
    expect(harness.generateBranchName.mock.calls[0]?.[0]).toMatchObject({
      message: "Add a safer reconnect backoff.",
    });
    expect(harness.refreshStatus.mock.calls[0]?.[0]).toBe("/tmp/provider-project-worktree");
  });

  it("forwards codex model options through session start and turn send", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-fast"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-fast"),
          role: "user",
          text: "hello fast mode",
          attachments: [],
        },
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ]),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    });
  });

  it("stamps the send with the turn-start request's own sequence", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-correlated"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-correlated"),
        role: "user",
        text: "hello correlated",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    // Read the durable sequence rather than assert a literal: the projector
    // matches placeholders on exactly this value, so a send stamped with
    // anything else silently reverts to positional adoption.
    const events = await harness.readEvents();
    const turnStartRequested = events.filter(
      (event) => event.type === "thread.turn-start-requested",
    );
    expect(turnStartRequested).toHaveLength(1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      turnRequestSequence: turnStartRequested[0]?.sequence,
    });
  });

  it("forwards claude effort options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort"),
          role: "user",
          text: "hello with effort",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
  });

  it("forwards claude fast mode options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-fast-mode"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-fast-mode"),
          role: "user",
          text: "hello with fast mode",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "fastMode", value: true }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "fastMode", value: true }],
      ),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "fastMode", value: true }],
      ),
    });
  });

  it("forwards plan interaction mode to the provider turn request", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-interaction-mode-set-plan"),
        threadId: ThreadId.make("thread-1"),
        interactionMode: "plan",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-plan"),
          role: "user",
          text: "plan this change",
          attachments: [],
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      interactionMode: "plan",
    });
  });

  it("preserves the active session model when in-session model switching is unsupported", async () => {
    const harness = await createHarness({ sessionModelSwitch: "unsupported" });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unsupported-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unsupported-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
    });
  });

  effectIt.effect(
    "rejects changing models after start when the provider requires a new thread",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({ requiresNewThreadForModelChange: true }),
        );
        const now = "2026-01-01T00:00:00.000Z";

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-restricted-1"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-restricted-1"),
            role: "user",
            text: "first",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-restricted-2"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-restricted-2"),
            role: "user",
            text: "second",
            attachments: [],
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.1-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        yield* Effect.promise(() =>
          waitFor(async () => {
            const readModel = await harness.readModel();
            const thread = readModel.threads.find(
              (entry) => entry.id === ThreadId.make("thread-1"),
            );
            return (
              thread?.activities.some(
                (activity) => activity.kind === "provider.turn.start.failed",
              ) ?? false
            );
          }),
        );

        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        const readModel = yield* Effect.promise(() => harness.readModel());
        const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
        expect(
          thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
        ).toMatchObject({
          payload: {
            detail: expect.stringContaining(
              "cannot switch models after the conversation has started",
            ),
          },
        });
      }),
  );

  it("starts a first turn on the requested provider instance even when it differs from the thread model", async () => {
    const harness = await createHarness({
      threadModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-first"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-first"),
          role: "user",
          text: "hello claude",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerName).toBe("claudeAgent");
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("claudeAgent"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBeUndefined();
  });

  it("reuses the same provider session when runtime mode is unchanged", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unchanged-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unchanged-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);
  });

  it("reuses the claudeAgent session across turns when the model selection is unchanged", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";
    // The client re-sends the selection on every turn, so each turn carries a
    // structurally-identical but distinct object. A reference-equality check
    // would treat every turn as a model change and restart (full-replay) the
    // provider session; the selection is unchanged, so the session is reused.
    const selection = () =>
      createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-sonnet-4-6", [
        { id: "effort", value: "max" },
      ]);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-unchanged-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-unchanged-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        modelSelection: selection(),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-unchanged-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-unchanged-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: selection(),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);
  });

  it("restarts an existing Codex thread on a compatible requested instance", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-compatible-codex-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-compatible-codex-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-compatible-codex-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-compatible-codex-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex_work"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex_work"),
      resumeCursor: { opaque: "resume-1" },
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
  });

  it("restarts the provider session when the thread workspace changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-workspace-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-workspace-1"),
          role: "user",
          text: "first in project root",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-worktree-change"),
        threadId: ThreadId.make("thread-1"),
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-workspace-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-workspace-2"),
          role: "user",
          text: "second in worktree",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      cwd: "/tmp/provider-project-worktree",
      resumeCursor: { opaque: "resume-1" },
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("restarts claude sessions when claude effort changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-1"),
          role: "user",
          text: "first claude turn",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "medium" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-2"),
          role: "user",
          text: "second claude turn",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      resumeCursor: { opaque: "resume-1" },
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
  });

  it("restarts the provider session when runtime mode is updated on the thread", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-1"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      resumeCursor: { opaque: "resume-1" },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("binds the replacement runtime's own session generation when restarting", async () => {
    // The ingestion layer drops a lifecycle event whose `sessionGeneration`
    // disagrees with the bound session's, which is how a superseded runtime's
    // late exit is kept from clobbering the live one. That guard is only armed
    // if the binding actually carries the generation the runtime minted — a
    // binding that omits it leaves the projection holding `undefined`, which
    // mismatches nothing, so the stale exit is accepted and then suppresses the
    // LIVE runtime's events as "stale". This exercises the production handoff
    // end to end: runtime mints it (harness `startSession`) -> reactor binds it
    // -> projection stores it -> read model exposes it.
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    // Start from full-access so the later switch is a genuine mode CHANGE and
    // therefore forces a restart, rather than a no-op reuse of the session.
    await harness.dispatch({
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("cmd-runtime-mode-set-generation-initial"),
      threadId: ThreadId.make("thread-1"),
      runtimeMode: "full-access",
      createdAt: now,
    });

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-generation-1"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-generation-1"),
        role: "user",
        text: "first",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      createdAt: now,
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    const firstReadModel = await harness.readModel();
    const firstThread = firstReadModel.threads.find(
      (entry) => entry.id === ThreadId.make("thread-1"),
    );
    expect(firstThread?.session?.sessionGeneration).toBe("generation-1");

    // Restart the runtime. The replacement keeps the same provider identity, so
    // the generation is the ONLY thing distinguishing its events from its dead
    // predecessor's — exactly the G1/G2 confusion the guard exists to resolve.
    await harness.dispatch({
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("cmd-runtime-mode-set-generation"),
      threadId: ThreadId.make("thread-1"),
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.session?.runtimeMode === "approval-required";
    });

    const secondReadModel = await harness.readModel();
    const secondThread = secondReadModel.threads.find(
      (entry) => entry.id === ThreadId.make("thread-1"),
    );
    // Not merely "defined": it must be the NEW runtime's nonce. Leaving
    // generation-1 in place would make every live event look stale.
    expect(secondThread?.session?.sessionGeneration).toBe("generation-2");
  });

  it("does not inject derived model options when restarting claude on runtime mode changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-runtime-mode-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-claude-no-options"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("does not stop the active session when restart fails before rebind", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access-2"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-restart-failure-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-restart-failure-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    harness.startSession.mockImplementationOnce(
      (_: unknown, __: unknown) => Effect.fail("simulated restart failure") as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-restart-failure"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await harness.drain();

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(1);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("full-access");
  });

  it("rejects provider changes after a thread is already bound to a session provider", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-switch-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-switch-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.sendTurn.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerName).toBe("codex");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("cannot switch to 'claudeAgent'"),
      },
    });
  });

  it("rejects cross-driver provider changes after the existing thread session has stopped", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stopped-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "stopped",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-stopped-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-stopped-provider-switch"),
          role: "user",
          text: "continue with claude",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("cannot switch to 'claudeAgent'"),
      },
    });
  });

  it("reacts to thread.turn.interrupt-requested by calling provider interrupt", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
    });
  });

  it("retries, escalates, and reports when the ordinary interrupt cannot be delivered", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    // The projection marks the turn interrupted the moment
    // `thread.turn-interrupt-requested` is appended, BEFORE the provider is
    // told anything. So a failed `interruptTurn` on this path is not a missed
    // stop that the UI still shows as running — it is a UI that says stopped
    // over a provider that is still running the turn and still taking side
    // effects. Swallowing it into the reactor's generic warning logger, which
    // is what this path did, is the one handling that cannot be recovered from
    // by anything downstream.
    harness.interruptTurn.mockImplementation((_: unknown) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "session/interrupt",
          detail: "provider socket closed",
        }),
      ),
    );

    await harness.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-set-undeliverable"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "running",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: asTurnId("turn-1"),
        lastError: null,
        updatedAt: now,
      },
      createdAt: now,
    });

    await harness.dispatch({
      type: "thread.turn.interrupt",
      commandId: CommandId.make("cmd-turn-interrupt-undeliverable"),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
      createdAt: now,
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.interrupt.failed") ??
        false
      );
    });
    await harness.drain();

    // Retried once before escalating — a transient transport failure is the
    // likeliest kind and a duplicate interrupt is free.
    expect(harness.interruptTurn.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Escalated to the session, through the ordinary stop intent rather than a
    // direct provider call, so the barrier is raised and the projection agrees
    // with the runtime.
    const events = await harness.readEvents();
    expect(events.filter((event) => event.type === "thread.session-stop-requested")).toHaveLength(
      1,
    );
    expect(harness.stopSession.mock.calls.length).toBe(1);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.status).toBe("stopped");

    // And reported either way. The user pressed stop on one turn and lost the
    // whole session instead; that is not a silent success.
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.interrupt.failed"),
    ).toMatchObject({
      turnId: asTurnId("turn-1"),
      payload: {
        detail: expect.stringContaining("provider socket closed"),
      },
    });
  });

  it("preserves the original interrupt failure when escalation dispatch also fails", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-set-double-stop-failure"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "running",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: asTurnId("turn-1"),
        lastError: null,
        updatedAt: now,
      },
      createdAt: now,
    });

    harness.interruptTurn.mockImplementation((_: unknown) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "session/interrupt",
          detail: "original interrupt transport failure",
        }),
      ),
    );

    const originalDispatch = harness.engine.dispatch;
    const dispatchSpy = vi
      .spyOn(harness.engine, "dispatch")
      .mockImplementation((command: Parameters<typeof originalDispatch>[0]) =>
        command.type === "thread.session.stop"
          ? Effect.fail(
              new PersistenceSqlError({
                operation: "dispatch",
                detail: "escalation dispatch persistence failure",
              }) as never,
            )
          : originalDispatch(command),
      );

    await harness.dispatch({
      type: "thread.turn.interrupt",
      commandId: CommandId.make("cmd-turn-interrupt-double-failure"),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
      createdAt: now,
    });

    await waitFor(async () => {
      const model = await harness.readModel();
      return (
        model.threads
          .find((entry) => entry.id === ThreadId.make("thread-1"))
          ?.activities.some((activity) => activity.kind === "provider.turn.interrupt.failed") ===
        true
      );
    });
    await harness.drain();
    dispatchSpy.mockRestore();

    // The harness does not install a log-capturing logger, so pin the observable
    // propagation contract: escalation failure is logged by production code,
    // while reporting still carries the ORIGINAL interrupt cause and never
    // substitutes the persistence failure.
    const model = await harness.readModel();
    const activity = model.threads
      .find((entry) => entry.id === ThreadId.make("thread-1"))
      ?.activities.find((entry) => entry.kind === "provider.turn.interrupt.failed");
    const detail = (activity?.payload as { detail?: string } | undefined)?.detail;
    expect(detail).toContain("original interrupt transport failure");
    expect(detail).not.toContain("escalation dispatch persistence failure");
    expect(
      (await harness.readEvents()).filter(
        (event) => event.type === "thread.session-stop-requested",
      ),
    ).toHaveLength(0);
  });

  it("escalates without canceling a message the user sent while the interrupt was retrying", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-before-late-interrupt"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-1"),
        role: "user",
        text: "the turn the user will stop",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();

    // The escalation ladder runs on the reactor's clock, not the user's: the
    // interrupt fails, waits, fails again, and only then dispatches a session
    // stop. Every one of those steps happens AFTER the sequence the user's stop
    // actually occupies, so a message typed into that window sits between the
    // two — above the interrupt, below the escalated stop.
    //
    // Dispatched from inside the failing interrupt rather than racing a timer,
    // because the ordering is the whole subject of the test: doing it here
    // pins the replacement between the interrupt that is mid-retry and the
    // escalation that has not been decided on yet.
    let dispatchedReplacement = false;
    harness.interruptTurn.mockImplementation((_: unknown) =>
      Effect.promise(async () => {
        if (dispatchedReplacement) {
          return;
        }
        dispatchedReplacement = true;
        await harness.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-during-interrupt-retry"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-2"),
            role: "user",
            text: "actually, do this instead",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });
      }).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: ProviderDriverKind.make("codex"),
              method: "session/interrupt",
              detail: "provider socket closed",
            }),
          ),
        ),
      ),
    );

    await harness.dispatch({
      type: "thread.turn.interrupt",
      commandId: CommandId.make("cmd-turn-interrupt-with-replacement"),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
      createdAt: now,
    });

    // The stop is the LAST thing enqueued on this thread — it is dispatched
    // after the replacement — so a worker that has driven it has driven the
    // replacement too. Waiting on the stop rather than on the send is what
    // makes a regression fail fast and loudly instead of timing out.
    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    await harness.drain();

    const events = await harness.readEventsWithPayloads();
    const interruptSequence = events.find(
      (event) => event.type === "thread.turn-interrupt-requested",
    )?.sequence;
    const replacementSequence = events.find(
      (event) =>
        event.type === "thread.turn-start-requested" &&
        (event.payload as { messageId?: string }).messageId === "user-message-2",
    )?.sequence;
    const stop = events.find((event) => event.type === "thread.session-stop-requested");
    expect(interruptSequence).toBeDefined();
    expect(replacementSequence).toBeDefined();
    expect(stop).toBeDefined();

    // The interleaving the fix exists for. Asserted rather than assumed,
    // because if the replacement did not land inside the retry window the rest
    // of this test proves nothing about the escalation's cutoff.
    expect(replacementSequence!).toBeGreaterThan(interruptSequence!);
    expect(stop!.sequence).toBeGreaterThan(replacementSequence!);

    // The escalation is dated to what the user stopped, not to when the reactor
    // gave up trying. Carrying the interrupt's own sequence is what keeps the
    // widening on its intended axis — one turn to the whole session — instead
    // of also widening the moment it applies to.
    expect((stop!.payload as { canceledThroughSequence?: number }).canceledThroughSequence).toBe(
      interruptSequence,
    );

    // The point of all of it: a prompt submitted after the stop is still the
    // user's most recent instruction, and it reaches the provider. Before this
    // fix the event-log supersession guard counted the escalated stop as an
    // interrupt landing after the request, so it was dropped silently, leaving
    // a stranded pending placeholder and a user watching a thread that ignored
    // what they just typed.
    //
    // Twice, not once: the first send is this fix's — it passes the narrowed
    // cutoff — and the second is the re-drive that follows the escalated stop's
    // teardown, because that teardown destroys the session the first send
    // landed in. Sparing the request at the barrier is only half the guarantee;
    // the sibling test below owns the other half.
    expect(
      harness.sendTurn.mock.calls.filter(
        (call) => (call[0] as { input?: string }).input === "actually, do this instead",
      ),
    ).toHaveLength(2);

    // And the durable barrier agrees, which the send above cannot show on its
    // own. The two gates are independent and fail on different timescales: the
    // event-log guard decides this process's send, while the barrier is a row
    // that outlives the process and is re-read by any later replay of this same
    // request. A barrier raised at the escalation's own sequence would sit above
    // the replacement, so a crash here would resurrect as a refusal — this
    // request re-reads as `canceled` and is never re-driven — even though the
    // in-memory run had already delivered it.
    //
    // Asked as the request itself, at its own sequence, because that is
    // verbatim the question a replay asks: `acquire` is idempotent for a repeat
    // of the winner, so the only thing that can turn this answer into
    // `canceled` is a barrier standing above it.
    //
    // `superseded`, not `acquired`, and the distinction is the whole point.
    // Both mean "no barrier covers this request" — which is what this
    // assertion tests — but they differ in who holds the claim now, and the
    // holder here is the post-teardown re-drive of the SAME message, pinned by
    // `heldBySequence` below. A `canceled` here would mean the escalation had
    // dated its barrier to itself and buried the replacement; `superseded` by a
    // newer request for the same prompt means the replacement is alive and has
    // simply moved up.
    const redriveSequence = events.find(
      (event) =>
        event.type === "thread.turn-start-requested" &&
        (event.payload as { messageId?: string }).messageId === "user-message-2" &&
        event.sequence > stop!.sequence,
    )?.sequence;
    expect(redriveSequence).toBeDefined();

    const replayed = (await harness.acquireSendClaim({
      threadId: ThreadId.make("thread-1"),
      messageId: asMessageId("user-message-2"),
      requestSequence: replacementSequence!,
      claimedAt: now,
    })) as { _tag: string; heldBySequence?: number };
    expect(replayed._tag).toBe("superseded");
    expect(replayed.heldBySequence).toBe(redriveSequence);
  });

  it("re-drives a spared message after the escalated stop tears down the session it was sent into", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-before-redrive-escalation"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-1"),
        role: "user",
        text: "the turn the user will stop",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();

    // Same interleaving as the test above — the replacement is submitted while
    // the interrupt is mid-retry, so it lands above the interrupt's cutoff and
    // below the escalated stop, and the narrowed cutoff deliberately spares it.
    let dispatchedReplacement = false;
    harness.interruptTurn.mockImplementation((_: unknown) =>
      Effect.promise(async () => {
        if (dispatchedReplacement) {
          return;
        }
        dispatchedReplacement = true;
        await harness.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-spared-by-escalated-stop"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-2"),
            role: "user",
            text: "actually, do this instead",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });
      }).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: ProviderDriverKind.make("codex"),
              method: "session/interrupt",
              detail: "provider socket closed",
            }),
          ),
        ),
      ),
    );

    await harness.dispatch({
      type: "thread.turn.interrupt",
      commandId: CommandId.make("cmd-turn-interrupt-before-redrive"),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
      createdAt: now,
    });

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    // The re-drive is the last thing this chain produces, and it is what the
    // test is about — so wait for it explicitly rather than for the stop, which
    // a regression would also satisfy.
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    await harness.drain();

    const events = await harness.readEventsWithPayloads();
    const stop = events.find((event) => event.type === "thread.session-stop-requested");
    expect(stop).toBeDefined();

    const replacementStarts = events.filter(
      (event) =>
        event.type === "thread.turn-start-requested" &&
        (event.payload as { messageId?: string }).messageId === "user-message-2",
    );

    // The original request, spared by the cutoff, plus the re-drive. The
    // original sits below the stop (that is what "spared" means, and the test
    // above pins it); the re-drive sits above it, which is the only place it can
    // sit and still be driven — the barrier refuses anything at or below the
    // cutoff, and the session it would have run in is gone.
    expect(replacementStarts).toHaveLength(2);
    expect(replacementStarts[0]!.sequence).toBeLessThan(stop!.sequence);
    expect(replacementStarts[1]!.sequence).toBeGreaterThan(stop!.sequence);

    // The user's instruction survives the teardown. Without the re-drive the
    // first send below still happens — it wins the race with the stop on this
    // interleaving — but it is delivered into a session destroyed moments
    // later, so the prompt is lost with no error anywhere. That failure is
    // invisible to a "was it sent?" assertion, which is why this one counts the
    // sends including the one that happens AFTER the teardown.
    const replacementSends = harness.sendTurn.mock.calls.filter(
      (call) => (call[0] as { input?: string }).input === "actually, do this instead",
    );
    expect(replacementSends).toHaveLength(2);

    // Into a fresh session, not the torn-down one: the re-driven start goes
    // through the ordinary turn-start path, which finds the projection
    // `stopped` and starts a new provider session before sending.
    expect(harness.startSession.mock.calls.length).toBeGreaterThanOrEqual(2);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    // And the thread does not read as stopped while that re-driven turn is
    // running in it.
    expect(thread?.session?.status).not.toBe("stopped");
  });

  it("re-drives each spared message on its own model selection, not the thread's last-used one", async () => {
    // TWO spared messages, on two different models, and that is the whole
    // design of this test rather than incidental scope.
    //
    // The re-drive used to read a process-local cache of "whichever model this
    // thread last sent on". With a single spared request that cache is written
    // BY that request's own send, so it holds exactly the right value and a
    // one-message test passes against the defect — verified, not assumed: the
    // one-message version of this test survived the mutation that restores the
    // cache lookup. Two requests on different models is the smallest shape the
    // cache cannot satisfy, because one cache entry cannot be both answers.
    const threadModel = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    };
    const firstSparedModel = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex-mini",
    };
    const secondSparedModel = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex-max",
    };
    const harness = await createHarness({ threadModelSelection: threadModel });
    const now = "2026-01-01T00:00:00.000Z";

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-on-thread-model"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-1"),
        role: "user",
        text: "the turn the user will stop",
        attachments: [],
      },
      modelSelection: threadModel,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();

    let dispatchedReplacements = false;
    harness.interruptTurn.mockImplementation((_: unknown) =>
      Effect.promise(async () => {
        if (dispatchedReplacements) {
          return;
        }
        dispatchedReplacements = true;
        await harness.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-spared-on-first-model"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-2"),
            role: "user",
            text: "actually, do this instead",
            attachments: [],
          },
          modelSelection: firstSparedModel,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });
        await harness.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-spared-on-second-model"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-3"),
            role: "user",
            text: "and then do this too",
            attachments: [],
          },
          modelSelection: secondSparedModel,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });
      }).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: ProviderDriverKind.make("codex"),
              method: "session/interrupt",
              detail: "provider socket closed",
            }),
          ),
        ),
      ),
    );

    await harness.dispatch({
      type: "thread.turn.interrupt",
      commandId: CommandId.make("cmd-turn-interrupt-before-model-redrive"),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
      createdAt: now,
    });

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    await harness.drain();

    const events = await harness.readEventsWithPayloads();
    const stop = events.find((event) => event.type === "thread.session-stop-requested");
    expect(stop).toBeDefined();

    // The re-driven requests, not the originals: the originals sit below the
    // stop (that is what "spared" means) and carry their models because the
    // client sent them. Only the ones ABOVE the stop were synthesized by the
    // reactor, so they are the only ones whose model selection the re-drive is
    // responsible for.
    const redriveModelFor = (messageId: string) =>
      (
        events.find(
          (event) =>
            event.type === "thread.turn-start-requested" &&
            (event.payload as { messageId?: string }).messageId === messageId &&
            event.sequence > stop!.sequence,
        )?.payload as { modelSelection?: ModelSelection } | undefined
      )?.modelSelection;

    // Both re-drives exist and each carries ITS OWN model. A cache can hold
    // only one value, so any single-value source fails at least one of these
    // two assertions whichever value it happens to hold.
    expect(redriveModelFor("user-message-2")).toEqual(firstSparedModel);
    expect(redriveModelFor("user-message-3")).toEqual(secondSparedModel);

    // And they reach the provider on those models. The events alone are not
    // enough: a resume that carried the right selection but sent on a cached
    // one would still lose the user's choice, and the send is what they feel.
    const lastSendModelFor = (text: string) =>
      harness.sendTurn.mock.calls
        .map((call) => call[0] as { input?: string; modelSelection?: ModelSelection })
        .findLast((call) => call.input === text)?.modelSelection;
    expect(lastSendModelFor("actually, do this instead")).toEqual(firstSparedModel);
    expect(lastSendModelFor("and then do this too")).toEqual(secondSparedModel);
  });

  it("re-drives a spared message with its source proposed plan so the plan can still be marked", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    // The plan the spared request implements. It lives on the same thread here
    // only for brevity — the decider requires the source thread to exist and to
    // share a project, and this thread satisfies both.
    await harness.dispatch({
      type: "thread.proposed-plan.upsert",
      commandId: CommandId.make("cmd-proposed-plan-for-redrive"),
      threadId: ThreadId.make("thread-1"),
      proposedPlan: {
        id: "plan-1",
        turnId: null,
        planMarkdown: "1. do the thing",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: now,
        updatedAt: now,
      },
      createdAt: now,
    });

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-before-plan-redrive"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-1"),
        role: "user",
        text: "the turn the user will stop",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();

    let dispatchedReplacement = false;
    harness.interruptTurn.mockImplementation((_: unknown) =>
      Effect.promise(async () => {
        if (dispatchedReplacement) {
          return;
        }
        dispatchedReplacement = true;
        await harness.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-spared-with-plan"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-2"),
            role: "user",
            text: "implement the plan",
            attachments: [],
          },
          sourceProposedPlan: {
            threadId: ThreadId.make("thread-1"),
            planId: "plan-1",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });
      }).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: ProviderDriverKind.make("codex"),
              method: "session/interrupt",
              detail: "provider socket closed",
            }),
          ),
        ),
      ),
    );

    await harness.dispatch({
      type: "thread.turn.interrupt",
      commandId: CommandId.make("cmd-turn-interrupt-before-plan-redrive"),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
      createdAt: now,
    });

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    await harness.drain();

    const events = await harness.readEventsWithPayloads();
    const stop = events.find((event) => event.type === "thread.session-stop-requested");
    expect(stop).toBeDefined();

    const redrive = events.find(
      (event) =>
        event.type === "thread.turn-start-requested" &&
        (event.payload as { messageId?: string }).messageId === "user-message-2" &&
        event.sequence > stop!.sequence,
    );
    expect(redrive).toBeDefined();

    // Losing this is not cosmetic. The plan is marked implemented from exactly
    // this payload field when the turn folds or starts, so a re-drive that
    // drops it leaves the plan open forever with the work already done — and
    // nothing later ever retries, because the re-drive is the last event that
    // could have carried it.
    expect(
      (redrive!.payload as { sourceProposedPlan?: { threadId: string; planId: string } })
        .sourceProposedPlan,
    ).toEqual({ threadId: ThreadId.make("thread-1"), planId: "plan-1" });
  });

  it("re-drives one spared message once, carrying the latest request for it", async () => {
    // Two turn-starts for the SAME message inside the spared window, on
    // different models. Both name the same prompt, so re-driving each would
    // deliver it twice; and the later one exists precisely because it corrects
    // the earlier one, so collapsing to the FIRST would restore a selection the
    // user had already replaced. Different models are what make the two
    // failures distinguishable — a first-wins collapse and a latest-wins
    // collapse both produce exactly one re-drive.
    const firstModel = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    };
    const latestModel = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex-mini",
    };
    const harness = await createHarness({ threadModelSelection: firstModel });
    const now = "2026-01-01T00:00:00.000Z";

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-before-dedupe-redrive"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-1"),
        role: "user",
        text: "the turn the user will stop",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();

    let dispatchedReplacements = false;
    harness.interruptTurn.mockImplementation((_: unknown) =>
      Effect.promise(async () => {
        if (dispatchedReplacements) {
          return;
        }
        dispatchedReplacements = true;
        // Both land inside the interrupt's retry window, so both sit above the
        // narrowed cutoff and below the escalated stop — the exact window the
        // re-drive scans.
        await harness.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-spared-first"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-2"),
            role: "user",
            text: "actually, do this instead",
            attachments: [],
          },
          modelSelection: firstModel,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });
        // A re-issue of the SAME message — the auto-resume shape — dispatched
        // through the internal resume command so it produces a second
        // `thread.turn-start-requested` for `user-message-2` without a second
        // `thread.message-sent`.
        await harness.dispatch({
          type: "thread.turn.resume",
          commandId: CommandId.make("cmd-turn-resume-spared-latest"),
          threadId: ThreadId.make("thread-1"),
          messageId: asMessageId("user-message-2"),
          modelSelection: latestModel,
          reason: "test re-issue inside the spared window",
          createdAt: now,
        });
      }).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: ProviderDriverKind.make("codex"),
              method: "session/interrupt",
              detail: "provider socket closed",
            }),
          ),
        ),
      ),
    );

    await harness.dispatch({
      type: "thread.turn.interrupt",
      commandId: CommandId.make("cmd-turn-interrupt-before-dedupe-redrive"),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
      createdAt: now,
    });

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    await harness.drain();

    const events = await harness.readEventsWithPayloads();
    const stop = events.find((event) => event.type === "thread.session-stop-requested");
    expect(stop).toBeDefined();

    const sparedStarts = events.filter(
      (event) =>
        event.type === "thread.turn-start-requested" &&
        (event.payload as { messageId?: string }).messageId === "user-message-2" &&
        event.sequence < stop!.sequence,
    );
    // The premise, pinned rather than assumed: if only one request landed in
    // the window there is nothing to deduplicate and the rest proves nothing.
    expect(sparedStarts).toHaveLength(2);

    const redrives = events.filter(
      (event) =>
        event.type === "thread.turn-start-requested" &&
        (event.payload as { messageId?: string }).messageId === "user-message-2" &&
        event.sequence > stop!.sequence,
    );
    // Once, not twice — the same prompt delivered a second time is the failure
    // the collapse exists to prevent.
    expect(redrives).toHaveLength(1);
    // And on the LATEST request's model. A first-wins collapse also produces
    // exactly one re-drive, so this assertion is the only thing separating the
    // two.
    expect((redrives[0]!.payload as { modelSelection?: ModelSelection }).modelSelection).toEqual(
      latestModel,
    );
  });

  it("reports on the thread when the spared turn-starts cannot be read", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-before-unreadable-redrive"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-1"),
        role: "user",
        text: "the turn the user will stop",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();

    // Spied on the resolved service instance, as with the barrier-write test
    // above: a read that fails is not a state any external caller can produce,
    // and layer memoization makes this the same object the reactor holds.
    //
    // Counted INSIDE the effect rather than in the mock body, because the
    // reactor builds the read once and retries that value — a counter in the
    // body would record one call however many times the effect ran, and the
    // retry count is half of what this test checks.
    const readAttempts: Array<number> = [];
    const readSpy = vi
      .spyOn(harness.eventStore, "listThreadTurnStartsAboveCutoff")
      .mockImplementation(
        (input: Parameters<typeof harness.eventStore.listThreadTurnStartsAboveCutoff>[0]) =>
          Effect.suspend(() => {
            readAttempts.push(input.stopSequence);
            return Effect.fail(
              new PersistenceSqlError({
                operation: "listThreadTurnStartsAboveCutoff",
                detail: "spared turn-start read failed",
              }),
            );
          }),
      );

    let dispatchedReplacement = false;
    harness.interruptTurn.mockImplementation((_: unknown) =>
      Effect.promise(async () => {
        if (dispatchedReplacement) {
          return;
        }
        dispatchedReplacement = true;
        await harness.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-spared-but-unreadable"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-2"),
            role: "user",
            text: "actually, do this instead",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });
      }).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: ProviderDriverKind.make("codex"),
              method: "session/interrupt",
              detail: "provider socket closed",
            }),
          ),
        ),
      ),
    );

    await harness.dispatch({
      type: "thread.turn.interrupt",
      commandId: CommandId.make("cmd-turn-interrupt-before-unreadable-redrive"),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
      createdAt: now,
    });

    // Waited on rather than drained, for the same reason the barrier test
    // waits: the retries sleep on the real clock, so restoring the spy after a
    // drain that returned mid-backoff would let the remaining attempts hit the
    // real (working) store and quietly turn this into a test of the success
    // path.
    await waitFor(async () => {
      const model = await harness.readModel();
      return (
        model.threads
          .find((entry) => entry.id === ThreadId.make("thread-1"))
          ?.activities.some(
            (activity) =>
              activity.kind === "provider.session.stop.failed" &&
              activity.summary === "Messages sent while stopping may not have been recovered",
          ) === true
      );
    });
    await harness.drain();
    readSpy.mockRestore();

    // Three attempts: the initial one plus `times: 2`. Fewer means the retry is
    // not wired; more means it is unbounded.
    expect(readAttempts).toHaveLength(3);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    const activity = thread?.activities.find(
      (entry) =>
        entry.kind === "provider.session.stop.failed" &&
        entry.summary === "Messages sent while stopping may not have been recovered",
    );
    // Reported as an error, not a note: the user's prompt is gone and only they
    // can re-send it, so the thread has to say so rather than leave the failure
    // in a server log they will never read.
    expect(activity?.tone).toBe("error");

    // And the stop itself still stands. Failing the stop over an unreadable
    // re-drive would report a stop that did happen as failed, which is a
    // different lie than the one this fix removes.
    expect(harness.stopSession).toHaveBeenCalled();
  });

  it("reports on the thread when a spared turn-start cannot be re-driven", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-before-failed-redrive"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-1"),
        role: "user",
        text: "the turn the user will stop",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();

    // The read succeeds and finds the spared request; the DISPATCH of its
    // re-drive is what fails. That is the other half of the finding, and it
    // fails differently: the read failure loses every spared prompt at once,
    // this one loses a specific named message.
    //
    // Failed by command id rather than by type so only the re-drive is
    // affected — failing every `thread.turn.resume` would also break unrelated
    // machinery, and failing the projection write would take down the stop.
    const engineDispatch = harness.engine.dispatch.bind(harness.engine);
    const dispatchSpy = vi
      .spyOn(harness.engine, "dispatch")
      .mockImplementation((command: Parameters<typeof harness.engine.dispatch>[0]) =>
        command.type === "thread.turn.resume" &&
        command.commandId.includes("escalated-stop-redrive")
          ? Effect.fail(
              new PersistenceSqlError({
                operation: "dispatch",
                detail: "re-drive dispatch failed",
              }) as never,
            )
          : engineDispatch(command),
      );

    let dispatchedReplacement = false;
    harness.interruptTurn.mockImplementation((_: unknown) =>
      Effect.promise(async () => {
        if (dispatchedReplacement) {
          return;
        }
        dispatchedReplacement = true;
        await harness.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-spared-but-undrivable"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-2"),
            role: "user",
            text: "actually, do this instead",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });
      }).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: ProviderDriverKind.make("codex"),
              method: "session/interrupt",
              detail: "provider socket closed",
            }),
          ),
        ),
      ),
    );

    await harness.dispatch({
      type: "thread.turn.interrupt",
      commandId: CommandId.make("cmd-turn-interrupt-before-failed-redrive"),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
      createdAt: now,
    });

    await waitFor(async () => {
      const model = await harness.readModel();
      return (
        model.threads
          .find((entry) => entry.id === ThreadId.make("thread-1"))
          ?.activities.some(
            (activity) =>
              activity.kind === "provider.session.stop.failed" &&
              activity.summary === "A message sent while stopping was not recovered",
          ) === true
      );
    });
    await harness.drain();
    dispatchSpy.mockRestore();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    const activity = thread?.activities.find(
      (entry) =>
        entry.kind === "provider.session.stop.failed" &&
        entry.summary === "A message sent while stopping was not recovered",
    );
    expect(activity?.tone).toBe("error");
    // Names the prompt as unrecoverable-by-anything-but-the-user, which is the
    // only actionable thing left to say about it.
    expect((activity?.payload as { detail?: string })?.detail).toContain(
      "must be re-sent manually",
    );

    // The re-drive genuinely did not happen — no `thread.turn-start-requested`
    // for the spared message above the stop. Without this the activity could be
    // reporting a failure that a later retry silently fixed, and the test would
    // pass on a code path that never lost anything.
    const events = await harness.readEvents();
    const stop = events.find((event) => event.type === "thread.session-stop-requested");
    expect(stop).toBeDefined();
    const eventsWithPayloads = await harness.readEventsWithPayloads();
    expect(
      eventsWithPayloads.filter(
        (event) =>
          event.type === "thread.turn-start-requested" &&
          (event.payload as { messageId?: string }).messageId === "user-message-2" &&
          event.sequence > stop!.sequence,
      ),
    ).toHaveLength(0);
  });

  it("reports a re-drive that failed an invariant it did not merely no-op on", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-before-invariant-redrive"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-1"),
        role: "user",
        text: "the turn the user will stop",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();

    // `OrchestrationCommandInvariantError` is raised for two very different
    // things. One is benign — the decider produced no events because the message
    // is gone — and must stay a quiet no-op. The other is a genuine failure that
    // happens to share the tag: the engine wraps a failed event-id generation in
    // it, and the decider raises it for a source plan that no longer resolves.
    // Catching the tag wholesale silently drops the prompt on those, which is
    // exactly the lost-prompt behaviour the re-drive exists to prevent, so this
    // failure carries the genuine shape: a different `detail`, and a `cause`,
    // neither of which the empty-decision invariant ever has.
    const engineDispatch = harness.engine.dispatch.bind(harness.engine);
    const dispatchSpy = vi
      .spyOn(harness.engine, "dispatch")
      .mockImplementation((command: Parameters<typeof harness.engine.dispatch>[0]) =>
        command.type === "thread.turn.resume" &&
        command.commandId.includes("escalated-stop-redrive")
          ? Effect.fail(
              new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "Failed to generate an event identifier.",
                cause: new Error("crypto unavailable"),
              }) as never,
            )
          : engineDispatch(command),
      );

    let dispatchedReplacement = false;
    harness.interruptTurn.mockImplementation((_: unknown) =>
      Effect.promise(async () => {
        if (dispatchedReplacement) {
          return;
        }
        dispatchedReplacement = true;
        await harness.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-spared-invariant"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-2"),
            role: "user",
            text: "actually, do this instead",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });
      }).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: ProviderDriverKind.make("codex"),
              method: "session/interrupt",
              detail: "provider socket closed",
            }),
          ),
        ),
      ),
    );

    await harness.dispatch({
      type: "thread.turn.interrupt",
      commandId: CommandId.make("cmd-turn-interrupt-before-invariant-redrive"),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
      createdAt: now,
    });

    await waitFor(async () => {
      const model = await harness.readModel();
      return (
        model.threads
          .find((entry) => entry.id === ThreadId.make("thread-1"))
          ?.activities.some(
            (activity) =>
              activity.kind === "provider.session.stop.failed" &&
              activity.summary === "A message sent while stopping was not recovered",
          ) === true
      );
    });
    await harness.drain();
    dispatchSpy.mockRestore();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    const activity = thread?.activities.find(
      (entry) =>
        entry.kind === "provider.session.stop.failed" &&
        entry.summary === "A message sent while stopping was not recovered",
    );
    expect(activity?.tone).toBe("error");

    // And the prompt really is gone, so the activity is not describing a loss
    // that something else quietly repaired.
    const events = await harness.readEvents();
    const stop = events.find((event) => event.type === "thread.session-stop-requested");
    expect(stop).toBeDefined();
    const eventsWithPayloads = await harness.readEventsWithPayloads();
    expect(
      eventsWithPayloads.filter(
        (event) =>
          event.type === "thread.turn-start-requested" &&
          (event.payload as { messageId?: string }).messageId === "user-message-2" &&
          event.sequence > stop!.sequence,
      ),
    ).toHaveLength(0);
  });

  it("stays quiet when a re-drive finds nothing left to resume", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-before-noop-redrive"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-1"),
        role: "user",
        text: "the turn the user will stop",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();

    // The other side of the same discrimination, and the reason it cannot just
    // report everything: the empty decision is the NORMAL outcome when the
    // message is gone. Reporting it would put a red "was not recovered" activity
    // on a thread where nothing was lost, every time. Same tag as the test
    // above, benign detail, no cause.
    const engineDispatch = harness.engine.dispatch.bind(harness.engine);
    const dispatchSpy = vi
      .spyOn(harness.engine, "dispatch")
      .mockImplementation((command: Parameters<typeof harness.engine.dispatch>[0]) =>
        command.type === "thread.turn.resume" &&
        command.commandId.includes("escalated-stop-redrive")
          ? Effect.fail(
              new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: COMMAND_PRODUCED_NO_EVENTS_DETAIL,
              }) as never,
            )
          : engineDispatch(command),
      );

    let dispatchedReplacement = false;
    harness.interruptTurn.mockImplementation((_: unknown) =>
      Effect.promise(async () => {
        if (dispatchedReplacement) {
          return;
        }
        dispatchedReplacement = true;
        await harness.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-spared-noop"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-2"),
            role: "user",
            text: "actually, do this instead",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });
      }).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: ProviderDriverKind.make("codex"),
              method: "session/interrupt",
              detail: "provider socket closed",
            }),
          ),
        ),
      ),
    );

    await harness.dispatch({
      type: "thread.turn.interrupt",
      commandId: CommandId.make("cmd-turn-interrupt-before-noop-redrive"),
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
      createdAt: now,
    });

    // The stop still completes, which is what tells us the re-drive was reached
    // and returned rather than that the assertion below raced ahead of it.
    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    await harness.drain();
    dispatchSpy.mockRestore();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.filter(
        (entry) =>
          entry.kind === "provider.session.stop.failed" &&
          entry.summary === "A message sent while stopping was not recovered",
      ),
    ).toHaveLength(0);
  });

  it("starts a fresh session when only projected session state exists", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stale"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-stale"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-stale"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });
  });

  it("rejects active runtime sessions that are missing provider instance ids", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-instance"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    harness.runtimeSessions.push({
      provider: ProviderDriverKind.make("codex"),
      status: "ready",
      runtimeMode: "approval-required",
      threadId: ThreadId.make("thread-1"),
      cwd: "/tmp/provider-project",
      resumeCursor: { opaque: "resume-without-instance" },
      createdAt: now,
      updatedAt: now,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-missing-instance"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-missing-instance"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("without a provider instance id"),
      },
    });
  });

  it("reacts to thread.approval.respond by forwarding provider approval response", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-approval"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "accept",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToRequest.mock.calls.length === 1);
    expect(harness.respondToRequest.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "approval-request-1",
      decision: "accept",
    });
  });

  it("reacts to thread.user-input.respond by forwarding structured user input answers", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-user-input"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("cmd-user-input-respond"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToUserInput.mock.calls.length === 1);
    expect(harness.respondToUserInput.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "user-input-request-1",
      answers: {
        sandbox_mode: "workspace-write",
      },
    });
  });

  it("surfaces stale provider approval request failures without faking approval resolution", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.respondToRequest.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "session/request_permission",
          detail: "Unknown pending permission request: approval-request-1",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-approval-error"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-approval-requested"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-approval-requested"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: {
            requestId: "approval-request-1",
            requestKind: "command",
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond-stale"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "acceptForSession",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.approval.respond.failed",
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.approval.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "approval-request-1",
      detail: expect.stringContaining("Stale pending approval request: approval-request-1"),
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "approval.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "approval-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it("surfaces non-resumable provider user-input callbacks as stale failures", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.respondToUserInput.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("claudeAgent"),
          method: "item/tool/respondToUserInput",
          detail: "Unknown pending Codex user input request: user-input-request-1",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-user-input-error"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-user-input-requested"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-user-input-requested"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "user-input-request-1",
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "workspace-write",
                    description: "Allow workspace writes only",
                  },
                ],
              },
            ],
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("cmd-user-input-respond-stale"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.user-input.respond.failed",
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.user-input.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "user-input-request-1",
      detail: expect.stringContaining("Stale pending user-input request: user-input-request-1"),
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "user-input.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "user-input-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it("reacts to thread.session.stop by stopping provider session and clearing thread session state", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-stop"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex_work"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-session-stop"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session).not.toBeNull();
    expect(thread?.session?.status).toBe("stopped");
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
    expect(thread?.session?.activeTurnId).toBeNull();
  });

  it("re-drives a resumed message whose original turn-start already reached the provider", async () => {
    const harness = await createHarness();
    const originalCreatedAt = "2026-01-01T00:00:00.000Z";
    const resumeCreatedAt = "2026-01-01T00:00:05.000Z";

    // Session-exit auto-resume re-issues the SAME user message at a higher
    // sequence, and that re-issue MUST reach the provider — it is the recovery
    // this whole path exists to perform. The durable send-claim is keyed by
    // message, so it sees the original and the resume as contenders for one
    // row; if it resolved them first-wins, the stale original would hold the
    // claim forever and auto-resume would be silently dead while every
    // supersession test still passed. This is the control in that direction:
    // last-wins by request sequence, so the newer request takes the claim.
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-original"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-1"),
        role: "user",
        text: "resume me",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: originalCreatedAt,
    });
    // The original genuinely reaches the provider and claims the message before
    // the resume is issued — the ordering that makes the claim contended.
    await waitFor(() =>
      harness.sendTurn.mock.calls.some(
        (call) => (call[0] as { input?: string }).input === "resume me",
      ),
    );

    await harness.dispatch({
      type: "thread.turn.resume",
      commandId: CommandId.make("cmd-turn-resume"),
      threadId: ThreadId.make("thread-1"),
      messageId: asMessageId("user-message-1"),
      createdAt: resumeCreatedAt,
    });

    await waitFor(
      () =>
        harness.sendTurn.mock.calls.filter(
          (call) => (call[0] as { input?: string }).input === "resume me",
        ).length === 2,
    );

    const drives = harness.sendTurn.mock.calls.filter(
      (call) => (call[0] as { input?: string }).input === "resume me",
    );
    // Twice: once for the original, once for the resume recovering it. Nothing
    // superseded the resume and nothing canceled it, so refusing it would be a
    // lost turn, not a saved duplicate.
    expect(drives.length).toBe(2);
  });

  it("interrupts a turn the user stopped while the send was in flight", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";

    // The sibling test above drives the barrier to its post-condition because
    // the pre-send interleaving cannot be scheduled from outside. This one CAN
    // schedule the remaining window, because it lives inside `sendTurn` itself:
    // the mock raises the barrier while the send is in flight, which is exactly
    // a user hitting stop after the claim was granted and before the provider
    // has a turn to interrupt.
    //
    // No amount of database atomicity closes this window — `sendTurn` is an RPC
    // to another process and no write spans it — so the claim CANNOT prevent
    // this send, and the reactor must instead notice afterwards and stop what it
    // started. Asserting `interruptTurn` fired is asserting the user's stop was
    // ultimately honored rather than swallowed by a race.
    harness.sendTurn.mockImplementationOnce((_: unknown) =>
      Effect.promise(async () => {
        await harness.cancelSendClaims({
          threadId: ThreadId.make("thread-1"),
          canceledThroughSequence: 1_000_000,
          updatedAt: createdAt,
        });
        return {
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-1"),
        };
      }),
    );

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-stopped-mid-send"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-1"),
        role: "user",
        text: "stop me mid-flight",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt,
    });

    // The send does happen — that is the premise, not a failure.
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    // And the turn it started is then stopped.
    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);

    // Addressed to the turn this send started, not merely to the thread. The
    // fence runs asynchronously with respect to the rest of the thread, so by
    // the time it fires the session may be running a LATER turn; a
    // thread-scoped interrupt would then stop whichever turn happens to be
    // current instead of the one that was stopped.
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
    });
  });

  it("tells the user when a stop landed during the send and could not be delivered", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";

    // The fence cannot unsend an RPC that already landed, so when the interrupt
    // it issues also fails there is no way to honor the stop. What it can do —
    // and what failing open silently did NOT do — is say so. A user who pressed
    // stop and watched the turn continue is owed the same interrupt-failure
    // activity every other unfulfillable stop produces; without it the UI shows
    // a turn quietly ignoring them, which is indistinguishable from a bug in
    // the button.
    harness.sendTurn.mockImplementationOnce((_: unknown) =>
      Effect.promise(async () => {
        await harness.cancelSendClaims({
          threadId: ThreadId.make("thread-1"),
          canceledThroughSequence: 1_000_000,
          updatedAt: createdAt,
        });
        return {
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-1"),
        };
      }),
    );
    // Fails every attempt, so the retry is exhausted rather than rescuing it.
    harness.interruptTurn.mockImplementation((_: unknown) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "session/interrupt",
          detail: "provider socket closed",
        }),
      ),
    );

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-interrupt-undeliverable"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-1"),
        role: "user",
        text: "stop me and fail the stop",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt,
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.interrupt.failed") ??
        false
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.interrupt.failed"),
    ).toMatchObject({
      turnId: asTurnId("turn-1"),
      payload: {
        detail: expect.stringContaining("provider socket closed"),
      },
    });
    // Retried once before giving up: a transient failure is the likeliest kind
    // and a duplicate interrupt costs nothing, so one retry is worth having and
    // its absence would be a silently weaker guarantee.
    expect(harness.interruptTurn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("escalates to a session stop when the fence's interrupt will not land", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";

    // Reporting an unstoppable turn is the last resort, not the first. Before
    // it, there is a strictly stronger tool available: the session the turn is
    // running in. The barrier that put the fence on this branch already covers
    // everything queued behind the send, so nothing in this session is still
    // wanted — killing it honors the stop that the interrupt could not.
    //
    // Without this the user's only recourse is a turn that visibly ignores
    // stop, which is indistinguishable from a broken button.
    harness.sendTurn.mockImplementationOnce((_: unknown) =>
      Effect.promise(async () => {
        await harness.cancelSendClaims({
          threadId: ThreadId.make("thread-1"),
          canceledThroughSequence: 1_000_000,
          updatedAt: createdAt,
        });
        return {
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-1"),
        };
      }),
    );
    harness.interruptTurn.mockImplementation((_: unknown) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "session/interrupt",
          detail: "provider socket closed",
        }),
      ),
    );

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-interrupt-escalates"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-1"),
        role: "user",
        text: "stop me, and fail the stop",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt,
    });

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    await harness.drain();

    expect(harness.stopSession.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });

    // Escalated through the ordinary stop intent, not by calling the provider
    // behind the projection's back. The event is what makes the session read as
    // stopped in the UI and what raises the barrier; a direct provider call
    // would kill the runtime while the thread still showed a live session.
    const events = await harness.readEvents();
    expect(events.filter((event) => event.type === "thread.session-stop-requested")).toHaveLength(
      1,
    );

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.status).toBe("stopped");

    // And still reported. Losing the whole session is not a silent success —
    // the user asked to stop one turn and got something blunter.
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.interrupt.failed"),
    ).toMatchObject({
      turnId: asTurnId("turn-1"),
      payload: { detail: expect.stringContaining("provider socket closed") },
    });
  });

  it("falls back to the event log when the fence cannot read its send claim", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";

    // An unreadable claim is "we do not know", not "no stop" — and only one of
    // those two answers leaves a turn the user killed still running. The claim
    // table and the event log are separate stores, so an outage of one is no
    // reason to stop asking; the log records the interrupt independently.
    //
    // Failing EVERY attempt is what makes this a test of the fallback rather
    // than of the retry: a single rejection would be absorbed upstream.
    const originalAcquire = harness.sendClaims.acquire;
    const acquireAttempts: Array<number> = [];
    const acquireSpy = vi
      .spyOn(harness.sendClaims, "acquire")
      .mockImplementation((input: Parameters<typeof harness.sendClaims.acquire>[0]) =>
        // Counted inside the effect: the reactor builds the acquire effect once
        // and retries that value, so a counter in the mock body would record
        // one call however many times it ran.
        Effect.suspend(() => {
          // The PRE-send acquire is left working. It is a different question at
          // a different moment — "may I send at all", asked before any stop
          // exists — and breaking it would stop the send from happening, which
          // is the premise this test needs rather than the behavior it checks.
          // Only the post-send fence read is broken.
          if (acquireAttempts.length === 0 && harness.sendTurn.mock.calls.length === 0) {
            acquireAttempts.push(-1);
            return originalAcquire(input);
          }
          acquireAttempts.push(input.requestSequence);
          return Effect.fail(
            new PersistenceSqlError({ operation: "acquire", detail: "claim read failed" }),
          );
        }),
      );

    // The stop lands in the EVENT LOG while the send is in flight, and nowhere
    // else — no barrier is raised through the repository, because the whole
    // point is that the repository is the thing that is broken.
    harness.sendTurn.mockImplementationOnce((_: unknown) =>
      Effect.promise(async () => {
        await harness.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make("cmd-interrupt-during-unreadable-claim"),
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-1"),
          createdAt,
        });
        return {
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-1"),
        };
      }),
    );

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-unreadable-claim"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-1"),
        role: "user",
        text: "stop me while the claim table is down",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt,
    });

    // The fence's interrupt, addressed to the turn this send started. The
    // separate interrupt-handler call is thread-scoped and carries no turnId,
    // so this is the fence's and not a coincidence of the stop itself.
    await waitFor(() =>
      harness.interruptTurn.mock.calls.some(
        (call) => (call[0] as { turnId?: string }).turnId === asTurnId("turn-1"),
      ),
    );
    await harness.drain();
    acquireSpy.mockRestore();

    // Four entries: the pre-send acquire that was allowed through, then the
    // fence's three — the initial one plus `times: 2`. Fewer means the retry is
    // not wired; more means it is unbounded.
    expect(acquireAttempts.filter((entry) => entry >= 0)).toHaveLength(3);
  });

  it("does not manufacture an interrupt when the unreadable-claim fallback finds no stop", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const originalAcquire = harness.sendClaims.acquire;
    const acquireAttempts: Array<number> = [];
    let markFallbackRead!: () => void;
    const fallbackRead = new Promise<void>((resolve) => {
      markFallbackRead = resolve;
    });

    const acquireSpy = vi
      .spyOn(harness.sendClaims, "acquire")
      .mockImplementation((input: Parameters<typeof harness.sendClaims.acquire>[0]) =>
        Effect.suspend(() => {
          if (acquireAttempts.length === 0 && harness.sendTurn.mock.calls.length === 0) {
            acquireAttempts.push(-1);
            return originalAcquire(input);
          }
          acquireAttempts.push(input.requestSequence);
          return Effect.fail(
            new PersistenceSqlError({ operation: "acquire", detail: "claim read failed" }),
          );
        }),
      );
    const originalClaimRead = harness.eventStore.getThreadTurnStartClaim;
    const claimReadSpy = vi
      .spyOn(harness.eventStore, "getThreadTurnStartClaim")
      .mockImplementation((input: Parameters<typeof originalClaimRead>[0]) =>
        originalClaimRead(input).pipe(
          Effect.tap(() =>
            harness.sendTurn.mock.calls.length > 0 &&
            acquireAttempts.filter((entry) => entry >= 0).length === 3
              ? Effect.sync(markFallbackRead)
              : Effect.void,
          ),
        ),
      );

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-unreadable-claim-no-stop"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-1"),
        role: "user",
        text: "leave me running when ownership is unknown",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt,
    });
    await fallbackRead;
    acquireSpy.mockRestore();
    claimReadSpy.mockRestore();

    // The sentinel is processed after the fallback read has returned. It gives
    // the old fence's immediate continuation a scheduling turn, so zero
    // interrupts means the synthetic owner-less `superseded` outcome really was
    // a no-op rather than merely not having run yet.
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-unreadable-claim-no-stop-sentinel"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-2"),
        role: "user",
        text: "unreadable claim sentinel",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    await waitFor(() =>
      harness.sendTurn.mock.calls.some(
        (call) => (call[0] as { input?: string }).input === "unreadable claim sentinel",
      ),
    );
    await harness.drain();

    expect(acquireAttempts.filter((entry) => entry >= 0)).toHaveLength(3);
    expect(harness.interruptTurn.mock.calls).toHaveLength(0);
  });

  // --- Steered sends (folds) ----------------------------------------------
  //
  // Claude/Cursor/Grok/OpenCode fold a send that arrives mid-turn into the
  // running turn and deliberately emit NO `turn.started` for it, because a
  // steer is not a turn boundary. Nothing downstream therefore consumes the
  // `thread.turn-start-requested` placeholder that send answered, and a
  // surviving placeholder is read everywhere else as "requested but never
  // started". The adapter is the only party that knows a fold happened, so it
  // reports `steered` and the reactor consumes the placeholder explicitly.

  const foldedEvents = (events: ReadonlyArray<{ type: string; payload: unknown }>) =>
    events.filter((event) => event.type === "thread.turn-start-folded");

  it("folds the pending turn-start when the provider steered an already-running turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.sendTurn.mockImplementationOnce((_: unknown) =>
      Effect.succeed({
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-running"),
        steered: true,
      }),
    );

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-steered"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-steer"),
        role: "user",
        text: "actually, also do this",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await waitFor(async () => foldedEvents(await harness.readEventsWithPayloads()).length === 1);
    await harness.drain();

    const events = await harness.readEventsWithPayloads();
    const requested = events.filter((event) => event.type === "thread.turn-start-requested");
    expect(requested).toHaveLength(1);

    // Read the durable sequence rather than assert a literal: the projector
    // deletes the placeholder keyed on exactly this value, so a fold carrying
    // anything else consumes nothing and leaves the defect in place.
    const folded = foldedEvents(events);
    expect(folded).toHaveLength(1);
    expect(folded[0]?.payload).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      turnRequestSequence: requested[0]?.sequence,
      // The turn the message was folded into, not a new one — a steer has no
      // turn id of its own.
      turnId: asTurnId("turn-running"),
    });
  });

  it("does not fold a send that opened a real turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    // The control. The default `sendTurn` mock reports no `steered` flag, which
    // is the ordinary turn-boundary case: `turn.started` will arrive and consume
    // the placeholder itself. Folding here would delete a placeholder that a
    // real start still needs, so the fold must be conditional on the adapter's
    // report rather than issued for every send.
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-unsteered"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-fresh"),
        role: "user",
        text: "start a fresh turn",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();

    expect(foldedEvents(await harness.readEventsWithPayloads())).toHaveLength(0);
  });

  it("records the fold even when a stop lands during the steered send", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";

    // Ordering, not merely presence. The fold records a fact that is already
    // true — the provider has the message — and the fence that runs after it can
    // interrupt, which does not make it any less true. Recording the fold only
    // after a clear fence would strand the placeholder on exactly the paths
    // (stop mid-send, interrupt failure) where reading it as "never sent" does
    // the most damage: recovery would re-issue a prompt the provider already
    // received and acted on.
    harness.sendTurn.mockImplementationOnce((_: unknown) =>
      Effect.promise(async () => {
        await harness.cancelSendClaims({
          threadId: ThreadId.make("thread-1"),
          canceledThroughSequence: 1_000_000,
          updatedAt: createdAt,
        });
        return {
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-running"),
          steered: true,
        };
      }),
    );

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-steer-stopped-mid-send"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-steer-stopped"),
        role: "user",
        text: "steer me, then stop me",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt,
    });

    // The fence still fires — the user's stop is honored, which is the sibling
    // behavior this must not regress.
    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    await harness.drain();

    const events = await harness.readEventsWithPayloads();
    const requested = events.find((event) => event.type === "thread.turn-start-requested");
    const folded = foldedEvents(events);
    expect(folded).toHaveLength(1);
    expect(folded[0]?.payload).toMatchObject({
      turnRequestSequence: requested?.sequence,
      turnId: asTurnId("turn-running"),
    });
  });

  /**
   * Seed a proposed plan on a second thread and return its id.
   *
   * "Implement this plan" sends carry a reference to a plan that lives on
   * ANOTHER thread, so a test for that path needs both threads and a real plan
   * row — the decider rejects a `sourceProposedPlan` naming a plan that does
   * not exist, so a fabricated id would fail the dispatch instead of exercising
   * the bookkeeping.
   */
  const seedSourceProposedPlan = async (
    harness: Awaited<ReturnType<typeof createHarness>>,
    input: {
      readonly sourceThreadId: ThreadId;
      readonly planId: string;
      readonly createdAt: string;
    },
  ) => {
    await harness.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-thread-create-${input.sourceThreadId}`),
      threadId: input.sourceThreadId,
      projectId: asProjectId("project-1"),
      title: "Planning Thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: input.createdAt,
    });
    await harness.dispatch({
      type: "thread.proposed-plan.upsert",
      commandId: CommandId.make(`cmd-plan-upsert-${input.planId}`),
      threadId: input.sourceThreadId,
      proposedPlan: {
        id: input.planId,
        turnId: null,
        planMarkdown: "# Source plan",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
    return input.planId;
  };

  const readSourcePlan = async (
    harness: Awaited<ReturnType<typeof createHarness>>,
    input: { readonly sourceThreadId: ThreadId; readonly planId: string },
  ) => {
    const readModel = await harness.readModel();
    return readModel.threads
      .find((entry) => entry.id === input.sourceThreadId)
      ?.proposedPlans.find((entry) => entry.id === input.planId);
  };

  it("marks the source plan implemented when a plan-backed send is steered", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const sourceThreadId = ThreadId.make("thread-plan-source");
    const planId = await seedSourceProposedPlan(harness, {
      sourceThreadId,
      planId: "plan:thread-plan-source:turn:plan-1",
      createdAt,
    });

    // Ingestion marks a plan implemented off `turn.started`. A steer emits no
    // such event BY DESIGN — it is not a turn boundary — so on this path the
    // plan reference the request carried has exactly one chance to be acted on
    // before the fold deletes the row holding it. Missing it leaves a plan the
    // provider has already been asked to implement showing as unimplemented
    // forever, with no later event able to correct it.
    harness.sendTurn.mockImplementationOnce((_: unknown) =>
      Effect.succeed({
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-running"),
        steered: true,
      }),
    );

    expect((await readSourcePlan(harness, { sourceThreadId, planId }))?.implementedAt).toBeNull();

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-steered-plan"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-steer-plan"),
        role: "user",
        text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
        attachments: [],
      },
      sourceProposedPlan: { threadId: sourceThreadId, planId },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt,
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await waitFor(async () => foldedEvents(await harness.readEventsWithPayloads()).length === 1);
    await waitFor(
      async () =>
        (await readSourcePlan(harness, { sourceThreadId, planId }))?.implementedAt !== null,
    );
    await harness.drain();

    const sourcePlan = await readSourcePlan(harness, { sourceThreadId, planId });
    expect(sourcePlan?.implementedAt).toBe(createdAt);
    // The thread doing the work, not the thread that proposed it — this is the
    // link the UI follows from a plan to its implementation.
    expect(sourcePlan?.implementationThreadId).toBe(ThreadId.make("thread-1"));
  });

  it("does not touch a source plan another turn already marked implemented", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const alreadyImplementedAt = "2025-12-31T00:00:00.000Z";
    const sourceThreadId = ThreadId.make("thread-plan-source-taken");
    const planId = await seedSourceProposedPlan(harness, {
      sourceThreadId,
      planId: "plan:thread-plan-source-taken:turn:plan-1",
      createdAt,
    });

    // A `turn.started` racing this fold can mark the same plan first, and
    // whichever loses must not restamp it: doing so would repoint the plan at a
    // second implementation thread and rewrite the timestamp, silently
    // rewriting history the user can see. Idempotence here is the same
    // `implementedAt !== null` guard ingestion uses, checked on this path too.
    await harness.dispatch({
      type: "thread.proposed-plan.upsert",
      commandId: CommandId.make("cmd-plan-already-implemented"),
      threadId: sourceThreadId,
      proposedPlan: {
        id: planId,
        turnId: null,
        planMarkdown: "# Source plan",
        implementedAt: alreadyImplementedAt,
        implementationThreadId: ThreadId.make("thread-2"),
        createdAt,
        updatedAt: alreadyImplementedAt,
      },
      createdAt: alreadyImplementedAt,
    });

    // Cancel the claim from inside `sendTurn` so the fence interrupts. That is
    // not the behavior under test — it is the happens-after barrier. The fence
    // runs strictly downstream of the plan-marking step, so an observed
    // interrupt proves the plan-marking step has already run (or declined to),
    // which "drain, then look" alone does not: a mark landing a moment later
    // would sail past the assertion and make this test vacuous.
    harness.sendTurn.mockImplementationOnce((_: unknown) =>
      Effect.promise(async () => {
        await harness.cancelSendClaims({
          threadId: ThreadId.make("thread-1"),
          canceledThroughSequence: 1_000_000,
          updatedAt: createdAt,
        });
        return {
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-running"),
          steered: true,
        };
      }),
    );

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-steered-plan-taken"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-steer-plan-taken"),
        role: "user",
        text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
        attachments: [],
      },
      sourceProposedPlan: { threadId: sourceThreadId, planId },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt,
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await waitFor(async () => foldedEvents(await harness.readEventsWithPayloads()).length === 1);
    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    await harness.drain();

    // Nothing was written at all — not "written with the same values". A
    // conditional that re-upserts identical-looking data would still repoint
    // `updatedAt` and re-emit an event, so count the events rather than
    // compare the row.
    const upserts = (await harness.readEventsWithPayloads()).filter(
      (event) => event.type === "thread.proposed-plan-upserted",
    );
    expect(upserts).toHaveLength(2);

    const sourcePlan = await readSourcePlan(harness, { sourceThreadId, planId });
    expect(sourcePlan?.implementedAt).toBe(alreadyImplementedAt);
    expect(sourcePlan?.implementationThreadId).toBe(ThreadId.make("thread-2"));
  });

  it("retries and reports a plan mark that never lands, instead of swallowing it", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const sourceThreadId = ThreadId.make("thread-plan-source-unmarkable");
    const planId = await seedSourceProposedPlan(harness, {
      sourceThreadId,
      planId: "plan:thread-plan-source-unmarkable:turn:plan-1",
      createdAt,
    });

    // The fold has already deleted the placeholder that carried this plan
    // reference, and a steer emits no `turn.started` for ingestion to mark
    // from, so nothing downstream will ever try again: a failure here is
    // permanent. The plan then shows as unimplemented forever while the
    // provider is in fact implementing it — a lie the user can only act on if
    // they are told.
    //
    // Failing EVERY attempt (rather than one) pins the retry: a single
    // rejection would be absorbed and prove nothing about the fallback. Only
    // the plan upsert is failed, so the fold itself still succeeds — that
    // separation is the point, since the fold is what must survive.
    const originalPlanDispatch = harness.engine.dispatch;
    const markAttempts: Array<string> = [];
    const planDispatchSpy = vi
      .spyOn(harness.engine, "dispatch")
      .mockImplementation((command: Parameters<typeof originalPlanDispatch>[0]) => {
        if (command.type === "thread.proposed-plan.upsert" && command.threadId === sourceThreadId) {
          markAttempts.push(command.commandId);
          return Effect.fail(
            new PersistenceSqlError({ operation: "dispatch", detail: "plan mark write failed" }),
          );
        }
        return originalPlanDispatch(command);
      });

    harness.sendTurn.mockImplementationOnce((_: unknown) =>
      Effect.succeed({
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-running"),
        steered: true,
      }),
    );

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-steered-plan-unmarkable"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-steer-plan-unmarkable"),
        role: "user",
        text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
        attachments: [],
      },
      sourceProposedPlan: { threadId: sourceThreadId, planId },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt,
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads
          .find((entry) => entry.id === ThreadId.make("thread-1"))
          ?.activities.some(
            (activity) => activity.kind === "provider.plan.mark-implemented.failed",
          ) === true
      );
    });
    await harness.drain();
    planDispatchSpy.mockRestore();

    // Three attempts: the initial one plus `times: 2`. Fewer means the retry
    // is not wired; more means it is unbounded.
    expect(markAttempts).toHaveLength(3);

    const planFailureModel = await harness.readModel();
    const planFailureActivity = planFailureModel.threads
      .find((entry) => entry.id === ThreadId.make("thread-1"))
      ?.activities.find((entry) => entry.kind === "provider.plan.mark-implemented.failed");
    expect(planFailureActivity?.tone).toBe("error");
    expect(planFailureActivity?.turnId).toBe(asTurnId("turn-running"));

    // And the fold still landed. The whole reason this failure is caught
    // rather than propagated is that the fold is the part preventing a
    // duplicate prompt; a plan badge must not cost the user that.
    expect(foldedEvents(await harness.readEventsWithPayloads())).toHaveLength(1);
  });

  it("reports a lost fold on the thread instead of swallowing it", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";

    // The fold is the only record that a steered message reached the provider.
    // If it never lands, recovery reads the surviving placeholder as "never
    // sent" and re-issues a prompt the provider already acted on — so the
    // failure has a real, duplicated-work consequence and must not be a log
    // line nobody reads.
    //
    // Failing every attempt (rather than one) also pins the retry: a single
    // rejection would be absorbed and prove nothing about the fallback.
    const originalDispatch = harness.engine.dispatch;
    const foldAttempts: Array<string> = [];
    const dispatchSpy = vi
      .spyOn(harness.engine, "dispatch")
      .mockImplementation((command: Parameters<typeof originalDispatch>[0]) => {
        if (command.type === "thread.turn-start.fold") {
          foldAttempts.push(command.commandId);
          // A typed persistence failure, not a defect: the retry is scoped to
          // the error channel, and a contended SQLite write is exactly the
          // transient case it exists for.
          return Effect.fail(
            new PersistenceSqlError({ operation: "dispatch", detail: "fold write failed" }),
          );
        }
        return originalDispatch(command);
      });

    harness.sendTurn.mockImplementationOnce((_: unknown) =>
      Effect.succeed({
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-running"),
        steered: true,
      }),
    );

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-fold-fails"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-fold-fails"),
        role: "user",
        text: "steer me, then lose the fold",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt,
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads
          .find((entry) => entry.id === ThreadId.make("thread-1"))
          ?.activities.some((activity) => activity.kind === "provider.turn.fold.failed") === true
      );
    });
    await harness.drain();
    dispatchSpy.mockRestore();

    // Three attempts: the initial one plus `times: 2`. Fewer means the retry
    // is not wired; more means it is unbounded.
    expect(foldAttempts).toHaveLength(3);

    const readModel = await harness.readModel();
    const activity = readModel.threads
      .find((entry) => entry.id === ThreadId.make("thread-1"))
      ?.activities.find((entry) => entry.kind === "provider.turn.fold.failed");
    expect(activity?.tone).toBe("error");
    expect(activity?.turnId).toBe(asTurnId("turn-running"));
  });

  it("interrupts an older delivered turn after a newer same-message request steals its claim", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const releaseOlderSend = await harness.makeLatch();
    const releaseNewerSend = await harness.makeLatch();
    const olderSendEntered = await harness.makeLatch();
    const newerSendEntered = await harness.makeLatch();
    const olderDeliveryRecorded = await harness.makeLatch();
    let sameMessageSendCount = 0;

    // Both sends enter the provider before either is allowed to return. Release
    // the OLD one first and wait until its delivery is durably stamped; only
    // then let the newer replacement succeed. This is the completion order in
    // which the winning sender, not the stale sender, must discover and
    // interrupt the older turn. Hard-coding the newer success before releasing
    // the race would cover only the opposite direction.
    const originalRecordDelivery = harness.sendClaims.recordDelivery;
    const recordDeliverySpy = vi
      .spyOn(harness.sendClaims, "recordDelivery")
      .mockImplementation((input: Parameters<typeof originalRecordDelivery>[0]) =>
        originalRecordDelivery(input).pipe(
          Effect.tap(() =>
            input.turnId === asTurnId("turn-older")
              ? Deferred.succeed(olderDeliveryRecorded, undefined)
              : Effect.void,
          ),
        ),
      );
    harness.sendTurn.mockImplementation((input: unknown) =>
      Effect.gen(function* () {
        if ((input as { input?: string }).input !== "supersede me mid-flight") {
          return {
            threadId: ThreadId.make("thread-1"),
            turnId: asTurnId("turn-unrelated"),
          };
        }
        sameMessageSendCount += 1;
        if (sameMessageSendCount === 1) {
          yield* Deferred.succeed(olderSendEntered, undefined);
          yield* Deferred.await(releaseOlderSend);
          return {
            threadId: ThreadId.make("thread-1"),
            turnId: asTurnId("turn-older"),
          };
        }
        yield* Deferred.succeed(newerSendEntered, undefined);
        yield* Deferred.await(releaseNewerSend);
        return {
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-newer"),
        };
      }),
    );

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-superseded-mid-send"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-1"),
        role: "user",
        text: "supersede me mid-flight",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt,
    });
    await harness.runEffect(Deferred.await(olderSendEntered));

    await harness.dispatch({
      type: "thread.turn.resume",
      commandId: CommandId.make("cmd-turn-resume-while-original-sends"),
      threadId: ThreadId.make("thread-1"),
      messageId: asMessageId("user-message-1"),
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await harness.runEffect(Deferred.await(newerSendEntered));

    const sameMessageRequests = (await harness.readEventsWithPayloads()).filter(
      (event) =>
        event.type === "thread.turn-start-requested" &&
        (event.payload as { messageId?: string }).messageId === asMessageId("user-message-1"),
    );
    expect(sameMessageRequests).toHaveLength(2);
    expect(sameMessageRequests[1]!.sequence).toBeGreaterThan(sameMessageRequests[0]!.sequence);
    expect(
      await harness.acquireSendClaim({
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("user-message-1"),
        requestSequence: sameMessageRequests[0]!.sequence,
        claimedAt: createdAt,
      }),
    ).toEqual({
      _tag: "superseded",
      heldBySequence: sameMessageRequests[1]!.sequence,
    });

    await harness.runEffect(Deferred.succeed(releaseOlderSend, undefined));
    await harness.runEffect(Deferred.await(olderDeliveryRecorded));
    expect(harness.interruptTurn.mock.calls).toHaveLength(0);

    await harness.runEffect(Deferred.succeed(releaseNewerSend, undefined));
    await waitFor(() =>
      harness.interruptTurn.mock.calls.some(
        (call) => (call[0] as { turnId?: string }).turnId === asTurnId("turn-older"),
      ),
    );
    await harness.drain();
    recordDeliverySpy.mockRestore();

    expect(sameMessageSendCount).toBe(2);
    expect(
      harness.interruptTurn.mock.calls.filter(
        (call) => (call[0] as { turnId?: string }).turnId === asTurnId("turn-older"),
      ).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      harness.interruptTurn.mock.calls.some(
        (call) => (call[0] as { turnId?: string }).turnId === asTurnId("turn-newer"),
      ),
    ).toBe(false);
    expect(harness.stopSession.mock.calls).toHaveLength(0);
  });

  it("reconciles every stale turn in a three-request delivery chain", async () => {
    const harness = await createHarness();
    const releases = [
      await harness.makeLatch(),
      await harness.makeLatch(),
      await harness.makeLatch(),
    ] as const;
    const entered = [
      await harness.makeLatch(),
      await harness.makeLatch(),
      await harness.makeLatch(),
    ] as const;
    const recorded = [
      await harness.makeLatch(),
      await harness.makeLatch(),
      await harness.makeLatch(),
    ] as const;
    const turnIds = [
      asTurnId("turn-chain-a"),
      asTurnId("turn-chain-b"),
      asTurnId("turn-chain-c"),
    ] as const;
    let sendCount = 0;

    const originalRecordDelivery = harness.sendClaims.recordDelivery;
    const recordDeliverySpy = vi
      .spyOn(harness.sendClaims, "recordDelivery")
      .mockImplementation((input: Parameters<typeof originalRecordDelivery>[0]) =>
        originalRecordDelivery(input).pipe(
          Effect.tap(() => {
            const index = turnIds.indexOf(input.turnId);
            return index >= 0 ? Deferred.succeed(recorded[index]!, undefined) : Effect.void;
          }),
        ),
      );
    harness.sendTurn.mockImplementation((input: unknown) =>
      Effect.gen(function* () {
        if ((input as { input?: string }).input !== "deliver an a b c chain") {
          return {
            threadId: ThreadId.make("thread-1"),
            turnId: asTurnId("turn-unrelated"),
          };
        }
        const index = sendCount++;
        yield* Deferred.succeed(entered[index]!, undefined);
        yield* Deferred.await(releases[index]!);
        return {
          threadId: ThreadId.make("thread-1"),
          turnId: turnIds[index]!,
        };
      }),
    );

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-chain-a"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-delivery-chain"),
        role: "user",
        text: "deliver an a b c chain",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await harness.runEffect(Deferred.await(entered[0]));
    await harness.dispatch({
      type: "thread.turn.resume",
      commandId: CommandId.make("cmd-turn-chain-b"),
      threadId: ThreadId.make("thread-1"),
      messageId: asMessageId("user-message-delivery-chain"),
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await harness.runEffect(Deferred.await(entered[1]));
    await harness.dispatch({
      type: "thread.turn.resume",
      commandId: CommandId.make("cmd-turn-chain-c"),
      threadId: ThreadId.make("thread-1"),
      messageId: asMessageId("user-message-delivery-chain"),
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    await harness.runEffect(Deferred.await(entered[2]));

    const requests = (await harness.readEventsWithPayloads()).filter(
      (event) =>
        event.type === "thread.turn-start-requested" &&
        (event.payload as { messageId?: string }).messageId ===
          asMessageId("user-message-delivery-chain"),
    );
    expect(requests).toHaveLength(3);
    expect(requests.map((event) => event.sequence)).toEqual(
      requests.map((event) => event.sequence).sort((a, b) => a - b),
    );

    // C owns before any send returns. A then B then C complete, reproducing the
    // overwrite order that lost A when only one superseded slot existed.
    await harness.runEffect(Deferred.succeed(releases[0], undefined));
    await harness.runEffect(Deferred.await(recorded[0]));
    await harness.runEffect(Deferred.succeed(releases[1], undefined));
    await harness.runEffect(Deferred.await(recorded[1]));
    await harness.runEffect(Deferred.succeed(releases[2], undefined));
    await harness.runEffect(Deferred.await(recorded[2]));

    await waitFor(
      () =>
        harness.interruptTurn.mock.calls.some(
          (call) => (call[0] as { turnId?: string }).turnId === turnIds[0],
        ) &&
        harness.interruptTurn.mock.calls.some(
          (call) => (call[0] as { turnId?: string }).turnId === turnIds[1],
        ),
    );
    await harness.drain();
    recordDeliverySpy.mockRestore();

    expect(sendCount).toBe(3);
    for (const staleTurnId of turnIds.slice(0, 2)) {
      expect(
        harness.interruptTurn.mock.calls.filter(
          (call) => (call[0] as { turnId?: string }).turnId === staleTurnId,
        ).length,
      ).toBe(1);
    }
    expect(
      harness.interruptTurn.mock.calls.some(
        (call) => (call[0] as { turnId?: string }).turnId === turnIds[2],
      ),
    ).toBe(false);
    expect(harness.stopSession.mock.calls).toHaveLength(0);
  });

  it("orders distinct equal-sequence delivery replays by insertion and interrupts only the first", async () => {
    const harness = await createHarness();
    const releaseA = await harness.makeLatch();
    const releaseB = await harness.makeLatch();
    const enteredA = await harness.makeLatch();
    const enteredB = await harness.makeLatch();
    const recordedA = await harness.makeLatch();
    const recordedB = await harness.makeLatch();
    const messageId = asMessageId("user-message-equal-sequence");
    const turnA = asTurnId("turn-equal-sequence-a");
    const turnB = asTurnId("turn-equal-sequence-b");
    let sendCount = 0;
    let sharedDeliverySequence: number | undefined;
    let equalSequenceDeliveries: ReadonlyArray<{
      readonly requestSequence: number;
      readonly turnId: TurnId;
    }> = [];

    const delegatedPreSendAcquires: Array<Parameters<typeof harness.sendClaims.acquire>[0]> = [];
    const originalAcquire = harness.sendClaims.acquire;
    const acquireSpy = vi
      .spyOn(harness.sendClaims, "acquire")
      .mockImplementation((input: Parameters<typeof originalAcquire>[0]) =>
        Effect.suspend(() => {
          const replayInput =
            input.messageId === messageId && sharedDeliverySequence !== undefined
              ? {
                  ...input,
                  requestSequence: NonNegativeInt.make(sharedDeliverySequence),
                }
              : input;
          if (input.messageId === messageId && harness.sendTurn.mock.calls.length < 2) {
            delegatedPreSendAcquires.push(replayInput);
          }
          return originalAcquire(replayInput);
        }),
      );
    const originalRecordDelivery = harness.sendClaims.recordDelivery;
    const recordDeliverySpy = vi
      .spyOn(harness.sendClaims, "recordDelivery")
      .mockImplementation((input: Parameters<typeof originalRecordDelivery>[0]) => {
        const replayInput =
          input.messageId === messageId && sharedDeliverySequence !== undefined
            ? {
                ...input,
                requestSequence: NonNegativeInt.make(sharedDeliverySequence),
              }
            : input;
        return originalRecordDelivery(replayInput).pipe(
          Effect.tap((state) => {
            if (input.turnId === turnB && state._tag === "recorded") {
              equalSequenceDeliveries = state.deliveries.map(({ requestSequence, turnId }) => ({
                requestSequence,
                turnId,
              }));
            }
            return input.turnId === turnA
              ? Deferred.succeed(recordedA, undefined)
              : input.turnId === turnB
                ? Deferred.succeed(recordedB, undefined)
                : Effect.void;
          }),
        );
      });
    harness.sendTurn.mockImplementation((input: unknown) =>
      Effect.gen(function* () {
        if ((input as { input?: string }).input !== "equal sequence concrete replay") {
          return {
            threadId: ThreadId.make("thread-1"),
            turnId: asTurnId("turn-unrelated"),
          };
        }
        sendCount += 1;
        if (sendCount === 1) {
          yield* Deferred.succeed(enteredA, undefined);
          yield* Deferred.await(releaseA);
          return {
            threadId: ThreadId.make("thread-1"),
            turnId: turnA,
          };
        }
        yield* Deferred.succeed(enteredB, undefined);
        yield* Deferred.await(releaseB);
        return {
          threadId: ThreadId.make("thread-1"),
          turnId: turnB,
        };
      }),
    );

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-equal-sequence-a"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId,
        role: "user",
        text: "equal sequence concrete replay",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await harness.runEffect(Deferred.await(enteredA));

    const firstRequests = (await harness.readEventsWithPayloads()).filter(
      (event) =>
        event.type === "thread.turn-start-requested" &&
        (event.payload as { messageId?: string }).messageId === messageId,
    );
    expect(firstRequests).toHaveLength(1);
    sharedDeliverySequence = firstRequests[0]!.sequence;

    await harness.dispatch({
      type: "thread.turn.resume",
      commandId: CommandId.make("cmd-turn-equal-sequence-b"),
      threadId: ThreadId.make("thread-1"),
      messageId,
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await harness.runEffect(Deferred.await(enteredB));

    const requests = (await harness.readEventsWithPayloads()).filter(
      (event) =>
        event.type === "thread.turn-start-requested" &&
        (event.payload as { messageId?: string }).messageId === messageId,
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]!.sequence).toBeGreaterThan(requests[0]!.sequence);
    expect(delegatedPreSendAcquires.map((input) => input.requestSequence)).toEqual([
      sharedDeliverySequence,
      sharedDeliverySequence,
    ]);

    await harness.runEffect(Deferred.succeed(releaseA, undefined));
    await harness.runEffect(Deferred.await(recordedA));
    await harness.runEffect(Deferred.succeed(releaseB, undefined));
    await harness.runEffect(Deferred.await(recordedB));
    await waitFor(() =>
      harness.interruptTurn.mock.calls.some(
        (call) => (call[0] as { turnId?: string }).turnId === turnA,
      ),
    );
    await harness.drain();
    acquireSpy.mockRestore();
    recordDeliverySpy.mockRestore();

    expect(sendCount).toBe(2);
    expect(equalSequenceDeliveries).toEqual([
      { requestSequence: sharedDeliverySequence, turnId: turnA },
      { requestSequence: sharedDeliverySequence, turnId: turnB },
    ]);
    expect(
      harness.interruptTurn.mock.calls.filter(
        (call) => (call[0] as { turnId?: string }).turnId === turnA,
      ),
    ).toHaveLength(1);
    expect(
      harness.interruptTurn.mock.calls.some(
        (call) => (call[0] as { turnId?: string }).turnId === turnB,
      ),
    ).toBe(false);
    expect(harness.stopSession.mock.calls).toHaveLength(0);
  });

  it("keeps stale and survivor deliveries live when durable reconciliation fails", async () => {
    const harness = await createHarness();
    const releaseStale = await harness.makeLatch();
    const releaseSurvivor = await harness.makeLatch();
    const staleEntered = await harness.makeLatch();
    const survivorEntered = await harness.makeLatch();
    const staleRecorded = await harness.makeLatch();
    const survivorRecorded = await harness.makeLatch();
    const messageId = asMessageId("user-message-failed-durable-reconciliation");
    const staleTurnId = asTurnId("turn-failed-reconciliation-stale");
    const survivorTurnId = asTurnId("turn-failed-reconciliation-survivor");
    let sendCount = 0;

    const originalRecordDelivery = harness.sendClaims.recordDelivery;
    const recordDeliverySpy = vi
      .spyOn(harness.sendClaims, "recordDelivery")
      .mockImplementation((input: Parameters<typeof originalRecordDelivery>[0]) =>
        originalRecordDelivery(input).pipe(
          Effect.tap(() =>
            input.turnId === staleTurnId
              ? Deferred.succeed(staleRecorded, undefined)
              : input.turnId === survivorTurnId
                ? Deferred.succeed(survivorRecorded, undefined)
                : Effect.void,
          ),
        ),
      );
    harness.sendTurn.mockImplementation((input: unknown) =>
      Effect.gen(function* () {
        if ((input as { input?: string }).input !== "fail durable reconciliation") {
          return {
            threadId: ThreadId.make("thread-1"),
            turnId: asTurnId("turn-unrelated"),
          };
        }
        sendCount += 1;
        if (sendCount === 1) {
          yield* Deferred.succeed(staleEntered, undefined);
          yield* Deferred.await(releaseStale);
          return {
            threadId: ThreadId.make("thread-1"),
            turnId: staleTurnId,
          };
        }
        yield* Deferred.succeed(survivorEntered, undefined);
        yield* Deferred.await(releaseSurvivor);
        return {
          threadId: ThreadId.make("thread-1"),
          turnId: survivorTurnId,
        };
      }),
    );
    harness.interruptTurn.mockImplementation((_: unknown) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "session/interrupt",
          detail: "original stale interrupt transport failure",
        }),
      ),
    );

    const escalatedStops: Array<Parameters<typeof harness.engine.dispatch>[0]> = [];
    const originalDispatch = harness.engine.dispatch;
    const dispatchSpy = vi
      .spyOn(harness.engine, "dispatch")
      .mockImplementation((command: Parameters<typeof originalDispatch>[0]) => {
        if (command.type === "thread.session.stop") {
          escalatedStops.push(command);
          return Effect.fail(
            new PersistenceSqlError({
              operation: "dispatch",
              detail: "reconciliation stop dispatch persistence failure",
            }) as never,
          );
        }
        return originalDispatch(command);
      });

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-failed-reconciliation-stale"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId,
        role: "user",
        text: "fail durable reconciliation",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await harness.runEffect(Deferred.await(staleEntered));
    await harness.dispatch({
      type: "thread.turn.resume",
      commandId: CommandId.make("cmd-turn-failed-reconciliation-survivor"),
      threadId: ThreadId.make("thread-1"),
      messageId,
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await harness.runEffect(Deferred.await(survivorEntered));

    const requests = (await harness.readEventsWithPayloads()).filter(
      (event) =>
        event.type === "thread.turn-start-requested" &&
        (event.payload as { messageId?: string }).messageId === messageId,
    );
    expect(requests).toHaveLength(2);
    const staleSequence = requests[0]!.sequence;
    const survivorSequence = requests[1]!.sequence;
    expect(survivorSequence).toBeGreaterThan(staleSequence);

    await harness.runEffect(Deferred.succeed(releaseStale, undefined));
    await harness.runEffect(Deferred.await(staleRecorded));
    await harness.runEffect(Deferred.succeed(releaseSurvivor, undefined));
    await harness.runEffect(Deferred.await(survivorRecorded));
    await waitFor(async () => {
      const model = await harness.readModel();
      return (
        model.threads
          .find((thread) => thread.id === ThreadId.make("thread-1"))
          ?.activities.some((activity) => activity.kind === "provider.turn.interrupt.failed") ===
        true
      );
    });
    await harness.drain();
    dispatchSpy.mockRestore();
    recordDeliverySpy.mockRestore();

    const finalLedger = await harness.runEffect(
      harness.sendClaims.recordDelivery({
        threadId: ThreadId.make("thread-1"),
        messageId,
        requestSequence: survivorSequence,
        turnId: survivorTurnId,
      }),
    );

    expect(sendCount).toBe(2);
    expect(harness.interruptTurn.mock.calls).toHaveLength(2);
    expect(
      harness.interruptTurn.mock.calls.every(
        (call) => (call[0] as { turnId?: string }).turnId === staleTurnId,
      ),
    ).toBe(true);
    expect(escalatedStops).toHaveLength(1);
    expect(escalatedStops[0]).toMatchObject({
      type: "thread.session.stop",
      canceledThroughSequence: staleSequence,
    });
    expect(finalLedger._tag).toBe("recorded");
    if (finalLedger._tag === "recorded") {
      expect(
        finalLedger.deliveries.map(({ requestSequence, turnId }) => ({ requestSequence, turnId })),
      ).toEqual([
        { requestSequence: staleSequence, turnId: staleTurnId },
        { requestSequence: survivorSequence, turnId: survivorTurnId },
      ]);
    }
    expect(
      (await harness.readEvents()).filter(
        (event) => event.type === "thread.session-stop-requested",
      ),
    ).toHaveLength(0);

    const activity = (await harness.readModel()).threads
      .find((thread) => thread.id === ThreadId.make("thread-1"))
      ?.activities.find((entry) => entry.kind === "provider.turn.interrupt.failed");
    const detail = (activity?.payload as { detail?: string } | undefined)?.detail;
    expect(activity?.turnId).toBe(staleTurnId);
    expect(detail).toContain("original stale interrupt transport failure");
    expect(detail).not.toContain("reconciliation stop dispatch persistence failure");
  });

  it("interrupts a repeated stale turn id only once per reconciliation pass", async () => {
    const harness = await createHarness();
    const releaseA = await harness.makeLatch();
    const releaseB = await harness.makeLatch();
    const releaseC = await harness.makeLatch();
    const enteredA = await harness.makeLatch();
    const enteredB = await harness.makeLatch();
    const enteredC = await harness.makeLatch();
    const recordedA = await harness.makeLatch();
    const recordedB = await harness.makeLatch();
    let sendCount = 0;
    let sharedDeliveryCount = 0;

    const originalRecordDelivery = harness.sendClaims.recordDelivery;
    const recordDeliverySpy = vi
      .spyOn(harness.sendClaims, "recordDelivery")
      .mockImplementation((input: Parameters<typeof originalRecordDelivery>[0]) =>
        originalRecordDelivery(input).pipe(
          Effect.tap(() => {
            if (input.turnId !== asTurnId("turn-repeated-stale")) {
              return Effect.void;
            }
            sharedDeliveryCount += 1;
            return Deferred.succeed(sharedDeliveryCount === 1 ? recordedA : recordedB, undefined);
          }),
        ),
      );
    harness.sendTurn.mockImplementation((input: unknown) =>
      Effect.gen(function* () {
        if ((input as { input?: string }).input !== "dedupe a repeated stale turn") {
          return {
            threadId: ThreadId.make("thread-1"),
            turnId: asTurnId("turn-unrelated"),
          };
        }
        sendCount += 1;
        if (sendCount === 1) {
          yield* Deferred.succeed(enteredA, undefined);
          yield* Deferred.await(releaseA);
          return {
            threadId: ThreadId.make("thread-1"),
            turnId: asTurnId("turn-repeated-stale"),
          };
        }
        if (sendCount === 2) {
          yield* Deferred.succeed(enteredB, undefined);
          yield* Deferred.await(releaseB);
          return {
            threadId: ThreadId.make("thread-1"),
            turnId: asTurnId("turn-repeated-stale"),
          };
        }
        yield* Deferred.succeed(enteredC, undefined);
        yield* Deferred.await(releaseC);
        return {
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-distinct-survivor"),
        };
      }),
    );

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-repeated-stale-a"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-repeated-stale"),
        role: "user",
        text: "dedupe a repeated stale turn",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await harness.runEffect(Deferred.await(enteredA));
    await harness.dispatch({
      type: "thread.turn.resume",
      commandId: CommandId.make("cmd-turn-repeated-stale-b"),
      threadId: ThreadId.make("thread-1"),
      messageId: asMessageId("user-message-repeated-stale"),
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await harness.runEffect(Deferred.await(enteredB));
    await harness.dispatch({
      type: "thread.turn.resume",
      commandId: CommandId.make("cmd-turn-repeated-stale-c"),
      threadId: ThreadId.make("thread-1"),
      messageId: asMessageId("user-message-repeated-stale"),
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    await harness.runEffect(Deferred.await(enteredC));

    await harness.runEffect(Deferred.succeed(releaseA, undefined));
    await harness.runEffect(Deferred.await(recordedA));
    await harness.runEffect(Deferred.succeed(releaseB, undefined));
    await harness.runEffect(Deferred.await(recordedB));
    // A and B share one live steer id, so neither delivery alone may stop it.
    expect(harness.interruptTurn.mock.calls).toHaveLength(0);

    await harness.runEffect(Deferred.succeed(releaseC, undefined));
    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    await harness.drain();
    recordDeliverySpy.mockRestore();

    expect(harness.interruptTurn.mock.calls).toEqual([
      [{ threadId: ThreadId.make("thread-1"), turnId: asTurnId("turn-repeated-stale") }],
    ]);
  });

  it("escalates a newer-side stale interrupt at the stale request sequence", async () => {
    const harness = await createHarness();
    const releaseOlder = await harness.makeLatch();
    const releaseNewer = await harness.makeLatch();
    const olderEntered = await harness.makeLatch();
    const newerEntered = await harness.makeLatch();
    const olderRecorded = await harness.makeLatch();
    let sendCount = 0;

    const originalRecordDelivery = harness.sendClaims.recordDelivery;
    const recordDeliverySpy = vi
      .spyOn(harness.sendClaims, "recordDelivery")
      .mockImplementation((input: Parameters<typeof originalRecordDelivery>[0]) =>
        originalRecordDelivery(input).pipe(
          Effect.tap(() =>
            input.turnId === asTurnId("turn-escalation-stale")
              ? Deferred.succeed(olderRecorded, undefined)
              : Effect.void,
          ),
        ),
      );
    harness.sendTurn.mockImplementation((input: unknown) =>
      Effect.gen(function* () {
        if ((input as { input?: string }).input !== "replacement must survive escalation") {
          return {
            threadId: ThreadId.make("thread-1"),
            turnId: asTurnId("turn-unrelated"),
          };
        }
        sendCount += 1;
        if (sendCount === 1) {
          yield* Deferred.succeed(olderEntered, undefined);
          yield* Deferred.await(releaseOlder);
          return {
            threadId: ThreadId.make("thread-1"),
            turnId: asTurnId("turn-escalation-stale"),
          };
        }
        yield* Deferred.succeed(newerEntered, undefined);
        yield* Deferred.await(releaseNewer);
        return {
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-escalation-replacement"),
        };
      }),
    );
    harness.interruptTurn.mockImplementation((_: unknown) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "session/interrupt",
          detail: "stale turn interrupt transport failure",
        }),
      ),
    );

    const escalatedStops: Array<Parameters<typeof harness.engine.dispatch>[0]> = [];
    const originalDispatch = harness.engine.dispatch;
    const dispatchSpy = vi
      .spyOn(harness.engine, "dispatch")
      .mockImplementation((command: Parameters<typeof originalDispatch>[0]) => {
        if (command.type === "thread.session.stop") {
          escalatedStops.push(command);
          // Capturing the internal command without enqueuing it isolates the
          // cutoff contract from session-stop redrive and avoids a second
          // reconciliation cycle obscuring which stale attempt produced it.
          return Effect.succeed({ sequence: NonNegativeInt.make(0) });
        }
        return originalDispatch(command);
      });

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-escalation-stale"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-escalation-sequence"),
        role: "user",
        text: "replacement must survive escalation",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await harness.runEffect(Deferred.await(olderEntered));
    await harness.dispatch({
      type: "thread.turn.resume",
      commandId: CommandId.make("cmd-turn-escalation-replacement"),
      threadId: ThreadId.make("thread-1"),
      messageId: asMessageId("user-message-escalation-sequence"),
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await harness.runEffect(Deferred.await(newerEntered));

    const requests = (await harness.readEventsWithPayloads()).filter(
      (event) =>
        event.type === "thread.turn-start-requested" &&
        (event.payload as { messageId?: string }).messageId ===
          asMessageId("user-message-escalation-sequence"),
    );
    expect(requests).toHaveLength(2);
    const staleSequence = requests[0]!.sequence;
    const replacementSequence = requests[1]!.sequence;

    await harness.runEffect(Deferred.succeed(releaseOlder, undefined));
    await harness.runEffect(Deferred.await(olderRecorded));
    expect(harness.interruptTurn.mock.calls).toHaveLength(0);
    await harness.runEffect(Deferred.succeed(releaseNewer, undefined));
    await waitFor(() => escalatedStops.length === 1);
    await harness.drain();
    dispatchSpy.mockRestore();
    recordDeliverySpy.mockRestore();

    expect(replacementSequence).toBeGreaterThan(staleSequence);
    expect(escalatedStops).toHaveLength(1);
    expect(escalatedStops[0]).toMatchObject({
      type: "thread.session.stop",
      canceledThroughSequence: staleSequence,
    });
    expect(staleSequence).toBeLessThan(replacementSequence);
    expect(
      harness.interruptTurn.mock.calls.filter(
        (call) => (call[0] as { turnId?: string }).turnId === asTurnId("turn-escalation-stale"),
      ),
    ).toHaveLength(2);

    const activity = (await harness.readModel()).threads
      .find((thread) => thread.id === ThreadId.make("thread-1"))
      ?.activities.find((entry) => entry.kind === "provider.turn.interrupt.failed");
    // A durably accepted widened stop is a successful ledger reconciliation,
    // unlike the ordinary user interrupt path which still reports its original
    // exact-turn failure after widening.
    expect(activity).toBeUndefined();
  });

  it("settles a real stale-stop redrive cycle without stopping the replacement again", async () => {
    const harness = await createHarness();
    const recordedA = await harness.makeLatch();
    const recordedRedrive = await harness.makeLatch();
    let sendCount = 0;

    const originalRecordDelivery = harness.sendClaims.recordDelivery;
    const recordDeliverySpy = vi
      .spyOn(harness.sendClaims, "recordDelivery")
      .mockImplementation((input: Parameters<typeof originalRecordDelivery>[0]) =>
        originalRecordDelivery(input).pipe(
          Effect.tap(() =>
            input.turnId === asTurnId("turn-loop-1")
              ? Deferred.succeed(recordedA, undefined)
              : input.turnId === asTurnId("turn-loop-3")
                ? Deferred.succeed(recordedRedrive, undefined)
                : Effect.void,
          ),
        ),
      );
    harness.sendTurn.mockImplementation((input: unknown) =>
      Effect.gen(function* () {
        if ((input as { input?: string }).input !== "break stale stop redrive loop") {
          return {
            threadId: ThreadId.make("thread-1"),
            turnId: asTurnId("turn-unrelated"),
          };
        }
        sendCount += 1;
        if (sendCount > 3) {
          return yield* new ProviderAdapterRequestError({
            provider: ProviderDriverKind.make("codex"),
            method: "turn/start",
            detail: "unexpected extra redrive",
          });
        }
        return {
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId(`turn-loop-${sendCount}`),
        };
      }),
    );
    // Codex rejects an exact-turn interrupt after that concrete target is no
    // longer active. Persistently fail the stale target so only the real
    // session-stop handler and its redrive can settle the cycle.
    harness.interruptTurn.mockImplementation((_: unknown) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "session/interrupt",
          detail: "exact stale turn is inactive",
        }),
      ),
    );

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-loop-a"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-loop-breaker"),
        role: "user",
        text: "break stale stop redrive loop",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await harness.runEffect(Deferred.await(recordedA));
    await harness.dispatch({
      type: "thread.turn.resume",
      commandId: CommandId.make("cmd-turn-loop-b"),
      threadId: ThreadId.make("thread-1"),
      messageId: asMessageId("user-message-loop-breaker"),
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await harness.runEffect(Deferred.await(recordedRedrive));
    await harness.drain();

    const events = await harness.readEventsWithPayloads();
    const messageStarts = events.filter(
      (event) =>
        event.type === "thread.turn-start-requested" &&
        (event.payload as { messageId?: string }).messageId ===
          asMessageId("user-message-loop-breaker"),
    );
    const sessionStops = events.filter((event) => event.type === "thread.session-stop-requested");
    const redriveSequence = messageStarts.at(-1)!.sequence;
    const finalLedger = await harness.runEffect(
      harness.sendClaims.recordDelivery({
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("user-message-loop-breaker"),
        requestSequence: redriveSequence,
        turnId: asTurnId("turn-loop-3"),
      }),
    );

    expect(harness.interruptTurn.mock.calls).toHaveLength(2);
    expect(
      harness.interruptTurn.mock.calls.every(
        (call) => (call[0] as { turnId?: string }).turnId === asTurnId("turn-loop-1"),
      ),
    ).toBe(true);
    expect(harness.stopSession.mock.calls).toHaveLength(1);
    expect(sendCount).toBe(3);
    expect(messageStarts).toHaveLength(3);
    expect(sessionStops).toHaveLength(1);
    expect(finalLedger).toMatchObject({
      _tag: "recorded",
      deliveries: [{ turnId: asTurnId("turn-loop-3") }],
    });

    const settledCounts = {
      interrupts: harness.interruptTurn.mock.calls.length,
      stops: harness.stopSession.mock.calls.length,
      sends: sendCount,
    };
    await harness.drain();
    expect({
      interrupts: harness.interruptTurn.mock.calls.length,
      stops: harness.stopSession.mock.calls.length,
      sends: sendCount,
    }).toEqual(settledCounts);
    recordDeliverySpy.mockRestore();
  });

  it("retires every stale sibling after one widened-stop dispatch", async () => {
    const harness = await createHarness();
    const releases = [
      await harness.makeLatch(),
      await harness.makeLatch(),
      await harness.makeLatch(),
    ] as const;
    const entered = [
      await harness.makeLatch(),
      await harness.makeLatch(),
      await harness.makeLatch(),
    ] as const;
    const recorded = [
      await harness.makeLatch(),
      await harness.makeLatch(),
      await harness.makeLatch(),
    ] as const;
    const stopDispatched = await harness.makeLatch();
    const turnIds = [
      asTurnId("turn-sibling-a"),
      asTurnId("turn-sibling-b"),
      asTurnId("turn-sibling-survivor"),
    ] as const;
    let sendCount = 0;
    let completedDeliveryCount = 0;

    const originalRecordDelivery = harness.sendClaims.recordDelivery;
    const recordDeliverySpy = vi
      .spyOn(harness.sendClaims, "recordDelivery")
      .mockImplementation((input: Parameters<typeof originalRecordDelivery>[0]) =>
        originalRecordDelivery(input).pipe(
          // Let A and B stamp the real ledger but withhold their predecessor
          // snapshots. C's unmodified read then deterministically performs the
          // one pass that observes both distinct stale siblings together.
          Effect.map((state) => {
            completedDeliveryCount += 1;
            return completedDeliveryCount < 3 && state._tag === "recorded"
              ? {
                  ...state,
                  deliveries: state.deliveries.filter(
                    (delivery) => delivery.turnId === input.turnId,
                  ),
                }
              : state;
          }),
          Effect.tap(() => {
            const index = turnIds.indexOf(input.turnId);
            return index >= 0 ? Deferred.succeed(recorded[index]!, undefined) : Effect.void;
          }),
        ),
      );
    harness.sendTurn.mockImplementation((input: unknown) =>
      Effect.gen(function* () {
        if ((input as { input?: string }).input !== "one stop covers stale siblings") {
          return {
            threadId: ThreadId.make("thread-1"),
            turnId: asTurnId("turn-unrelated"),
          };
        }
        const index = sendCount++;
        yield* Deferred.succeed(entered[index]!, undefined);
        yield* Deferred.await(releases[index]!);
        return {
          threadId: ThreadId.make("thread-1"),
          turnId: turnIds[index]!,
        };
      }),
    );
    harness.interruptTurn.mockImplementation((_: unknown) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "session/interrupt",
          detail: "stale sibling is inactive",
        }),
      ),
    );

    const escalatedStops: Array<Parameters<typeof harness.engine.dispatch>[0]> = [];
    const originalDispatch = harness.engine.dispatch;
    const dispatchSpy = vi
      .spyOn(harness.engine, "dispatch")
      .mockImplementation((command: Parameters<typeof originalDispatch>[0]) => {
        if (command.type === "thread.session.stop") {
          escalatedStops.push(command);
          return Deferred.succeed(stopDispatched, undefined).pipe(
            Effect.as({ sequence: NonNegativeInt.make(0) }),
          );
        }
        return originalDispatch(command);
      });

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-sibling-a"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-stale-siblings"),
        role: "user",
        text: "one stop covers stale siblings",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await harness.runEffect(Deferred.await(entered[0]));
    for (const index of [1, 2] as const) {
      await harness.dispatch({
        type: "thread.turn.resume",
        commandId: CommandId.make(`cmd-turn-sibling-${index}`),
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("user-message-stale-siblings"),
        createdAt: `2026-01-01T00:00:0${index}.000Z`,
      });
      await harness.runEffect(Deferred.await(entered[index]));
    }

    for (const index of [0, 1, 2] as const) {
      await harness.runEffect(Deferred.succeed(releases[index], undefined));
      await harness.runEffect(Deferred.await(recorded[index]));
    }
    await harness.runEffect(Deferred.await(stopDispatched));
    await harness.drain();

    const requests = (await harness.readEventsWithPayloads()).filter(
      (event) =>
        event.type === "thread.turn-start-requested" &&
        (event.payload as { messageId?: string }).messageId ===
          asMessageId("user-message-stale-siblings"),
    );
    const survivorState = await harness.runEffect(
      harness.sendClaims.recordDelivery({
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("user-message-stale-siblings"),
        requestSequence: requests.at(-1)!.sequence,
        turnId: turnIds[2],
      }),
    );

    expect(escalatedStops).toHaveLength(1);
    expect(harness.interruptTurn.mock.calls).toHaveLength(2);
    expect(
      harness.interruptTurn.mock.calls.every(
        (call) => (call[0] as { turnId?: string }).turnId === turnIds[0],
      ),
    ).toBe(true);
    expect(survivorState).toMatchObject({
      _tag: "recorded",
      deliveries: [{ turnId: turnIds[2] }],
    });
    expect(harness.stopSession.mock.calls).toHaveLength(0);
    dispatchSpy.mockRestore();
    recordDeliverySpy.mockRestore();
  });

  it("keeps the older delivered turn alive when the newer claimant's send fails", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const releaseOlderSend = await harness.makeLatch();
    const olderSendEntered = await harness.makeLatch();
    const olderDeliveryRecorded = await harness.makeLatch();
    let sameMessageSendCount = 0;

    const originalRecordDelivery = harness.sendClaims.recordDelivery;
    const recordDeliverySpy = vi
      .spyOn(harness.sendClaims, "recordDelivery")
      .mockImplementation((input: Parameters<typeof originalRecordDelivery>[0]) =>
        originalRecordDelivery(input).pipe(
          Effect.tap(() =>
            input.turnId === asTurnId("turn-healthy-older")
              ? Deferred.succeed(olderDeliveryRecorded, undefined)
              : Effect.void,
          ),
        ),
      );
    harness.sendTurn.mockImplementation((input: unknown) =>
      Effect.gen(function* () {
        if ((input as { input?: string }).input !== "new claimant can fail") {
          return {
            threadId: ThreadId.make("thread-1"),
            turnId: asTurnId("turn-unrelated"),
          };
        }
        sameMessageSendCount += 1;
        if (sameMessageSendCount === 1) {
          yield* Deferred.succeed(olderSendEntered, undefined);
          yield* Deferred.await(releaseOlderSend);
          return {
            threadId: ThreadId.make("thread-1"),
            turnId: asTurnId("turn-healthy-older"),
          };
        }
        return yield* new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "turn/start",
          detail: "newer replacement failed before delivery",
        });
      }),
    );

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-older-before-failed-replacement"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-failed-replacement"),
        role: "user",
        text: "new claimant can fail",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt,
    });
    await harness.runEffect(Deferred.await(olderSendEntered));

    await harness.dispatch({
      type: "thread.turn.resume",
      commandId: CommandId.make("cmd-turn-failed-replacement"),
      threadId: ThreadId.make("thread-1"),
      messageId: asMessageId("user-message-failed-replacement"),
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await waitFor(async () => {
      const model = await harness.readModel();
      return (
        model.threads
          .find((entry) => entry.id === ThreadId.make("thread-1"))
          ?.activities.some(
            (activity) =>
              activity.kind === "provider.turn.start.failed" &&
              (activity.payload as { detail?: string }).detail?.includes(
                "newer replacement failed before delivery",
              ),
          ) === true
      );
    });

    await harness.runEffect(Deferred.succeed(releaseOlderSend, undefined));
    await harness.runEffect(Deferred.await(olderDeliveryRecorded));
    await harness.drain();
    recordDeliverySpy.mockRestore();

    expect(sameMessageSendCount).toBe(2);
    expect(harness.interruptTurn.mock.calls).toHaveLength(0);
    expect(harness.stopSession.mock.calls).toHaveLength(0);
  });

  it("keeps the newest delivered request when a still-newer owner fails", async () => {
    const harness = await createHarness();
    const releaseA = await harness.makeLatch();
    const releaseB = await harness.makeLatch();
    const releaseCFailure = await harness.makeLatch();
    const enteredA = await harness.makeLatch();
    const enteredB = await harness.makeLatch();
    const enteredC = await harness.makeLatch();
    const recordedA = await harness.makeLatch();
    const recordedB = await harness.makeLatch();
    let sendCount = 0;

    const originalRecordDelivery = harness.sendClaims.recordDelivery;
    const recordDeliverySpy = vi
      .spyOn(harness.sendClaims, "recordDelivery")
      .mockImplementation((input: Parameters<typeof originalRecordDelivery>[0]) =>
        originalRecordDelivery(input).pipe(
          Effect.tap(() =>
            input.turnId === asTurnId("turn-failed-chain-a")
              ? Deferred.succeed(recordedA, undefined)
              : input.turnId === asTurnId("turn-failed-chain-b")
                ? Deferred.succeed(recordedB, undefined)
                : Effect.void,
          ),
        ),
      );
    harness.sendTurn.mockImplementation((input: unknown) =>
      Effect.gen(function* () {
        if ((input as { input?: string }).input !== "c owns but b delivered last") {
          return {
            threadId: ThreadId.make("thread-1"),
            turnId: asTurnId("turn-unrelated"),
          };
        }
        sendCount += 1;
        if (sendCount === 1) {
          yield* Deferred.succeed(enteredA, undefined);
          yield* Deferred.await(releaseA);
          return {
            threadId: ThreadId.make("thread-1"),
            turnId: asTurnId("turn-failed-chain-a"),
          };
        }
        if (sendCount === 2) {
          yield* Deferred.succeed(enteredB, undefined);
          yield* Deferred.await(releaseB);
          return {
            threadId: ThreadId.make("thread-1"),
            turnId: asTurnId("turn-failed-chain-b"),
          };
        }
        yield* Deferred.succeed(enteredC, undefined);
        yield* Deferred.await(releaseCFailure);
        return yield* new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "turn/start",
          detail: "current owner c failed before delivery",
        });
      }),
    );

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-failed-chain-a"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-failed-chain"),
        role: "user",
        text: "c owns but b delivered last",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await harness.runEffect(Deferred.await(enteredA));
    await harness.dispatch({
      type: "thread.turn.resume",
      commandId: CommandId.make("cmd-turn-failed-chain-b"),
      threadId: ThreadId.make("thread-1"),
      messageId: asMessageId("user-message-failed-chain"),
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await harness.runEffect(Deferred.await(enteredB));
    await harness.dispatch({
      type: "thread.turn.resume",
      commandId: CommandId.make("cmd-turn-failed-chain-c"),
      threadId: ThreadId.make("thread-1"),
      messageId: asMessageId("user-message-failed-chain"),
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    await harness.runEffect(Deferred.await(enteredC));

    // C owns before either successful RPC returns. Since ownership without a
    // delivery is not replacement evidence, B becomes the survivor when it
    // succeeds and A alone becomes stale.
    await harness.runEffect(Deferred.succeed(releaseA, undefined));
    await harness.runEffect(Deferred.await(recordedA));
    await harness.runEffect(Deferred.succeed(releaseB, undefined));
    await harness.runEffect(Deferred.await(recordedB));
    await waitFor(() =>
      harness.interruptTurn.mock.calls.some(
        (call) => (call[0] as { turnId?: string }).turnId === asTurnId("turn-failed-chain-a"),
      ),
    );
    await harness.runEffect(Deferred.succeed(releaseCFailure, undefined));
    await waitFor(async () => {
      const model = await harness.readModel();
      return (
        model.threads
          .find((thread) => thread.id === ThreadId.make("thread-1"))
          ?.activities.some(
            (activity) =>
              activity.kind === "provider.turn.start.failed" &&
              (activity.payload as { detail?: string }).detail?.includes(
                "current owner c failed before delivery",
              ),
          ) === true
      );
    });
    await harness.drain();
    recordDeliverySpy.mockRestore();

    expect(sendCount).toBe(3);
    expect(
      harness.interruptTurn.mock.calls.some(
        (call) => (call[0] as { turnId?: string }).turnId === asTurnId("turn-failed-chain-b"),
      ),
    ).toBe(false);
    expect(
      harness.interruptTurn.mock.calls.some(
        (call) => (call[0] as { turnId?: string }).turnId === asTurnId("turn-failed-chain-c"),
      ),
    ).toBe(false);
    const failure = (await harness.readModel()).threads
      .find((thread) => thread.id === ThreadId.make("thread-1"))
      ?.activities.find(
        (activity) =>
          activity.kind === "provider.turn.start.failed" &&
          (activity.payload as { detail?: string }).detail?.includes(
            "current owner c failed before delivery",
          ),
      );
    expect(failure).toBeDefined();
  });

  it("does not interrupt when superseding steers return the same active turn id", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const releaseOlderSend = await harness.makeLatch();
    const olderSendEntered = await harness.makeLatch();
    const newerDeliveryRecorded = await harness.makeLatch();
    const olderDeliveryRecorded = await harness.makeLatch();
    let sameMessageSendCount = 0;
    let deliveryStampCount = 0;

    const originalRecordDelivery = harness.sendClaims.recordDelivery;
    const recordDeliverySpy = vi
      .spyOn(harness.sendClaims, "recordDelivery")
      .mockImplementation((input: Parameters<typeof originalRecordDelivery>[0]) =>
        originalRecordDelivery(input).pipe(
          Effect.tap(() => {
            deliveryStampCount += 1;
            return deliveryStampCount === 1
              ? Deferred.succeed(newerDeliveryRecorded, undefined)
              : Deferred.succeed(olderDeliveryRecorded, undefined);
          }),
        ),
      );
    harness.sendTurn.mockImplementation((input: unknown) =>
      Effect.gen(function* () {
        if ((input as { input?: string }).input !== "shared steer turn") {
          return {
            threadId: ThreadId.make("thread-1"),
            turnId: asTurnId("turn-unrelated"),
          };
        }
        sameMessageSendCount += 1;
        if (sameMessageSendCount === 1) {
          yield* Deferred.succeed(olderSendEntered, undefined);
          yield* Deferred.await(releaseOlderSend);
        }
        return {
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-shared-active"),
          steered: true,
        };
      }),
    );

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-shared-steer-older"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-shared-steer"),
        role: "user",
        text: "shared steer turn",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt,
    });
    await harness.runEffect(Deferred.await(olderSendEntered));
    await harness.dispatch({
      type: "thread.turn.resume",
      commandId: CommandId.make("cmd-turn-shared-steer-newer"),
      threadId: ThreadId.make("thread-1"),
      messageId: asMessageId("user-message-shared-steer"),
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await harness.runEffect(Deferred.await(newerDeliveryRecorded));
    await harness.runEffect(Deferred.succeed(releaseOlderSend, undefined));
    await harness.runEffect(Deferred.await(olderDeliveryRecorded));
    await harness.drain();
    recordDeliverySpy.mockRestore();

    expect(sameMessageSendCount).toBe(2);
    expect(harness.interruptTurn.mock.calls).toHaveLength(0);
    expect(harness.stopSession.mock.calls).toHaveLength(0);
  });

  it("interrupts a late older return after the newer replacement already fenced", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const releaseOlderSend = await harness.makeLatch();
    const olderSendEntered = await harness.makeLatch();
    const newerFenceCompleted = await harness.makeLatch();
    let sameMessageSendCount = 0;

    const originalAcquire = harness.sendClaims.acquire;
    const acquireSpy = vi
      .spyOn(harness.sendClaims, "acquire")
      .mockImplementation((input: Parameters<typeof originalAcquire>[0]) =>
        originalAcquire(input).pipe(
          Effect.tap(() =>
            sameMessageSendCount === 2
              ? Deferred.succeed(newerFenceCompleted, undefined)
              : Effect.void,
          ),
        ),
      );
    harness.sendTurn.mockImplementation((input: unknown) =>
      Effect.gen(function* () {
        if ((input as { input?: string }).input !== "older returns after fence") {
          return {
            threadId: ThreadId.make("thread-1"),
            turnId: asTurnId("turn-unrelated"),
          };
        }
        sameMessageSendCount += 1;
        if (sameMessageSendCount === 1) {
          yield* Deferred.succeed(olderSendEntered, undefined);
          yield* Deferred.await(releaseOlderSend);
          return {
            threadId: ThreadId.make("thread-1"),
            turnId: asTurnId("turn-late-older"),
          };
        }
        return {
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-fenced-newer"),
        };
      }),
    );

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-late-older"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-late-older"),
        role: "user",
        text: "older returns after fence",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt,
    });
    await harness.runEffect(Deferred.await(olderSendEntered));
    await harness.dispatch({
      type: "thread.turn.resume",
      commandId: CommandId.make("cmd-turn-fenced-newer"),
      threadId: ThreadId.make("thread-1"),
      messageId: asMessageId("user-message-late-older"),
      createdAt: "2026-01-01T00:00:01.000Z",
    });

    // This latch fires from the newer sender's post-delivery acquire, proving
    // its replacement was stamped and its late-stop fence completed before the
    // old provider RPC is allowed to return.
    await harness.runEffect(Deferred.await(newerFenceCompleted));
    expect(harness.interruptTurn.mock.calls).toHaveLength(0);
    await harness.runEffect(Deferred.succeed(releaseOlderSend, undefined));
    await waitFor(() =>
      harness.interruptTurn.mock.calls.some(
        (call) => (call[0] as { turnId?: string }).turnId === asTurnId("turn-late-older"),
      ),
    );
    await harness.drain();
    acquireSpy.mockRestore();

    expect(
      harness.interruptTurn.mock.calls.some(
        (call) => (call[0] as { turnId?: string }).turnId === asTurnId("turn-fenced-newer"),
      ),
    ).toBe(false);
    expect(harness.stopSession.mock.calls).toHaveLength(0);
  });

  it("sends once when the identical turn-start command is delivered twice", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const sentinelCreatedAt = "2026-01-01T00:00:02.000Z";

    // The send-claim repository is row-idempotent but NOT send-idempotent: an
    // identical retry re-acquires its own claim and is granted `true` a second
    // time, by design, so a replayed request is not misread as superseded by
    // itself. At-most-once for the PROVIDER is therefore established above that
    // table, and this pins it at the boundary where a duplicate actually costs
    // something — a second prompt delivered to the provider.
    //
    // Two independent mechanisms currently cover this: the engine's command
    // receipt (same commandId returns the recorded result without re-deciding)
    // and the reactor's own `hasHandledTurnStartRecently` key. Disabling either
    // one alone leaves this test passing; disabling both makes it fail with 2
    // sends. That is deliberate — the assertion is the end-to-end guarantee, not
    // any single implementation of it, so a refactor that moves suppression
    // between the two layers stays green while removing it does not.
    const duplicate = {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-delivered-twice"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-1"),
        role: "user",
        text: "deliver me twice",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt,
    } as const;

    await harness.dispatch(duplicate);
    await waitFor(() =>
      harness.sendTurn.mock.calls.some(
        (call) => (call[0] as { input?: string }).input === "deliver me twice",
      ),
    );
    // Redelivered only after the first has genuinely reached the provider, which
    // is the ordering that makes the duplicate dangerous: the claim row now
    // exists and names this very request, so the repository will say yes again.
    await harness.dispatch(duplicate);

    // Sentinel after the redelivery, so "not sent twice" is distinguishable
    // from "the second delivery has not been processed yet".
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-duplicate-sentinel"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-2"),
        role: "user",
        text: "duplicate sentinel",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: sentinelCreatedAt,
    });
    await waitFor(() =>
      harness.sendTurn.mock.calls.some(
        (call) => (call[0] as { input?: string }).input === "duplicate sentinel",
      ),
    );
    await harness.drain();

    const drivenInputs = harness.sendTurn.mock.calls.map(
      (call) => (call[0] as { input?: string }).input,
    );
    expect(drivenInputs.filter((input) => input === "deliver me twice").length).toBe(1);
    // Control: a reactor that had simply stopped sending would also satisfy the
    // count above.
    expect(drivenInputs).toContain("duplicate sentinel");
  });

  it("refuses to send a turn-start the cancel barrier already covers", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const sentinelCreatedAt = "2026-01-01T00:00:01.000Z";

    // The window the durable send-claim closes is BETWEEN the reactor's final
    // supersession read and its `sendTurn` — a stop committed there passes a
    // check that already succeeded. That interleaving cannot be scheduled
    // reliably from outside the reactor, so this drives the barrier directly to
    // its post-condition instead: the state the interrupt path leaves behind
    // when it wins the race. What is under test is the consequence — the
    // reactor must consult the claim on the send path and honor a refusal — and
    // that is exactly what a real interrupt landing in the gap would produce.
    //
    // The event log is deliberately left clean: no interrupt event exists, so
    // every event-log guard in `processTurnStartRequested` passes and the claim
    // is the only thing that can stop this send. If the reactor ever stopped
    // consulting it, no other check would catch that.
    await harness.cancelSendClaims({
      threadId: ThreadId.make("thread-1"),
      // Above any sequence this thread's turn-start can be appended at, so the
      // barrier covers it however the surrounding events are ordered.
      canceledThroughSequence: 1_000_000,
      updatedAt: createdAt,
    });

    await harness.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-thread-create-claim-sentinel"),
      threadId: ThreadId.make("thread-2"),
      projectId: asProjectId("project-1"),
      title: "Sentinel Thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt,
    });

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-claim-stopped"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-1"),
        role: "user",
        text: "stopped before sending",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt,
    });

    // Sentinel on a second thread, dispatched after, proves the stopped
    // turn-start was processed to a decision rather than merely still queued —
    // without it, "never sent" and "not sent yet" look identical.
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-claim-sentinel"),
      threadId: ThreadId.make("thread-2"),
      message: {
        messageId: asMessageId("user-sentinel"),
        role: "user",
        text: "sentinel turn",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: sentinelCreatedAt,
    });
    await waitFor(() =>
      harness.sendTurn.mock.calls.some(
        (call) => (call[0] as { input?: string }).input === "sentinel turn",
      ),
    );
    await harness.drain();

    const drivenInputs = harness.sendTurn.mock.calls.map(
      (call) => (call[0] as { input?: string }).input,
    );
    expect(drivenInputs).not.toContain("stopped before sending");
    // The barrier is thread-scoped, so the other thread is untouched. This is
    // the control against a claim that refuses everything and would otherwise
    // satisfy the assertion above by breaking the reactor outright.
    expect(drivenInputs).toContain("sentinel turn");
  });

  it("skips an undriven turn-start below a session stop", async () => {
    const harness = await createHarness();
    const blockerCreatedAt = "2026-01-01T00:00:00.000Z";
    const pendingCreatedAt = "2026-01-01T00:00:01.000Z";
    const stopCreatedAt = "2026-01-01T00:00:02.000Z";
    const sentinelCreatedAt = "2026-01-01T00:00:03.000Z";

    // The sibling test above proves this for `thread.turn.interrupt`. Stopping
    // the whole SESSION is strictly broader than interrupting one turn, so it
    // must suppress at least as much — but the event-log guard originally
    // counted only turn interrupts, which let a queued turn-start sail past a
    // user who had shut the session down entirely.
    //
    // The consequence is worse than a stray prompt. `ProviderService.sendTurn`
    // resolves with `allowRecovery: true`, so the slipped send does not fail
    // against a dead session — it RESURRECTS it, and the user watches a thread
    // they stopped come back to life and start working.
    //
    // This test isolates the event-log guard specifically. The worker is parked
    // inside `startSession` when the stop is appended, so the stop is still
    // behind the queued turn-start in the FIFO queue: the reactor has not
    // processed it and the durable cancel barrier has therefore NOT been raised
    // yet. The event log is the only thing that can suppress this send.
    let releaseWorker: () => void = () => {};
    const workerGate = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    const originalStartSession = harness.startSession.getMockImplementation();
    if (!originalStartSession) {
      throw new Error("startSession mock implementation missing");
    }
    harness.startSession.mockImplementationOnce((threadId, sessionInput) =>
      Effect.promise(() => workerGate).pipe(
        Effect.flatMap(() => originalStartSession(threadId, sessionInput)),
      ),
    );

    await harness.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-thread-create-session-stop"),
      threadId: ThreadId.make("thread-2"),
      projectId: asProjectId("project-1"),
      title: "Sentinel Thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: blockerCreatedAt,
    });

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-stop-blocker"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-blocker"),
        role: "user",
        text: "blocker turn",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: blockerCreatedAt,
    });
    await waitFor(() => harness.startSession.mock.calls.length === 1);

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-below-session-stop"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-1"),
        role: "user",
        text: "stop the session on me",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: pendingCreatedAt,
    });
    await harness.dispatch({
      type: "thread.session.stop",
      commandId: CommandId.make("cmd-session-stop-suppresses"),
      threadId: ThreadId.make("thread-1"),
      createdAt: stopCreatedAt,
    });
    // Sentinel on a second thread proves the suppressed turn-start ahead of it
    // in the FIFO queue reached a decision, rather than merely never having been
    // reached.
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-session-stop-sentinel"),
      threadId: ThreadId.make("thread-2"),
      message: {
        messageId: asMessageId("user-sentinel"),
        role: "user",
        text: "sentinel turn",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: sentinelCreatedAt,
    });

    releaseWorker();
    await waitFor(() =>
      harness.sendTurn.mock.calls.some(
        (call) => (call[0] as { input?: string }).input === "sentinel turn",
      ),
    );
    await harness.drain();

    const drivenInputs = harness.sendTurn.mock.calls.map(
      (call) => (call[0] as { input?: string }).input,
    );
    expect(drivenInputs).not.toContain("stop the session on me");
    // The blocker was parked inside `startSession` when the stop landed, so its
    // prompt had not reached the provider either — undriven in exactly the sense
    // that matters.
    expect(drivenInputs).not.toContain("blocker turn");
    // Control against a reactor that has simply stopped sending, and against a
    // stop that poisons every thread rather than its own.
    expect(drivenInputs).toContain("sentinel turn");
  });

  it("raises the cancel barrier when the session is stopped", async () => {
    const harness = await createHarness();
    const stopCreatedAt = "2026-01-01T00:00:00.000Z";
    const sentinelCreatedAt = "2026-01-01T00:00:01.000Z";

    // The second half of the same defect, and a genuinely separate mechanism
    // from the test above. The event-log guard is read BEFORE the send; it
    // cannot help a turn-start that already passed it and is inside `sendTurn`
    // when the user stops the session. Only the durable barrier can, because the
    // post-send fence reads it — so `processSessionStopRequested` has to raise
    // it exactly as the turn-interrupt path does.
    //
    // Asserted at the repository, on the state the reactor leaves behind, for
    // the same reason the barrier's sibling test is: the interleaving that makes
    // the barrier load-bearing lives strictly between the reactor's own guard
    // read and its RPC, and cannot be scheduled from outside. The barrier's
    // post-condition is what the fence actually consumes.
    await harness.dispatch({
      type: "thread.session.stop",
      commandId: CommandId.make("cmd-session-stop-raises-barrier"),
      threadId: ThreadId.make("thread-1"),
      createdAt: stopCreatedAt,
    });
    // FIFO sentinel on a second thread: once this has driven, the stop ahead of
    // it has been processed.
    await harness.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-thread-create-barrier-sentinel"),
      threadId: ThreadId.make("thread-2"),
      projectId: asProjectId("project-1"),
      title: "Sentinel Thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: sentinelCreatedAt,
    });
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-barrier-sentinel"),
      threadId: ThreadId.make("thread-2"),
      message: {
        messageId: asMessageId("user-sentinel"),
        role: "user",
        text: "sentinel turn",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: sentinelCreatedAt,
    });
    await waitFor(() =>
      harness.sendTurn.mock.calls.some(
        (call) => (call[0] as { input?: string }).input === "sentinel turn",
      ),
    );
    await harness.drain();

    const events = await harness.readEvents();
    const stopSequence = events.find(
      (event) => event.type === "thread.session-stop-requested",
    )?.sequence;
    expect(stopSequence).toBeDefined();

    // A send that was in flight across the stop carries a sequence at or below
    // it, and must come back `canceled` so the fence interrupts the turn it
    // started.
    const covered = (await harness.acquireSendClaim({
      threadId: ThreadId.make("thread-1"),
      messageId: asMessageId("user-message-1"),
      requestSequence: stopSequence!,
      claimedAt: stopCreatedAt,
    })) as { _tag: string };
    expect(covered._tag).toBe("canceled");

    // Bounded by the stop's sequence: work the user requests AFTERWARDS is not
    // covered. Without this the barrier would poison the thread instead of
    // fencing the send that crossed the stop.
    const above = (await harness.acquireSendClaim({
      threadId: ThreadId.make("thread-1"),
      messageId: asMessageId("user-message-2"),
      requestSequence: stopSequence! + 1,
      claimedAt: stopCreatedAt,
    })) as { _tag: string };
    expect(above._tag).toBe("acquired");
  });

  it("retries a failed provider session stop and reports it without projecting or redriving", async () => {
    const harness = await createHarness();
    const stopCreatedAt = "2026-01-01T00:00:00.000Z";

    await harness.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-set-for-provider-stop-failure"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "ready",
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex_work"),
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: stopCreatedAt,
      },
      createdAt: stopCreatedAt,
    });

    // Count executions inside the effect. The reactor suspends the provider
    // call before retrying, so this pins the actual adapter attempts rather than
    // how many effect values the mock happened to construct.
    const stopAttempts: Array<ThreadId> = [];
    harness.stopSession.mockImplementation((input: unknown) =>
      Effect.suspend(() => {
        stopAttempts.push((input as { threadId: ThreadId }).threadId);
        return Effect.fail(
          new ProviderAdapterRequestError({
            provider: ProviderDriverKind.make("codex"),
            method: "session/stop",
            detail: "provider stop transport unavailable",
          }),
        );
      }),
    );

    // A narrowed internal stop would ordinarily inspect and re-drive requests
    // above its cutoff after teardown. Spying this read makes "no redrive"
    // load-bearing even though no real prompt needs to be queued in this test:
    // reaching the success tail would call it regardless of whether it found
    // rows.
    const redriveReadSpy = vi.spyOn(harness.eventStore, "listThreadTurnStartsAboveCutoff");

    await harness.dispatch({
      type: "thread.session.stop",
      commandId: CommandId.make("cmd-session-provider-stop-fails"),
      threadId: ThreadId.make("thread-1"),
      canceledThroughSequence: NonNegativeInt.make(0),
      createdAt: stopCreatedAt,
    });

    await waitFor(async () => {
      const model = await harness.readModel();
      return (
        model.threads
          .find((entry) => entry.id === ThreadId.make("thread-1"))
          ?.activities.some(
            (activity) =>
              activity.kind === "provider.session.stop.failed" &&
              activity.summary === "Provider session stop failed",
          ) === true
      );
    });
    await harness.drain();

    expect(stopAttempts).toEqual([ThreadId.make("thread-1"), ThreadId.make("thread-1")]);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.find(
        (activity) =>
          activity.kind === "provider.session.stop.failed" &&
          activity.summary === "Provider session stop failed",
      ),
    ).toMatchObject({
      tone: "error",
      payload: {
        detail: expect.stringContaining("provider stop transport unavailable"),
      },
    });

    // Final stop failure leaves both runtime-facing and projected state live.
    // In particular, the handler must not enter the success-only recovery tail
    // and must not drive any provider turn as a side effect.
    expect(thread?.session?.status).toBe("ready");
    expect(redriveReadSpy).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();
    redriveReadSpy.mockRestore();
  });

  it("abandons a session stop it cannot record rather than half-stopping the session", async () => {
    const harness = await createHarness();
    const stopCreatedAt = "2026-01-01T00:00:00.000Z";

    await harness.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-set-for-unraisable-stop"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "ready",
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex_work"),
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: stopCreatedAt,
      },
      createdAt: stopCreatedAt,
    });

    // The barrier is the half of the stop that reaches work not yet sent; the
    // provider call and the `stopped` projection are the half the user can see.
    // Completing only the visible half is worse than completing neither: a
    // queued turn-start still passes its claim guard, calls `sendTurn`, and —
    // because a send to a stopped session resolves with `allowRecovery: true` —
    // recovers the persisted binding and RESURRECTS the session, delivering a
    // prompt against a thread the UI now reads as stopped.
    //
    // Spied on the resolved service instance rather than driven from outside,
    // because a barrier write that FAILS is not a state any external caller can
    // produce; layer memoization makes this the same object the reactor holds.
    const cancelAttempts: Array<number> = [];
    const cancelSpy = vi
      .spyOn(harness.sendClaims, "cancel")
      .mockImplementation((input: Parameters<typeof harness.sendClaims.cancel>[0]) =>
        // Counted INSIDE the effect, not in the mock body. The reactor builds
        // the cancel effect once and retries that value, so a counter in the
        // body would record a single call however many times the effect ran —
        // and this test's whole point is the retry count.
        Effect.suspend(() => {
          cancelAttempts.push(input.canceledThroughSequence);
          // A typed persistence failure, not a defect: the retry is scoped to
          // the error channel, and a contended SQLite write is the transient
          // case it exists for.
          return Effect.fail(
            new PersistenceSqlError({ operation: "cancel", detail: "barrier write failed" }),
          );
        }),
      );

    await harness.dispatch({
      type: "thread.session.stop",
      commandId: CommandId.make("cmd-session-stop-unraisable-barrier"),
      threadId: ThreadId.make("thread-1"),
      createdAt: stopCreatedAt,
    });

    // The reported failure is the happens-after point, not a FIFO sentinel on
    // another thread. Every assertion below is about what did NOT happen, and
    // the activity is appended by `raiseCancelBarrier` itself — strictly after
    // the last retry and strictly before the handler could reach `stopSession`.
    // Draining alone would not do: the retries sleep on the real clock, so a
    // drain that returned mid-backoff would restore the spy and let the
    // remaining attempts hit the real (working) repository, quietly turning
    // this into a test of the success path.
    await waitFor(async () => {
      const model = await harness.readModel();
      return (
        model.threads
          .find((entry) => entry.id === ThreadId.make("thread-1"))
          ?.activities.some((activity) => activity.kind === "provider.session.stop.failed") === true
      );
    });
    await harness.drain();
    cancelSpy.mockRestore();

    // Three attempts: the initial one plus `times: 2`. Fewer means the retry is
    // not wired; more means it is unbounded.
    expect(cancelAttempts).toHaveLength(3);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));

    // Reported, not swallowed — the user has to be able to see that the stop
    // did not take and press it again.
    const activity = thread?.activities.find(
      (entry) => entry.kind === "provider.session.stop.failed",
    );
    expect(activity?.tone).toBe("error");

    // And the visible half was NOT performed. Both assertions matter: skipping
    // only one of them leaves the thread reading as stopped while still able to
    // accept — and resurrect on — a queued send.
    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(thread?.session?.status).toBe("ready");
  });

  it("skips a turn-start-requested superseded by a newer re-request for the same message", async () => {
    const harness = await createHarness();
    const staleCreatedAt = "2026-01-01T00:00:00.000Z"; // original interrupted turn-start
    const blockerCreatedAt = "2026-01-01T00:00:01.000Z";
    const resumeCreatedAt = "2026-01-01T00:00:02.000Z"; // newer re-request (auto-resume) wins
    const sentinelCreatedAt = "2026-01-01T00:00:03.000Z";

    // Park the worker on a blocker turn's session start so BOTH the stale
    // original turn-start-requested and the newer resume for the SAME message
    // commit (and project) before the worker processes either. This
    // deterministically reproduces the post-crash timing the guard targets: the
    // pending turn-start row already reflects the resume by the time the reactor
    // reaches the stale original.
    let releaseWorker: () => void = () => {};
    const workerGate = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    const originalStartSession = harness.startSession.getMockImplementation();
    if (!originalStartSession) {
      throw new Error("startSession mock implementation missing");
    }
    harness.startSession.mockImplementationOnce((threadId, sessionInput) =>
      Effect.promise(() => workerGate).pipe(
        Effect.flatMap(() => originalStartSession(threadId, sessionInput)),
      ),
    );

    // A second thread lets the sentinel turn (dispatched last) act as a "prior
    // events fully drained" marker via the single FIFO worker queue — WITHOUT
    // clobbering thread-1's pending turn-start row (one row per thread).
    await harness.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-thread-create-2"),
      threadId: ThreadId.make("thread-2"),
      projectId: asProjectId("project-1"),
      title: "Sentinel Thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: staleCreatedAt,
    });

    // Blocker turn on a DISTINCT message parks the worker inside startSession.
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-blocker"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-blocker"),
        role: "user",
        text: "blocker turn",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: blockerCreatedAt,
    });
    // Confirm the worker is parked (startSession invoked but not yet resolved).
    await waitFor(() => harness.startSession.mock.calls.length === 1);

    // Stale original turn-start for msg-1 (older createdAt), then the newer
    // resume for the SAME message. Both project synchronously in dispatch, so
    // thread-1's pending row reflects the resume before the still-parked worker
    // reaches the stale event.
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-stale"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-1"),
        role: "user",
        text: "resume me",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: staleCreatedAt,
    });
    await harness.dispatch({
      type: "thread.turn.resume",
      commandId: CommandId.make("cmd-turn-resume"),
      threadId: ThreadId.make("thread-1"),
      messageId: asMessageId("user-message-1"),
      createdAt: resumeCreatedAt,
    });
    // Sentinel turn on thread-2, dispatched last — its drive proves the stale
    // and resume events ahead of it in the FIFO queue have been processed.
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-sentinel"),
      threadId: ThreadId.make("thread-2"),
      message: {
        messageId: asMessageId("user-sentinel"),
        role: "user",
        text: "sentinel turn",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: sentinelCreatedAt,
    });

    releaseWorker();
    await waitFor(() =>
      harness.sendTurn.mock.calls.some(
        (call) => (call[0] as { input?: string }).input === "sentinel turn",
      ),
    );

    const msg1Drives = harness.sendTurn.mock.calls.filter(
      (call) => (call[0] as { input?: string }).input === "resume me",
    );
    // The stale original was superseded and skipped: msg-1 drove exactly once
    // (the resume). Total = blocker + resume + sentinel = 3; without the guard
    // the stale original would also drive, giving 4.
    expect(msg1Drives.length).toBe(1);
    expect(harness.sendTurn.mock.calls.length).toBe(3);
  });

  it("drives every turn-start-requested for DISTINCT messages (no over-suppression)", async () => {
    const harness = await createHarness();
    const olderCreatedAt = "2026-01-01T00:00:00.000Z";
    const newerCreatedAt = "2026-01-01T00:00:02.000Z";

    // Rapid multi-send of two DIFFERENT messages: the newer one's pending row
    // must NOT suppress the older one (the guard is scoped to same-messageId).
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-msg-a"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-a"),
        role: "user",
        text: "message a",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: olderCreatedAt,
    });
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-msg-b"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-b"),
        role: "user",
        text: "message b",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: newerCreatedAt,
    });

    await waitFor(() => harness.sendTurn.mock.calls.length >= 2);
    const inputs = harness.sendTurn.mock.calls.map((call) => (call[0] as { input?: string }).input);
    expect(harness.sendTurn.mock.calls.length).toBe(2);
    expect(inputs).toContain("message a");
    expect(inputs).toContain("message b");
  });

  it("skips every undriven turn-start below an interrupt, and drives one issued above it", async () => {
    const harness = await createHarness();
    const blockerCreatedAt = "2026-01-01T00:00:00.000Z";
    const pendingCreatedAt = "2026-01-01T00:00:01.000Z";
    const interruptCreatedAt = "2026-01-01T00:00:02.000Z";
    const afterStopCreatedAt = "2026-01-01T00:00:03.000Z";
    const sentinelCreatedAt = "2026-01-01T00:00:04.000Z";

    // Park the worker on a blocker turn's session start so the user's stop lands
    // BEFORE the worker reaches the queued turn-start-requested events behind it.
    // This reproduces the race the guard targets: the user stops the thread while
    // the reactor is still lagging behind queued starts that were accepted but
    // never driven.
    //
    // TWO queued starts precede the interrupt, which is the case an earlier
    // revision got wrong. That version bound the interrupt to the most recent
    // turn-start below it, so with `start A → start B → interrupt` only B was
    // suppressed and A was still sent to the provider after the user pressed
    // stop. Both must be skipped. The start issued ABOVE the interrupt is the
    // control in the other direction: suppression must not leak past the stop
    // and swallow work the user requested afterwards.
    let releaseWorker: () => void = () => {};
    const workerGate = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    const originalStartSession = harness.startSession.getMockImplementation();
    if (!originalStartSession) {
      throw new Error("startSession mock implementation missing");
    }
    harness.startSession.mockImplementationOnce((threadId, sessionInput) =>
      Effect.promise(() => workerGate).pipe(
        Effect.flatMap(() => originalStartSession(threadId, sessionInput)),
      ),
    );

    // Sentinel thread drains the FIFO worker queue without clobbering thread-1's
    // single pending turn-start row.
    await harness.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-thread-create-2"),
      threadId: ThreadId.make("thread-2"),
      projectId: asProjectId("project-1"),
      title: "Sentinel Thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: blockerCreatedAt,
    });

    // Blocker turn on a DISTINCT message parks the worker inside startSession.
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-blocker"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-blocker"),
        role: "user",
        text: "blocker turn",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: blockerCreatedAt,
    });
    await waitFor(() => harness.startSession.mock.calls.length === 1);

    // Queue TWO more messages, then interrupt the thread before the parked
    // worker can drive either. The interrupt is id-less (no active turn yet), so
    // it flags the single pending row without bumping any request's sequence —
    // only the event log records that it landed above both.
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-interrupted-a"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-1"),
        role: "user",
        text: "interrupt me",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: pendingCreatedAt,
    });
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-interrupted-b"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-2"),
        role: "user",
        text: "interrupt me too",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: pendingCreatedAt,
    });
    await harness.dispatch({
      type: "thread.turn.interrupt",
      commandId: CommandId.make("cmd-turn-interrupt"),
      threadId: ThreadId.make("thread-1"),
      createdAt: interruptCreatedAt,
    });
    // Issued AFTER the stop: the user asked for this one, so it must drive.
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-after-stop"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-3"),
        role: "user",
        text: "after the stop",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: afterStopCreatedAt,
    });
    // Sentinel proves the interrupted turn-starts ahead of it in the FIFO queue
    // have been processed by the time this drives.
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-sentinel"),
      threadId: ThreadId.make("thread-2"),
      message: {
        messageId: asMessageId("user-sentinel"),
        role: "user",
        text: "sentinel turn",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: sentinelCreatedAt,
    });

    releaseWorker();
    await waitFor(() =>
      harness.sendTurn.mock.calls.some(
        (call) => (call[0] as { input?: string }).input === "sentinel turn",
      ),
    );

    const drivenInputs = harness.sendTurn.mock.calls.map(
      (call) => (call[0] as { input?: string }).input,
    );
    // Every start below the stop is skipped, including the OLDEST — which a
    // most-recent-start-owns-the-interrupt rule would have let through. The
    // blocker counts too: parked inside `startSession`, its prompt had not
    // reached the provider when the user stopped the thread, so it is undriven
    // in exactly the sense that matters here. Nothing below the stop was sent,
    // so nothing below the stop survives it.
    expect(drivenInputs).not.toContain("blocker turn");
    expect(drivenInputs).not.toContain("interrupt me");
    expect(drivenInputs).not.toContain("interrupt me too");
    // The start issued above the stop, on the SAME thread, is untouched — so
    // suppression is bounded by the interrupt's sequence rather than poisoning
    // the thread. This is the control against over-suppression.
    expect(drivenInputs).toContain("after the stop");
    // Total = after-the-stop + sentinel = 2; without the guard the three starts
    // below the stop would also drive, giving 5.
    expect(harness.sendTurn.mock.calls.length).toBe(2);
  });

  it("skips a superseded turn-start while unrelated messages interleave on the thread", async () => {
    const harness = await createHarness();
    const staleCreatedAt = "2026-01-01T00:00:00.000Z"; // original turn-start for msg-1
    const blockerCreatedAt = "2026-01-01T00:00:01.000Z";
    const resumeCreatedAt = "2026-01-01T00:00:02.000Z"; // auto-resume re-request for msg-1
    const interleavedCreatedAt = "2026-01-01T00:00:03.000Z"; // DIFFERENT message, same thread
    const sentinelCreatedAt = "2026-01-01T00:00:04.000Z";

    // Supersession is judged from the append-only event log, not from the
    // pending turn-start projection rows, and this case is why. Those rows are
    // CONSUMED — `turn.started` deletes the placeholder it adopts — so a guard
    // reading them finds nothing left to compare against once a turn has begun,
    // concludes "not superseded", and drives BOTH the stale original and its
    // resume: the same prompt sent to the provider twice. Here a third message
    // lands between the two, so the thread's pending state is churning while
    // msg-1's re-issue has to stay visible. The event log is never consumed: the
    // re-request remains observable at its own sequence no matter what arrives
    // after it.
    let releaseWorker: () => void = () => {};
    const workerGate = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    const originalStartSession = harness.startSession.getMockImplementation();
    if (!originalStartSession) {
      throw new Error("startSession mock implementation missing");
    }
    harness.startSession.mockImplementationOnce((threadId, sessionInput) =>
      Effect.promise(() => workerGate).pipe(
        Effect.flatMap(() => originalStartSession(threadId, sessionInput)),
      ),
    );

    await harness.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-thread-create-2"),
      threadId: ThreadId.make("thread-2"),
      projectId: asProjectId("project-1"),
      title: "Sentinel Thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: blockerCreatedAt,
    });

    // Park the worker so every event below commits before any is processed.
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-blocker"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-blocker"),
        role: "user",
        text: "blocker turn",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: blockerCreatedAt,
    });
    await waitFor(() => harness.startSession.mock.calls.length === 1);

    // Stale original for msg-1, then its auto-resume (same message).
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-stale"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-1"),
        role: "user",
        text: "resume me",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: staleCreatedAt,
    });
    await harness.dispatch({
      type: "thread.turn.resume",
      commandId: CommandId.make("cmd-turn-resume"),
      threadId: ThreadId.make("thread-1"),
      messageId: asMessageId("user-message-1"),
      createdAt: resumeCreatedAt,
    });

    // A turn-start for a DIFFERENT message on the SAME thread, landing between
    // msg-1's re-issue and the decision about it. Nothing about msg-1 may be
    // lost because unrelated work arrived after it.
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-interleaved"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-2"),
        role: "user",
        text: "interleaved message",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: interleavedCreatedAt,
    });

    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-sentinel"),
      threadId: ThreadId.make("thread-2"),
      message: {
        messageId: asMessageId("user-sentinel"),
        role: "user",
        text: "sentinel turn",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: sentinelCreatedAt,
    });

    releaseWorker();
    await waitFor(() =>
      harness.sendTurn.mock.calls.some(
        (call) => (call[0] as { input?: string }).input === "sentinel turn",
      ),
    );

    const inputs = harness.sendTurn.mock.calls.map((call) => (call[0] as { input?: string }).input);
    // msg-1 drives exactly once — the resume, not the original it supersedes.
    expect(inputs.filter((input) => input === "resume me").length).toBe(1);
    // The interleaved message is a genuinely distinct request and must still
    // drive — this is what keeps the fix from degenerating into blanket
    // suppression of anything that follows a re-issue.
    expect(inputs.filter((input) => input === "interleaved message").length).toBe(1);
    // blocker + resume + interleaved + sentinel = 4. Reading the mutable pending
    // rows instead of the event log yields 5: the stale original drives as well.
    expect(harness.sendTurn.mock.calls.length).toBe(4);
  });
});
