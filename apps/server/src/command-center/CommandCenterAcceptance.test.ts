import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CAPABILITY_NAMES,
  Connection,
  Item,
  Memory,
  ProviderAvailability,
  RunId,
  Space,
  type ProviderAvailability as ProviderAvailabilityType,
} from "@command-center/core";
import {
  type ClientOrchestrationCommand,
  CommandCenterAutomationDefinitionCreateInput,
  CommandCenterAutomationDefinitionSnapshot,
  type CommandCenterCommandSubmitInput as CommandCenterCommandSubmitInputType,
  type CommandCenterCommandSubmitResult,
  CommandCenterCommandSubmitInput,
  CommandCenterMemoryProposeInput,
  CommandCenterRouteSelectedPayload,
  EnvironmentId,
  GoogleReadRequest,
  GoogleReadResult,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type GoogleReadRequest as GoogleReadRequestType,
  type GoogleReadResult as GoogleReadResultType,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { CommandCenterToolkitHandlersLive } from "../mcp/toolkits/command-center/handlers.ts";
import { CommandCenterToolkit } from "../mcp/toolkits/command-center/tools.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as AutomationDefinitionConfig from "./AutomationDefinitionConfig.ts";
import * as AutomationRuns from "./AutomationRuns.ts";
import { CommandCenterConfig, type LoadedCommandCenterConfig } from "./Config.ts";
import * as ConnectionHealth from "./ConnectionHealth.ts";
import * as GoogleReadConnector from "./GoogleReadConnector.ts";
import * as MemorySearchIndex from "./MemorySearchIndex.ts";
import * as ReadinessGate from "./ReadinessGate.ts";
import {
  type DispatcherDependencies,
  RunDispatcherError,
  type StoredRun,
  makeWithDependencies,
} from "./RunDispatcher.ts";
import {
  CommandCenterService,
  type CommandCenterServiceShape,
  layer as commandCenterServiceLayer,
} from "./Service.ts";

const fixtureTimestamp = "2026-01-01T00:00:00.000Z";
const decodeSpace = Schema.decodeUnknownSync(Space);
const decodeConnection = Schema.decodeUnknownSync(Connection);
const decodeProvider = Schema.decodeUnknownSync(ProviderAvailability);
const decodeAutomationCreate = Schema.decodeUnknownSync(
  CommandCenterAutomationDefinitionCreateInput,
);
const decodeAutomationSnapshot = Schema.decodeUnknownSync(
  CommandCenterAutomationDefinitionSnapshot,
);
const decodeCommand = Schema.decodeUnknownSync(CommandCenterCommandSubmitInput);
const decodeMemoryPropose = Schema.decodeUnknownSync(CommandCenterMemoryProposeInput);
const decodeMemory = Schema.decodeUnknownSync(Memory);
const decodeGoogleRead = Schema.decodeUnknownSync(GoogleReadRequest);
const decodeGoogleResult = Schema.decodeUnknownSync(GoogleReadResult);
const decodeItemsListResult = Schema.decodeUnknownSync(
  Schema.Struct({ items: Schema.Array(Item), needsYou: Schema.Array(Item) }),
);
const isGoogleReadRequest = Schema.is(GoogleReadRequest);
const decodeRouteReceipt = Schema.decodeUnknownSync(CommandCenterRouteSelectedPayload);
const decodeUnknownJsonString = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const studioSpace = decodeSpace({
  id: "example-studio",
  slug: "example-studio",
  displayName: "Example Studio",
  kind: "business",
  instructions: "Use the sample repository conventions.",
  policy: {
    allowedCapabilities: CAPABILITY_NAMES,
    autoRunRiskLevels: ["low", "reversible"],
  },
  connectionIds: [],
  repositories: [
    {
      id: "sample-mobile-app",
      displayName: "Sample Mobile App",
      aliases: ["legacy sample app"],
      remoteRef: "https://example.com/sample-mobile-app.git",
    },
  ],
  aliases: ["sample works"],
  lifecycle: "active",
  createdAt: fixtureTimestamp,
  updatedAt: fixtureTimestamp,
});

const systemSpace = decodeSpace({
  id: "example-command",
  slug: "example-command",
  displayName: "Example Command",
  kind: "system",
  instructions: "Route generic sample commands.",
  policy: {
    allowedCapabilities: CAPABILITY_NAMES,
    autoRunRiskLevels: ["low", "reversible"],
  },
  connectionIds: [],
  repositories: [],
  aliases: ["sample command"],
  lifecycle: "active",
  createdAt: fixtureTimestamp,
  updatedAt: fixtureTimestamp,
});

const personalSpace = decodeSpace({
  id: "example-personal",
  slug: "example-personal",
  displayName: "Example Personal",
  kind: "personal",
  instructions: "Use connected read-only services for personal context.",
  policy: {
    allowedCapabilities: CAPABILITY_NAMES,
    autoRunRiskLevels: ["low", "reversible"],
  },
  connectionIds: ["google-example"],
  repositories: [],
  aliases: ["my life"],
  lifecycle: "active",
  createdAt: fixtureTimestamp,
  updatedAt: fixtureTimestamp,
});

const googleConnection = decodeConnection({
  id: "google-example",
  spaceId: personalSpace.id,
  kind: "google",
  label: "Example read-only account",
  capabilities: [
    "cc.connections.google.gmail.read",
    "cc.connections.google.calendar.read",
    "cc.connections.google.drive.read",
  ],
  health: "disconnected",
});

const loadedConfig = {
  spaces: [studioSpace, systemSpace, personalSpace],
  connections: [googleConnection],
  automations: [],
  timezone: "Etc/UTC",
  routing: {
    mode: "auto",
    showPreview: true,
    explicitSelectionWins: true,
    providerFallback: "first-healthy-compatible",
  },
  health: { status: "loaded", configDirectory: "runtime-config" },
} satisfies LoadedCommandCenterConfig;

const makeConfigLayer = (config: LoadedCommandCenterConfig = loadedConfig) =>
  Layer.succeed(
    CommandCenterConfig,
    CommandCenterConfig.of({
      configDirectory: "runtime-config",
      load: Effect.succeed(config),
      resolveGoogleAccount: () =>
        Effect.die("Account resolution is replaced by the acceptance connector."),
    }),
  );

const makeTestLayer = (config: LoadedCommandCenterConfig = loadedConfig) =>
  commandCenterServiceLayer.pipe(
    Layer.provideMerge(makeConfigLayer(config)),
    Layer.provideMerge(ConnectionHealth.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );

const provider = decodeProvider({
  providerId: "provider-example",
  healthy: true,
  priority: 10,
  modelIds: ["model-example"],
  defaultModelId: "model-example",
  capabilities: CAPABILITY_NAMES,
}) satisfies ProviderAvailabilityType;

const routeReceiptFor = Effect.fn("CommandCenterAcceptance.routeReceiptFor")(function* (
  sql: SqlClient.SqlClient,
  runId: string,
) {
  const rows = yield* sql<{ readonly payloadJson: string }>`
    SELECT payload_json AS "payloadJson"
    FROM command_center_audit_events
    WHERE run_id = ${runId} AND action = 'cc.command.submit'
  `;
  expect(rows).toHaveLength(1);
  return decodeRouteReceipt(decodeUnknownJsonString(rows[0]!.payloadJson));
});

const runBoundaryFor = (sql: SqlClient.SqlClient, runId: string) =>
  sql<{
    readonly executionAuthorizedAt: string | null;
    readonly projectId: string | null;
    readonly resultJson: string | null;
    readonly state: StoredRun["state"];
    readonly threadId: string | null;
  }>`
    SELECT execution_authorized_at AS "executionAuthorizedAt",
      project_id AS "projectId", result_json AS "resultJson", state,
      thread_id AS "threadId"
    FROM command_center_runs
    WHERE id = ${runId}
  `;

interface MockGoogleConnector {
  readonly calls: Array<GoogleReadRequestType>;
  readonly service: GoogleReadConnector.GoogleReadConnectorShape;
}

const makeMockGoogleConnector = (): MockGoogleConnector => {
  const calls: Array<GoogleReadRequestType> = [];
  return {
    calls,
    service: GoogleReadConnector.GoogleReadConnector.of({
      verify: () => Effect.void,
      read: (request) =>
        Effect.sync(() => {
          calls.push(request);
          return decodeGoogleResult({
            operation: request.operation,
            contentTrust: "untrusted-external",
            data: { fixture: true },
          }) as GoogleReadResultType;
        }),
      exportDrive: () => Effect.die("Drive export is unavailable in this acceptance connector."),
      discardExport: () => Effect.void,
    }),
  };
};

const fakeHttpServer = HttpServer.HttpServer.of({
  address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 },
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("command-center-acceptance")),
  getDescriptor: Effect.die("The acceptance MCP registry does not need a host descriptor."),
});

