import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  CommandId,
  EnvironmentId,
  type ServerLifecycleStreamEvent,
} from "@t3tools/contracts";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

import { makeCommandCenterAuditLog } from "./command-center/AuditLog.ts";
import * as GoogleActivityPoller from "./command-center/GoogleActivityPoller.ts";
import * as GoogleReadConnector from "./command-center/GoogleReadConnector.ts";
import * as ReadinessGate from "./command-center/ReadinessGate.ts";
import * as RunRecoveryCoordinator from "./command-center/RunRecoveryCoordinator.ts";
import * as CommandCenterService from "./command-center/Service.ts";
import * as SpaceActivityReactor from "./command-center/SpaceActivityReactor.ts";
import * as SpaceAgentWaker from "./command-center/SpaceAgentWaker.ts";
import * as AutomationRecoveryCoordinator from "./command-center/automation/RecoveryCoordinator.ts";
import * as AutomationScheduleRunner from "./command-center/automation/ScheduleRunner.ts";
import * as HostUsage from "./resourceTelemetry/HostUsage.ts";
import * as WorktreeCleanup from "./worktreeCleanup.ts";
import * as ServerConfig from "./config.ts";
import { layerMemory as SqlitePersistenceMemory } from "./persistence/Sqlite.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as Keybindings from "./keybindings.ts";
import * as EffectWorker from "./orchestration-v2/EffectWorker.ts";
import * as LegacyV1ThreadImporter from "./orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProviderRuntimeRecovery from "./orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as ThreadLaunch from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";
import { ServerActivation } from "./serverActivation.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";

const commandCenterAuditStartupLayer = Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer);

it.effect("verifies every configured Google connection before command readiness", () =>
  Effect.gen(function* () {
    const verified = yield* Ref.make<ReadonlyArray<string>>([]);

    yield* ServerRuntimeStartup.verifyConfiguredGoogleConnections(
      {
        queryConnections: () =>
          Effect.succeed({
            connections: [
              { id: "google-a", spaceId: "space-a", kind: "google" },
              { id: "google-b", spaceId: "space-b", kind: "google" },
              { id: "github-a", spaceId: "space-a", kind: "github" },
            ] as never,
          }),
      },
      {
        verify: ({ connectionId }) =>
          Ref.update(verified, (current) => [...current, connectionId]).pipe(
            Effect.flatMap(() =>
              connectionId === "google-b"
                ? Effect.fail({ reason: "process" } as never)
                : Effect.void,
            ),
          ),
      },
    );

    // Both Google connections are checked (one failure does not stop the
    // other) and non-Google connections are not.
    assert.deepStrictEqual([...(yield* Ref.get(verified))].sort(), ["google-a", "google-b"]);
  }),
);

it.effect("starts Command Center workers only after valid audit history is verified", () =>
  Effect.gen(function* () {
    const auditLog = yield* makeCommandCenterAuditLog;
    const startedWorkers = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* auditLog.append({
      eventId: "startup-valid",
      actorKind: "system",
      action: "fixture.startup.valid",
      payload: { valid: true },
      occurredAt: "2026-01-01T00:00:00.000Z",
    });

    yield* ServerRuntimeStartup.startCommandCenterWorkersAfterAuditVerification(
      auditLog.verify,
      Ref.set(startedWorkers, ["schedule", "automation-recovery", "run-recovery"]),
    );

    assert.deepStrictEqual(yield* Ref.get(startedWorkers), [
      "schedule",
      "automation-recovery",
      "run-recovery",
    ]);
  }).pipe(Effect.provide(commandCenterAuditStartupLayer)),
);

it.effect("runs projection-writing connector startup only after audit verification", () =>
  Effect.gen(function* () {
    const order = yield* Ref.make<ReadonlyArray<string>>([]);

    yield* ServerRuntimeStartup.startCommandCenterWorkersAfterAuditVerification(
      Ref.update(order, (current) => [...current, "audit"]).pipe(
        Effect.as({
          valid: true,
          eventCount: 0,
          headSequence: null,
          headHash: null,
        }),
      ),
      Effect.gen(function* () {
        yield* Ref.update(order, (current) => [...current, "google-health"]);
        yield* Ref.update(order, (current) => [...current, "workers"]);
      }),
    );

    assert.deepStrictEqual(yield* Ref.get(order), ["audit", "google-health", "workers"]);
  }),
);

