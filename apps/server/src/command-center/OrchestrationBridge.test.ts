import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as OrchestrationBridge from "./OrchestrationBridge.ts";

const projectId = ProjectId.make("project:bridge-test");
const codexSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-example" };
const claudeSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-example",
};
const project = {
  id: projectId,
  title: "Example project",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: codexSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deletedAt: null,
} as const;

const adapter = (instanceId: string, driver: string) =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("provider execution is disabled in bridge tests"),
  }) as ProviderAdapter.ProviderAdapterV2["Service"];

const provider = (instanceId: string, driver: string) =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    models: [],
  }) as unknown as ServerProvider;

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const ONE_PIXEL_PNG_BYTES = Buffer.from(ONE_PIXEL_PNG, "base64").byteLength;

function makeHarness() {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
    adapter("codex", "codex"),
    adapter("claudeAgent", "claudeAgent"),
  ]);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "command-center-bridge" },
    layerRegistry,
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest();
  const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(layerReceipts),
  );
  const createWorktree = vi.fn(
    (input: Parameters<GitWorkflow.GitWorkflowService["Service"]["createWorktree"]>[0]) =>
      Effect.succeed({
        worktree: { path: "/repo-worktrees/cc-run", refName: input.newRefName, headSha: "abc" },
      } as never),
  );
  const projectCalls: Array<{ readonly kind: "create" | "update"; readonly input: unknown }> = [];
  const layerExternalServices = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    Layer.succeed(ProjectService.ProjectService, {
      create: (input) =>
        Effect.sync(() => {
          projectCalls.push({ kind: "create", input });
          return project as never;
        }),
      bootstrap: () => Effect.die("unused"),
      update: (input) =>
        Effect.sync(() => {
          projectCalls.push({ kind: "update", input });
          return project as never;
        }),
      delete: () => Effect.die("unused"),
      getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
      getByWorkspaceRoot: () => Effect.succeed(Option.some(project)),
      snapshot: Effect.die("unused"),
      getShell: () => Effect.die("unused"),
      listShells: () => Effect.die("unused"),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      createWorktree,
      renameBranch: (input) => Effect.succeed({ branch: input.newBranch }),
      fetchRemote: () => Effect.void,
      hasCommit: () => Effect.succeed(false),
      remoteExists: () => Effect.succeed(true),
      remoteBranchExists: () => Effect.succeed(true),
      removeWorktree: () => Effect.void,
      resolveRemoteTrackingCommit: () =>
        Effect.succeed({
          commitSha: "remote-main-sha",
          remoteRefName: "origin/main",
          remoteName: "origin",
          remoteUrl: "git@github.com:acme/example.git",
          remotePushUrl: "git@github.com:acme/example.git",
        }),
    }),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: () => Effect.succeed({ status: "no-script" as const }),
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadTitle: () => Effect.succeed({ title: "Generated title" }),
      generateBranchName: () => Effect.succeed({ branch: "generated-branch" }),
    }),
    layerServerSettings,
    ProviderRegistryMock.layer([
      provider("codex", "codex"),
      provider("claudeAgent", "claudeAgent"),
    ]),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      folderForThread: () => Effect.succeed(Option.none()),
    }),
  );
  const layerLaunch = ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerExternalServices,
        layerThreadManagement,
        layerReceipts,
        IdAllocator.layer,
      ),
    ),
  );
  const layerServerConfig = Layer.effect(
    ServerConfig.ServerConfig,
    ProviderReplayHarness.makeReplayServerConfig("command-center-bridge").pipe(Effect.orDie),
  ).pipe(Layer.provide(NodeServices.layer));
  const layerStores = Layer.mergeAll(ProjectionStore.layer, ProjectStore.layer).pipe(
    Layer.provide(layerDatabase),
  );
  const layerBridge = OrchestrationBridge.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerLaunch,
        layerThreadManagement,
        layerStores,
        layerExternalServices,
        layerServerConfig,
        layerDatabase,
        NodeServices.layer,
      ),
    ),
  );
  return {
    layer: Layer.mergeAll(
      layerBridge,
      layerThreadManagement,
      layerServerConfig,
      layerDatabase,
      NodeServices.layer,
    ),
    createWorktree,
    projectCalls,
  };
}

/** Worktree preparation runs on its own fiber after the launch commits (as in ThreadLaunchService tests). */
function waitUntil(predicate: () => boolean): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return;
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
    }
    assert.fail("Condition was not reached before timeout.");
  });
}

