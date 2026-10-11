// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentHttpApi,
  ProviderDriverKind,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import * as Cause from "effect/Cause";
import * as InstagramPublishLive from "./command-center/publish/instagram/InstagramPublishLive.ts";
import * as InstagramPublish from "./command-center/publish/instagram/InstagramPublish.ts";
import * as InstagramTokenStore from "./command-center/publish/instagram/InstagramTokenStore.ts";
import * as InstagramWorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "./background/HostPowerMonitor.ts";
import * as ServerConfig from "./config.ts";
import {
  otlpTracesProxyRouteLayer,
  assetRouteLayer,
  attachmentUploadRouteLayer,
  serverEnvironmentHttpApiLayer,
  staticAndDevRouteLayer,
  browserApiCorsLayer,
  httpCompressionLayer,
  untracedRequestsLayer,
} from "./http.ts";
import { guardHttpResponseWriteErrors } from "./httpResponseErrorGuard.ts";
import { fixPath } from "./os-jank.ts";
import { websocketRpcRouteLayer } from "./ws.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as NodePtyAdapter from "./terminal/NodePtyAdapter.ts";
import { pullRequestHttpApiLayer } from "./pullRequest/http.ts";
import { webPushHttpApiLayer } from "./webPush/http.ts";
import * as WebPushConfig from "./webPush/WebPushConfig.ts";
import * as WebPushSubscriptions from "./webPush/WebPushSubscriptions.ts";
import * as WebPushSender from "./webPush/WebPushSender.ts";
import { layer as localWebPushNotifierLayer } from "./webPush/LocalWebPushNotifier.ts";
import * as PullRequestProviderRegistry from "./pullRequest/PullRequestProviderRegistry.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite.ts";
import * as PullRequestFilesViewed from "./persistence/PullRequestFilesViewed.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory.ts";
import * as ProviderSessionRuntime from "./persistence/ProviderSessionRuntime.ts";
import { ProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry.ts";
import * as ModelManifest from "./provider/ModelManifest.ts";
import * as ResetCreditCoordinator from "./provider/Layers/resetCreditCoordinator.ts";
import * as ProviderEventLoggers from "./provider/Layers/ProviderEventLoggers.ts";
import { ProviderServiceLive } from "./provider/Layers/ProviderService.ts";
import { ProviderAuthServiceLive } from "./provider/Layers/ProviderAuthService.ts";
import { CodexInstallation } from "./provider/CodexInstallation.ts";
import { AntigravityInstallation } from "./provider/AntigravityInstallation.ts";
import { ProviderInstanceRegistry } from "./provider/Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry.ts";
import { ProviderSessionReaperLive } from "./provider/Layers/ProviderSessionReaper.ts";
import { StalledTurnWatchdogLive } from "./orchestration/Layers/StalledTurnWatchdog.ts";
import { WorktreeCleanupLive } from "./worktreeCleanup.ts";
import { ProviderUsageLimitsIngestionLive } from "./provider/Layers/ProviderUsageLimitsIngestion.ts";
import * as OpenCodeRuntime from "./provider/opencodeRuntime.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as CheckpointStore from "./checkpointing/CheckpointStore.ts";
import * as AzureDevOpsCli from "./sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "./sourceControl/BitbucketApi.ts";
import * as GitHubCli from "./sourceControl/GitHubCli.ts";
import * as GitLabCli from "./sourceControl/GitLabCli.ts";
import * as ForgejoCli from "./sourceControl/ForgejoCli.ts";
import * as TextGeneration from "./textGeneration/TextGeneration.ts";
import { ProviderInstanceRegistryHydrationLive } from "./provider/Layers/ProviderInstanceRegistryHydration.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as McpHttpServer from "./mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "./mcp/McpSessionRegistry.ts";
import * as SupabaseMcpConnector from "./database/SupabaseMcpConnector.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as DeviceService from "./device/DeviceService.ts";
import { deviceHubProxyRouteLayer } from "./device/DeviceHubProxy.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import { makePreviewGatewayRoutesLayer } from "./preview/gatewayRoute.ts";
import {
  desktopHttpRouteLayer,
  desktopSignalHttpRouteLayer,
  sandboxCredentialHttpRouteLayer,
  sandboxArtifactHttpRouteLayer,
  sandboxPreviewResolveHttpRouteLayer,
} from "./sandbox/DesktopHttpRoutes.ts";
import * as ProcessRunner from "./processRunner.ts";
import * as GitManager from "./git/GitManager.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as Keybindings from "./keybindings.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor.ts";
import { RuntimeReceiptBusLive } from "./orchestration/Layers/RuntimeReceiptBus.ts";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion.ts";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor.ts";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor.ts";
import { ThreadDeletionReactorLive } from "./orchestration/Layers/ThreadDeletionReactor.ts";
import { SandboxSettleCleanupReactorLive } from "./orchestration/Layers/SandboxSettleCleanupReactor.ts";
import { SubagentDelegationReactorLive } from "./orchestration/Layers/SubagentDelegationReactor.ts";
import { SpaceActivityReactorLive } from "./orchestration/Layers/SpaceActivityReactor.ts";
import { SandboxLifecycleReactorLive } from "./orchestration/Layers/SandboxLifecycleReactor.ts";
import { SandboxRuntimeManagerLive } from "./sandbox/SandboxRuntimeManager.ts";
import * as ThreadSettlementReactor from "./orchestration/ThreadSettlementReactor.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as PullRequestSyncReactor from "./orchestration/PullRequestSyncReactor.ts";
import * as ThreadPullRequestReactor from "./orchestration/ThreadPullRequestReactor.ts";
import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";
import { hasCloudPublicConfig } from "./cloud/publicConfig.ts";
import { ProviderRegistryLive } from "./provider/Layers/ProviderRegistry.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as NativeAppIconResolver from "./assets/NativeAppIconResolver.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "./project/T3ProjectFileLoader.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as PullRequestReadCache from "./pullRequest/PullRequestReadCache.ts";
import * as SourceControlRateLimit from "./sourceControl/SourceControlRateLimit.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import { ObservabilityLive } from "./observability/Layers/Observability.ts";
import * as HeapSnapshot from "./observability/HeapSnapshot.ts";
import * as EventLoopMonitor from "./observability/EventLoopMonitor.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import { authHttpApiLayer, environmentAuthenticatedAuthLayer } from "./auth/http.ts";
import * as ReplayMarkers from "./auth/replayMarkers.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import {
  connectHttpApiLayer,
  pendingServiceUpdateExists,
  reconcileDesiredCloudLinkIfStillDesired,
  recoverManagedCloudTunnel,
  registerManagedCloudTunnelRecovery,
  startManagedCloudTunnelIfOriginConfirmed,
  releaseManagedTunnelOnShutdown,
} from "./cloud/http.ts";
import { serverRelayBrokerTracingLayer } from "./cloud/relayTracing.ts";
import { shouldRetryCloudLink } from "./cloud/relayResponse.ts";
import * as CloudManagedEndpointRuntime from "./cloud/ManagedEndpointRuntime.ts";
import {
  MANAGED_TUNNEL_FIRST_REGISTRATION_JITTER,
  MANAGED_TUNNEL_RECOVERY_COOLDOWN,
  managedTunnelStartupAction,
  retryManagedTunnelRegistration,
} from "./cloud/managedTunnelStartup.ts";
import * as CloudCliTokenManager from "./cloud/CliTokenManager.ts";
import * as CloudCliState from "./cloud/CliState.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as DesktopAppUpdate from "./desktopUpdate/DesktopAppUpdate.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as HostUsage from "./resourceTelemetry/HostUsage.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as DesktopTelemetryReceiver from "./resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as NativeTelemetryClient from "./resourceTelemetry/NativeTelemetryClient.ts";
import * as ResourceAttribution from "./resourceTelemetry/ResourceAttribution.ts";
import * as ResourceMonitorBinary from "./resourceTelemetry/ResourceMonitorBinary.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as UsageService from "./usage/UsageService.ts";
import {
  OrchestrationLayerLive,
  OrchestrationRuntimeStateLayerLive,
} from "./orchestration/runtimeLayer.ts";
import * as OrchestrationCommandDispatcher from "./orchestration/CommandDispatcher.ts";
import * as Judge from "./efficiency/Judge.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery.ts";
import {
  clearPersistedServerRuntimeState,
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "./serverRuntimeState.ts";
import { orchestrationHttpApiLayer } from "./orchestration/http.ts";
import * as NetService from "@t3tools/shared/Net";
import * as RelayClient from "@t3tools/shared/relayClient";
import { disableTailscaleServe, ensureTailscaleServe } from "@t3tools/tailscale";
import * as CommandCenterService from "./command-center/Service.ts";
import * as CommandCenterInbox from "./command-center/Inbox.ts";
import * as SprintPlan from "./command-center/SprintPlan.ts";
import * as CommandCenterDigest from "./command-center/Digest.ts";
import * as CommandCenterEventStream from "./command-center/EventStream.ts";
import * as Observations from "./command-center/Observations.ts";
import * as AutomationDefinitionConfig from "./command-center/AutomationDefinitionConfig.ts";
import * as AutomationRuns from "./command-center/AutomationRuns.ts";
import * as Responsibilities from "./command-center/Responsibilities.ts";
import * as RepositoryChecks from "./command-center/RepositoryChecks.ts";
import * as InboxGmailDrafts from "./command-center/InboxGmailDrafts.ts";
import * as AutomationScheduleRunner from "./command-center/automation/ScheduleRunner.ts";
import * as AutomationRecoveryCoordinator from "./command-center/automation/RecoveryCoordinator.ts";
import * as AutomationTriggerCoordinator from "./command-center/automation/TriggerCoordinator.ts";
import * as AutomationScheduleInterpreter from "./command-center/automation/ScheduleInterpreter.ts";
import * as AutomationScopedShell from "./command-center/automation/AutomationScopedShell.ts";
import * as VerifiedScopedShell from "./command-center/automation/VerifiedScopedShell.ts";
import * as MemorySearchIndex from "./command-center/MemorySearchIndex.ts";
import * as SpaceActivity from "./command-center/SpaceActivity.ts";
import * as GoogleReadConnector from "./command-center/GoogleReadConnector.ts";
import * as WindowsMediaConnector from "./command-center/WindowsMediaConnector.ts";
import * as GoogleConnectionSetup from "./command-center/GoogleConnectionSetup.ts";
import * as PublishConnections from "./command-center/publish/PublishConnections.ts";
import * as YouTubeAnalytics from "./command-center/publish/youtube/YouTubeAnalytics.ts";
import * as YouTubeTokenStore from "./command-center/publish/youtube/YouTubeTokenStore.ts";
import * as CommandCenterConfig from "./command-center/Config.ts";
import * as ConnectionHealth from "./command-center/ConnectionHealth.ts";
import * as RunDispatcher from "./command-center/RunDispatcher.ts";
import * as RunRecoveryCoordinator from "./command-center/RunRecoveryCoordinator.ts";
import * as SpaceAgent from "./command-center/SpaceAgent.ts";
import * as SpaceAgentWaker from "./command-center/SpaceAgentWaker.ts";
import * as RunLifecycle from "./command-center/RunLifecycle.ts";
import * as ReadinessGate from "./command-center/ReadinessGate.ts";
import { webhookHttpRouteLayer } from "./command-center/WebhookHttp.ts";
import { forkParked, ServerActivation } from "./serverActivation.ts";

// MCP handoff thread IDs include escaped provenance and can exceed find-my-way's
// 100-character default for one path segment.
export const HTTP_ROUTER_CONFIG = {
  maxParamLength: 512,
} as const;

// Effect's default preemptive shutdown waits 20s before finalizing request scopes.
// T3's primary transport is long-lived WebSocket RPC, whose Effect scope finalizer
// already closes the websocket gracefully. Do not add an artificial drain before
// those finalizers get a chance to run.
const HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS = 0;
const ResourceAttributionLayerLive = ResourceAttribution.layer;
const ApplicationObservabilityLive = EventLoopMonitor.layer.pipe(
  Layer.provideMerge(ObservabilityLive),
  Layer.provideMerge(ResourceAttributionLayerLive),
);

const PtyAdapterLive = NodePtyAdapter.layer;

const ServerSettingsLayerLive = ServerSettings.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistenceLayerLive),
);