it.effect("fails closed before Command Center workers start when audit history is tampered", () =>
  Effect.gen(function* () {
    const auditLog = yield* makeCommandCenterAuditLog;
    const sql = yield* SqlClient.SqlClient;
    const startedWorkers = yield* Ref.make(0);
    yield* auditLog.append({
      eventId: "startup-tampered",
      actorKind: "system",
      action: "fixture.startup.tampered",
      payload: { valid: true },
      occurredAt: "2026-01-01T00:00:00.000Z",
    });

    // Simulate historical storage corruption that bypassed the normal
    // append-only database protections.
    yield* sql`DROP TRIGGER command_center_audit_events_no_update`;
    yield* sql`
      UPDATE command_center_audit_events
      SET payload_json = '{"valid":false}'
      WHERE event_id = 'startup-tampered'
    `;

    const error = yield* ServerRuntimeStartup.startCommandCenterWorkersAfterAuditVerification(
      auditLog.verify,
      Ref.update(startedWorkers, (count) => count + 1),
    ).pipe(Effect.flip);

    assert.instanceOf(error, ServerRuntimeStartup.CommandCenterAuditIntegrityError);
    assert.equal(error.reason, "event-hash");
    assert.equal(error.invalidSequence, 1);
    assert.equal(yield* Ref.get(startedWorkers), 0);
  }).pipe(Effect.provide(commandCenterAuditStartupLayer)),
);