const firstTurn = (input: {
  readonly threadId: string;
  readonly command: string;
  readonly text: string;
  readonly modelSelection?: typeof codexSelection;
  readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  readonly worktree?: boolean;
  readonly attachments?: OrchestrationBridge.CommandCenterTurnStartCommand["message"]["attachments"];
}): OrchestrationBridge.CommandCenterTurnStartCommand => {
  const modelSelection = input.modelSelection ?? claudeSelection;
  const runtimeMode = input.runtimeMode ?? "auto";
  return {
    type: "thread.turn.start",
    commandId: CommandId.make(input.command),
    threadId: ThreadId.make(input.threadId),
    message: {
      messageId: MessageId.make(`${input.command}:message`),
      role: "user",
      text: input.text,
      attachments: input.attachments ?? [],
    },
    modelSelection,
    titleSeed: "Example agent",
    runtimeMode,
    interactionMode: "default",
    bootstrap: {
      createThread: {
        projectId,
        title: "Example agent",
        modelSelection,
        runtimeMode,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: "2026-06-20T00:00:00.000Z",
      },
      ...(input.worktree === true
        ? {
            prepareWorktree: {
              projectCwd: "/repo",
              baseBranch: "main",
              branch: "cc/run-example",
              startFromOrigin: true,
            },
            runSetupScript: true,
          }
        : {}),
    },
    createdAt: "2026-06-20T00:00:00.000Z",
  };
};

