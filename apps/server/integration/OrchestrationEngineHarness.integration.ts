// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  CodexSettings,
  DEFAULT_SANDBOX_RESOURCE_LIMITS,
  ProviderDriverKind,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../src/checkpointing/CheckpointStore.ts";
import { TextGeneration, type TextGenerationShape } from "../src/textGeneration/TextGeneration.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionCheckpointRepositoryLive } from "../src/persistence/Layers/ProjectionCheckpoints.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../src/persistence/Layers/ProjectionPendingApprovals.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../src/persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderTurnSendClaimRepositoryLive } from "../src/persistence/Layers/ProviderTurnSendClaims.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { ProjectionCheckpointRepository } from "../src/persistence/Services/ProjectionCheckpoints.ts";
import { ProjectionPendingApprovalRepository } from "../src/persistence/Services/ProjectionPendingApprovals.ts";
import { makeAdapterRegistryMock } from "../src/provider/testUtils/providerAdapterRegistryMock.ts";
import { ProviderAdapterRegistry } from "../src/provider/Services/ProviderAdapterRegistry.ts";
import { makeProviderRegistryLayer } from "../src/provider/testUtils/providerRegistryMock.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";
import { makeProviderServiceLive } from "../src/provider/Layers/ProviderService.ts";
import { makeCodexAdapter } from "../src/provider/Layers/CodexAdapter.ts";
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../src/provider/Layers/ProviderEventLoggers.ts";
import { ProviderService } from "../src/provider/Services/ProviderService.ts";
import { AnalyticsService } from "../src/telemetry/Services/AnalyticsService.ts";
import { CheckpointReactorLive } from "../src/orchestration/Layers/CheckpointReactor.ts";
import * as RepositoryIdentityResolver from "../src/project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../src/orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../src/orchestration/ThreadPlanProgress.ts";
import { RuntimeReceiptBusTest } from "../src/orchestration/Layers/RuntimeReceiptBus.ts";
import { OrchestrationReactorLive } from "../src/orchestration/Layers/OrchestrationReactor.ts";
import { SandboxLifecycleReactorLive } from "../src/orchestration/Layers/SandboxLifecycleReactor.ts";
import { SandboxSettleCleanupReactorLive } from "../src/orchestration/Layers/SandboxSettleCleanupReactor.ts";
import { ThreadDeletionReactorLive } from "../src/orchestration/Layers/ThreadDeletionReactor.ts";
import {
  make as makeProviderCommandReactor,
  ProviderCommandReactorLive,
} from "../src/orchestration/Layers/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionLive } from "../src/orchestration/Layers/ProviderRuntimeIngestion.ts";
import { CheckpointReactor } from "../src/orchestration/Services/CheckpointReactor.ts";
import { ProviderRuntimeIngestionService } from "../src/orchestration/Services/ProviderRuntimeIngestion.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../src/orchestration/Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "../src/orchestration/Services/ThreadDeletionReactor.ts";
import { SandboxLifecycleReactor } from "../src/orchestration/Services/SandboxLifecycleReactor.ts";
import { SandboxSettleCleanupReactor } from "../src/orchestration/Services/SandboxSettleCleanupReactor.ts";
import { ProviderCommandReactor } from "../src/orchestration/Services/ProviderCommandReactor.ts";
import { OrchestrationReactor } from "../src/orchestration/Services/OrchestrationReactor.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  RuntimeReceiptBus,
  type OrchestrationRuntimeReceipt,
} from "../src/orchestration/Services/RuntimeReceiptBus.ts";