it.effect.each([
  "disabled-codex",
  "disabled-default",
  "launch-failure",
  "project-failure",
] as const)("keeps bootstrap launch failures separate from project failures: %s", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const projectId = ProjectId.make("bootstrap-project");
      const instanceId = ProviderInstanceId.make(
        scenario === "disabled-default" ? "custom" : "codex",
      );
      const events: ServerLifecycleStreamEvent[] = [];
      const recovery = {
        terminalizedRuns: 0,
        stoppedSessions: 0,
        closedRequests: 0,
        retiredEffects: 0,
        requeuedEffects: 0,
      };
      const imports = { importedThreadCount: 0, importedMessageCount: 0 };
      const dependencies = Layer.mergeAll(
        NodeCrypto.layer,
        Path.layer,
        Layer.mock(ServerConfig.ServerConfig)({
          ...(yield* ServerConfig.deriveServerPaths("/bootstrap-project", undefined).pipe(
            Effect.provide(Path.layer),
          )),
          baseDir: "/bootstrap-project",
          logLevel: "Error",
          traceMinLevel: "Info",
          traceTimingEnabled: false,
          traceBatchWindowMs: 200,
          traceMaxBytes: 1024,
          traceMaxFiles: 1,
          otlpTracesUrl: undefined,
          otlpMetricsUrl: undefined,
          otlpLogsUrl: undefined,
          otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
          otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
          otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
          otelEnvironment: OtelEnvironment.none,
          staticDir: undefined,
          devAllowedOrigins: [],
          desktopBootstrapToken: undefined,
          logWebSocketEvents: false,
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
          previewGatewayEnabled: false,
          previewGatewayPort: 0,
          previewGatewayServePort: ServerConfig.DEFAULT_PREVIEW_GATEWAY_SERVE_PORT,
          mode: "web",
          cwd: "/bootstrap-project",
          host: "localhost",
          port: 3773,
          devUrl: undefined,
          noBrowser: true,
          startupPresentation: "browser",
          autoBootstrapProjectFromCwd: true,
        }),
        Layer.mock(Keybindings.Keybindings)({ start: Effect.void }),
        Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({
          pendingThreadCount: Effect.succeed(0),
          reconcileShells: Effect.succeed(imports),
          importPendingTranscripts: Effect.succeed(imports),
        }),
        Layer.mock(ProviderRuntimeRecovery.ProviderRuntimeRecoveryService)({
          recover: Effect.succeed(recovery),
          prepareForShutdown: Effect.void,
          reconcile: () => Effect.succeed(recovery),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({ recoverDelegatedTasks: Effect.void }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ shutdown: Effect.void }),
        Layer.mock(AgentAwarenessRelay.AgentAwarenessRelay)({ start: () => Effect.void }),
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({ runOnce: Effect.never }),
        Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({
          publish: (event) =>
            Effect.sync(() => {
              const published = { ...event, sequence: events.length + 1 };
              events.push(published);
              return published;
            }),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          start: Effect.void,
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            defaultModelSelection:
              scenario === "disabled-default" ? { instanceId, model: "custom-model" } : null,
            providerInstances: {
              [instanceId]: {
                driver: ProviderDriverKind.make("codex"),
                enabled: false,
                config: {},
              },
            },
          }),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId: EnvironmentId.make("bootstrap-environment"),
            label: "Test environment",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          }),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({}),
        Layer.mock(ProjectService.ProjectService)({
          bootstrap: () =>
            scenario === "project-failure"
              ? Effect.die("project bootstrap failed")
              : Effect.succeed({
                  created: true,
                  project: {
                    id: projectId,
                    title: "Project",
                    workspaceRoot: "/bootstrap-project",
                    repositoryIdentity: null,
                    faviconPath: null,
                    scripts: [],
                    createdAt: "2026-01-01T00:00:00Z",
                    updatedAt: "2026-01-01T00:00:00Z",
                    deletedAt: null,
                    defaultModelSelection:
                      scenario === "disabled-default"
                        ? { instanceId, model: "custom-model" }
                        : null,
                  },
                }),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getShellSnapshot: () =>
            Effect.succeed({
              threads: [],
              archivedThreads: [],
              schemaVersion: 1,
              snapshotSequence: 0,
            }),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) => {
            assert.equal(input.modelSelection.instanceId, instanceId);
            return scenario === "launch-failure"
              ? Effect.fail(
                  new ThreadLaunch.ThreadLaunchError({
                    operation: "create-thread",
                    commandId: CommandId.make("bootstrap-command"),
                    projectId,
                    cause: "test launch failure",
                  }),
                )
              : Effect.fail(
                  new ThreadManagement.ThreadManagementProviderInstanceDisabledError({
                    projectId,
                    instanceId,
                  }),
                );
          },
        }),
        Layer.mock(ServiceLauncherClient.ServiceLauncherClient)({
          managed: false,
          // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
          prepareTrial: Effect.succeed(undefined),
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(AnalyticsService.AnalyticsService)({}),
        // No provider logins or Connect link, so startup records no owners.
        FileSystem.layerNoop({}),
        Layer.mock(ServerSecretStore.ServerSecretStore)({ get: () => Effect.succeedNone }),
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
        Layer.mock(ExternalLauncher.ExternalLauncher)({}),
        Layer.mock(HttpServer.HttpServer)({
          address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
        }),
        // Command Center startup dependencies (fork): an empty audit chain and
        // idle workers, so startup reaches the bootstrap phase unchanged.
        Layer.orDie(SqlitePersistenceMemory),
        Layer.mock(WorktreeCleanup.WorktreeCleanup)({ start: () => Effect.void }),
        Layer.mock(HostUsage.HostUsage)({ start: () => Effect.void }),
        Layer.mock(AutomationScheduleRunner.AutomationScheduleRunner)({
          start: () => Effect.void,
        }),
        Layer.mock(SpaceAgentWaker.SpaceAgentWaker)({ start: () => Effect.void }),
        Layer.mock(SpaceActivityReactor.SpaceActivityReactor)({ start: () => Effect.void }),
        Layer.mock(GoogleActivityPoller.GoogleActivityPoller)({ start: () => Effect.void }),
        Layer.mock(AutomationRecoveryCoordinator.AutomationRecoveryCoordinator)({
          start: () => Effect.void,
        }),
        Layer.mock(RunRecoveryCoordinator.RunRecoveryCoordinator)({ start: () => Effect.void }),
        Layer.mock(CommandCenterService.CommandCenterService)({
          queryConnections: () => Effect.succeed({ connections: [] }),
          // Parked forever: the periodic config refresh is not under test.
          syncConfiguration: () => Effect.never,
        }),
        Layer.mock(GoogleReadConnector.GoogleReadConnector)({}),
        ReadinessGate.layer,
      );
      yield* Effect.gen(function* () {
        const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
        yield* startup.markHttpListening;
        const ready = yield* Effect.exit(startup.awaitCommandReady);
        assert.equal(Exit.isSuccess(ready), scenario !== "project-failure");
        const welcome = events.find((event) => event.type === "welcome");
        if (scenario === "project-failure") {
          assert.isUndefined(welcome);
        } else {
          assert.isDefined(welcome);
          if (welcome?.type === "welcome") {
            assert.equal(welcome.payload.bootstrapProjectId, projectId);
            assert.isUndefined(welcome.payload.bootstrapThreadId);
          }
        }
      }).pipe(
        Effect.provide(ServerRuntimeStartup.layerWithOptions().pipe(Layer.provide(dependencies))),
        Effect.provideService(ServerActivation, Effect.never),
      );
    }),
  ),
);