it.effect(
  "launches a v2 thread with its first message and replays the same command idempotently",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const bridge = yield* OrchestrationBridge.OrchestrationBridge;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const command = firstTurn({
        threadId: "cc-space-agent-example",
        command: "space-agent:example:turn:1",
        text: "Wake up and check the inbox.",
      });

      const first = yield* bridge.dispatchCommand(command);
      const replay = yield* bridge.dispatchCommand(command);

      const shell = Option.getOrUndefined(
        yield* bridge.getThreadShellById(ThreadId.make("cc-space-agent-example")),
      );
      assert.isDefined(shell);
      assert.equal(shell?.projectId, projectId);
      assert.equal(shell?.title, "Example agent");
      assert.equal(shell?.runtimeMode, "auto");
      assert.equal(shell?.modelSelection.instanceId, claudeSelection.instanceId);
      assert.isNotNull(shell?.latestRunId);
      const projection = yield* threads.getThreadProjection(
        ThreadId.make("cc-space-agent-example"),
      );
      const userMessages = projection.messages.filter((message) => message.role === "user");
      assert.deepEqual(
        userMessages.map((message) => message.text),
        ["Wake up and check the inbox."],
      );
      assert.equal(projection.runs.length, 1);
      assert.isAbove(first.sequence, 0);
      assert.equal(replay.sequence, first.sequence);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("sends a follow-up turn to an existing thread", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const bridge = yield* OrchestrationBridge.OrchestrationBridge;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = ThreadId.make("cc-space-agent-follow-up");
    yield* bridge.dispatchCommand(
      firstTurn({ threadId, command: "space-agent:follow-up:1", text: "First turn" }),
    );
    const followUp = yield* bridge.dispatchCommand({
      type: "thread.turn.start",
      commandId: CommandId.make("space-agent:follow-up:2"),
      threadId,
      message: {
        messageId: MessageId.make("space-agent:follow-up:2:message"),
        role: "user",
        text: "Second turn",
        attachments: [],
      },
      runtimeMode: "auto",
      interactionMode: "default",
      createdAt: "2026-06-20T00:01:00.000Z",
    });
    const projection = yield* threads.getThreadProjection(threadId);
    assert.deepEqual(
      projection.messages.filter((message) => message.role === "user").map((m) => m.text),
      ["First turn", "Second turn"],
    );
    assert.isAbove(followUp.sequence, 0);

    const missing = yield* Effect.flip(
      bridge.dispatchCommand({
        type: "thread.turn.start",
        commandId: CommandId.make("space-agent:missing:1"),
        threadId: ThreadId.make("cc-space-agent-missing"),
        message: {
          messageId: MessageId.make("space-agent:missing:1:message"),
          role: "user",
          text: "Hello",
          attachments: [],
        },
        runtimeMode: "auto",
        interactionMode: "default",
        createdAt: "2026-06-20T00:01:00.000Z",
      }),
    );
    assert.equal(missing._tag, "OrchestrationBridgeDispatchError");
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "persists inline image attachments under the thread and prepares the run worktree",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const bridge = yield* OrchestrationBridge.OrchestrationBridge;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const threadId = ThreadId.make("thread-bridge-attachments");
      yield* bridge.dispatchCommand(
        firstTurn({
          threadId,
          command: "bridge:attachments:1",
          text: "Describe this image",
          worktree: true,
          attachments: [
            {
              type: "image",
              name: "pixel.png",
              mimeType: "image/png",
              sizeBytes: ONE_PIXEL_PNG_BYTES,
              dataUrl: `data:image/png;base64,${ONE_PIXEL_PNG}`,
            },
          ],
        }),
      );
      const projection = yield* threads.getThreadProjection(threadId);
      const attachment = projection.messages.find((message) => message.role === "user")
        ?.attachments[0];
      assert.equal(attachment?.type, "image");
      assert.isTrue(attachment?.id.startsWith("thread-bridge-attachments-"));
      const stored = yield* fileSystem.readFile(
        path.join(config.attachmentsDir, `${attachment?.id}.png`),
      );
      assert.equal(stored.byteLength, ONE_PIXEL_PNG_BYTES);
      yield* waitUntil(() => harness.createWorktree.mock.calls.length > 0);
      assert.equal(harness.createWorktree.mock.calls.length, 1);
      assert.include(JSON.stringify(harness.createWorktree.mock.calls[0]?.[0]), "cc/run-example");

      const tampered = yield* Effect.flip(
        bridge.dispatchCommand(
          firstTurn({
            threadId: "thread-bridge-tampered",
            command: "bridge:attachments:2",
            text: "Size mismatch",
            attachments: [
              {
                type: "image",
                name: "pixel.png",
                mimeType: "image/png",
                sizeBytes: ONE_PIXEL_PNG_BYTES + 1,
                dataUrl: `data:image/png;base64,${ONE_PIXEL_PNG}`,
              },
            ],
          }),
        ),
      );
      assert.equal(tampered._tag, "OrchestrationBridgeDispatchError");
      assert.isTrue(
        Option.isNone(yield* bridge.getThreadShellById(ThreadId.make("thread-bridge-tampered"))),
      );
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect.each([
  {
    name: "Codex until the v2 isolation layer exists",
    modelSelection: codexSelection,
    runtimeMode: "auto-accept-edits" as const,
    reason: "Codex isolation is not wired on orchestration v2",
  },
  {
    name: "a provider without a host-filesystem isolation profile",
    modelSelection: claudeSelection,
    runtimeMode: "auto-accept-edits" as const,
    reason: "Command Center runs require Codex",
  },
  {
    name: "full-access sessions",
    modelSelection: codexSelection,
    runtimeMode: "full-access" as const,
    reason: "cannot use full-access",
  },
  {
    name: "an unknown provider instance",
    modelSelection: { instanceId: ProviderInstanceId.make("missing"), model: "x" },
    runtimeMode: "approval-required" as const,
    reason: "is not configured",
  },
])(
  "refuses a cc: thread on $name and creates nothing",
  ({ modelSelection, runtimeMode, reason }) => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const bridge = yield* OrchestrationBridge.OrchestrationBridge;
      const threadId = "cc:automation:run-example";
      const refusal = yield* Effect.flip(
        bridge.dispatchCommand(
          firstTurn({
            threadId,
            command: "cc:run:example:turn",
            text: "Do the task",
            modelSelection,
            runtimeMode,
            worktree: true,
          }),
        ),
      );
      assert.equal(refusal._tag, "CommandCenterIsolationUnavailable");
      assert.include(refusal.message, reason);
      const admission = yield* Effect.flip(
        bridge.admitThread({ threadId: ThreadId.make(threadId), modelSelection, runtimeMode }),
      );
      assert.include(admission.reason, reason);
      assert.isTrue(Option.isNone(yield* bridge.getThreadShellById(ThreadId.make(threadId))));
      assert.equal(harness.createWorktree.mock.calls.length, 0);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("admits threads outside Command Center Runs without consulting providers", () =>
  OrchestrationBridge.admitCommandCenterThread({
    threadId: "cc-space-agent-example",
    modelSelection: { instanceId: ProviderInstanceId.make("anything") },
    runtimeMode: "full-access",
    providers: [],
  }),
);

it.effect("creates a project and records its default model", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const bridge = yield* OrchestrationBridge.OrchestrationBridge;
    yield* bridge.dispatchCommand({
      type: "project.create",
      commandId: CommandId.make("cc:system-project:create:v1"),
      projectId: ProjectId.make("command-center:system"),
      title: "Command Center",
      workspaceRoot: "/base/system/command-center-workspace",
      createWorkspaceRootIfMissing: false,
      defaultModelSelection: codexSelection,
      createdAt: "2026-06-20T00:00:00.000Z",
    });
    assert.deepEqual(harness.projectCalls, [
      {
        kind: "create",
        input: {
          commandId: "cc:system-project:create:v1",
          projectId: "command-center:system",
          title: "Command Center",
          workspaceRoot: "/base/system/command-center-workspace",
          createWorkspaceRootIfMissing: false,
        },
      },
      {
        kind: "update",
        input: {
          commandId: "cc:system-project:create:v1:default-model",
          projectId: "command-center:system",
          defaultModelSelection: codexSelection,
        },
      },
    ]);
  }).pipe(Effect.provide(harness.layer));
});
