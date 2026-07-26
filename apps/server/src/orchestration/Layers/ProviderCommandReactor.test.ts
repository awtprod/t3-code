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
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import {
  providerErrorLabel,
  providerErrorLabelFromInstanceHint,
  ProviderCommandReactorLive,
} from "./ProviderCommandReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
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
    | ProviderTurnSendClaimRepository,
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
    const sendTurn = vi.fn((_: unknown) =>
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
    const stopSession = vi.fn((input: unknown) =>
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
      readEvents,
      readEventsWithPayloads,
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

  it("leaves a newer turn alone when an older send loses its claim to it", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";

    // The sibling test above covers the case the fence exists FOR. This covers
    // the case it must not create.
    //
    // Losing the claim is not evidence of a stop. A session-exit auto-resume
    // re-issues the same message at a higher sequence and takes the claim by
    // design, and the turn it starts is work the user wants. If the fence read
    // "I no longer hold the claim" as "I was stopped", it would interrupt that
    // replacement — turning a mechanism that recovers a missed stop into one
    // that kills healthy turns, which is the worse of the two failures.
    //
    // The interleaving is scheduled from inside `sendTurn`, the only place it
    // can be: while the first send is in flight, a newer request for the SAME
    // message acquires the claim. Nothing raises the barrier, so the correct
    // reading is "superseded", not "canceled".
    harness.sendTurn.mockImplementationOnce((_: unknown) =>
      Effect.promise(async () => {
        await harness.acquireSendClaim({
          threadId: ThreadId.make("thread-1"),
          messageId: asMessageId("user-message-1"),
          requestSequence: 1_000_000,
          claimedAt: createdAt,
        });
        return {
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-1"),
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

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    // A sentinel turn that must reach the provider, so "no interrupt" is
    // distinguishable from "the fence has not run yet" — the fence for the
    // first send is scheduled before this send is even dispatched, so by the
    // time this one lands the fence has had its chance.
    await harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-superseded-sentinel"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("user-message-2"),
        role: "user",
        text: "supersede sentinel",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    await waitFor(() =>
      harness.sendTurn.mock.calls.some(
        (call) => (call[0] as { input?: string }).input === "supersede sentinel",
      ),
    );

    expect(harness.interruptTurn.mock.calls).toHaveLength(0);
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