it.effect("interrupts the effect worker when awareness relay startup fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const workerInterrupted = yield* Ref.make(false);
      const workerFiberRef = yield* Ref.make<Fiber.Fiber<void, never> | null>(null);

      const exit = yield* ServerRuntimeStartup.startEffectWorkerWithRelay({
        runWorker: Effect.never.pipe(Effect.ensuring(Ref.set(workerInterrupted, true))),
        startRelay: Effect.yieldNow.pipe(
          Effect.andThen(Effect.die("awareness relay startup failed")),
        ),
        workerFiberRef,
      }).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      assert.isTrue(yield* Ref.get(workerInterrupted));
      assert.isNull(yield* Ref.get(workerFiberRef));
    }),
  ),
);

it.effect("queues commands until startup signals readiness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* ServerRuntimeStartup.makeCommandGate;
      const count = yield* Ref.make(0);
      const queued = yield* gate
        .enqueueCommand(Ref.updateAndGet(count, (value) => value + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(count), 0);
      yield* gate.signalCommandReady;
      assert.equal(yield* Fiber.join(queued), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
          cause: new Error("test startup failure"),
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "Server runtime startup failed before command readiness.");
    }),
  ),
);

it.effect("automatic pull only updates enabled, behind, clean default-branch checkouts", () =>
  Effect.gen(function* () {
    const pulled: string[] = [];
    const git = {
      statusDetails: (cwd: string) =>
        Effect.succeed({
          isRepo: true,
          isDefaultBranch: cwd !== "/feature",
          hasUpstream: true,
          hasWorkingTreeChanges: cwd === "/dirty",
          aheadCount: cwd === "/ahead" ? 1 : 0,
          behindCount: cwd === "/current" ? 0 : 1,
        } as never),
      pullCurrentBranch: (cwd: string) =>
        Effect.sync(() => {
          pulled.push(cwd);
          return {
            status: "pulled" as const,
            refName: "main",
            upstreamRef: "origin/main",
          };
        }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];
    const project = (workspaceRoot: string) =>
      ({ id: ProjectId.make(workspaceRoot), workspaceRoot }) as never;
    const overrides = (entries: Record<string, boolean>) => ({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: Object.fromEntries(
        Object.entries(entries).map(([root, defaultAutoPull]) => [
          ProjectId.make(root),
          { defaultAutoPull },
        ]),
      ),
    });

    yield* ServerRuntimeStartup.autoPullProjects(
      [
        project("/clean"),
        project("/current"),
        project("/dirty"),
        project("/ahead"),
        project("/feature"),
        project("/disabled"),
      ],
      overrides({
        "/clean": true,
        "/current": true,
        "/dirty": true,
        "/ahead": true,
        "/feature": true,
        "/disabled": false,
      }),
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));

    assert.deepStrictEqual(pulled, ["/clean"]);

    pulled.length = 0;
    yield* ServerRuntimeStartup.autoPullProjects(
      [project("/inherited"), project("/opted-out"), project("/dirty")],
      { ...overrides({ "/opted-out": false }), defaultAutoPull: true },
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));
    assert.deepStrictEqual(pulled, ["/inherited"]);
  }),
);