// The efficiency Judge reads the live judge settings, records usage rows, and
// writes the decision log. Self-contained (bundles ServerSettings + SQL) so it
// can be provided both to the command dispatcher (tier judgment) and, ambiently,
// to the WebSocket preview RPC. ServerConfig / FileSystem / Path stay open
// requirements, satisfied by the runtime. Test harnesses that compose the raw
// orchestration/route layers provide `Judge.layerTest` at their boundary.
const JudgeLayerLive = Judge.layer.pipe(Layer.provide(ServerSettingsLayerLive));

const NativeTelemetryLayerLive = NativeTelemetryClient.layer.pipe(
  Layer.provide(ResourceMonitorBinary.layer),
);
const DesktopTelemetryReceiverLayerLive = DesktopTelemetryReceiver.layer.pipe(
  Layer.provideMerge(ServerSettingsLayerLive),
);

const ResourceTelemetryLayerLive = ResourceTelemetry.layer.pipe(
  Layer.provideMerge(NativeTelemetryLayerLive),
  Layer.provideMerge(DesktopTelemetryReceiverLayerLive),
);

const HostPowerMonitorLayerLive = HostPowerMonitor.layer.pipe(
  Layer.provide(DesktopTelemetryReceiverLayerLive),
);

// Reuses DesktopTelemetryReceiverLayerLive: a fresh receiver layer here
// would open a second reader on the desktop telemetry fd.
const DesktopAppUpdateLayerLive = DesktopAppUpdate.layer.pipe(
  Layer.provide(DesktopTelemetryReceiverLayerLive),
);

const BackgroundLayerLive = BackgroundPolicy.layer.pipe(
  Layer.provide(HostPowerMonitorLayerLive),
  Layer.provideMerge(ServerSettingsLayerLive),
);

const UsageLayerLive = UsageService.layer.pipe(Layer.provide(ServerSettingsLayerLive));

const ResourceDiagnosticsLayerLive = Layer.mergeAll(
  HostResources.layer,
  ResourceTelemetryLayerLive,
  ProcessDiagnostics.layer.pipe(Layer.provide(ResourceTelemetryLayerLive)),
  ProcessResourceMonitor.layer.pipe(Layer.provide(ResourceTelemetryLayerLive)),
);

const RelayClientLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return RelayClient.layerCloudflared({ baseDir: config.baseDir });
  }),
);

const HttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return NodeHttpServer.layer(() => guardHttpResponseWriteErrors(NodeHttp.createServer()), {
      host: config.host ?? "127.0.0.1",
      port: config.port,
      gracefulShutdownTimeout: HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS,
      // Negotiate permessage-deflate with clients that offer it; clients
      // that don't still get uncompressed frames on their connection.
      // Context takeover stays enabled (ws default) so the compression
      // window is shared across frames — that also makes small frames cheap
      // to compress, so no size threshold is set (ws only honors
      // `threshold` when context takeover is disabled).
      websocket: { perMessageDeflate: true },
    });
  }),
);

/**
 * The preview gateway's own listener.
 *
 * It cannot share the main server: the gateway is mounted at `/` (dev servers
 * emit absolute URLs that would 404 under a path prefix), and `/` on the main
 * server is already claimed by the static/dev catch-all route. Always loopback —
 * reachability from another machine is Tailscale Serve's job, not the socket's.
 */
const PreviewGatewayHttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    if (typeof Bun !== "undefined") {
      const BunHttpServer = yield* Effect.promise(
        () => import("@effect/platform-bun/BunHttpServer"),
      );
      return BunHttpServer.layer({
        port: config.previewGatewayPort,
        hostname: "127.0.0.1",
        gracefulShutdownTimeout: HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS,
      });
    }
    const [NodeHttpServer, NodeHttp] = yield* Effect.all([
      Effect.promise(() => import("@effect/platform-node/NodeHttpServer")),
      Effect.promise(() => import("node:http")),
    ]);
    return NodeHttpServer.layer(NodeHttp.createServer, {
      host: "127.0.0.1",
      port: config.previewGatewayPort,
      gracefulShutdownTimeout: HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS,
    });
  }),
);

/**
 * Serve the preview gateway's routes on their own listener.
 *
 * `Layer.fresh` is the load-bearing part. `HttpRouter.serve` builds its router
 * from the module-level `HttpRouter.layer`, and layers are memoized by identity
 * within a single build — so without it the gateway registers its routes into
 * the *main app's* router. Both mount a catch-all at `/`, and startup dies with
 * `Method 'GET' already declared for route '/*'`. (Observed on a live boot with
 * `--preview-gateway`; a control boot without the flag started clean.)
 *
 * The listener is a parameter so a test can supply an ephemeral one and still
 * exercise this exact composition rather than a copy of it.
 */
export const makePreviewGatewayServedLayer = <A extends HttpServer.HttpServer, E, R>(
  httpServerLayer: Layer.Layer<A, E, R>,
) =>
  HttpRouter.serve(makePreviewGatewayRoutesLayer, { disableLogger: true }).pipe(
    Layer.fresh,
    Layer.provide(httpServerLayer),
  );
const PlatformServicesLive = NodeServices.layer;

// Web Push services (VAPID config, subscription store, sender) shared by the
// notifier reactor and the HTTP route group. ServerSecretStore holds the VAPID
// key pair; the sender reads the resolved config. SqlClient (subscription store)
// and the secret store's own deps are satisfied by the runtime context.
const WebPushConfigLayerLive = WebPushConfig.layer.pipe(Layer.provide(ServerSecretStore.layer));
export const WebPushServicesLive = Layer.mergeAll(
  WebPushConfigLayerLive,
  WebPushSubscriptions.layer,
  WebPushSender.layer.pipe(Layer.provide(WebPushConfigLayerLive)),
);

const ReactorLayerLive = Layer.empty.pipe(
  Layer.provideMerge(OrchestrationReactorLive),
  Layer.provideMerge(localWebPushNotifierLayer),
  Layer.provideMerge(ProviderRuntimeIngestionLive),
  Layer.provideMerge(ProviderCommandReactorLive),
  Layer.provideMerge(CheckpointReactorLive),
  Layer.provideMerge(StorageCleanup.layer),
  Layer.provideMerge(ThreadDeletionReactorLive),
  Layer.provideMerge(SandboxLifecycleReactorLive),
  Layer.provideMerge(SandboxSettleCleanupReactorLive),
  Layer.provideMerge(SubagentDelegationReactorLive),
  Layer.provideMerge(SpaceActivityReactorLive),
  Layer.provideMerge(ThreadSettlementReactor.layer),
  Layer.provideMerge(PullRequestSyncReactor.layer),
  Layer.provideMerge(ThreadPullRequestReactor.layer),
  Layer.provideMerge(AgentAwarenessRelay.layer.pipe(Layer.provide(ServerSecretStore.layer))),
  Layer.provideMerge(RuntimeReceiptBusLive),
);

const ProviderSessionDirectoryLayerLive = ProviderSessionDirectoryLive.pipe(
  Layer.provide(ProviderSessionRuntime.layer),
);

// `ProviderAdapterRegistryLive` is now a facade that resolves kind → adapter
// by looking up the default `ProviderInstance` per driver in the instance
// registry. Adapter construction itself moved inside each driver's
// `create()`; `ProviderEventLoggers.layer` owns the shared native/canonical
// NDJSON writers and is provided at the outer runtime layer so both
// `ProviderService` and the per-instance drivers read the same logger pair.
const ProviderLayerLive = ProviderServiceLive.pipe(
  Layer.provide(ProviderAdapterRegistryLive),
  Layer.provideMerge(ProviderSessionDirectoryLayerLive),
);

const PersistenceLayerLive = Layer.empty.pipe(Layer.provideMerge(SqlitePersistenceLayerLive));

const VcsDriverRegistryLayerLive = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProjectConfig.layer),
);

const SourceControlProviderRegistryLayerLive = SourceControlProviderRegistry.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      AzureDevOpsCli.layer,
      BitbucketApi.layer,
      GitHubCli.layer,
      GitLabCli.layer,
      ForgejoCli.layer,
    ),
  ),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(VcsDriverRegistryLayerLive),
);

const RepositoryIdentityResolverLayerLive = Layer.effect(
  RepositoryIdentityResolver.RepositoryIdentityResolver,
  Effect.gen(function* () {
    const registry = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
    return yield* RepositoryIdentityResolver.make({
      refine: Effect.fn(function* (identity: RepositoryIdentity) {
        const remote = ForgejoCli.parseForgejoRemote(identity.locator.remoteUrl);
        if (
          !remote ||
          !identity.rootPath ||
          (identity.provider !== undefined &&
            identity.provider !== "unknown" &&
            identity.provider !== "forgejo")
        )
          return identity;
        const handle = yield* registry.resolveHandle({
          cwd: identity.rootPath,
          context: {
            provider: { kind: "unknown", name: "Unknown", baseUrl: "" },
            remoteName: identity.locator.remoteName,
            remoteUrl: identity.locator.remoteUrl,
          },
        });
        if (handle.context?.provider.kind !== "forgejo") return identity;
        const baseUrl = handle.context.provider.baseUrl.replace(/\/+$/, "");
        const basePath = new URL(baseUrl).pathname.replace(/^\/+|\/+$/g, "");
        const path =
          !remote.ssh && basePath && remote.path.startsWith(`${basePath}/`)
            ? remote.path.slice(basePath.length + 1)
            : remote.path;
        return { ...identity, provider: "forgejo", webUrl: `${baseUrl}/${path}` };
      }),
    });
  }),
).pipe(Layer.provide(SourceControlProviderRegistryLayerLive), Layer.provide(ProcessRunner.layer));

const PullRequestServiceLive = PullRequestService.layer.pipe(
  Layer.provide(PullRequestProviderRegistry.layer),
  // Where the viewed-file marks live for a host that keeps none of its own.
  Layer.provide(PullRequestFilesViewed.layer),
  Layer.provide(PullRequestReadCache.layer),
  Layer.provide(SourceControlProviderRegistryLayerLive),
  Layer.provide(SourceControlRateLimit.layer),
);

const GitManagerLayerLive = GitManager.layer.pipe(
  Layer.provideMerge(ProjectSetupScriptRunner.layer.pipe(Layer.provide(ServerSettingsLayerLive))),
  Layer.provideMerge(WorktreeSetupTracker.layer),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(SourceControlProviderRegistryLayerLive),
  Layer.provideMerge(
    TextGeneration.layer.pipe(Layer.provide(SourceControlProviderRegistryLayerLive)),
  ),
);

const GitLayerLive = Layer.empty.pipe(
  Layer.provideMerge(GitManagerLayerLive),
  Layer.provideMerge(GitVcsDriver.layer),
);

const GitWorkflowLayerLive = GitWorkflowService.layer.pipe(
  Layer.provideMerge(VcsDriverRegistryLayerLive),
  Layer.provideMerge(GitLayerLive),
);