import {
  makeTestProviderAdapterHarness,
  type TestProviderAdapterHarness,
} from "./TestProviderAdapter.integration.ts";
import { deriveServerPaths, ServerConfig } from "../src/config.ts";
import * as WorkspaceEntries from "../src/workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../src/workspace/WorkspacePaths.ts";
import * as VcsDriverRegistry from "../src/vcs/VcsDriverRegistry.ts";
import { VcsStatusBroadcaster } from "../src/vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../src/git/GitWorkflowService.ts";
import * as VcsProcess from "../src/vcs/VcsProcess.ts";
import * as TerminalManager from "../src/terminal/Manager.ts";
import * as AgentAwarenessRelay from "../src/relay/AgentAwarenessRelay.ts";
import { ThreadSandboxRuntime } from "../src/sandbox/ThreadSandboxRuntime.ts";
import {
  SandboxManagerError,
  SandboxRuntimeManager,
  SandboxRuntimeManagerLive,
} from "../src/sandbox/SandboxRuntimeManager.ts";
import { T3ProjectFileLoader } from "../src/project/T3ProjectFileLoader.ts";

const decodeCodexSettings = Schema.decodeEffect(CodexSettings);

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

const initializeGitWorkspace = Effect.fn(function* (cwd: string) {
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  const fileSystem = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  yield* fileSystem.writeFileString(join(cwd, "README.md"), "v1\n");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
});