const makeMcpRegistry = () =>
  McpSessionRegistry.__testing
    .make({ now: () => Date.parse(fixtureTimestamp) })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
    );

const dispatcherFailure = (
  reason: RunDispatcherError["reason"],
  runId: RunId,
  message: string,
  cause?: unknown,
) =>
  new RunDispatcherError({
    reason,
    runId,
    message,
    ...(cause === undefined ? {} : { cause }),
  });

interface DispatcherHarness {
  readonly dispatcher: ReturnType<typeof makeWithDependencies>;
  readonly dispatchCommand: (
    command: ClientOrchestrationCommand,
  ) => Effect.Effect<{ readonly sequence: number }>;
  readonly read: () => {
    readonly commands: ReadonlyArray<ClientOrchestrationCommand>;
    readonly failed: RunDispatcherError | undefined;
    readonly preparedWorktree:
      | {
          readonly projectId: ProjectId;
          readonly runId: RunId;
        }
      | undefined;
    readonly registeredScope: McpSessionRegistry.McpThreadScope | undefined;
  };
}

const makeDispatcherHarness = (
  sql: SqlClient.SqlClient,
  registry: McpSessionRegistry.McpSessionRegistryShape,
  submitted: CommandCenterCommandSubmitResult,
  command: CommandCenterCommandSubmitInputType,
): DispatcherHarness => {
  const commands: Array<ClientOrchestrationCommand> = [];
  let failed: RunDispatcherError | undefined;
  let preparedWorktree:
    | {
        readonly projectId: ProjectId;
        readonly runId: RunId;
      }
    | undefined;
  let registeredScope: McpSessionRegistry.McpThreadScope | undefined;

  const dependencies: DispatcherDependencies = {
    loadRun: (requestedRunId) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly executionAuthorizedAt: string | null;
          readonly id: string;
          readonly projectId: string | null;
          readonly state: StoredRun["state"];
          readonly threadId: string | null;
        }>`
          SELECT id, execution_authorized_at AS "executionAuthorizedAt",
            project_id AS "projectId", state, thread_id AS "threadId"
          FROM command_center_runs
          WHERE id = ${requestedRunId}
        `.pipe(
          Effect.mapError((cause) =>
            dispatcherFailure(
              "persistence-failed",
              requestedRunId,
              "The acceptance Run could not be loaded.",
              cause,
            ),
          ),
        );
        const row = rows[0];
        if (row === undefined) {
          return yield* dispatcherFailure("not-found", requestedRunId, "Run was not found.");
        }
        if (submitted.route.spaceId === null) {
          return yield* dispatcherFailure(
            "invalid-route",
            requestedRunId,
            "The acceptance route has no Space.",
          );
        }
        return {
          id: RunId.make(row.id),
          commandId: command.commandId,
          spaceId: submitted.route.spaceId,
          projectId: row.projectId,
          threadId: row.threadId,
          executionAuthorizedAt: row.executionAuthorizedAt,
          parentRunId: null,
          state: row.state,
          route: submitted.route,
          command,
        } satisfies StoredRun;
      }),
    loadSpace: (spaceId) => {
      const space = loadedConfig.spaces.find((candidate) => candidate.id === spaceId);
      return space === undefined
        ? Effect.fail(dispatcherFailure("not-found", submitted.run.id, "Space was not found."))
        : Effect.succeed({
            id: space.id,
            displayName: space.displayName,
            instructions: space.instructions,
            policy: space.policy,
            repositories: space.repositories,
          });
    },
    loadApproval: () => Effect.sync(() => undefined),
    loadPriorContext: () => Effect.succeed([]),
    resolveTargetProject: ({ route }) =>
      Effect.succeed({
        id: ProjectId.make(
          route.repositoryId === null
            ? "command-center:acceptance-system"
            : `command-center:acceptance:${route.repositoryId}`,
        ),
        title: route.repositoryId === null ? "Command Center" : "Sample Mobile App",
        workspaceRoot:
          route.repositoryId === null
            ? "/runtime/command-center-workspace"
            : "/runtime/sample-mobile-app",
        ...(route.repositoryId === null ? {} : { repositoryId: route.repositoryId }),
      }),
    resolveWorktreeBase: (runId, project) =>
      Effect.sync(() => {
        preparedWorktree = { runId, projectId: project.id };
        return { branch: "main", startFromOrigin: false };
      }),
    revalidateTargetProject: () => Effect.void,
    claim: (input) =>
      sql<{ readonly id: string }>`
        UPDATE command_center_runs
        SET project_id = ${input.projectId}, thread_id = ${input.threadId}, state = 'running'
        WHERE id = ${input.runId} AND state = 'queued' AND thread_id IS NULL
          AND execution_authorized_at IS NOT NULL
        RETURNING id
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError((cause) =>
          dispatcherFailure(
            "persistence-failed",
            input.runId,
            "The acceptance Run could not be claimed.",
            cause,
          ),
        ),
      ),
    queueApproved: () => Effect.succeed(false),
    markFailed: (_runId, error) =>
      Effect.sync(() => {
        failed = error;
      }),
    recordDispatch: (input) =>
      sql`
        UPDATE command_center_runs
        SET result_json = ${encodeUnknownJsonString({
          sequence: input.sequence,
          projectId: input.projectId,
          threadId: input.threadId,
        })}
        WHERE id = ${input.runId} AND state = 'running'
      `.pipe(
        Effect.asVoid,
        Effect.mapError((cause) =>
          dispatcherFailure(
            "persistence-failed",
            input.runId,
            "The acceptance dispatch result could not be linked.",
            cause,
          ),
        ),
      ),
    randomUUID: Effect.succeed(`thread-${submitted.run.id}`),
    now: Effect.succeed(fixtureTimestamp),
    registerScope: (threadId, scope) =>
      registry.registerThreadScope(threadId, scope).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            registeredScope = scope;
          }),
        ),
        Effect.as(true),
      ),
    unregisterScope: (threadId) => registry.unregisterThreadScope(threadId),
  };

  return {
    dispatcher: makeWithDependencies(dependencies),
    dispatchCommand: (nextCommand) =>
      Effect.sync(() => {
        commands.push(nextCommand);
        return { sequence: 73 };
      }),
    read: () => ({ commands, failed, preparedWorktree, registeredScope }),
  };
};

const resolveIssuedScope = Effect.fn("CommandCenterAcceptance.resolveIssuedScope")(function* (
  registry: McpSessionRegistry.McpSessionRegistryShape,
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
) {
  const issued = yield* registry.issue({ threadId, providerInstanceId });
  expect(issued.config.authorizationHeader).toMatch(/^Bearer\s+[A-Za-z0-9_-]+$/u);
  const token = issued.config.authorizationHeader.replace(/^Bearer\s+/u, "");
  const scope = yield* registry.resolve(token);
  if (scope === undefined) {
    return yield* Effect.die("The issued MCP bearer credential did not resolve.");
  }
  return scope;
});

const readyGate = ReadinessGate.CommandCenterReadinessGate.of({
  state: Effect.succeed("ready"),
  requireReady: Effect.void,
  markReady: Effect.void,
  markFailed: Effect.void,
});

const unusedAutomationDefinitions = AutomationDefinitionConfig.AutomationDefinitionConfig.of({
  authoringHealth: Effect.succeed({ status: "available" }),
  create: () => Effect.die("Automation definition creation is not used by this acceptance path."),
  get: () => Effect.die("Automation definition lookup is not used by this acceptance path."),
  save: () => Effect.die("Automation definition saving is not used by this acceptance path."),
});
const unusedAutomationRuns = AutomationRuns.AutomationRuns.of({
  start: () => Effect.die("Automation execution is not used by this acceptance path."),
  get: () => Effect.die("Automation execution lookup is not used by this acceptance path."),
  recoverDue: () => Effect.die("Automation recovery is not used by this acceptance path."),
  decideApproval: () => Effect.die("Automation approval is not used by this acceptance path."),
});
const unusedMemorySearch = MemorySearchIndex.MemorySearchIndex.of({
  rebuild: () => Effect.die("Memory indexing is not used by this acceptance path."),
  ensureCurrent: () => Effect.die("Memory indexing is not used by this acceptance path."),
  search: () => Effect.die("Memory search is not used by this acceptance path."),
});
const unusedProviderRegistry = ProviderRegistry.ProviderRegistry.of({
  getProviders: Effect.die("Provider lookup is not used by this acceptance path."),
  refresh: () => Effect.die("Provider refresh is not used by this acceptance path."),
  refreshInstance: () => Effect.die("Provider refresh is not used by this acceptance path."),
  getProviderMaintenanceCapabilitiesForInstance: () =>
    Effect.die("Provider maintenance is not used by this acceptance path."),
  setProviderMaintenanceActionState: () =>
    Effect.die("Provider maintenance is not used by this acceptance path."),
  streamChanges: Stream.empty,
});

const makeToolkitLayer = (input: {
  readonly service: CommandCenterServiceShape;
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly google: GoogleReadConnector.GoogleReadConnectorShape;
  readonly automationDefinitions?: AutomationDefinitionConfig.AutomationDefinitionConfigShape;
}) =>
  CommandCenterToolkitHandlersLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(CommandCenterService, input.service),
        Layer.succeed(McpInvocationContext.McpInvocationContext, input.scope),
        Layer.succeed(GoogleReadConnector.GoogleReadConnector, input.google),
        Layer.succeed(ReadinessGate.CommandCenterReadinessGate, readyGate),
        Layer.succeed(
          AutomationDefinitionConfig.AutomationDefinitionConfig,
          input.automationDefinitions ?? unusedAutomationDefinitions,
        ),
        Layer.succeed(AutomationRuns.AutomationRuns, unusedAutomationRuns),
        Layer.succeed(MemorySearchIndex.MemorySearchIndex, unusedMemorySearch),
        Layer.succeed(ProviderRegistry.ProviderRegistry, unusedProviderRegistry),
      ),
    ),
  );

const invokeItemsList = (
  service: CommandCenterServiceShape,
  scope: McpInvocationContext.McpInvocationScope,
  google: GoogleReadConnector.GoogleReadConnectorShape,
  spaceId: typeof systemSpace.id,
) =>
  Effect.gen(function* () {
    const toolkit = yield* CommandCenterToolkit;
    const outputStream = yield* toolkit.handle("cc_items_list", { spaceId });
    const outputs = Array.from(yield* outputStream.pipe(Stream.runCollect));
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.isFailure).toBe(false);
    return decodeItemsListResult(outputs[0]!.result);
  }).pipe(Effect.provide(makeToolkitLayer({ service, scope, google })));

const invokeMemoryPropose = (
  service: CommandCenterServiceShape,
  scope: McpInvocationContext.McpInvocationScope,
  google: GoogleReadConnector.GoogleReadConnectorShape,
  input: ReturnType<typeof decodeMemoryPropose>,
) =>
  Effect.gen(function* () {
    const toolkit = yield* CommandCenterToolkit;
    const outputStream = yield* toolkit.handle("cc_memory_propose", input);
    const outputs = Array.from(yield* outputStream.pipe(Stream.runCollect));
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.isFailure).toBe(false);
    return decodeMemory(outputs[0]!.result);
  }).pipe(Effect.provide(makeToolkitLayer({ service, scope, google })));

const invokeGoogleRead = (
  service: CommandCenterServiceShape,
  scope: McpInvocationContext.McpInvocationScope,
  google: GoogleReadConnector.GoogleReadConnectorShape,
  input: GoogleReadRequestType,
) =>
  Effect.gen(function* () {
    const toolkit = yield* CommandCenterToolkit;
    const outputStream = yield* toolkit.handle("cc_google_read", input);
    const outputs = Array.from(yield* outputStream.pipe(Stream.runCollect));
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.isFailure).toBe(false);
    return decodeGoogleResult(outputs[0]!.result);
  }).pipe(Effect.provide(makeToolkitLayer({ service, scope, google })));

const invokeAutomationCreate = (
  service: CommandCenterServiceShape,
  scope: McpInvocationContext.McpInvocationScope,
  google: GoogleReadConnector.GoogleReadConnectorShape,
  automationDefinitions: AutomationDefinitionConfig.AutomationDefinitionConfigShape,
  input: ReturnType<typeof decodeAutomationCreate>,
) =>
  Effect.gen(function* () {
    const toolkit = yield* CommandCenterToolkit;
    const outputStream = yield* toolkit.handle("cc_automations_create", input);
    const outputs = Array.from(yield* outputStream.pipe(Stream.runCollect));
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.isFailure).toBe(false);
    return decodeAutomationSnapshot(outputs[0]!.result);
  }).pipe(Effect.provide(makeToolkitLayer({ service, scope, google, automationDefinitions })));

const makeAutomationAuthoringFixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.make();
  const configDirectory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "command-center-acceptance-config-",
  });
  const automationsDirectory = path.join(configDirectory, "automations");
  yield* fileSystem.makeDirectory(automationsDirectory, { recursive: true });
  yield* fileSystem.writeFileString(path.join(automationsDirectory, ".gitkeep"), "");

  const git = Effect.fn("CommandCenterAcceptance.git")(function* (args: ReadonlyArray<string>) {
    const result = yield* processRunner.run({
      command: "git",
      args: ["-C", configDirectory, ...args],
      timeout: "10 seconds",
    });
    if (result.code !== 0) {
      return yield* Effect.die(
        new Error(`Acceptance fixture Git command failed: ${args[0] ?? "unknown"}`),
      );
    }
    return result.stdout;
  });

  yield* git(["init", "--quiet"]);
  yield* git(["add", "--", "automations/.gitkeep"]);
  yield* git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture",
    "commit",
    "--quiet",
    "-m",
    "Initial fixture",
  ]);

  const invocations: Array<ProcessRunner.ProcessRunInput> = [];
  const recordingRunner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.sync(() => {
        invocations.push(input);
      }).pipe(Effect.andThen(processRunner.run(input))),
  });
  const authoringConfig = CommandCenterConfig.of({
    configDirectory,
    load: Effect.succeed({
      ...loadedConfig,
      health: { status: "loaded", configDirectory },
    }),
    resolveGoogleAccount: () => Effect.die("Google is not used by automation authoring."),
  });
  const definitions = yield* AutomationDefinitionConfig.make.pipe(
    Effect.provideService(CommandCenterConfig, authoringConfig),
    Effect.provideService(ProcessRunner.ProcessRunner, recordingRunner),
  );

  return {
    automationsDirectory,
    configDirectory,
    definitions,
    fileSystem,
    git,
    invocations,
    path,
  };
});

describe("Command Center acceptance prompts", () => {
  it.effect("projects Needs You through an acknowledged, authenticated Command run", () =>
    Effect.gen(function* () {
      const service = yield* CommandCenterService;
      const sql = yield* SqlClient.SqlClient;
      const registry = yield* makeMcpRegistry();
      const google = makeMockGoogleConnector();
      const needsReview = yield* service.createItem({
        requestId: "acceptance-needs-review",
        spaceId: systemSpace.id,
        kind: "decision",
        priority: "normal",
        title: "Choose the sample release window",
      });
      const routine = yield* service.createItem({
        requestId: "acceptance-routine-task",
        spaceId: systemSpace.id,
        kind: "task",
        priority: "normal",
        title: "Routine sample follow-up",
      });
      const command = decodeCommand({
        commandId: "acceptance-needs-you",
        text: "What needs me?",
      });
      const submitted = yield* service.submitCommand(command, [provider]);
      const harness = makeDispatcherHarness(sql, registry, submitted, command);
      const receipt = yield* routeReceiptFor(sql, submitted.run.id);

      expect(receipt).toEqual({
        commandId: command.commandId,
        route: submitted.route,
        state: "queued",
      });
      expect(receipt.route).toMatchObject({
        spaceId: systemSpace.id,
        intent: "item",
        actionKind: "read",
        risk: "low",
        status: "ready",
        capabilities: ["cc.items.read"],
      });
      expect(
        yield* harness.dispatcher.inspectRecovery(submitted.run.id).pipe(Effect.flip),
      ).toMatchObject({ reason: "not-ready" });
      expect(harness.read().commands).toEqual([]);
      expect(yield* runBoundaryFor(sql, submitted.run.id)).toEqual([
        {
          executionAuthorizedAt: null,
          projectId: null,
          resultJson: null,
          state: "queued",
          threadId: null,
        },
      ]);

      yield* service.authorizeRunExecution({ runId: submitted.run.id, actorKind: "user" });
      const dispatched = yield* harness.dispatcher.dispatch({
        runId: submitted.run.id,
        dispatchCommand: harness.dispatchCommand,
      });
      const scope = yield* resolveIssuedScope(
        registry,
        dispatched.threadId,
        ProviderInstanceId.make(submitted.route.providerId ?? ""),
      );
      const projected = yield* invokeItemsList(service, scope, google.service, systemSpace.id);

      expect(projected.items.map((item) => item.id)).toEqual([needsReview.id, routine.id]);
      expect(projected.needsYou.map((item) => item.id)).toEqual([needsReview.id]);
      expect(scope).toMatchObject({
        threadId: dispatched.threadId,
        spaceId: systemSpace.id,
        memoryWriteMode: "propose",
      });
      expect([...scope.capabilities]).toEqual(["cc.items.read"]);
      expect(harness.read()).toMatchObject({
        failed: undefined,
        preparedWorktree: undefined,
        registeredScope: { spaceId: systemSpace.id, memoryWriteMode: "propose" },
      });
      expect(
        decodeUnknownJsonString((yield* runBoundaryFor(sql, submitted.run.id))[0]!.resultJson!),
      ).toEqual({
        sequence: 73,
        projectId: dispatched.projectId,
        threadId: dispatched.threadId,
      });
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("governs explicit Memory through the acknowledged Run's bearer-bound MCP scope", () =>
    Effect.gen(function* () {
      const service = yield* CommandCenterService;
      const sql = yield* SqlClient.SqlClient;
      const registry = yield* makeMcpRegistry();
      const google = makeMockGoogleConnector();
      const command = decodeCommand({
        commandId: "acceptance-remember",
        text: "Remember to run sample checks for Example Studio.",
        spaceId: studioSpace.id,
        repositoryId: "sample-mobile-app",
      });
      const submitted = yield* service.submitCommand(command, [provider]);
      const harness = makeDispatcherHarness(sql, registry, submitted, command);
      const receipt = yield* routeReceiptFor(sql, submitted.run.id);

      expect(receipt.route).toMatchObject({
        spaceId: studioSpace.id,
        repositoryId: "sample-mobile-app",
        actionKind: "memory.remember",
        risk: "reversible",
        status: "ready",
        capabilities: ["cc.memory.propose"],
      });
      expect((yield* service.queryMemories({ spaceId: studioSpace.id })).memories).toEqual([]);
      expect(
        yield* harness.dispatcher.inspectRecovery(submitted.run.id).pipe(Effect.flip),
      ).toMatchObject({ reason: "not-ready" });
      expect(harness.read().commands).toEqual([]);

      yield* service.authorizeRunExecution({ runId: submitted.run.id, actorKind: "user" });
      const dispatched = yield* harness.dispatcher.dispatch({
        runId: submitted.run.id,
        dispatchCommand: harness.dispatchCommand,
      });
      const scope = yield* resolveIssuedScope(
        registry,
        dispatched.threadId,
        ProviderInstanceId.make(submitted.route.providerId ?? ""),
      );
      const memory = yield* invokeMemoryPropose(
        service,
        scope,
        google.service,
        decodeMemoryPropose({
          requestId: "acceptance-remember-write",
          spaceId: studioSpace.id,
          repositoryId: "sample-mobile-app",
          kind: "procedure",
          content: "Run the sample checks before review.",
          confidence: 0.4,
          sourceRef: submitted.run.id,
        }),
      );

      expect(scope).toMatchObject({
        spaceId: studioSpace.id,
        repositoryId: "sample-mobile-app",
        memoryWriteMode: "remember",
      });
      expect(memory).toMatchObject({
        spaceId: studioSpace.id,
        repositoryId: "sample-mobile-app",
        status: "approved",
        confidence: 1,
        provenance: { kind: "user", sourceRef: submitted.run.id },
      });
      expect((yield* service.queryMemories({ spaceId: studioSpace.id })).memories).toEqual([
        memory,
      ]);
      expect((yield* service.queryApprovals({ spaceId: studioSpace.id })).approvals).toEqual([]);
      expect(harness.read().commands).toHaveLength(1);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "dispatches primary and legacy repository prompts into a linked isolated worktree",
    () =>
      Effect.gen(function* () {
        const service = yield* CommandCenterService;
        const sql = yield* SqlClient.SqlClient;
        const prompts = [
          {
            commandId: "acceptance-primary-app",
            text: "Start work on the Example Studio app.",
          },
          {
            commandId: "acceptance-legacy-repository",
            text: "Open the legacy sample app repo and fix Z.",
          },
        ] as const;

        for (const prompt of prompts) {
          const registry = yield* makeMcpRegistry();
          const command = decodeCommand(prompt);
          const submitted = yield* service.submitCommand(command, [provider]);
          const harness = makeDispatcherHarness(sql, registry, submitted, command);
          const receipt = yield* routeReceiptFor(sql, submitted.run.id);
          expect(receipt.route).toMatchObject({
            spaceId: studioSpace.id,
            repositoryId: "sample-mobile-app",
            intent: "repository",
            actionKind: "worktree.edit",
            risk: "reversible",
            status: "ready",
            capabilities: ["cc.runs.start"],
          });
          expect(receipt.route.sources.space).toBe("classifier");
          expect(receipt.route.sources.repository).toBe("classifier");
          expect(
            yield* harness.dispatcher.inspectRecovery(submitted.run.id).pipe(Effect.flip),
          ).toMatchObject({ reason: "not-ready" });
          expect(harness.read().preparedWorktree).toBeUndefined();
          expect(harness.read().commands).toEqual([]);

          yield* service.authorizeRunExecution({ runId: submitted.run.id, actorKind: "user" });
          const dispatched = yield* harness.dispatcher.dispatch({
            runId: submitted.run.id,
            dispatchCommand: harness.dispatchCommand,
          });
          const dispatchedCommand = harness.read().commands[0];
          if (dispatchedCommand?.type !== "thread.turn.start") {
            return yield* Effect.die("The Run dispatcher did not emit a T3 thread turn.");
          }
          expect(dispatched).toMatchObject({
            projectId: ProjectId.make("command-center:acceptance:sample-mobile-app"),
            state: "running",
            sequence: 73,
            duplicate: false,
          });
          expect(dispatchedCommand.message.text).toContain("Command Center route receipt");
          expect(dispatchedCommand.message.text).toContain(
            "Space: Example Studio (example-studio)",
          );
          expect(dispatchedCommand.message.text).toContain("Repository scope: sample-mobile-app");
          expect(dispatchedCommand.message.text).toContain(prompt.text);
          expect(dispatchedCommand.bootstrap?.prepareWorktree).toMatchObject({
            projectCwd: "/runtime/sample-mobile-app",
            baseBranch: "main",
            startFromOrigin: false,
          });
          expect(harness.read()).toMatchObject({
            failed: undefined,
            preparedWorktree: {
              runId: submitted.run.id,
              projectId: dispatched.projectId,
            },
            registeredScope: {
              spaceId: studioSpace.id,
              repositoryId: "sample-mobile-app",
              memoryWriteMode: "propose",
            },
          });
          expect(yield* runBoundaryFor(sql, submitted.run.id)).toEqual([
            {
              executionAuthorizedAt: expect.any(String),
              projectId: dispatched.projectId,
              resultJson: expect.any(String),
              state: "running",
              threadId: dispatched.threadId,
            },
          ]);
        }

        expect((yield* service.queryApprovals({ spaceId: studioSpace.id })).approvals).toEqual([]);
        expect((yield* service.queryArtifacts({ spaceId: studioSpace.id })).artifacts).toEqual([]);
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("invokes exact-bound Google reads through authenticated MCP with no write tool", () =>
    Effect.gen(function* () {
      const service = yield* CommandCenterService;
      const health = yield* ConnectionHealth.ConnectionHealth;
      const sql = yield* SqlClient.SqlClient;
      const connector = makeMockGoogleConnector();
      yield* service.bootstrap;
      yield* health.markConnected({
        spaceId: personalSpace.id,
        connectionId: googleConnection.id,
      });

      const cases = [
        {
          commandId: "acceptance-calendar-read",
          text: "Check tomorrow's calendar.",
          capability: "cc.connections.google.calendar.read",
          request: decodeGoogleRead({
            spaceId: personalSpace.id,
            connectionId: googleConnection.id,
            operation: "calendar.events",
            from: "2026-01-02T00:00:00.000Z",
            to: "2026-01-03T00:00:00.000Z",
          }),
        },
        {
          commandId: "acceptance-email-read",
          text: "Find the email about the sample launch.",
          capability: "cc.connections.google.gmail.read",
          request: decodeGoogleRead({
            spaceId: personalSpace.id,
            connectionId: googleConnection.id,
            operation: "gmail.search",
            query: "sample launch",
          }),
        },
      ] as const;

      expect(Object.keys(CommandCenterToolkit.tools)).toContain("cc_google_read");
      expect(Object.keys(CommandCenterToolkit.tools)).not.toContain("cc_google_write");
      expect(
        isGoogleReadRequest({
          spaceId: personalSpace.id,
          connectionId: googleConnection.id,
          operation: "gmail.send",
        }),
      ).toBe(false);

      for (const [index, entry] of cases.entries()) {
        const registry = yield* makeMcpRegistry();
        const command = decodeCommand({ commandId: entry.commandId, text: entry.text });
        const submitted = yield* service.submitCommand(command, [provider]);
        const harness = makeDispatcherHarness(sql, registry, submitted, command);
        const receipt = yield* routeReceiptFor(sql, submitted.run.id);
        expect(receipt.route).toMatchObject({
          spaceId: personalSpace.id,
          intent: "google",
          actionKind: "read",
          risk: "low",
          status: "ready",
          capabilities: [entry.capability],
        });
        expect(connector.calls).toHaveLength(index);
        expect(
          yield* harness.dispatcher.inspectRecovery(submitted.run.id).pipe(Effect.flip),
        ).toMatchObject({ reason: "not-ready" });

        yield* service.authorizeRunExecution({ runId: submitted.run.id, actorKind: "user" });
        const dispatched = yield* harness.dispatcher.dispatch({
          runId: submitted.run.id,
          dispatchCommand: harness.dispatchCommand,
        });
        const scope = yield* resolveIssuedScope(
          registry,
          dispatched.threadId,
          ProviderInstanceId.make(submitted.route.providerId ?? ""),
        );
        const result = yield* invokeGoogleRead(service, scope, connector.service, entry.request);
        expect(scope).toMatchObject({
          spaceId: personalSpace.id,
          memoryWriteMode: "propose",
        });
        expect(scope.repositoryId).toBeUndefined();
        expect([...scope.capabilities]).toEqual([entry.capability]);
        expect(result).toMatchObject({
          operation: entry.request.operation,
          contentTrust: "untrusted-external",
        });
        expect(connector.calls[index]).toEqual(entry.request);
      }

      expect(connector.calls.map((request) => request.operation)).toEqual([
        "calendar.events",
        "gmail.search",
      ]);
      expect((yield* service.queryApprovals({ spaceId: personalSpace.id })).approvals).toEqual([]);
      expect((yield* service.queryArtifacts({ spaceId: personalSpace.id })).artifacts).toEqual([]);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("authors a weekly draft through scoped MCP as one linked local config commit", () =>
    Effect.gen(function* () {
      const service = yield* CommandCenterService;
      const sql = yield* SqlClient.SqlClient;
      const registry = yield* makeMcpRegistry();
      const google = makeMockGoogleConnector();
      const authoring = yield* makeAutomationAuthoringFixture;
      const command = decodeCommand({
        commandId: "acceptance-weekly-automation",
        text: "Create a weekly automation.",
      });
      const submitted = yield* service.submitCommand(command, [provider]);
      const harness = makeDispatcherHarness(sql, registry, submitted, command);
      const receipt = yield* routeReceiptFor(sql, submitted.run.id);

      expect(receipt.route).toMatchObject({
        spaceId: systemSpace.id,
        intent: "automation",
        actionKind: "automation.draft",
        risk: "reversible",
        status: "ready",
        capabilities: ["cc.automations.read", "cc.automations.write"],
      });
      expect(
        yield* harness.dispatcher.inspectRecovery(submitted.run.id).pipe(Effect.flip),
      ).toMatchObject({ reason: "not-ready" });
      expect(harness.read().commands).toEqual([]);
      expect(
        yield* authoring.fileSystem.exists(
          authoring.path.join(authoring.automationsDirectory, "weekly-brief.json"),
        ),
      ).toBe(false);

      yield* service.authorizeRunExecution({ runId: submitted.run.id, actorKind: "user" });
      const dispatched = yield* harness.dispatcher.dispatch({
        runId: submitted.run.id,
        dispatchCommand: harness.dispatchCommand,
      });
      const scope = yield* resolveIssuedScope(
        registry,
        dispatched.threadId,
        ProviderInstanceId.make(submitted.route.providerId ?? ""),
      );
      const created = yield* invokeAutomationCreate(
        service,
        scope,
        google.service,
        authoring.definitions,
        decodeAutomationCreate({
          requestId: "acceptance-create-weekly-brief",
          spaceId: systemSpace.id,
          preferredAutomationId: "weekly-brief",
          name: "Weekly brief",
          enabled: false,
          trigger: {
            kind: "schedule",
            expression: "0 9 * * 1",
            timezone: loadedConfig.timezone,
          },
          nodes: [
            {
              id: "prepare",
              kind: "transform",
              config: { template: "Prepare the weekly brief" },
            },
          ],
          edges: [],
          layout: { nodes: { prepare: { x: 80, y: 120 } } },
        }),
      );

      expect(scope).toMatchObject({ spaceId: systemSpace.id, memoryWriteMode: "propose" });
      expect([...scope.capabilities]).toEqual(["cc.automations.read", "cc.automations.write"]);
      expect(created).toMatchObject({
        automationId: "weekly-brief",
        spaceId: systemSpace.id,
        definition: {
          enabled: false,
          trigger: {
            kind: "schedule",
            expression: "0 9 * * 1",
            timezone: loadedConfig.timezone,
          },
        },
      });
      expect(created.definitionDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(created.configCommitSha).toMatch(/^[a-f0-9]{40,64}$/u);
      expect((yield* authoring.git(["status", "--porcelain=v1"])).trim()).toBe("");
      expect(
        (yield* authoring.git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])).trim(),
      ).toBe("automations/weekly-brief.json");
      expect((yield* authoring.git(["remote"])).trim()).toBe("");
      expect(authoring.invocations.length).toBeGreaterThan(0);
      expect(
        authoring.invocations.every(
          (input) =>
            input.command === "/usr/bin/git" ||
            (/^\/usr\/bin\/python3(?:\.[0-9]+)*$/u.test(input.command) &&
              input.args[0] === "-I" &&
              input.args[1] === "-S" &&
              input.args[2] === "-c"),
        ),
      ).toBe(true);
      expect(authoring.invocations.some((input) => input.args.includes("push"))).toBe(false);

      const auditRows = yield* sql<{
        readonly payloadJson: string;
        readonly runId: string | null;
      }>`
        SELECT payload_json AS "payloadJson", run_id AS "runId"
        FROM command_center_audit_events
        WHERE action = 'cc.automations.definition.committed'
          AND run_id = ${submitted.run.id}
      `;
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]?.runId).toBe(submitted.run.id);
      expect(decodeUnknownJsonString(auditRows[0]!.payloadJson)).toMatchObject({
        operation: "created",
        requestId: "acceptance-create-weekly-brief",
        automationId: "weekly-brief",
        configCommitSha: created.configCommitSha,
        definitionDigest: created.definitionDigest,
        pushed: false,
        source: {
          kind: "mcp",
          threadId: dispatched.threadId,
          providerInstanceId: submitted.route.providerId,
        },
      });
      expect((yield* service.queryApprovals({ spaceId: systemSpace.id })).approvals).toEqual([]);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("creates a digest-bound approval when Space policy gates automation drafts", () =>
    Effect.gen(function* () {
      const service = yield* CommandCenterService;
      const sql = yield* SqlClient.SqlClient;
      const submitted = yield* service.submitCommand(
        decodeCommand({
          commandId: "acceptance-weekly-automation-gated",
          text: "Create a weekly automation.",
          spaceId: systemSpace.id,
        }),
        [provider],
      );
      const receipt = yield* routeReceiptFor(sql, submitted.run.id);
      const bootstrap = yield* service.bootstrap;

      expect(receipt.route).toMatchObject({
        spaceId: systemSpace.id,
        actionKind: "automation.draft",
        status: "approval-required",
        approvalRequired: true,
      });
      expect(receipt.state).toBe("waiting_approval");
      expect(bootstrap.approvals).toHaveLength(1);
      expect(bootstrap.needsYou).toContainEqual(
        expect.objectContaining({
          spaceId: systemSpace.id,
          kind: "approval",
          status: "waiting",
          priority: "urgent",
        }),
      );
      expect(bootstrap.approvals[0]?.payloadDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(yield* runBoundaryFor(sql, submitted.run.id)).toEqual([
        {
          executionAuthorizedAt: null,
          projectId: null,
          resultJson: null,
          state: "waiting_approval",
          threadId: null,
        },
      ]);
      expect((yield* service.queryAutomations({ spaceId: systemSpace.id })).automations).toEqual(
        [],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer({
          ...loadedConfig,
          spaces: [
            studioSpace,
            decodeSpace({
              ...systemSpace,
              policy: {
                allowedCapabilities: CAPABILITY_NAMES,
                autoRunRiskLevels: ["low"],
              },
            }),
            personalSpace,
          ],
        }),
      ),
    ),
  );
});