const SourceControlRepositoryServiceLayerLive = SourceControlRepositoryService.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(SourceControlProviderRegistryLayerLive),
);

const RunDispatcherLayerLive = RunDispatcher.layer.pipe(
  Layer.provide(GitWorkflowLayerLive),
  Layer.provide(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(PersistenceLayerLive),
  Layer.provide(SourceControlRepositoryServiceLayerLive),
);

const ConnectionHealthLayerLive = ConnectionHealth.layer.pipe(Layer.provide(PersistenceLayerLive));

const CommandCenterConfigLayerLive = CommandCenterConfig.layer.pipe(
  Layer.provide(ProcessRunner.layer),
);

const GoogleReadConnectorLayerLive = GoogleReadConnector.layer.pipe(
  Layer.provideMerge(CommandCenterConfigLayerLive),
  Layer.provide(ConnectionHealthLayerLive),
  Layer.provide(ProcessRunner.layer),
  Layer.provide(ServerSecretStore.layer),
);

const WindowsMediaConnectorLayerLive = WindowsMediaConnector.layer.pipe(
  Layer.provide(ProcessRunner.layer),
);

const GoogleConnectionSetupLayerLive = GoogleConnectionSetup.layer.pipe(
  Layer.provideMerge(CommandCenterConfigLayerLive),
  Layer.provide(ProcessRunner.layer),
  Layer.provide(ServerSecretStore.layer),
);

const PublishConnectionsLayerLive = PublishConnections.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
);

const YouTubeAnalyticsLayerLive = YouTubeAnalytics.layer.pipe(
  Layer.provide(YouTubeTokenStore.layer.pipe(Layer.provide(ServerSecretStore.layer))),
  Layer.provide(Observations.layer),
);

const AutomationDefinitionConfigLayerLive = AutomationDefinitionConfig.layer.pipe(
  Layer.provideMerge(CommandCenterConfigLayerLive),
  Layer.provide(ProcessRunner.layer),
);

const AutomationScheduleInterpreterLayerLive = AutomationScheduleInterpreter.layer.pipe(
  Layer.provideMerge(
    TextGeneration.layer.pipe(Layer.provide(SourceControlProviderRegistryLayerLive)),
  ),
  Layer.provide(ServerSettingsLayerLive),
);

const AutomationScopedShellLayerLive = AutomationScopedShell.AutomationScopedShellLayer.pipe(
  Layer.provide(VerifiedScopedShell.VerifiedLinuxScopedShellLayer),
  Layer.provide(CommandCenterConfigLayerLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(PersistenceLayerLive),
);

const CommandCenterBaseLayerLive = Layer.mergeAll(
  CommandCenterService.runtimeLayer,
  CommandCenterInbox.layer,
  CommandCenterDigest.liveLayer,
  CommandCenterEventStream.layer,
  Observations.layer,
  MemorySearchIndex.layer,
  SpaceActivity.layer,
  GoogleReadConnectorLayerLive,
  WindowsMediaConnectorLayerLive,
  GoogleConnectionSetupLayerLive,
  PublishConnectionsLayerLive,
  YouTubeAnalyticsLayerLive,
  AutomationDefinitionConfigLayerLive,
  AutomationScheduleInterpreterLayerLive,
  AutomationScopedShellLayerLive,
);

const RepositoryChecksLayerLive = RepositoryChecks.layer.pipe(
  Layer.provide(CommandCenterBaseLayerLive),
  Layer.provide(GitHubCli.layer),
  Layer.provide(SourceControlRateLimit.layer),
  Layer.provide(VcsProcess.layer),
  Layer.provide(PersistenceLayerLive),
);

const InboxGmailDraftsLayerLive = InboxGmailDrafts.layer.pipe(
  Layer.provide(CommandCenterBaseLayerLive),
  Layer.provide(CommandCenterConfigLayerLive),
  Layer.provide(PersistenceLayerLive),
);

const CommandCenterCoreLayerLive = Layer.mergeAll(
  CommandCenterBaseLayerLive,
  RepositoryChecksLayerLive,
  InboxGmailDraftsLayerLive,
  AutomationRuns.safeRuntimeLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        CommandCenterBaseLayerLive,
        RepositoryChecksLayerLive,
        InboxGmailDraftsLayerLive,
      ),
    ),
  ),
);

const AutomationRunsLayerLive = AutomationRuns.layer.pipe(
  Layer.provideMerge(CommandCenterCoreLayerLive),
);

const ResponsibilitiesLayerLive = Layer.effect(
  Responsibilities.Responsibilities,
  Effect.gen(function* () {
    const commandCenter = yield* CommandCenterService.CommandCenterService;
    const configured = Effect.fn("Responsibilities.configured")(function* () {
      const config = yield* commandCenter.syncConfiguration({ force: true }).pipe(
        Effect.mapError(
          (cause) =>
            new Responsibilities.ResponsibilityError({
              code: "config-unavailable",
              message: "Could not verify the committed Automation configuration.",
              cause,
            }),
        ),
      );
      if (config.health.status !== "loaded") {
        return yield* new Responsibilities.ResponsibilityError({
          code: "config-unavailable",
          message: "The committed Automation configuration is unavailable.",
        });
      }
      const activeSpaces = new Set(
        config.spaces.filter((space) => space.lifecycle === "active").map((space) => space.id),
      );
      return config.automations.flatMap((automation) =>
        activeSpaces.has(automation.spaceId) && automation.configCommit
          ? [
              {
                automationId: automation.id,
                spaceId: automation.spaceId,
                configCommitSha: automation.configCommit,
                definitionDigest: automation.definitionDigest,
                enabled: automation.enabled,
              },
            ]
          : [],
      );
    });
    return yield* Responsibilities.make({
      now: Effect.map(DateTime.now, DateTime.formatIso),
      listConfiguredAutomations: configured,
      validateAutomation: ({ automationId, spaceId }) =>
        configured().pipe(
          Effect.flatMap((automations) => {
            const identity = automations.find(
              (item) => item.automationId === automationId && item.spaceId === spaceId,
            );
            return identity
              ? Effect.succeed(identity)
              : Effect.fail(
                  new Responsibilities.ResponsibilityError({
                    code: "not-found",
                    message: "The Responsibility is absent from committed configuration.",
                  }),
                );
          }),
        ),
    });
  }),
).pipe(Layer.provideMerge(CommandCenterBaseLayerLive), Layer.provide(PersistenceLayerLive));

const AutomationTriggerCoordinatorLayerLive = AutomationTriggerCoordinator.layer.pipe(
  Layer.provide(AutomationRunsLayerLive),
);

const AutomationScheduleRunnerLayerLive = AutomationScheduleRunner.layer.pipe(
  Layer.provide(AutomationTriggerCoordinatorLayerLive),
  Layer.provide(CommandCenterBaseLayerLive),
  Layer.provide(PersistenceLayerLive),
);

const AutomationRecoveryCoordinatorLayerLive = AutomationRecoveryCoordinator.layer.pipe(
  Layer.provide(AutomationRunsLayerLive),
);

const RunLifecycleLayerLive = RunLifecycle.layer.pipe(
  Layer.provide(ProviderLayerLive),
  Layer.provide(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(OrchestrationLayerLive),
  Layer.provide(PersistenceLayerLive),
);

const ProjectCloneTrackerLayerLive = ProjectCloneTracker.layer.pipe(
  Layer.provide(SourceControlRepositoryServiceLayerLive),
);
const ReviewLayerLive = ReviewService.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(VcsDriverRegistryLayerLive),
);