export function gitRefExists(cwd: string, ref: string): boolean {
  try {
    runGit(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

export function gitShowFileAtRef(cwd: string, ref: string, filePath: string): string {
  return runGit(cwd, ["show", `${ref}:${filePath}`]);
}

class WaitForTimeoutError extends Schema.TaggedErrorClass<WaitForTimeoutError>()(
  "WaitForTimeoutError",
  {
    description: Schema.String,
  },
) {}

function waitFor<A, E>(
  read: Effect.Effect<A, E>,
  predicate: (value: A) => boolean,
  description: string,
  timeoutMs?: number,
): Effect.Effect<A, never>;
function waitFor<A, B extends A, E>(
  read: Effect.Effect<A, E>,
  predicate: (value: A) => value is B,
  description: string,
  timeoutMs?: number,
): Effect.Effect<B, never>;
function waitFor<A, E>(
  read: Effect.Effect<A, E>,
  predicate: (value: A) => boolean,
  description: string,
  timeoutMs = 40_000,
): Effect.Effect<A, never> {
  const RETRY_SIGNAL = "wait_for_retry";
  const retryIntervalMs = 10;
  const maxRetries = Math.max(0, Math.floor(timeoutMs / retryIntervalMs));
  const retrySchedule = Schedule.spaced(`${retryIntervalMs} millis`);

  return read.pipe(
    Effect.filterOrFail(predicate, () => RETRY_SIGNAL),
    Effect.retry({
      schedule: retrySchedule,
      times: maxRetries,
      while: (error) => error === RETRY_SIGNAL,
    }),
    Effect.mapError((error) =>
      error === RETRY_SIGNAL ? new WaitForTimeoutError({ description }) : error,
    ),
    Effect.orDie,
  );
}

class OrchestrationHarnessRuntimeError extends Schema.TaggedErrorClass<OrchestrationHarnessRuntimeError>()(
  "OrchestrationHarnessRuntimeError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const tryRuntimePromise = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new OrchestrationHarnessRuntimeError({ operation, cause }),
  });

export interface OrchestrationIntegrationHarness {
  readonly rootDir: string;
  readonly workspaceDir: string;
  readonly baseCommit: string;
  readonly dbPath: string;
  readonly adapterHarness: TestProviderAdapterHarness | null;
  readonly engine: OrchestrationEngineShape;
  readonly snapshotQuery: ProjectionSnapshotQuery["Service"];
  readonly providerService: ProviderService["Service"];
  readonly checkpointStore: CheckpointStore.CheckpointStore["Service"];
  readonly checkpointRepository: ProjectionCheckpointRepository["Service"];
  readonly pendingApprovalRepository: ProjectionPendingApprovalRepository["Service"];
  readonly waitForThread: (
    threadId: string,
    predicate: (thread: OrchestrationThread) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<OrchestrationThread, never>;
  readonly waitForDomainEvent: (
    predicate: (event: OrchestrationEvent) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<ReadonlyArray<OrchestrationEvent>, never>;
  readonly waitForPendingApproval: (
    requestId: string,
    predicate: (row: {
      readonly status: "pending" | "resolved";
      readonly decision: "accept" | "acceptForSession" | "decline" | "cancel" | null;
      readonly resolvedAt: string | null;
    }) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<
    {
      readonly status: "pending" | "resolved";
      readonly decision: "accept" | "acceptForSession" | "decline" | "cancel" | null;
      readonly resolvedAt: string | null;
    },
    never
  >;
  readonly waitForReceipt: {
    (
      predicate: (receipt: OrchestrationRuntimeReceipt) => boolean,
      timeoutMs?: number,
    ): Effect.Effect<OrchestrationRuntimeReceipt, never>;
    <Receipt extends OrchestrationRuntimeReceipt>(
      predicate: (receipt: OrchestrationRuntimeReceipt) => receipt is Receipt,
      timeoutMs?: number,
    ): Effect.Effect<Receipt, never>;
  };
  readonly drainProviderRuntime: Effect.Effect<void>;
  readonly drainCheckpointReactor: Effect.Effect<void>;
  readonly dispose: Effect.Effect<void, never>;
}

interface MakeOrchestrationIntegrationHarnessOptions {
  readonly provider?: ProviderDriverKind;
  readonly realCodex?: boolean;
  /**
   * Wire the real sandbox lifecycle, settle-cleanup, and thread-deletion
   * reactors instead of the stubs. Off by default: decider/projection tests
   * dispatch sandbox states by hand and must not touch a container runtime.
   * On, `sandbox.provision` really provisions -- so the host needs a working
   * rootless docker/podman and digest-pinned `T3_SANDBOX_*` images.
   */
  readonly realSandboxReactors?: boolean;
}

export const makeOrchestrationIntegrationHarness = (
  options?: MakeOrchestrationIntegrationHarnessOptions,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;

    const provider = options?.provider ?? ProviderDriverKind.make("codex");
    const useRealCodex = options?.realCodex === true;
    const useRealSandboxReactors = options?.realSandboxReactors === true;
    const adapterHarness = useRealCodex
      ? null
      : yield* makeTestProviderAdapterHarness({
          provider,
        });
    const fakeRegistry = adapterHarness
      ? Layer.succeed(
          ProviderAdapterRegistry,
          makeAdapterRegistryMock({ [adapterHarness.provider]: adapterHarness.adapter }),
        )
      : null;
    const rootDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-orchestration-integration-",
      // With the real reactors, the container runtime reads seed bundles off
      // this path by absolute name. A private /tmp (systemd `PrivateTmp`, or a
      // sandboxed agent shell) is invisible to the runtime's own namespace, so
      // `podman cp` reports "could not be found on the host". Honour
      // T3_INTEGRATION_TMPDIR to place the root somewhere both sides can see.
      ...(useRealSandboxReactors && process.env.T3_INTEGRATION_TMPDIR
        ? { directory: process.env.T3_INTEGRATION_TMPDIR }
        : {}),
    });
    const workspaceDir = path.join(rootDir, "workspace");
    const { stateDir, dbPath } = yield* deriveServerPaths(rootDir, undefined).pipe(
      Effect.provideService(Path.Path, path),
    );
    yield* fileSystem.makeDirectory(workspaceDir, { recursive: true });
    yield* fileSystem.makeDirectory(stateDir, { recursive: true });
    yield* initializeGitWorkspace(workspaceDir);
    const baseCommit = runGit(workspaceDir, ["rev-parse", "HEAD"]).trim();
    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    );
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntimeRepositoryLive),
    );
    const realCodexRegistry = Layer.effect(
      ProviderAdapterRegistry,
      Effect.gen(function* () {
        const codexSettings = yield* decodeCodexSettings({});
        const codexAdapter = yield* makeCodexAdapter(codexSettings);
        return makeAdapterRegistryMock({
          [ProviderDriverKind.make("codex")]: codexAdapter,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(workspaceDir, rootDir)),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(providerSessionDirectoryLayer),
    );
    const providerEventLoggersLayer = Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers);
    const providerLayer = useRealCodex
      ? makeProviderServiceLive().pipe(
          Layer.provide(providerSessionDirectoryLayer),
          Layer.provide(realCodexRegistry),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(providerEventLoggersLayer),
        )
      : makeProviderServiceLive().pipe(
          Layer.provide(providerSessionDirectoryLayer),
          Layer.provide(fakeRegistry!),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(providerEventLoggersLayer),
        );
    const providerRegistryLayer = makeProviderRegistryLayer();

    // The fake manager answers `exec` by shelling out in the workspace dir and
    // reports provisioning as instantly-ready -- right for decider tests, but it
    // never touches a container runtime. `realSandboxReactors` swaps in the Live
    // manager so provisioning really creates containers, networks, and volumes.
    const sandboxRuntimeManagerLayer = useRealSandboxReactors
      ? SandboxRuntimeManagerLive
      : makeSandboxRuntimeManagerLayer();
    const checkpointStoreCommonLayer = CheckpointStore.layer.pipe(
      Layer.provide(VcsDriverRegistry.layer),
    );
    const checkpointStoreLayer = useRealCodex
      ? checkpointStoreCommonLayer
      : checkpointStoreCommonLayer.pipe(Layer.provide(sandboxRuntimeManagerLayer));
    const projectionSnapshotQueryLayer = OrchestrationProjectionSnapshotQueryLive;
    const runtimeServicesLayer = Layer.mergeAll(
      projectionSnapshotQueryLayer,
      orchestrationLayer.pipe(Layer.provide(projectionSnapshotQueryLayer)),
      ProjectionCheckpointRepositoryLive,
      ProjectionPendingApprovalRepositoryLive,
      checkpointStoreLayer,
      providerLayer,
      // Expose the session directory so ProviderRuntimeIngestion can read the
      // interrupted turn's model selection off the persisted binding at resume.
      providerSessionDirectoryLayer,
      RuntimeReceiptBusTest,
    ).pipe(
      Layer.provideMerge(ThreadBackgroundLiveness.layer),
      Layer.provideMerge(ThreadPlanProgress.layer),
    );
    const serverSettingsLayer = ServerSettingsService.layerTest();
    const runtimeIngestionLayer = ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(serverSettingsLayer),
    );
    const gitWorkflowLayer = Layer.mock(GitWorkflowService)({
      localStatus: () =>
        Effect.succeed({
          isRepo: true,
          hasPrimaryRemote: false,
          isDefaultRef: true,
          refName: "main",
          hasWorkingTreeChanges: false,
          workingTree: { files: [], insertions: 0, deletions: 0 },
        }),
      resolveRemoteTrackingCommit: () =>
        Effect.succeed({ commitSha: baseCommit, remoteRefName: "main" }),
      renameBranch: (input: {
        readonly cwd: string;
        readonly oldBranch: string;
        readonly newBranch: string;
      }) => Effect.succeed({ branch: input.newBranch }),
    });
    const textGenerationLayer = Layer.succeed(TextGeneration, {
      generateBranchName: () => Effect.succeed({ branch: "update" }),
      generateThreadTitle: () => Effect.succeed({ title: "New thread" }),
    } as unknown as TextGenerationShape);
    const threadSandboxRuntimeLayer = Layer.succeed(ThreadSandboxRuntime, {
      ensureReady: (thread: OrchestrationThread) =>
        Effect.succeed({
          kind: "sandbox" as const,
          threadId: thread.id,
          sandboxId: thread.sandbox?.sandboxId ?? `test-${thread.id}`,
          runtimeRef: thread.sandbox?.runtimeRef ?? `test-${thread.id}`,
          runtime: "docker" as const,
          workspaceCwd: "/workspace/repo",
        }),
    });
    function makeSandboxRuntimeManagerLayer() {
      return Layer.succeed(SandboxRuntimeManager, {
        exec: (_runtime, _threadId, input) =>
          Effect.gen(function* () {
            if (input.cwd !== "/workspace/repo") {
              return yield* new SandboxManagerError({
                message: `test sandbox exec rejected cwd '${input.cwd ?? ""}'`,
              });
            }
            if (input.executable !== "git" && input.executable !== "rm") {
              return yield* new SandboxManagerError({
                message: `test sandbox exec rejected executable '${input.executable}'`,
              });
            }
            const mapSandboxPath = (value: string) =>
              value === "/workspace/repo"
                ? workspaceDir
                : value.startsWith("/workspace/repo/")
                  ? NodePath.join(workspaceDir, value.slice("/workspace/repo/".length))
                  : value;
            const args = [...(input.args ?? [])].map(mapSandboxPath);
            if (
              input.executable === "rm" &&
              args.some((arg) => {
                if (arg.startsWith("-")) return false;
                const relative = NodePath.relative(
                  workspaceDir,
                  NodePath.resolve(workspaceDir, arg),
                );
                return relative === ".." || relative.startsWith(`..${NodePath.sep}`);
              })
            ) {
              return yield* new SandboxManagerError({
                message: "test sandbox exec rejected rm path outside workspace",
              });
            }
            const result = NodeChildProcess.spawnSync(input.executable, args, {
              cwd: workspaceDir,
              env: {
                ...process.env,
                ...Object.fromEntries(
                  Object.entries(input.env ?? {}).map(([key, value]) => [
                    key,
                    mapSandboxPath(value),
                  ]),
                ),
              },
              encoding: "utf8",
              input: input.stdin,
              timeout: input.timeoutMs ?? 30_000,
              maxBuffer: 1024 * 1024,
            });
            if (result.error) {
              return yield* new SandboxManagerError({
                message: result.error.message,
                cause: result.error,
              });
            }
            return {
              exitCode: result.status ?? 1,
              stdout: (result.stdout ?? "").slice(0, 1024 * 1024),
              stderr: (result.stderr ?? "").slice(0, 1024 * 1024),
            };
          }),
        provision: (input) =>
          Effect.succeed({
            sandboxId: `test-${input.bootstrap.threadId}`,
            runtime: input.config?.runtime ?? "docker",
            containerName: `test-${input.bootstrap.threadId}`,
            networkName: `test-${input.bootstrap.threadId}`,
            workspaceVolumeName: `test-${input.bootstrap.threadId}-workspace`,
            desktopVolumeName: `test-${input.bootstrap.threadId}-desktop`,
            branchName: input.bootstrap.branchName,
            limits: input.config?.limits ?? DEFAULT_SANDBOX_RESOURCE_LIMITS,
            desktopSessionId: `test-${input.bootstrap.threadId}`,
            desktopStreamPath: `/desktop/test-${input.bootstrap.threadId}`,
            services: [],
          }),
        exportBranch: () => Effect.die("exportBranch should not be called in this test"),
        stop: () => Effect.die("stop should not be called in this test"),
        reconcile: () => Effect.die("reconcile should not be called in this test"),
        sampleUsage: () => Effect.die("sampleUsage should not be called in this test"),
        recoverPreview: () => Effect.die("recoverPreview should not be called in this test"),
        revokeCredentials: () => Effect.succeed(0),
        removeThreadArtifacts: () => Effect.void,
      });
    }
    const projectFileLoaderLayer = Layer.succeed(T3ProjectFileLoader, {
      load: () =>
        Effect.succeed(
          Option.some({
            sandbox: {
              image:
                "registry.example/t3-desktop@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
          }),
        ),
    });
    const providerCommandReactorCommonLayer = (
      useRealCodex
        ? ProviderCommandReactorLive
        : Layer.effect(ProviderCommandReactor, makeProviderCommandReactor).pipe(
            Layer.provide(OrchestrationEventStoreLive),
            Layer.provide(ProviderTurnSendClaimRepositoryLive),
            Layer.provide(projectFileLoaderLayer),
          )
    ).pipe(
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(gitWorkflowLayer),
      Layer.provideMerge(textGenerationLayer),
      Layer.provideMerge(serverSettingsLayer),
    );
    const providerCommandReactorLayer = useRealCodex
      ? providerCommandReactorCommonLayer
      : providerCommandReactorCommonLayer.pipe(
          Layer.provideMerge(threadSandboxRuntimeLayer),
          Layer.provideMerge(sandboxRuntimeManagerLayer),
        );
    const checkpointReactorCommonLayer = CheckpointReactorLive.pipe(
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(
        Layer.succeed(VcsStatusBroadcaster, {
          getStatus: () => Effect.die("getStatus should not be called in this test"),
          refreshLocalStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: false,
              isDefaultRef: true,
              refName: "main",
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          refreshStatus: () => Effect.die("refreshStatus should not be called in this test"),
          streamStatus: () => Stream.empty,
        }),
      ),
      Layer.provideMerge(
        WorkspaceEntries.layer.pipe(
          Layer.provide(WorkspacePaths.layer),
          Layer.provideMerge(VcsDriverRegistry.layer),
          Layer.provide(NodeServices.layer),
        ),
      ),
      Layer.provideMerge(WorkspacePaths.layer),
      Layer.provideMerge(VcsProcess.layer),
    );
    const checkpointReactorLayer = checkpointReactorCommonLayer;
    const sandboxReactorSupportLayer = Layer.mergeAll(
      runtimeServicesLayer,
      gitWorkflowLayer,
      sandboxRuntimeManagerLayer,
    ).pipe(
      // ThreadDeletionReactor closes a deleted thread's terminals, and the
      // lifecycle reactor's git work runs through VcsProcess. The real
      // TerminalManager drags in PTY and port-discovery adapters that nothing
      // under test needs, so deletion sees a no-op terminal manager.
      Layer.provideMerge(
        Layer.mock(TerminalManager.TerminalManager)({
          close: () => Effect.void,
        }),
      ),
      Layer.provideMerge(VcsProcess.layer),
    );
    const threadDeletionReactorLayer = useRealSandboxReactors
      ? ThreadDeletionReactorLive.pipe(Layer.provideMerge(sandboxReactorSupportLayer))
      : Layer.succeed(ThreadDeletionReactor, {
          start: () => Effect.void,
          drain: Effect.void,
        });
    const orchestrationReactorLayer = OrchestrationReactorLive.pipe(
      Layer.provideMerge(runtimeIngestionLayer),
      Layer.provideMerge(providerCommandReactorLayer),
      Layer.provideMerge(checkpointReactorLayer),
      Layer.provideMerge(threadDeletionReactorLayer),
      // The sandbox reactors are what actually call the container runtime.
      // Stubs keep decider/projection tests hermetic; the real Lives make
      // `sandbox.provision` provision for real (see `realSandboxReactors`).
      Layer.provideMerge(
        useRealSandboxReactors
          ? SandboxLifecycleReactorLive.pipe(Layer.provideMerge(sandboxReactorSupportLayer))
          : Layer.succeed(SandboxLifecycleReactor, {
              start: () => Effect.void,
              drain: Effect.void,
            }),
      ),
      Layer.provideMerge(
        useRealSandboxReactors
          ? SandboxSettleCleanupReactorLive.pipe(Layer.provideMerge(sandboxReactorSupportLayer))
          : Layer.succeed(SandboxSettleCleanupReactor, {
              start: () => Effect.void,
              drain: Effect.void,
            }),
      ),
      Layer.provideMerge(
        Layer.succeed(AgentAwarenessRelay.AgentAwarenessRelay, {
          publishThread: () => Effect.void,
          start: () => Effect.void,
        }),
      ),
    );
    const layer = Layer.empty.pipe(
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(orchestrationReactorLayer),
      Layer.provideMerge(providerRegistryLayer),
      Layer.provide(persistenceLayer),
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(workspaceDir, rootDir)),
      Layer.provideMerge(NodeServices.layer),
    );

    const runtime = ManagedRuntime.make(layer);
    const engine = yield* tryRuntimePromise("load OrchestrationEngine service", () =>
      runtime.runPromise(Effect.service(OrchestrationEngineService)),
    ).pipe(Effect.orDie);
    const reactor = yield* tryRuntimePromise("load OrchestrationReactor service", () =>
      runtime.runPromise(Effect.service(OrchestrationReactor)),
    ).pipe(Effect.orDie);
    const providerRuntimeIngestion = yield* tryRuntimePromise(
      "load ProviderRuntimeIngestion service",
      () => runtime.runPromise(Effect.service(ProviderRuntimeIngestionService)),
    ).pipe(Effect.orDie);
    const checkpointReactor = yield* tryRuntimePromise("load CheckpointReactor service", () =>
      runtime.runPromise(Effect.service(CheckpointReactor)),
    ).pipe(Effect.orDie);
    const snapshotQuery = yield* tryRuntimePromise("load ProjectionSnapshotQuery service", () =>
      runtime.runPromise(Effect.service(ProjectionSnapshotQuery)),
    ).pipe(Effect.orDie);
    const providerService = yield* tryRuntimePromise("load ProviderService service", () =>
      runtime.runPromise(Effect.service(ProviderService)),
    ).pipe(Effect.orDie);
    const checkpointStore = yield* tryRuntimePromise("load CheckpointStore service", () =>
      runtime.runPromise(Effect.service(CheckpointStore.CheckpointStore)),
    ).pipe(Effect.orDie);
    const checkpointRepository = yield* tryRuntimePromise(
      "load ProjectionCheckpointRepository service",
      () => runtime.runPromise(Effect.service(ProjectionCheckpointRepository)),
    ).pipe(Effect.orDie);
    const pendingApprovalRepository = yield* tryRuntimePromise(
      "load ProjectionPendingApprovalRepository service",
      () => runtime.runPromise(Effect.service(ProjectionPendingApprovalRepository)),
    ).pipe(Effect.orDie);
    const runtimeReceiptBus = yield* tryRuntimePromise("load RuntimeReceiptBus service", () =>
      runtime.runPromise(Effect.service(RuntimeReceiptBus)),
    ).pipe(Effect.orDie);

    const scope = yield* Scope.make("sequential");
    yield* tryRuntimePromise("start OrchestrationReactor", () =>
      runtime.runPromise(reactor.start().pipe(Scope.provide(scope))),
    ).pipe(Effect.orDie);
    const receiptHistory = yield* Ref.make<ReadonlyArray<OrchestrationRuntimeReceipt>>([]);
    yield* Stream.runForEach(runtimeReceiptBus.streamEventsForTest, (receipt) =>
      Ref.update(receiptHistory, (history) => [...history, receipt]).pipe(Effect.asVoid),
    ).pipe(Effect.forkIn(scope));
    yield* Effect.sleep(10);

    const waitForThread: OrchestrationIntegrationHarness["waitForThread"] = (
      threadId,
      predicate,
      timeoutMs,
    ) =>
      waitFor(
        snapshotQuery
          .getSnapshot()
          .pipe(
            Effect.map(
              (snapshot) => snapshot.threads.find((thread) => thread.id === threadId) ?? null,
            ),
          ),
        (thread): thread is OrchestrationThread => thread !== null && predicate(thread),
        `projected thread '${threadId}'`,
        timeoutMs,
      ) as Effect.Effect<OrchestrationThread, never>;

    const waitForDomainEvent: OrchestrationIntegrationHarness["waitForDomainEvent"] = (
      predicate,
      timeoutMs,
    ) =>
      waitFor(
        Stream.runCollect(engine.readEvents(0)).pipe(
          Effect.map((chunk): ReadonlyArray<OrchestrationEvent> => Array.from(chunk)),
        ),
        (events) => events.some(predicate),
        "domain event",
        timeoutMs,
      );

    const waitForPendingApproval: OrchestrationIntegrationHarness["waitForPendingApproval"] = (
      requestId,
      predicate,
      timeoutMs,
    ) =>
      waitFor(
        pendingApprovalRepository
          .getByRequestId({ requestId: ApprovalRequestId.make(requestId) })
          .pipe(
            Effect.map((row) =>
              Option.match(row, {
                onNone: () => null,
                onSome: (value) => ({
                  status: value.status,
                  decision: value.decision,
                  resolvedAt: value.resolvedAt,
                }),
              }),
            ),
          ),
        (
          row,
        ): row is {
          readonly status: "pending" | "resolved";
          readonly decision: "accept" | "acceptForSession" | "decline" | "cancel" | null;
          readonly resolvedAt: string | null;
        } => row !== null && predicate(row),
        `pending approval '${requestId}'`,
        timeoutMs,
      ) as Effect.Effect<
        {
          readonly status: "pending" | "resolved";
          readonly decision: "accept" | "acceptForSession" | "decline" | "cancel" | null;
          readonly resolvedAt: string | null;
        },
        never
      >;

    function waitForReceipt(
      predicate: (receipt: OrchestrationRuntimeReceipt) => boolean,
      timeoutMs?: number,
    ): Effect.Effect<OrchestrationRuntimeReceipt, never>;
    function waitForReceipt<Receipt extends OrchestrationRuntimeReceipt>(
      predicate: (receipt: OrchestrationRuntimeReceipt) => receipt is Receipt,
      timeoutMs?: number,
    ): Effect.Effect<Receipt, never>;
    function waitForReceipt(
      predicate: (receipt: OrchestrationRuntimeReceipt) => boolean,
      timeoutMs?: number,
    ) {
      const readMatchingReceipt = Ref.get(receiptHistory).pipe(
        Effect.map((history) => history.find(predicate)),
      );

      return waitFor(
        readMatchingReceipt,
        (receipt): receipt is OrchestrationRuntimeReceipt => receipt !== undefined,
        "runtime receipt",
        timeoutMs,
      );
    }

    let disposed = false;
    const dispose = Effect.gen(function* () {
      if (disposed) {
        return;
      }
      disposed = true;

      const shutdown = Effect.gen(function* () {
        const closeScopeExit = yield* Effect.exit(Scope.close(scope, Exit.void));
        const disposeRuntimeExit = yield* Effect.exit(Effect.promise(() => runtime.dispose()));

        const failureCause = Exit.isFailure(closeScopeExit)
          ? closeScopeExit.cause
          : Exit.isFailure(disposeRuntimeExit)
            ? disposeRuntimeExit.cause
            : null;

        if (failureCause) {
          return yield* Effect.failCause(failureCause);
        }
      });

      yield* shutdown;
    });

    return {
      rootDir,
      workspaceDir,
      baseCommit,
      dbPath,
      adapterHarness,
      engine,
      snapshotQuery,
      providerService,
      checkpointStore,
      checkpointRepository,
      pendingApprovalRepository,
      waitForThread,
      waitForDomainEvent,
      waitForPendingApproval,
      waitForReceipt,
      drainProviderRuntime: providerRuntimeIngestion.drain,
      drainCheckpointReactor: checkpointReactor.drain,
      dispose,
    } satisfies OrchestrationIntegrationHarness;
  });