const VcsLayerLive = Layer.empty.pipe(
  Layer.provideMerge(VcsProjectConfig.layer),
  Layer.provideMerge(VcsDriverRegistryLayerLive),
  Layer.provideMerge(VcsProvisioningService.layer.pipe(Layer.provide(VcsDriverRegistryLayerLive))),
  Layer.provideMerge(GitWorkflowLayerLive),
  Layer.provideMerge(ReviewLayerLive),
  Layer.provideMerge(SourceControlRepositoryServiceLayerLive),
  Layer.provideMerge(ProjectCloneTrackerLayerLive),
  Layer.provideMerge(
    VcsStatusBroadcaster.layer.pipe(
      Layer.provide(GitWorkflowLayerLive),
      Layer.provide(
        VcsStatusBroadcaster.autoPullPolicyLayer.pipe(Layer.provide(ServerSettingsLayerLive)),
      ),
    ),
  ),
);

/**
 * Exported so `SandboxRuntimeManagerWiring.test.ts` can assert on this exact
 * composition rather than a replica of it -- a copy would keep passing after a
 * regression here.
 */
export const CheckpointingLayerLive = Layer.empty.pipe(
  Layer.provideMerge(CheckpointDiffQuery.layer),
  // `SandboxRuntimeManagerLive` is deliberately NOT provided here. The manager
  // holds the per-thread container records in memory, so the reactors that
  // provision a sandbox and the store that runs git inside it must share one
  // instance. `Layer.provide` scopes a dependency privately to the layer it
  // wraps, which gave the store its own manager while the reactors fell
  // through to the `Context.Reference` default -- a second, empty manager, and
  // silently, because a default value cannot fail. Checkpoints then failed with
  // "sandbox for thread <id> is not ready" against a sandbox that was ready and
  // actively running a turn. It is provided once at the composition root below.
  Layer.provideMerge(CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistryLayerLive))),
);

const PortScannerLayerLive = PortScanner.layer.pipe(Layer.provide(ProcessRunner.layer));

const TerminalLayerLive = TerminalManager.layer.pipe(
  Layer.provide(PtyAdapterLive),
  Layer.provide(PortScannerLayerLive),
  Layer.provide(NativeTelemetryLayerLive),
);

const ProjectSetupScriptRunnerLayerLive = ProjectSetupScriptRunner.layer.pipe(
  Layer.provide(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(TerminalLayerLive),
);

const OrchestrationCommandDispatcherLayerLive = OrchestrationCommandDispatcher.layer.pipe(
  Layer.provide(GitWorkflowLayerLive),
  Layer.provide(OrchestrationLayerLive),
  Layer.provide(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(ProviderRegistryLive),
  Layer.provide(ProjectSetupScriptRunnerLayerLive),
  Layer.provide(ServerSettingsLayerLive),
  Layer.provide(JudgeLayerLive),
  Layer.provide(T3ProjectFileLoader.layer),
  Layer.provide(VcsStatusBroadcaster.layer.pipe(Layer.provide(GitWorkflowLayerLive))),
  Layer.provide(WorkspacePaths.layer),
);

const CommandCenterRunDispatchLayerLive = Layer.mergeAll(
  RunDispatcherLayerLive,
  OrchestrationCommandDispatcherLayerLive,
);

const RunRecoveryCoordinatorLayerLive = RunRecoveryCoordinator.layer.pipe(
  Layer.provide(CommandCenterRunDispatchLayerLive),
  Layer.provide(CommandCenterBaseLayerLive),
  Layer.provide(ProviderRegistryLive),
  Layer.provide(PersistenceLayerLive),
);

const SpaceAgentLayerLive = SpaceAgent.layer.pipe(
  Layer.provide(CommandCenterRunDispatchLayerLive),
  Layer.provide(CommandCenterBaseLayerLive),
  Layer.provide(PersistenceLayerLive),
);

const SpaceAgentWakerLayerLive = SpaceAgentWaker.layer.pipe(
  Layer.provide(SpaceAgentLayerLive),
  Layer.provide(PersistenceLayerLive),
);

const InstagramPublishLayerLive = InstagramPublishLive.layer.pipe(
  Layer.provide(InstagramTokenStore.layer.pipe(Layer.provide(ServerSecretStore.layer))),
  Layer.provide(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(InstagramWorkspacePaths.layer),
  Layer.provide(PersistenceLayerLive),
);
const InstagramRunnerLayerLive = InstagramPublish.runnerLayer.pipe(
  Layer.provideMerge(InstagramPublishLayerLive),
);

const CommandCenterLayerLive = Layer.mergeAll(
  ResponsibilitiesLayerLive,
  InstagramRunnerLayerLive,
  AutomationScheduleInterpreterLayerLive,
  AutomationRunsLayerLive,
  AutomationTriggerCoordinatorLayerLive,
  AutomationScheduleRunnerLayerLive,
  AutomationRecoveryCoordinatorLayerLive,
  CommandCenterRunDispatchLayerLive,
  RunRecoveryCoordinatorLayerLive,
  RunLifecycleLayerLive,
  SpaceAgentLayerLive,
  SpaceAgentWakerLayerLive,
).pipe(Layer.provide(OrchestrationProjectionSnapshotQueryLive));

const PreviewLayerLive = Layer.empty.pipe(
  Layer.provideMerge(PreviewManager.layer),
  Layer.provideMerge(PortScannerLayerLive),
);

const DeviceLayerLive = DeviceService.layer.pipe(
  Layer.provide(ServerSettingsLayerLive),
  Layer.provide(ProcessRunner.layer),
  Layer.provide(NetService.layer),
);

const WorkspaceEntriesLayerLive = WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer));

const WorkspaceFileSystemLayerLive = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntriesLayerLive),
);

const WorkspaceLayerLive = Layer.mergeAll(
  WorkspacePaths.layer,
  WorkspaceEntriesLayerLive,
  WorkspaceFileSystemLayerLive,
);

const ProjectFaviconResolverLayerLive = ProjectFaviconResolver.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(T3ProjectFileLoader.layer),
);

const ServerEnvironmentLayerLive = ServerEnvironment.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
);

const AuthLayerLive = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provide(ServerEnvironmentLayerLive),
  Layer.provide(ServerSecretStore.layer),
);

const CloudManagedEndpointRuntimeLive = Layer.mergeAll(
  RelayClientLive,
  CloudManagedEndpointRuntime.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(RelayClientLive),
  ),
);

// Self-contained (not relying on ambient availability from wherever it gets
// merged in): it needs GitVcsDriver and ProjectSetupScriptRunner, neither of
// which flow through ProviderLayerLive/OrchestrationLayerLive.
const WorktreeCleanupLayerLive = WorktreeCleanupLive.pipe(
  Layer.provide(GitLayerLive),
  Layer.provide(ProjectSetupScriptRunnerLayerLive),
  Layer.provide(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(TerminalLayerLive),
);

// Reclaims build output with the same git checks as the worktree cleanup sweep.
const HostUsageLayerLive = HostUsage.layer.pipe(
  Layer.provide(GitLayerLive),
  Layer.provide(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(ProcessRunner.layer),
  Layer.provide(HostResources.layer),
);

const ProviderRuntimeLayerLive = Layer.mergeAll(
  ProviderSessionReaperLive,
  ProviderUsageLimitsIngestionLive,
  StalledTurnWatchdogLive,
  WorktreeCleanupLayerLive,
  HostUsageLayerLive,
).pipe(Layer.provideMerge(ProviderLayerLive), Layer.provideMerge(OrchestrationLayerLive));

const ProviderInstallationRefreshLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const antigravity = yield* AntigravityInstallation;
    const codex = yield* CodexInstallation;
    const instances = yield* ProviderInstanceRegistry;
    const providers = yield* ProviderRegistry;
    yield* Stream.merge(
      antigravity.changes.pipe(
        Stream.changesWith((a, b) => a.installedVersion === b.installedVersion),
        Stream.drop(1),
      ),
      codex.changes.pipe(
        Stream.changesWith((a, b) => a.installedVersion === b.installedVersion),
        Stream.drop(1),
      ),
    ).pipe(
      Stream.runForEach((state) =>
        instances.listInstances.pipe(
          Effect.flatMap((entries) =>
            Effect.forEach(
              entries.filter((instance) => instance.driverKind === state.driver),
              (instance) => providers.refreshInstance(instance.instanceId),
              { discard: true },
            ),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);

const RuntimeCoreDependenciesLive = ReactorLayerLive.pipe(
  Layer.provideMerge(ProviderInstallationRefreshLive),
  Layer.provideMerge(ReplayMarkers.layer),
  Layer.provideMerge(ProviderAuthServiceLive),
  // Core Services
  Layer.provideMerge(
    Layer.mergeAll(OrchestrationRuntimeStateLayerLive, ServerSettingsLayerLive, JudgeLayerLive),
  ),
  Layer.provideMerge(CheckpointingLayerLive),
  // `GitHubCli` is the registry's own instance, exposed because the asset route fetches
  // GitHub-hosted pull request media with the repository's credential.
  Layer.provideMerge(
    Layer.mergeAll(
      SourceControlProviderRegistryLayerLive,
      PullRequestServiceLive,
      GitHubCli.layer,
      // Shared by every consumer: the reactors that provision and tear down
      // sandboxes, and the checkpoint store that execs git inside them. See
      // the note on `CheckpointingLayerLive`.
      SandboxRuntimeManagerLive,
    ),
  ),
  Layer.provideMerge(GitLayerLive),
  Layer.provideMerge(VcsLayerLive),
  Layer.provideMerge(ProviderRuntimeLayerLive),
  Layer.provideMerge(
    Layer.mergeAll(PreviewLayerLive, CommandCenterLayerLive, DeviceLayerLive).pipe(
      Layer.provideMerge(TerminalLayerLive),
    ),
  ),
  // Web Push config/store/sender, shared by the notifier reactor (above) and the
  // route group. Kept above PersistenceLayerLive in the pipe so the later
  // PersistenceLayerLive satisfies the subscription store's SqlClient requirement;
  // nested so both stay a single pipe step and PersistenceLayerLive is still
  // exposed to the rest of the runtime.
  Layer.provideMerge(WebPushServicesLive.pipe(Layer.provideMerge(PersistenceLayerLive))),
  // Both read a user-owned file out of the state directory and stream changes
  // to clients; neither depends on the other.
  Layer.provideMerge(
    Layer.mergeAll(Keybindings.layer, EnvironmentTheme.layer, UsageLimitSources.layer),
  ),
  Layer.provideMerge(ProviderRegistryLive),
  // The instance registry is the new routing keystone — text generation,
  // adapter lookup, and runtime ingestion all resolve `ProviderInstanceId`
  // through this layer. Built-in drivers come from `BUILT_IN_DRIVERS`;
  // `providerInstances` hydration merges `settings.providers.<kind>`
  // with explicit `providerInstances` entries on boot.
  //
  // `ClaudeDriver.create` yields the efficiency `Judge` for the tool-result
  // sieve, so this hydration layer (the single site where `BUILT_IN_DRIVERS`
  // are instantiated) requires `Judge`. Close it here with `JudgeLayerLive`
  // so the requirement never leaks onto the runtime's exported surface —
  // Effect memoizes the shared layer reference, so this is the same Judge
  // singleton used by the tier-judgment dispatcher.
  Layer.provideMerge(ProviderInstanceRegistryHydrationLive.pipe(Layer.provide(JudgeLayerLive))),
).pipe(
  Layer.provideMerge(Layer.mergeAll(AntigravityInstallation.layer, CodexInstallation.layer)),
  // Shared native/canonical NDJSON writers used by both the per-instance
  // drivers (native stream, written from inside each `<X>Adapter`) and
  // `ProviderService` (canonical stream, written after event normalization).
  // Provided once at the runtime level so every consumer sees the same
  // logger instances.
  // `ModelManifest.layer` is the legacy-model classification data, refreshed
  // from the repo's `model-manifest.json` on `main` and applied by the
  // Codex/Claude drivers.
  Layer.provideMerge(
    Layer.mergeAll(ProviderEventLoggers.layer, ModelManifest.layer, ResetCreditCoordinator.layer),
  ),
  // `OpenCodeDriver.create()` yields `OpenCodeRuntime`; previously the old
  // `ProviderRegistryLive` pulled `OpenCodeRuntimeLive` in for itself, but
  // the rewritten registry reads snapshots off the instance registry and
  // no longer transitively provides it. Exposing it at the runtime level
  // keeps a single Live for all opencode consumers.
  Layer.provideMerge(OpenCodeRuntime.OpenCodeRuntimeLive),
  Layer.provideMerge(WorkspaceLayerLive),
  Layer.provideMerge(Layer.mergeAll(NativeAppIconResolver.layer, ProjectFaviconResolverLayerLive)),
  Layer.provideMerge(RepositoryIdentityResolverLayerLive),
  Layer.provideMerge(ServerEnvironmentLayerLive),
  Layer.provideMerge(AuthLayerLive),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      CloudCliTokenManager.layer.pipe(
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(ExternalLauncher.layer),
      ),
      CloudManagedEndpointRuntimeLive,
    ),
  ),
);

const RuntimeDependenciesLive = RuntimeCoreDependenciesLive.pipe(
  // Misc.
  Layer.provideMerge(SprintPlan.layer.pipe(Layer.provide(PersistenceLayerLive))),
  Layer.provideMerge(ReadinessGate.layer),
  Layer.provideMerge(ProcessDiagnostics.layer),
  Layer.provideMerge(ProcessResourceMonitor.layer),
  Layer.provideMerge(BackgroundLayerLive),
  Layer.provideMerge(ResourceDiagnosticsLayerLive),
  Layer.provideMerge(UsageLayerLive),
  Layer.provideMerge(TraceDiagnostics.layer),
  Layer.provideMerge(AnalyticsService.layer),
  Layer.provideMerge(ExternalLauncher.layer),
  Layer.provideMerge(RemoteOpenTargets.layer),
  Layer.provideMerge(ServerLifecycleEvents.layer),
  Layer.provide(NetService.layer),
);

const commandReadinessLayer = HttpRouter.middleware(
  (httpEffect) =>
    Effect.flatMap(ServerRuntimeStartup.ServerRuntimeStartup, (startup) =>
      startup.awaitCommandReady.pipe(Effect.orDie, Effect.andThen(httpEffect)),
    ),
  { global: true },
);

export const makeRoutesLayer = Layer.mergeAll(
  Layer.mergeAll(
    HttpApiBuilder.layer(EnvironmentHttpApi).pipe(
      Layer.provide(authHttpApiLayer),
      Layer.provide(connectHttpApiLayer),
      Layer.provide(orchestrationHttpApiLayer),
      Layer.provide(pullRequestHttpApiLayer),
      Layer.provide(webPushHttpApiLayer),
      Layer.provide(serverEnvironmentHttpApiLayer),
      Layer.provide(environmentAuthenticatedAuthLayer),
    ),
    otlpTracesProxyRouteLayer,
    desktopHttpRouteLayer,
    desktopSignalHttpRouteLayer,
    sandboxCredentialHttpRouteLayer,
    sandboxArtifactHttpRouteLayer,
    sandboxPreviewResolveHttpRouteLayer,
    assetRouteLayer,
    attachmentUploadRouteLayer,
    deviceHubProxyRouteLayer,
    staticAndDevRouteLayer,
    webhookHttpRouteLayer,
    websocketRpcRouteLayer,
  ),
  McpHttpServer.layer.pipe(
    Layer.provide(SupabaseMcpConnector.layer),
    Layer.provide(McpSessionRegistry.layer),
  ),
  // Last, so no route layer can replace the server's one TracerDisabledWhen.
  untracedRequestsLayer,
).pipe(
  // Both transports consume the same service instance, so caches single-flight across clients
  // and mutations observed on WebSocket invalidate patches subsequently read over HTTP.
  Layer.provide(PullRequestServiceLive),
  Layer.provide(PreviewAutomationBroker.layer),
  Layer.provide(ServerSelfUpdate.layer.pipe(Layer.provide(DesktopAppUpdateLayerLive))),
  Layer.provide(commandReadinessLayer),
  Layer.provide(browserApiCorsLayer),
  Layer.provide(httpCompressionLayer),
);

const makeServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const activation = yield* Deferred.make<void>();
    const awaitActivation = Deferred.await(activation);
    const activationLayer = Layer.succeed(ServerActivation, awaitActivation);
    const runtimeStateParked = yield* Deferred.make<void>();
    const tailscaleParked = yield* Deferred.make<void>();
    const cloudLinkParked = yield* Deferred.make<void>();
    const routesReady = yield* Deferred.make<void>();
    const launcherLayer = ServiceLauncherClient.layer;

    yield* fixPath();

    const httpListeningLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* HttpServer.HttpServer;
        const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
        yield* startup.markHttpListening;
      }),
    );
    const runtimeStateLayer = Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.gen(function* () {
          yield* Deferred.succeed(runtimeStateParked, undefined).pipe(Effect.orDie);
          yield* awaitActivation;
          const server = yield* HttpServer.HttpServer;
          const address = server.address;
          if (typeof address === "string" || !("port" in address)) {
            return;
          }

          const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
          const state = yield* makePersistedServerRuntimeState({
            config,
            port: address.port,
            serviceManaged: launcher.managed,
          });
          yield* persistServerRuntimeState({
            path: config.serverRuntimeStatePath,
            state,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to persist server runtime state", { cause }),
            ),
          );
        }),
        () =>
          clearPersistedServerRuntimeState(config.serverRuntimeStatePath).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to clear server runtime state", { cause }),
            ),
          ),
      ),
    );
    const tailscaleServeLayer = config.tailscaleServeEnabled
      ? Layer.effectDiscard(
          Effect.acquireRelease(
            Effect.gen(function* () {
              yield* Deferred.succeed(tailscaleParked, undefined).pipe(Effect.orDie);
              yield* awaitActivation;
              const server = yield* HttpServer.HttpServer;
              const address = server.address;
              if (typeof address === "string" || !("port" in address)) {
                return null;
              }

              const localPort = address.port;
              return yield* ensureTailscaleServe({
                localPort,
                servePort: config.tailscaleServePort,
                localHost: "127.0.0.1",
              }).pipe(
                Effect.as({ localPort, servePort: config.tailscaleServePort }),
                Effect.tap(() =>
                  Effect.logInfo("Tailscale Serve configured", {
                    localPort,
                    servePort: config.tailscaleServePort,
                  }),
                ),
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to configure Tailscale Serve", {
                    cause,
                    localPort,
                    servePort: config.tailscaleServePort,
                  }).pipe(Effect.as(null)),
                ),
              );
            }),
            (configured) =>
              configured
                ? disableTailscaleServe({ servePort: configured.servePort }).pipe(
                    Effect.tap(() =>
                      Effect.logInfo("Tailscale Serve disabled", {
                        servePort: configured.servePort,
                      }),
                    ),
                    Effect.catch((cause) =>
                      Effect.logWarning("Failed to disable Tailscale Serve", {
                        cause,
                        servePort: configured.servePort,
                      }),
                    ),
                  )
                : Effect.void,
          ),
        )
      : Layer.empty;
    // The gateway is a second listener, so it needs its own Serve mapping on its
    // own HTTPS port. It is published from the configured port rather than the
    // bound address because the gateway server lives in a sibling layer scope.
    const previewGatewayTailscaleServeLayer =
      config.tailscaleServeEnabled && config.previewGatewayEnabled && config.previewGatewayPort > 0
        ? Layer.effectDiscard(
            Effect.acquireRelease(
              ensureTailscaleServe({
                localPort: config.previewGatewayPort,
                servePort: config.previewGatewayServePort,
                localHost: "127.0.0.1",
              }).pipe(
                Effect.as({ servePort: config.previewGatewayServePort }),
                Effect.tap(() =>
                  Effect.logInfo("Tailscale Serve configured for preview gateway", {
                    localPort: config.previewGatewayPort,
                    servePort: config.previewGatewayServePort,
                  }),
                ),
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to configure Tailscale Serve for preview gateway", {
                    cause,
                    localPort: config.previewGatewayPort,
                    servePort: config.previewGatewayServePort,
                  }).pipe(Effect.as(null)),
                ),
              ),
              (configured) =>
                configured
                  ? disableTailscaleServe({ servePort: configured.servePort }).pipe(
                      Effect.catch((cause) =>
                        Effect.logWarning("Failed to disable Tailscale Serve for preview gateway", {
                          cause,
                          servePort: configured.servePort,
                        }),
                      ),
                    )
                  : Effect.void,
            ),
          )
        : Layer.empty;
    const previewGatewayLayer = config.previewGatewayEnabled
      ? makePreviewGatewayServedLayer(PreviewGatewayHttpServerLive)
      : Layer.empty;
    const cloudDesiredLinkReconcileLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        const releaseManagedTunnel = releaseManagedTunnelOnShutdown().pipe(
          Effect.timeout("10 seconds"),
          Effect.tap((released) =>
            released ? Effect.logInfo("Released the managed tunnel on shutdown") : Effect.void,
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "Failed to release the managed tunnel on shutdown; the next link reuses it",
              { errors: Cause.prettyErrors(cause).map((error) => error.message) },
            ),
          ),
          Effect.asVoid,
        );
        // A launcher trial can be stopped before activation. The previous
        // server is already gone, so the trial owns cleanup immediately; the
        // pending-state check keeps the tunnel for normal commit or rollback,
        // while the launcher's explicit-stop marker allows it to be released.
        // Other runtimes wait for activation so a failed standby cannot tear
        // down the active runtime's tunnel.
        const cleanupBeforeActivation = yield* pendingServiceUpdateExists;
        if (cleanupBeforeActivation) {
          yield* Effect.addFinalizer(() => releaseManagedTunnel);
        }
        yield* forkParked(
          Effect.gen(function* () {
            if (!cleanupBeforeActivation) {
              yield* Effect.addFinalizer(() => releaseManagedTunnel);
            }
            const server = yield* HttpServer.HttpServer;
            const address = server.address;
            if (typeof address === "string" || !("port" in address)) return;
            const localOrigin = `http://127.0.0.1:${address.port}`;
            const endpointRuntime = yield* CloudManagedEndpointRuntime.CloudManagedEndpointRuntime;
            const recoveryLock = yield* Semaphore.make(1);
            let lastRecoveryAtMillis = 0;
            const recoverManagedTunnel = (config: RelayManagedEndpointRuntimeConfig) =>
              recoveryLock.withPermits(1)(
                Effect.gen(function* () {
                  const elapsed = (yield* Clock.currentTimeMillis) - lastRecoveryAtMillis;
                  const wait = Duration.toMillis(MANAGED_TUNNEL_RECOVERY_COOLDOWN) - elapsed;
                  if (wait > 0) yield* Effect.sleep(Duration.millis(wait));
                  lastRecoveryAtMillis = yield* Clock.currentTimeMillis;
                }).pipe(
                  Effect.andThen(
                    recoverManagedCloudTunnel(localOrigin, config, {
                      retryRuntimeFailures: true,
                    }),
                  ),
                  Effect.retry({
                    while: (error) =>
                      shouldRetryCloudLink(error) &&
                      error._tag !== "EnvironmentCloudEndpointUnavailableError",
                    schedule: Schedule.exponential("1 second").pipe(
                      Schedule.modifyDelay(({ duration }) =>
                        Effect.succeed(Duration.min(duration, Duration.seconds(30))),
                      ),
                      Schedule.jittered,
                    ),
                  }),
                  Effect.tap((recovered) =>
                    recovered ? Effect.logInfo("T3 Connect managed tunnel recovered") : Effect.void,
                  ),
                  Effect.catchCause((cause) =>
                    Cause.hasInterrupts(cause)
                      ? Effect.interrupt
                      : Effect.logWarning("Failed to recover the T3 Connect managed tunnel", {
                          cause,
                        }),
                  ),
                ),
              );
            yield* endpointRuntime.recoveryRequests.pipe(
              Stream.runForEach(recoverManagedTunnel),
              Effect.forkScoped,
            );
            // No settling delay before the first attempt: routes are already
            // serving by the time activation opens this gate (the startup
            // sequence awaits routesReady), and the retry schedule below
            // covers anything this sleep used to hedge against. Every
            // millisecond here is dead time on the path to remote
            // reachability after a restart.
            const wantsCliLink = hasCloudPublicConfig
              ? yield* CloudCliState.readCliDesiredCloudLink.pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("Failed to read the desired T3 Connect link", { cause }).pipe(
                      Effect.as(false),
                    ),
                  ),
                )
              : false;
            // A failed read must not end this fiber before it registers
            // recovery and starts consuming recovery requests. "managed" is
            // what a missing value means, so it is the safe fallback.
            const desiredCliLinkMode = wantsCliLink
              ? yield* CloudCliState.readCliDesiredLinkMode.pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("Failed to read the desired T3 Connect link mode", {
                      cause,
                    }).pipe(Effect.as("managed" as const)),
                  ),
                )
              : null;
            // A publish-only link must not expose the host, even if a managed
            // config from an earlier link is still stored.
            const startedConfirmed =
              desiredCliLinkMode === "publish_only"
                ? false
                : yield* startManagedCloudTunnelIfOriginConfirmed(localOrigin).pipe(
                    Effect.catch((cause) =>
                      Effect.logWarning("Failed to start the confirmed T3 Connect tunnel", {
                        cause,
                      }).pipe(Effect.as(false)),
                    ),
                  );
            const startStoredManagedTunnel = startManagedCloudTunnelIfOriginConfirmed(localOrigin, {
              requireConfirmedOrigin: false,
            }).pipe(
              Effect.tap((started) =>
                started
                  ? Effect.logWarning(
                      "T3 Connect started the stored tunnel without relay confirmation",
                    )
                  : Effect.void,
              ),
              Effect.catch((cause) =>
                Effect.logWarning("Failed to start the stored T3 Connect tunnel", { cause }),
              ),
              Effect.asVoid,
            );
            const registerManagedTunnel = retryManagedTunnelRegistration(
              registerManagedCloudTunnelRecovery(localOrigin, {
                retryRuntimeFailures: true,
              }),
              (error) =>
                shouldRetryCloudLink(error) &&
                error._tag !== "EnvironmentCloudEndpointUnavailableError",
              startedConfirmed ? Effect.void : startStoredManagedTunnel,
            ).pipe(
              Effect.tap((result) =>
                result.status === "ready"
                  ? Effect.logInfo("T3 Connect managed tunnel recovery registered")
                  : Effect.void,
              ),
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.interrupt
                  : Effect.logWarning("Failed to register T3 Connect managed tunnel recovery", {
                      cause,
                    }).pipe(Effect.as({ status: "unavailable" as const })),
              ),
            );
            // A host without a confirmed marker is on its first boot after the
            // upgrade. Spread those registrations so an auto-update wave does
            // not hit the relay all at once.
            if (!startedConfirmed && desiredCliLinkMode !== "publish_only") {
              const jitter = yield* Random.nextIntBetween(
                0,
                Duration.toMillis(MANAGED_TUNNEL_FIRST_REGISTRATION_JITTER),
              );
              yield* Effect.sleep(Duration.millis(jitter));
            }
            const registration =
              desiredCliLinkMode === "publish_only"
                ? { status: "not_linked" as const }
                : yield* registerManagedTunnel;
            // A terminal registration failure also allows the stored config
            // to start. Transient outages use the fallback above and keep
            // registration retrying in this scoped startup fiber.
            if (registration.status === "unavailable" && !startedConfirmed) {
              yield* startStoredManagedTunnel;
            }
            const startupAction = managedTunnelStartupAction({ wantsCliLink, registration });
            if (startupAction.action === "request_recovery") {
              yield* endpointRuntime.requestRecovery(startupAction.config);
            }
            if (startupAction.action === "reconcile_link") {
              const reconciledMode = yield* reconcileDesiredCloudLinkIfStillDesired(
                localOrigin,
              ).pipe(
                Effect.retry({
                  while: shouldRetryCloudLink,
                  schedule: Schedule.exponential("1 second").pipe(
                    Schedule.modifyDelay(({ duration }) =>
                      Effect.succeed(Duration.min(duration, Duration.seconds(30))),
                    ),
                    Schedule.upTo({ duration: "10 minutes" }),
                  ),
                }),
                Effect.tap((mode) =>
                  mode === null
                    ? Effect.void
                    : Effect.logInfo("T3 Connect desired link reconciled on startup"),
                ),
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to reconcile T3 Connect desired link on startup", {
                    cause,
                  }).pipe(Effect.as(null)),
                ),
              );
              if (reconciledMode === "managed") {
                const afterReconcile = yield* registerManagedTunnel;
                if (afterReconcile.status === "recovery_required") {
                  yield* endpointRuntime.requestRecovery(afterReconcile.config);
                }
              }
            }
          }),
        );
        yield* Deferred.succeed(cloudLinkParked, undefined).pipe(Effect.orDie);
      }),
    );

    const runtimeServicesLive = ServerRuntimeStartup.layerWithOptions({
      activate: Deferred.succeed(activation, undefined).pipe(Effect.asVoid),
      abort: (error) => Deferred.die(activation, error).pipe(Effect.asVoid),
      awaitAuxiliaryParked: Effect.all(
        [
          Deferred.await(runtimeStateParked),
          Deferred.await(cloudLinkParked),
          Deferred.await(routesReady),
          ...(config.tailscaleServeEnabled ? [Deferred.await(tailscaleParked)] : []),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.asVoid),
    }).pipe(Layer.provideMerge(RuntimeDependenciesLive), Layer.provide(launcherLayer));

    const routesLayer = HttpRouter.serve(makeRoutesLayer.pipe(Layer.provide(launcherLayer)), {
      disableLogger: !config.logWebSocketEvents,
      routerConfig: HTTP_ROUTER_CONFIG,
    }).pipe(Layer.tap(() => Deferred.succeed(routesReady, undefined).pipe(Effect.orDie)));
    const serverApplicationLayer = Layer.mergeAll(
      routesLayer,
      httpListeningLayer,
      runtimeStateLayer.pipe(Layer.provide(launcherLayer)),
      tailscaleServeLayer,
      previewGatewayLayer,
      previewGatewayTailscaleServeLayer,
      cloudDesiredLinkReconcileLayer,
      HeapSnapshot.layer,
    );

    return serverApplicationLayer.pipe(
      Layer.provideMerge(runtimeServicesLive),
      Layer.provide(activationLayer),
      Layer.provideMerge(serverRelayBrokerTracingLayer),
      Layer.provideMerge(HttpServerLive),
      Layer.provide(ApplicationObservabilityLive),
      Layer.provideMerge(FetchHttpClient.layer),
      // PR reads, Git operations, and WebSocket discovery share one process limiter.
      Layer.provide(VcsProcess.layer),
      Layer.provide(OrchestrationRuntimeStateLayerLive),
      Layer.provideMerge(PlatformServicesLive),
    );
  }),
);

// The CLI supplies configuration.
export const runServer = Layer.launch(makeServerLayer);
