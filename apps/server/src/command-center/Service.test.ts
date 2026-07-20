import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CAPABILITY_NAMES,
  Artifact,
  Connection,
  ProviderAvailability,
  Space,
  type ProviderAvailability as ProviderAvailabilityType,
} from "@command-center/core";
import {
  CommandCenterApprovalDecisionInput,
  CommandCenterCommandSubmitInput,
  CommandCenterItemUpdateInput,
  CommandCenterItemChangedPayload,
  CommandCenterMemoryProposeInput,
  CommandCenterMemoryRememberInput,
  CommandCenterMemoryReviewInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CommandCenterConfig, type LoadedCommandCenterConfig } from "./Config.ts";
import * as ConnectionHealth from "./ConnectionHealth.ts";
import {
  CommandCenterService,
  itemNeedsYou,
  layer as commandCenterServiceLayer,
} from "./Service.ts";

const decodeSpace = Schema.decodeUnknownSync(Space);
const decodeArtifact = Schema.decodeUnknownSync(Artifact);
const decodeConnection = Schema.decodeUnknownSync(Connection);
const decodeProvider = Schema.decodeUnknownSync(ProviderAvailability);
const decodeCommand = Schema.decodeUnknownSync(CommandCenterCommandSubmitInput);
const decodeItemUpdate = Schema.decodeUnknownSync(CommandCenterItemUpdateInput);
const decodeItemChangedPayload = Schema.decodeUnknownSync(CommandCenterItemChangedPayload);
const decodeRemember = Schema.decodeUnknownSync(CommandCenterMemoryRememberInput);
const decodeProposal = Schema.decodeUnknownSync(CommandCenterMemoryProposeInput);
const decodeMemoryReview = Schema.decodeUnknownSync(CommandCenterMemoryReviewInput);
const decodeApprovalDecision = Schema.decodeUnknownSync(CommandCenterApprovalDecisionInput);
const decodeUnknownJsonString = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

const fixtureTimestamp = "2026-01-01T00:00:00.000Z";

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
  connectionIds: ["google-primary"],
  repositories: [],
  aliases: ["my life"],
  lifecycle: "active",
  createdAt: fixtureTimestamp,
  updatedAt: fixtureTimestamp,
});

const multiRepositoryStudioSpace = decodeSpace({
  ...studioSpace,
  repositories: [
    ...studioSpace.repositories,
    {
      id: "sample-service",
      displayName: "Sample Service",
      aliases: ["sample backend"],
      remoteRef: "https://example.com/sample-service.git",
    },
  ],
});

const loadedConfig = {
  spaces: [studioSpace, systemSpace, personalSpace],
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
} satisfies LoadedCommandCenterConfig;

const approvalGatedStudioSpace = decodeSpace({
  ...studioSpace,
  policy: {
    allowedCapabilities: CAPABILITY_NAMES,
    autoRunRiskLevels: [],
  },
});

const approvalGatedConfig = {
  ...loadedConfig,
  spaces: [approvalGatedStudioSpace, systemSpace, personalSpace],
} satisfies LoadedCommandCenterConfig;

const enabledGoogleConnection = decodeConnection({
  id: "google-primary",
  spaceId: personalSpace.id,
  kind: "google",
  label: "Example Google account",
  capabilities: ["cc.connections.google.read"],
  health: "disconnected",
});

const makeConfigLayer = (config: LoadedCommandCenterConfig = loadedConfig) =>
  Layer.succeed(
    CommandCenterConfig,
    CommandCenterConfig.of({
      configDirectory: "runtime-config",
      load: Effect.succeed(config),
      resolveGoogleAccount: () => Effect.die("Google account resolution is not used here."),
    }),
  );

const makeConfigLayerFrom = (load: Effect.Effect<LoadedCommandCenterConfig>) =>
  Layer.succeed(
    CommandCenterConfig,
    CommandCenterConfig.of({
      configDirectory: "runtime-config",
      load,
      resolveGoogleAccount: () => Effect.die("Google account resolution is not used here."),
    }),
  );

const makeTestLayer = (config: LoadedCommandCenterConfig = loadedConfig) =>
  commandCenterServiceLayer.pipe(
    Layer.provideMerge(makeConfigLayer(config)),
    Layer.provideMerge(ConnectionHealth.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );

const makeTestLayerFrom = (load: Effect.Effect<LoadedCommandCenterConfig>) =>
  commandCenterServiceLayer.pipe(
    Layer.provideMerge(makeConfigLayerFrom(load)),
    Layer.provideMerge(ConnectionHealth.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );

function unavailableConfig(status: "missing" | "invalid"): LoadedCommandCenterConfig {
  return {
    spaces: [],
    connections: [],
    automations: [],
    timezone: null,
    routing: null,
    health: {
      status,
      configDirectory: "runtime-config",
      message: status === "missing" ? "Configuration is absent." : "Configuration is invalid.",
    },
  };
}

function provider(
  providerId: string,
  modelIds: ReadonlyArray<string>,
  priority: number,
): ProviderAvailabilityType {
  const defaultModelId = modelIds[0];
  if (defaultModelId === undefined) throw new Error("A provider fixture needs a default model.");
  return decodeProvider({
    providerId,
    healthy: true,
    priority,
    modelIds,
    defaultModelId,
    capabilities: CAPABILITY_NAMES,
  });
}

const providers = [
  provider("provider-alpha", ["model-alpha", "model-alpha-fast"], 10),
  provider("provider-beta", ["model-beta", "model-beta-careful"], 20),
];

it("projects only decisions, approvals, review work, and urgent waits into Needs You", () => {
  expect(itemNeedsYou({ kind: "approval", status: "waiting", priority: "urgent" })).toBe(true);
  expect(itemNeedsYou({ kind: "decision", status: "ready", priority: "normal" })).toBe(true);
  expect(itemNeedsYou({ kind: "alert", status: "review", priority: "high" })).toBe(true);
  expect(itemNeedsYou({ kind: "task", status: "waiting", priority: "urgent" })).toBe(true);
  expect(itemNeedsYou({ kind: "task", status: "waiting", priority: "normal" })).toBe(false);
  expect(itemNeedsYou({ kind: "alert", status: "captured", priority: "high" })).toBe(false);
});

it.effect("routes Space and repository aliases to the canonical Space", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;

    const bySpaceAlias = yield* service.submitCommand(
      decodeCommand({
        commandId: "command-space-alias",
        text: "Review code in Sample Works",
      }),
      providers,
    );
    const byRepositoryAlias = yield* service.submitCommand(
      decodeCommand({
        commandId: "command-repository-alias",
        text: "Open the legacy sample app repo and fix the test",
      }),
      providers,
    );

    expect(bySpaceAlias.route.spaceId).toBe(studioSpace.id);
    expect(bySpaceAlias.run.spaceId).toBe(studioSpace.id);
    expect(byRepositoryAlias.route.spaceId).toBe(studioSpace.id);
    expect(byRepositoryAlias.route.repositoryId).toBe("sample-mobile-app");
    expect(byRepositoryAlias.run.spaceId).toBe(studioSpace.id);
    expect(byRepositoryAlias.run.repositoryId).toBe("sample-mobile-app");
    expect(bySpaceAlias.route.sources.space).toBe("classifier");
    expect(byRepositoryAlias.route.sources.space).toBe("classifier");
    expect(byRepositoryAlias.route.sources.repository).toBe("classifier");
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("routes a Space's app to its sole primary repository", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const result = yield* service.submitCommand(
      decodeCommand({
        commandId: "command-primary-repository",
        text: "Start work on the Example Studio app",
      }),
      providers,
    );

    expect(result.route.spaceId).toBe(studioSpace.id);
    expect(result.route.repositoryId).toBe("sample-mobile-app");
    expect(result.run.repositoryId).toBe("sample-mobile-app");
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("admits Runs without execution authority and authorizes them once under races", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const sql = yield* SqlClient.SqlClient;
    const submitted = yield* service.submitCommand(
      decodeCommand({
        commandId: "command-route-receipt-ack",
        text: "Start work on the Example Studio app",
      }),
      providers,
    );

    const admitted = yield* sql<{
      readonly executionAuthorizedAt: string | null;
    }>`
      SELECT execution_authorized_at AS "executionAuthorizedAt"
      FROM command_center_runs
      WHERE id = ${submitted.run.id}
    `;
    expect(admitted).toEqual([{ executionAuthorizedAt: null }]);

    const acknowledgements = yield* Effect.all(
      [
        service.authorizeRunExecution({
          runId: submitted.run.id,
          actorKind: "user",
        }),
        service.authorizeRunExecution({
          runId: submitted.run.id,
          actorKind: "user",
        }),
      ],
      { concurrency: 2 },
    );
    expect(acknowledgements.filter((result) => result.duplicate)).toHaveLength(1);
    expect(acknowledgements.filter((result) => !result.duplicate)).toHaveLength(1);

    const stored = yield* sql<{
      readonly executionAuthorizedAt: string | null;
      readonly authorizationEvents: number;
    }>`
      SELECT run.execution_authorized_at AS "executionAuthorizedAt",
        (
          SELECT COUNT(*) FROM command_center_audit_events event
          WHERE event.run_id = run.id AND event.action = 'cc.runs.execution.authorized'
        ) AS "authorizationEvents"
      FROM command_center_runs run
      WHERE run.id = ${submitted.run.id}
    `;
    expect(stored[0]?.executionAuthorizedAt).not.toBeNull();
    expect(stored[0]?.authorizationEvents).toBe(1);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("links and authorizes an MCP child Run from authenticated source provenance", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const sql = yield* SqlClient.SqlClient;
    const parent = yield* service.submitCommand(
      decodeCommand({
        commandId: "command-mcp-parent",
        text: "Start work on the Example Studio app",
        spaceId: studioSpace.id,
        repositoryId: "sample-mobile-app",
      }),
      providers,
    );
    yield* sql`
      UPDATE command_center_runs
      SET state = 'running', project_id = 'source-project', thread_id = 'source-thread',
        execution_authorized_at = ${fixtureTimestamp}
      WHERE id = ${parent.run.id}
    `;
    const child = yield* service.submitMcpChildCommand(
      decodeCommand({
        commandId: "command-mcp-child",
        text: "Fix the sample application test",
        spaceId: studioSpace.id,
        repositoryId: "sample-mobile-app",
      }),
      providers,
      {
        spaceId: studioSpace.id,
        repositoryId: "sample-mobile-app",
        threadId: "source-thread",
        providerSessionId: "provider-session-source",
        providerInstanceId: "provider-source",
      },
    );
    const rows = yield* sql<{
      readonly parentRunId: string | null;
      readonly executionAuthorizedAt: string | null;
      readonly action: string;
      readonly payloadJson: string;
    }>`
      SELECT run.parent_run_id AS "parentRunId",
        run.execution_authorized_at AS "executionAuthorizedAt",
        event.action, event.payload_json AS "payloadJson"
      FROM command_center_runs run
      JOIN command_center_audit_events event ON event.run_id = run.id
      WHERE run.id = ${child.run.id}
        AND event.event_id = ${`mcp-child-run:${child.run.id}:bound`}
    `;

    expect(child.duplicate).toBe(false);
    expect(rows).toHaveLength(1);
    const stored = rows[0]!;
    expect(stored.executionAuthorizedAt).not.toBeNull();
    expect(rows[0]).toMatchObject({
      parentRunId: parent.run.id,
      action: "cc.runs.mcp-child.bound",
    });
    expect(decodeUnknownJsonString(stored.payloadJson)).toEqual({
      childRunId: child.run.id,
      parentRunId: parent.run.id,
      linkedAt: stored.executionAuthorizedAt,
      executionAuthorizedAt: stored.executionAuthorizedAt,
      source: {
        kind: "mcp",
        threadId: "source-thread",
        providerSessionId: "provider-session-source",
        providerInstanceId: "provider-source",
        spaceId: studioSpace.id,
        repositoryId: "sample-mobile-app",
      },
    });
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("rejects MCP child linkage across credential-bound Space and repository scopes", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const sql = yield* SqlClient.SqlClient;
    const parent = yield* service.submitCommand(
      decodeCommand({
        commandId: "command-mcp-scope-parent",
        text: "Start work in the sample mobile application",
        spaceId: studioSpace.id,
        repositoryId: "sample-mobile-app",
      }),
      providers,
    );
    yield* sql`
      UPDATE command_center_runs
      SET state = 'running', project_id = 'scope-project', thread_id = 'scope-source-thread',
        execution_authorized_at = ${fixtureTimestamp}
      WHERE id = ${parent.run.id}
    `;

    const wrongSpace = yield* service
      .submitMcpChildCommand(
        decodeCommand({
          commandId: "command-mcp-wrong-space-child",
          text: "Summarize the current status",
          spaceId: systemSpace.id,
        }),
        providers,
        {
          spaceId: systemSpace.id,
          threadId: "scope-source-thread",
          providerSessionId: "scope-session",
          providerInstanceId: "scope-provider",
        },
      )
      .pipe(Effect.flip);
    const wrongRepository = yield* service
      .submitMcpChildCommand(
        decodeCommand({
          commandId: "command-mcp-wrong-repository-child",
          text: "Fix the sample service",
          spaceId: studioSpace.id,
          repositoryId: "sample-service",
        }),
        providers,
        {
          spaceId: studioSpace.id,
          repositoryId: "sample-service",
          threadId: "scope-source-thread",
          providerSessionId: "scope-session",
          providerInstanceId: "scope-provider",
        },
      )
      .pipe(Effect.flip);
    const orphaned = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM command_center_runs
      WHERE command_id IN ('command-mcp-wrong-space-child', 'command-mcp-wrong-repository-child')
    `;

    expect(wrongSpace.reason).toBe("validation");
    expect(wrongRepository.reason).toBe("validation");
    expect(orphaned).toEqual([{ count: 0 }]);
  }).pipe(
    Effect.provide(
      makeTestLayer({
        ...loadedConfig,
        spaces: [multiRepositoryStudioSpace, systemSpace, personalSpace],
      }),
    ),
  ),
);

it.effect("binds an approval-gated MCP child before approval grants execution authority", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const sql = yield* SqlClient.SqlClient;
    const parent = yield* service.submitCommand(
      decodeCommand({
        commandId: "command-mcp-approval-parent",
        text: "Summarize the Example Studio app",
        spaceId: studioSpace.id,
        repositoryId: "sample-mobile-app",
      }),
      providers,
    );
    yield* sql`
        UPDATE command_center_runs
        SET state = 'running', project_id = 'approval-source-project',
          thread_id = 'approval-source-thread', execution_authorized_at = ${fixtureTimestamp}
        WHERE id = ${parent.run.id}
      `;

    const child = yield* service.submitMcpChildCommand(
      decodeCommand({
        commandId: "command-mcp-approval-child",
        text: "Summarize the Example Studio app",
        spaceId: studioSpace.id,
        repositoryId: "sample-mobile-app",
      }),
      providers,
      {
        spaceId: studioSpace.id,
        repositoryId: "sample-mobile-app",
        threadId: "approval-source-thread",
        providerSessionId: "approval-source-session",
        providerInstanceId: "approval-source-provider",
      },
    );
    const before = yield* sql<{
      readonly parentRunId: string | null;
      readonly executionAuthorizedAt: string | null;
    }>`
        SELECT parent_run_id AS "parentRunId",
          execution_authorized_at AS "executionAuthorizedAt"
        FROM command_center_runs
        WHERE id = ${child.run.id}
      `;
    const approval = (yield* service.bootstrap).approvals.find(
      (candidate) => candidate.runId === child.run.id,
    );
    expect(approval).toBeDefined();
    if (approval === undefined) return;

    yield* service.decideApproval(
      decodeApprovalDecision({
        approvalId: approval.id,
        payloadDigest: approval.payloadDigest,
        decision: "approved",
      }),
    );
    const after = yield* sql<{
      readonly parentRunId: string | null;
      readonly executionAuthorizedAt: string | null;
      readonly state: string;
    }>`
        SELECT parent_run_id AS "parentRunId",
          execution_authorized_at AS "executionAuthorizedAt", state
        FROM command_center_runs
        WHERE id = ${child.run.id}
      `;

    expect(child.run.status).toBe("waiting_approval");
    expect(before).toEqual([{ parentRunId: parent.run.id, executionAuthorizedAt: null }]);
    expect(after[0]).toMatchObject({
      parentRunId: parent.run.id,
      state: "queued",
    });
    expect(after[0]?.executionAuthorizedAt).not.toBeNull();
  }).pipe(Effect.provide(makeTestLayer(approvalGatedConfig))),
);

it.effect("leaves an MCP child unauthorized when its source thread has no parent Run", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const sql = yield* SqlClient.SqlClient;
    const error = yield* service
      .submitMcpChildCommand(
        decodeCommand({
          commandId: "command-mcp-missing-parent",
          text: "Fix the sample application test",
          spaceId: studioSpace.id,
          repositoryId: "sample-mobile-app",
        }),
        providers,
        {
          spaceId: studioSpace.id,
          repositoryId: "sample-mobile-app",
          threadId: "missing-source-thread",
          providerSessionId: "missing-parent-session",
          providerInstanceId: "missing-parent-provider",
        },
      )
      .pipe(Effect.flip);
    const stored = yield* sql<{
      readonly count: number;
    }>`
      SELECT COUNT(*) AS count
      FROM command_center_runs
      WHERE command_id = 'command-mcp-missing-parent'
    `;

    expect(error.reason).toBe("not_found");
    expect(stored).toEqual([{ count: 0 }]);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("replays the exact MCP child authorization without another audit event", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const sql = yield* SqlClient.SqlClient;
    const parent = yield* service.submitCommand(
      decodeCommand({
        commandId: "command-mcp-replay-parent",
        text: "Start work on the Example Studio app",
        spaceId: studioSpace.id,
        repositoryId: "sample-mobile-app",
      }),
      providers,
    );
    yield* sql`
      UPDATE command_center_runs
      SET state = 'running', project_id = 'replay-project', thread_id = 'replay-source-thread',
        execution_authorized_at = ${fixtureTimestamp}
      WHERE id = ${parent.run.id}
    `;
    const command = decodeCommand({
      commandId: "command-mcp-replay-child",
      text: "Fix the sample application test",
      spaceId: studioSpace.id,
      repositoryId: "sample-mobile-app",
    });
    const source = {
      spaceId: studioSpace.id,
      repositoryId: "sample-mobile-app",
      threadId: "replay-source-thread",
      providerSessionId: "replay-session",
      providerInstanceId: "replay-provider",
    } as const;

    const first = yield* service.submitMcpChildCommand(command, providers, source);
    const replay = yield* service.submitMcpChildCommand(command, [], source);
    const events = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM command_center_audit_events
      WHERE event_id = ${`mcp-child-run:${first.run.id}:bound`}
    `;

    expect(first.duplicate).toBe(false);
    expect(replay).toMatchObject({
      duplicate: true,
      run: { id: first.run.id, parentRunId: parent.run.id },
    });
    expect(events).toEqual([{ count: 1 }]);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("denies an explicit repository outside the selected Space", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const error = yield* Effect.flip(
      service.submitCommand(
        decodeCommand({
          commandId: "command-cross-space-repository",
          text: "Open the repository",
          spaceId: systemSpace.id,
          repositoryId: studioSpace.repositories[0]?.id,
        }),
        providers,
      ),
    );

    expect(error.reason).toBe("validation");
    expect(error.message).toContain("not bound to the selected Space");
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("enforces Space capability and auto-run policy", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const sql = yield* SqlClient.SqlClient;
    const blocked = yield* service.submitCommand(
      decodeCommand({
        commandId: "command-disallowed-capability",
        text: "Fix the code",
        spaceId: systemSpace.id,
      }),
      providers,
    );

    expect(blocked.route.status).toBe("blocked");
    expect(blocked.run.status).toBe("failed");
    expect((yield* service.bootstrap).needsYou).toContainEqual(
      expect.objectContaining({
        kind: "alert",
        status: "review",
        priority: "high",
      }),
    );
    const actions = yield* sql<{ readonly action: string }>`
      SELECT action FROM command_center_audit_events
      WHERE run_id = ${blocked.run.id}
      ORDER BY sequence
    `;
    expect(actions.map(({ action }) => action)).toEqual([
      "cc.command.submit",
      "cc.failures.recorded",
      "cc.items.changed",
    ]);
  }).pipe(
    Effect.provide(
      makeTestLayer({
        ...loadedConfig,
        spaces: [
          decodeSpace({
            ...systemSpace,
            policy: {
              allowedCapabilities: ["cc.items.read"],
              autoRunRiskLevels: ["low"],
            },
          }),
        ],
      }),
    ),
  ),
);

it.effect("requires approval when the Space does not auto-run a safe risk level", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const result = yield* service.submitCommand(
      decodeCommand({
        commandId: "command-policy-approval",
        text: "Summarize today",
        spaceId: systemSpace.id,
      }),
      providers,
    );

    expect(result.route.risk).toBe("low");
    expect(result.route.status).toBe("approval-required");
    expect(result.run.status).toBe("waiting_approval");
  }).pipe(
    Effect.provide(
      makeTestLayer({
        ...loadedConfig,
        spaces: [
          decodeSpace({
            ...systemSpace,
            policy: {
              allowedCapabilities: ["cc.runs.start"],
              autoRunRiskLevels: [],
            },
          }),
        ],
      }),
    ),
  ),
);

it.effect("routes a disabled Google assignment to its Space but grants no capability", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const result = yield* service.submitCommand(
      decodeCommand({
        commandId: "command-google-space",
        text: "Check tomorrow's calendar",
      }),
      providers,
    );

    expect(result.route.spaceId).toBe(personalSpace.id);
    expect(result.route.status).toBe("blocked");
    expect(result.run.status).toBe("failed");
    expect(result.route.capabilities).toEqual([]);
    expect(result.route.reasons).toContain(
      "The selected Space's read-only Google connection is disabled",
    );
    expect(result.route.sources.space).toBe("classifier");
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("blocks an enabled but unhealthy Google connection without granting capability", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const result = yield* service.submitCommand(
      decodeCommand({
        commandId: "command-google-unhealthy",
        text: "Find the email about the sample launch",
      }),
      providers,
    );

    expect(result.route.spaceId).toBe(personalSpace.id);
    expect(result.route.status).toBe("blocked");
    expect(result.route.capabilities).toEqual([]);
    expect(result.route.reasons).toContain(
      "The selected Space's read-only Google connection is unavailable",
    );
  }).pipe(
    Effect.provide(
      makeTestLayer({
        ...loadedConfig,
        connections: [enabledGoogleConnection],
      }),
    ),
  ),
);

it.effect("grants a Google read capability only after the exact Connection is healthy", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const health = yield* ConnectionHealth.ConnectionHealth;
    yield* service.bootstrap;
    yield* health.markConnected({
      spaceId: personalSpace.id,
      connectionId: enabledGoogleConnection.id,
    });

    const result = yield* service.submitCommand(
      decodeCommand({
        commandId: "command-google-healthy",
        text: "Check tomorrow's calendar",
      }),
      providers,
    );

    expect(result.route.spaceId).toBe(personalSpace.id);
    expect(result.route.status).toBe("ready");
    expect(result.route.capabilities).toEqual(["cc.connections.google.read"]);
  }).pipe(
    Effect.provide(
      makeTestLayer({
        ...loadedConfig,
        connections: [enabledGoogleConnection],
      }),
    ),
  ),
);

it.effect("uses least-privilege capabilities for Needs You and automation drafting", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const needsYou = yield* service.submitCommand(
      decodeCommand({
        commandId: "command-needs-you-read-only",
        text: "What needs me?",
        spaceId: systemSpace.id,
      }),
      providers,
    );
    const draft = yield* service.submitCommand(
      decodeCommand({
        commandId: "command-draft-automation",
        text: "Create a weekly automation",
        spaceId: systemSpace.id,
      }),
      providers,
    );
    const run = yield* service.submitCommand(
      decodeCommand({
        commandId: "command-run-automation",
        text: "Run the weekly automation",
        spaceId: systemSpace.id,
      }),
      providers,
    );

    expect(needsYou.route.capabilities).toEqual(["cc.items.read"]);
    expect(needsYou.route.actionKind).toBe("read");
    expect(draft.route.capabilities).toEqual(["cc.automations.read", "cc.automations.write"]);
    expect(draft.route.actionKind).toBe("automation.draft");
    expect(run.route.capabilities).toEqual(["cc.automations.read", "cc.automations.run"]);
    expect(run.route.actionKind).toBe("automation.run");
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("replays duplicate command ids with the current Run state and immutable route", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const sql = yield* SqlClient.SqlClient;
    const command = decodeCommand({
      commandId: "command-idempotent",
      text: "What items need review?",
      spaceId: systemSpace.id,
    });

    const first = yield* service.submitCommand(command, providers);
    yield* sql`
      UPDATE command_center_runs
      SET state = 'running', project_id = 'project-current', thread_id = 'thread-current'
      WHERE id = ${first.run.id}
    `;
    const runningDuplicate = yield* service.submitCommand(command, []);

    const finishedAt = "2026-01-02T00:00:00.000Z";
    yield* sql`
      UPDATE command_center_runs
      SET state = 'succeeded', result_json = ${encodeUnknownJsonString({ outcome: "complete" })},
        finished_at = ${finishedAt}
      WHERE id = ${first.run.id}
    `;
    const terminalDuplicate = yield* service.submitCommand(command, []);
    const bootstrap = yield* service.bootstrap;

    expect(first.duplicate).toBe(false);
    expect(runningDuplicate).toMatchObject({
      duplicate: true,
      run: {
        id: first.run.id,
        status: "running",
        projectId: "project-current",
        threadId: "thread-current",
      },
    });
    expect(runningDuplicate.route).toEqual(first.route);
    expect(terminalDuplicate).toMatchObject({
      duplicate: true,
      run: {
        id: first.run.id,
        status: "succeeded",
        projectId: "project-current",
        threadId: "thread-current",
        finishedAt,
      },
    });
    expect(terminalDuplicate.route).toEqual(first.route);
    expect(bootstrap.runs).toHaveLength(1);
    expect(bootstrap.runs[0]?.commandId).toBe(command.commandId);
    expect(bootstrap.runs[0]?.status).toBe("succeeded");
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect(
  "auto-queues allowed reads and creates an exact digest-bound approval when Space policy gates work",
  () =>
    Effect.gen(function* () {
      const service = yield* CommandCenterService;
      const sql = yield* SqlClient.SqlClient;

      const safe = yield* service.submitCommand(
        decodeCommand({
          commandId: "command-safe-read",
          text: "What items need me?",
          spaceId: studioSpace.id,
        }),
        providers,
      );
      const risky = yield* service.submitCommand(
        decodeCommand({
          commandId: "command-policy-gated-read",
          text: "Summarize today",
          spaceId: systemSpace.id,
        }),
        providers,
      );
      const bootstrap = yield* service.bootstrap;
      const persisted = yield* sql<{
        readonly payloadDigest: string;
        readonly payloadJson: string;
      }>`
      SELECT payload_digest AS "payloadDigest", payload_json AS "payloadJson"
      FROM command_center_approvals
      WHERE run_id = ${risky.run.id}
    `;
      const auditActions = yield* sql<{ readonly action: string }>`
        SELECT action FROM command_center_audit_events
        WHERE run_id = ${risky.run.id}
        ORDER BY sequence
      `;

      expect(safe.route.status).toBe("ready");
      expect(safe.route.risk).toBe("low");
      expect(safe.run.status).toBe("queued");
      expect(risky.route.status).toBe("approval-required");
      expect(risky.route.risk).toBe("low");
      expect(risky.run.status).toBe("waiting_approval");
      expect(bootstrap.approvals).toHaveLength(1);
      expect(bootstrap.approvals[0]?.proposal).toContain("Command: Summarize today");
      expect(bootstrap.approvals[0]?.proposal).toContain("Action: read");
      expect(bootstrap.needsYou).toHaveLength(1);
      expect(bootstrap.needsYou[0]).toMatchObject({
        spaceId: systemSpace.id,
        kind: "approval",
        status: "waiting",
        priority: "urgent",
      });
      expect(auditActions.map(({ action }) => action)).toEqual([
        "cc.command.submit",
        "cc.approvals.changed",
        "cc.items.changed",
      ]);
      expect(persisted).toHaveLength(1);
      const approvalRow = persisted[0];
      expect(approvalRow).toBeDefined();
      if (approvalRow !== undefined) {
        expect(approvalRow.payloadDigest).toBe(
          NodeCrypto.createHash("sha256").update(approvalRow.payloadJson).digest("hex"),
        );
        expect(decodeUnknownJsonString(approvalRow.payloadJson)).toMatchObject({
          kind: "command-action",
          version: 1,
          command: { text: "Summarize today" },
          route: { actionKind: "read", spaceId: systemSpace.id },
        });
      }
    }).pipe(
      Effect.provide(
        makeTestLayer({
          ...loadedConfig,
          spaces: [
            studioSpace,
            decodeSpace({
              ...systemSpace,
              policy: {
                allowedCapabilities: ["cc.runs.start"],
                autoRunRiskLevels: [],
              },
            }),
            personalSpace,
          ],
        }),
      ),
    ),
);

it.effect("blocks protected actions until a narrow server-mediated executor exists", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const result = yield* service.submitCommand(
      decodeCommand({
        commandId: "command-protected-deploy",
        text: "Deploy the application",
        spaceId: studioSpace.id,
      }),
      providers,
    );
    const bootstrap = yield* service.bootstrap;

    expect(result.route.risk).toBe("approval-required");
    expect(result.route.status).toBe("blocked");
    expect(result.route.approvalRequired).toBe(false);
    expect(result.route.capabilities).toEqual([]);
    expect(result.route.reasons).toContain(
      "No narrow server-mediated executor is available for this protected action in v1",
    );
    expect(result.run.status).toBe("failed");
    expect(bootstrap.approvals).toEqual([]);
    expect(bootstrap.needsYou).toContainEqual(
      expect.objectContaining({
        kind: "alert",
        status: "review",
        priority: "high",
      }),
    );
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("honors explicit provider and model overrides", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const result = yield* service.submitCommand(
      decodeCommand({
        commandId: "command-explicit-provider",
        text: "Review the current status",
        spaceId: studioSpace.id,
        providerId: "provider-beta",
        modelId: "model-beta-careful",
      }),
      providers,
    );

    expect(result.route.status).toBe("ready");
    expect(result.route.providerId).toBe("provider-beta");
    expect(result.route.modelId).toBe("model-beta-careful");
    expect(result.route.sources.provider).toBe("explicit");
    expect(result.route.sources.model).toBe("explicit");
    expect(result.run.providerId).toBe("provider-beta");
    expect(result.run.modelId).toBe("model-beta-careful");
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("stores explicit memory as approved and inferred memory as a scoped candidate", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const sql = yield* SqlClient.SqlClient;
    const remembered = yield* service.remember(
      decodeRemember({
        requestId: "memory-approved",
        spaceId: studioSpace.id,
        repositoryId: "sample-mobile-app",
        kind: "procedure",
        content: "Run the sample checks before review.",
        sourceRef: "command-memory-approved",
      }),
    );
    const proposed = yield* service.proposeMemory(
      decodeProposal({
        requestId: "memory-candidate",
        spaceId: studioSpace.id,
        kind: "preference",
        content: "The sample may prefer concise reports.",
        confidence: 0.62,
        sourceRef: "run-memory-candidate",
      }),
    );
    const bootstrap = yield* service.bootstrap;
    const projectedItemEvents = yield* sql<{
      readonly action: string;
      readonly payloadJson: string;
    }>`
      SELECT action, payload_json AS "payloadJson"
      FROM command_center_audit_events
      WHERE event_id = ${`memory-review-item:${proposed.id}:created`}
    `;

    expect(remembered).toMatchObject({
      spaceId: studioSpace.id,
      repositoryId: "sample-mobile-app",
      status: "approved",
      confidence: 1,
      provenance: { kind: "user", sourceRef: "command-memory-approved" },
    });
    expect(proposed).toMatchObject({
      spaceId: studioSpace.id,
      status: "candidate",
      confidence: 0.62,
      provenance: { kind: "agent", sourceRef: "run-memory-candidate" },
    });
    expect(bootstrap.memories).toHaveLength(2);
    expect(bootstrap.memories.find((memory) => memory.id === proposed.id)?.status).toBe(
      "candidate",
    );
    expect(bootstrap.needsYou).toContainEqual(
      expect.objectContaining({
        kind: "decision",
        status: "review",
        metadata: expect.objectContaining({
          type: "memory-candidate",
          memoryId: proposed.id,
        }),
      }),
    );
    expect(projectedItemEvents).toHaveLength(1);
    expect(projectedItemEvents[0]?.action).toBe("cc.items.changed");
    expect(decodeUnknownJsonString(projectedItemEvents[0]?.payloadJson ?? "{}")).toMatchObject({
      change: "created",
      kind: "decision",
      status: "review",
    });
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("reviews Memory candidates explicitly and enforces exact repository scope", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const sql = yield* SqlClient.SqlClient;
    const proposed = yield* service.proposeMemory(
      decodeProposal({
        requestId: "memory-repository-candidate",
        spaceId: studioSpace.id,
        repositoryId: "sample-mobile-app",
        kind: "decision",
        content: "Keep the sample release process reviewable.",
        confidence: 0.71,
      }),
    );

    const wrongScope = yield* service
      .reviewMemory(
        decodeMemoryReview({
          memoryId: proposed.id,
          spaceId: studioSpace.id,
          decision: "approve",
        }),
      )
      .pipe(Effect.flip);
    expect(wrongScope).toMatchObject({ reason: "not_found" });
    expect((yield* service.bootstrap).memories[0]?.status).toBe("candidate");

    const decision = decodeMemoryReview({
      memoryId: proposed.id,
      spaceId: studioSpace.id,
      repositoryId: "sample-mobile-app",
      decision: "approve",
    });
    const approved = yield* service.reviewMemory(decision);
    const replay = yield* service.reviewMemory(decision);
    const after = yield* service.bootstrap;
    const candidateRows = yield* sql<{ readonly status: string }>`
      SELECT status FROM command_center_memory_candidates WHERE id = ${proposed.id}
    `;

    expect(approved.status).toBe("approved");
    expect(replay).toMatchObject({ id: approved.id, status: "approved" });
    expect(after.needsYou).toHaveLength(0);
    expect(candidateRows).toEqual([{ status: "promoted" }]);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("allows only one conflicting Memory review to append audit state", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const sql = yield* SqlClient.SqlClient;
    const proposed = yield* service.proposeMemory(
      decodeProposal({
        requestId: "memory-concurrent-review",
        spaceId: studioSpace.id,
        kind: "fact",
        content: "A candidate with one final decision.",
        confidence: 0.6,
      }),
    );
    const review = (decision: "approve" | "reject") =>
      service
        .reviewMemory(
          decodeMemoryReview({
            memoryId: proposed.id,
            spaceId: studioSpace.id,
            decision,
          }),
        )
        .pipe(Effect.exit);
    const results = yield* Effect.all([review("approve"), review("reject")], {
      concurrency: "unbounded",
    });
    const audit = yield* sql<{ readonly eventId: string }>`
      SELECT event_id AS "eventId"
      FROM command_center_audit_events
      WHERE event_id LIKE ${`memory-review:${proposed.id}:%`}
        AND action = 'cc.memory.changed'
    `;

    expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
    expect(results.filter((result) => result._tag === "Failure")).toHaveLength(1);
    expect(audit).toHaveLength(1);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("serves typed, filtered entity queries with the configured timezone", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const sql = yield* SqlClient.SqlClient;
    yield* service.submitCommand(
      decodeCommand({
        commandId: "query-run",
        text: "Summarize the current status",
        spaceId: systemSpace.id,
      }),
      providers,
    );
    const queryMemory = yield* service.proposeMemory(
      decodeProposal({
        requestId: "query-memory",
        spaceId: studioSpace.id,
        kind: "fact",
        content: "A query-scoped candidate.",
        confidence: 0.5,
      }),
    );
    yield* service.reviewMemory(
      decodeMemoryReview({
        memoryId: queryMemory.id,
        spaceId: studioSpace.id,
        decision: "reject",
      }),
    );
    const closedItem = yield* service.createItem({
      requestId: "query-done-item",
      spaceId: studioSpace.id,
      kind: "task",
      priority: "normal",
      title: "A completed query fixture",
    });
    yield* sql`
      UPDATE command_center_items SET status = 'done' WHERE id = ${closedItem.id}
    `;

    expect((yield* service.bootstrap).timezone).toBe("Etc/UTC");
    expect(yield* service.querySpaces({ spaceId: studioSpace.id })).toMatchObject({
      spaces: [{ id: studioSpace.id }],
    });
    expect(
      yield* service.queryRuns({
        spaceId: systemSpace.id,
        statuses: ["queued"],
      }),
    ).toMatchObject({ runs: [{ commandId: "query-run", status: "queued" }] });
    expect(
      yield* service.queryMemories({
        spaceId: studioSpace.id,
        statuses: ["rejected"],
        limit: 1,
      }),
    ).toMatchObject({
      memories: [{ id: "query-memory", status: "rejected" }],
    });
    expect(
      (yield* service.queryItems({
        spaceId: studioSpace.id,
        statuses: ["done"],
      })).items,
    ).toContainEqual(expect.objectContaining({ id: "query-done-item", status: "done" }));
    expect(yield* service.queryAutomations({ spaceId: studioSpace.id })).toEqual({
      automations: [],
    });
    expect(yield* service.queryApprovals({ spaceId: studioSpace.id })).toEqual({
      approvals: [],
    });
    expect(yield* service.queryConnections({ spaceId: studioSpace.id })).toEqual({
      connections: [],
    });
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("records digest-addressed Artifacts and enforces exact Space and Run scope", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const sql = yield* SqlClient.SqlClient;
    const run = yield* service.submitCommand(
      decodeCommand({
        commandId: "artifact-run",
        text: "Summarize the current status",
        spaceId: systemSpace.id,
      }),
      providers,
    );
    const artifact = decodeArtifact({
      id: "artifact-example",
      spaceId: systemSpace.id,
      runId: run.run.id,
      kind: "export",
      name: "Google Drive export.pdf",
      locator: "cc-artifact://artifact-example",
      mimeType: "application/pdf",
      contentDigest: "a".repeat(64),
      provenance: {
        kind: "connector",
        sourceRef: "google-drive:file-example",
        capturedAt: fixtureTimestamp,
      },
      createdAt: fixtureTimestamp,
    });

    const first = yield* service.recordArtifact({
      artifact,
      sizeBytes: 42,
      format: "pdf",
    });
    const replay = yield* service.recordArtifact({
      artifact,
      sizeBytes: 42,
      format: "pdf",
    });
    const ownSpace = yield* service.queryArtifacts({
      spaceId: systemSpace.id,
    });
    const otherSpace = yield* service.queryArtifacts({
      spaceId: studioSpace.id,
    });
    const audit = yield* sql<{ readonly action: string }>`
      SELECT action FROM command_center_audit_events WHERE action = 'cc.artifacts.changed'
    `;

    expect(first).toEqual(artifact);
    expect(replay).toEqual(artifact);
    expect(ownSpace.artifacts).toEqual([artifact]);
    expect(otherSpace.artifacts).toEqual([]);
    expect(audit).toEqual([{ action: "cc.artifacts.changed" }]);

    const wrongRunScope = yield* service
      .recordArtifact({
        artifact: decodeArtifact({
          ...artifact,
          id: "artifact-wrong",
          spaceId: studioSpace.id,
        }),
      })
      .pipe(Effect.flip);
    expect(wrongRunScope).toMatchObject({ reason: "not_found" });
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("rejects an approval decision when its payload digest does not match", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    yield* service.submitCommand(
      decodeCommand({
        commandId: "command-approval-mismatch",
        text: "Summarize the application",
        spaceId: studioSpace.id,
      }),
      providers,
    );
    const before = yield* service.bootstrap;
    const approval = before.approvals[0];
    expect(approval).toBeDefined();
    if (approval === undefined) return;

    const error = yield* service
      .decideApproval(
        decodeApprovalDecision({
          approvalId: approval.id,
          payloadDigest: "0".repeat(64),
          decision: "approved",
        }),
      )
      .pipe(Effect.flip);
    const after = yield* service.bootstrap;

    expect(error).toMatchObject({
      _tag: "CommandCenterError",
      reason: "conflict",
    });
    expect(after.approvals[0]?.status).toBe("requested");
    expect(after.runs[0]?.status).toBe("waiting_approval");
    expect(after.needsYou).toHaveLength(1);
  }).pipe(Effect.provide(makeTestLayer(approvalGatedConfig))),
);

it.effect("revalidates the digest against the immutable command and route before approval", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const sql = yield* SqlClient.SqlClient;
    const submitted = yield* service.submitCommand(
      decodeCommand({
        commandId: "command-approval-bound-input",
        text: "Summarize the reviewed application",
        spaceId: studioSpace.id,
      }),
      providers,
    );
    const approval = (yield* service.bootstrap).approvals[0];
    expect(approval).toBeDefined();
    if (approval === undefined) return;

    yield* sql`
      UPDATE command_center_runs
      SET input_json = ${encodeUnknownJsonString({
        commandId: "command-approval-bound-input",
        text: "Summarize a different application",
        spaceId: studioSpace.id,
      })}
      WHERE id = ${submitted.run.id}
    `;

    const error = yield* service
      .decideApproval(
        decodeApprovalDecision({
          approvalId: approval.id,
          payloadDigest: approval.payloadDigest,
          decision: "approved",
        }),
      )
      .pipe(Effect.flip);
    expect(error).toMatchObject({ reason: "conflict" });
  }).pipe(Effect.provide(makeTestLayer(approvalGatedConfig))),
);

it.effect("replays the same approval decision without dispatching it twice", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    yield* service.submitCommand(
      decodeCommand({
        commandId: "command-approval-replay",
        text: "Summarize the application",
        spaceId: studioSpace.id,
      }),
      providers,
    );
    const requested = (yield* service.bootstrap).approvals[0];
    expect(requested).toBeDefined();
    if (requested === undefined) return;
    const decision = decodeApprovalDecision({
      approvalId: requested.id,
      payloadDigest: requested.payloadDigest,
      decision: "approved",
    });

    const first = yield* service.decideApproval(decision);
    const replay = yield* service.decideApproval(decision);

    expect(first.status).toBe("approved");
    expect(replay).toMatchObject({ id: first.id, status: "approved" });
  }).pipe(Effect.provide(makeTestLayer(approvalGatedConfig))),
);

it.effect("expires stale approvals and removes them from Needs You", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const sql = yield* SqlClient.SqlClient;
    const result = yield* service.submitCommand(
      decodeCommand({
        commandId: "command-approval-expiry",
        text: "Summarize the application",
        spaceId: studioSpace.id,
      }),
      providers,
    );
    yield* sql`
      UPDATE command_center_approvals
      SET expires_at = '1900-01-01T00:00:00.000Z'
      WHERE run_id = ${result.run.id}
    `;

    const bootstrap = yield* service.bootstrap;

    expect(bootstrap.approvals[0]?.status).toBe("expired");
    expect(bootstrap.runs[0]?.status).toBe("canceled");
    expect(bootstrap.needsYou).toHaveLength(0);
  }).pipe(Effect.provide(makeTestLayer(approvalGatedConfig))),
);

it.effect("records a hash-chained local automation definition commit without publication", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const sql = yield* SqlClient.SqlClient;
    yield* service.querySpaces({ spaceId: studioSpace.id });
    yield* service.recordAutomationDefinitionCommit({
      operation: "updated",
      automationId: "sample-flow",
      spaceId: studioSpace.id,
      previousConfigCommitSha: "a".repeat(40),
      configCommitSha: "b".repeat(40),
      previousDefinitionDigest: `sha256:${"c".repeat(64)}`,
      definitionDigest: `sha256:${"d".repeat(64)}`,
    });

    const rows = yield* sql<{
      readonly action: string;
      readonly payloadJson: string;
      readonly eventHash: string;
    }>`
      SELECT action, payload_json AS "payloadJson", event_hash AS "eventHash"
      FROM command_center_audit_events
      WHERE event_id = ${`automation-definition:${"b".repeat(40)}`}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("cc.automations.definition.committed");
    expect(rows[0]?.eventHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(decodeUnknownJsonString(rows[0]!.payloadJson)).toMatchObject({
      automationId: "sample-flow",
      pushed: false,
    });
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect(
  "binds agent-authored config commits to the active parent Run and rejects stale sessions",
  () =>
    Effect.gen(function* () {
      const service = yield* CommandCenterService;
      const sql = yield* SqlClient.SqlClient;
      const submitted = yield* service.submitCommand(
        decodeCommand({
          commandId: "automation-authoring-parent",
          text: "Create a weekly automation",
          spaceId: studioSpace.id,
        }),
        providers,
      );
      yield* service.authorizeRunExecution({ runId: submitted.run.id, actorKind: "user" });
      yield* sql`
      UPDATE command_center_runs
      SET state = 'running', thread_id = 'thread-automation-authoring'
      WHERE id = ${submitted.run.id}
    `;

      yield* service.recordAutomationDefinitionCommit({
        operation: "created",
        requestId: "weekly-authoring-request",
        automationId: "weekly-brief",
        spaceId: studioSpace.id,
        previousConfigCommitSha: "e".repeat(40),
        configCommitSha: "f".repeat(40),
        previousDefinitionDigest: null,
        definitionDigest: `sha256:${"a".repeat(64)}`,
        actor: {
          kind: "agent",
          threadId: "thread-automation-authoring",
          providerSessionId: "provider-session-1",
          providerInstanceId: "provider-instance-1",
        },
      });

      const rows = yield* sql<{
        readonly actorKind: string;
        readonly runId: string | null;
        readonly payloadJson: string;
      }>`
      SELECT actor_kind AS "actorKind", run_id AS "runId", payload_json AS "payloadJson"
      FROM command_center_audit_events
      WHERE event_id = ${`automation-definition:${"f".repeat(40)}`}
    `;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorKind: "agent", runId: submitted.run.id });
      expect(decodeUnknownJsonString(rows[0]!.payloadJson)).toMatchObject({
        operation: "created",
        requestId: "weekly-authoring-request",
        source: {
          kind: "mcp",
          threadId: "thread-automation-authoring",
          providerSessionId: "provider-session-1",
        },
        pushed: false,
      });

      const stale = yield* Effect.flip(
        service.recordAutomationDefinitionCommit({
          operation: "created",
          requestId: "stale-authoring-request",
          automationId: "stale-weekly-brief",
          spaceId: studioSpace.id,
          previousConfigCommitSha: "1".repeat(40),
          configCommitSha: "2".repeat(40),
          previousDefinitionDigest: null,
          definitionDigest: `sha256:${"3".repeat(64)}`,
          actor: {
            kind: "agent",
            threadId: "missing-thread",
            providerSessionId: "expired-session",
            providerInstanceId: "provider-instance-1",
          },
        }),
      );
      expect(stale).toMatchObject({ _tag: "CommandCenterError", reason: "validation" });
    }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("archives removed Spaces, hides their projections, and denies scoped replays", () => {
  let currentConfig: LoadedCommandCenterConfig = approvalGatedConfig;

  return Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const sql = yield* SqlClient.SqlClient;
    yield* service.bootstrap;

    const itemInput = {
      requestId: "removed-space-item",
      spaceId: studioSpace.id,
      kind: "task" as const,
      priority: "normal" as const,
      title: "Preserved historical task",
    };
    const memoryInput = decodeRemember({
      requestId: "removed-space-memory",
      spaceId: studioSpace.id,
      kind: "decision",
      content: "Preserve the generic release decision.",
    });
    const commandInput = decodeCommand({
      commandId: "removed-space-command",
      text: "Summarize the sample application",
      spaceId: studioSpace.id,
    });
    const item = yield* service.createItem(itemInput);
    const memory = yield* service.remember(memoryInput);
    const submitted = yield* service.submitCommand(commandInput, providers);
    const approval = (yield* service.bootstrap).approvals[0];
    expect(approval).toBeDefined();
    if (approval === undefined) return;

    const artifact = decodeArtifact({
      id: "removed-space-artifact",
      spaceId: studioSpace.id,
      runId: submitted.run.id,
      kind: "report",
      name: "Preserved report",
      locator: "cc-artifact://removed-space-artifact",
      contentDigest: "e".repeat(64),
      provenance: { kind: "agent", capturedAt: fixtureTimestamp },
      createdAt: fixtureTimestamp,
    });
    yield* service.recordArtifact({ artifact });

    const auditBefore = yield* sql<{ readonly count: number }>`
      SELECT count(*) AS count FROM command_center_audit_events
    `;
    currentConfig = {
      ...approvalGatedConfig,
      spaces: approvalGatedConfig.spaces.filter((space) => space.id !== studioSpace.id),
    };

    const archived = yield* service.bootstrap;
    expect(archived.spaces.some((space) => space.id === studioSpace.id)).toBe(false);
    expect(archived.items.some((candidate) => candidate.spaceId === studioSpace.id)).toBe(false);
    expect(archived.runs.some((candidate) => candidate.spaceId === studioSpace.id)).toBe(false);
    expect(archived.approvals.some((candidate) => candidate.spaceId === studioSpace.id)).toBe(
      false,
    );
    expect(archived.memories.some((candidate) => candidate.spaceId === studioSpace.id)).toBe(false);
    expect(archived.needsYou.some((candidate) => candidate.spaceId === studioSpace.id)).toBe(false);
    expect(yield* service.queryItems({ spaceId: studioSpace.id })).toEqual({
      items: [],
    });
    expect(yield* service.queryRuns({ spaceId: studioSpace.id })).toEqual({
      runs: [],
    });
    expect(yield* service.queryMemories({ spaceId: studioSpace.id })).toEqual({ memories: [] });
    expect(yield* service.queryArtifacts({ spaceId: studioSpace.id })).toEqual({ artifacts: [] });

    const itemReplayError = yield* service.createItem(itemInput).pipe(Effect.flip);
    const memoryReplayError = yield* service.remember(memoryInput).pipe(Effect.flip);
    const commandReplayError = yield* service
      .submitCommand(commandInput, providers)
      .pipe(Effect.flip);
    const artifactReplayError = yield* service.recordArtifact({ artifact }).pipe(Effect.flip);
    const crossSpaceItemReplayError = yield* service
      .createItem({ ...itemInput, spaceId: systemSpace.id })
      .pipe(Effect.flip);
    const crossSpaceMemoryReplayError = yield* service
      .remember(decodeRemember({ ...memoryInput, spaceId: systemSpace.id }))
      .pipe(Effect.flip);
    const approvalError = yield* service
      .decideApproval(
        decodeApprovalDecision({
          approvalId: approval.id,
          payloadDigest: approval.payloadDigest,
          decision: "approved",
        }),
      )
      .pipe(Effect.flip);
    expect(itemReplayError.reason).toBe("not_found");
    expect(memoryReplayError.reason).toBe("not_found");
    expect(commandReplayError.reason).toBe("not_found");
    expect(artifactReplayError.reason).toBe("not_found");
    expect(crossSpaceItemReplayError.reason).toBe("conflict");
    expect(crossSpaceMemoryReplayError.reason).toBe("conflict");
    expect(approvalError.reason).toBe("not_found");

    const preserved = yield* sql<{
      readonly lifecycle: string;
      readonly items: number;
      readonly runs: number;
      readonly approvals: number;
      readonly artifacts: number;
      readonly memories: number;
    }>`
      SELECT s.lifecycle,
        (SELECT count(*) FROM command_center_items WHERE id = ${item.id}) AS items,
        (SELECT count(*) FROM command_center_runs WHERE id = ${submitted.run.id}) AS runs,
        (SELECT count(*) FROM command_center_approvals WHERE id = ${approval.id}) AS approvals,
        (SELECT count(*) FROM command_center_artifacts WHERE id = ${artifact.id}) AS artifacts,
        (SELECT count(*) FROM command_center_memories WHERE id = ${memory.id}) AS memories
      FROM command_center_spaces s
      WHERE s.id = ${studioSpace.id}
    `;
    expect(preserved).toEqual([
      {
        lifecycle: "archived",
        items: 1,
        runs: 1,
        approvals: 1,
        artifacts: 1,
        memories: 1,
      },
    ]);
    expect(
      (yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count FROM command_center_audit_events
      `)[0]?.count,
    ).toBe(auditBefore[0]?.count);

    currentConfig = loadedConfig;
    const recovered = yield* service.bootstrap;
    expect(recovered.spaces).toContainEqual(expect.objectContaining({ id: studioSpace.id }));
    expect(recovered.items).toContainEqual(expect.objectContaining({ id: item.id }));
    expect(recovered.runs).toContainEqual(expect.objectContaining({ id: submitted.run.id }));
    expect(recovered.memories).toContainEqual(expect.objectContaining({ id: memory.id }));
    expect(yield* service.queryArtifacts({ spaceId: studioSpace.id })).toEqual({
      artifacts: [artifact],
    });
  }).pipe(Effect.provide(makeTestLayerFrom(Effect.sync(() => currentConfig))));
});

for (const unavailableStatus of ["missing", "invalid"] as const) {
  it.effect(
    `${unavailableStatus} private config archives projections and denies scoped writes without data loss`,
    () => {
      const availableConfig: LoadedCommandCenterConfig = {
        ...loadedConfig,
        connections: [enabledGoogleConnection],
      };
      let currentConfig = availableConfig;

      return Effect.gen(function* () {
        const service = yield* CommandCenterService;
        const sql = yield* SqlClient.SqlClient;
        yield* service.bootstrap;
        const existing = yield* service.createItem({
          requestId: `unavailable-config-${unavailableStatus}-existing`,
          spaceId: systemSpace.id,
          kind: "task",
          priority: "normal",
          title: "Preserved while configuration is unavailable",
        });
        const auditBefore = yield* sql<{ readonly count: number }>`
          SELECT count(*) AS count FROM command_center_audit_events
        `;

        currentConfig = unavailableConfig(unavailableStatus);
        const unavailable = yield* service.bootstrap;
        expect(unavailable.configHealth.status).toBe(unavailableStatus);
        expect(unavailable.spaces).toEqual([]);
        expect(unavailable.items).toEqual([]);
        expect(unavailable.runs).toEqual([]);
        expect(unavailable.approvals).toEqual([]);
        expect(unavailable.automations).toEqual([]);
        expect(unavailable.connections).toEqual([]);
        expect(unavailable.memories).toEqual([]);
        expect(yield* service.querySpaces({ spaceId: systemSpace.id })).toEqual({ spaces: [] });
        expect(yield* service.queryItems({ spaceId: systemSpace.id })).toEqual({
          items: [],
        });

        const writeError = yield* service
          .createItem({
            requestId: `unavailable-config-${unavailableStatus}-denied`,
            spaceId: systemSpace.id,
            kind: "task",
            priority: "normal",
            title: "This write must be denied",
          })
          .pipe(Effect.flip);
        expect(writeError.reason).toBe("config");

        const preserved = yield* sql<{
          readonly lifecycle: string;
          readonly existingItems: number;
          readonly deniedItems: number;
          readonly connections: number;
        }>`
          SELECT s.lifecycle,
            (SELECT count(*) FROM command_center_items WHERE id = ${existing.id}) AS "existingItems",
            (SELECT count(*) FROM command_center_items
              WHERE id = ${`unavailable-config-${unavailableStatus}-denied`}) AS "deniedItems",
            (SELECT count(*) FROM command_center_connections
              WHERE id = ${enabledGoogleConnection.id}) AS connections
          FROM command_center_spaces s
          WHERE s.id = ${systemSpace.id}
        `;
        expect(preserved).toEqual([
          {
            lifecycle: "archived",
            existingItems: 1,
            deniedItems: 0,
            connections: 1,
          },
        ]);
        expect(
          (yield* sql<{ readonly count: number }>`
            SELECT count(*) AS count FROM command_center_audit_events
          `)[0]?.count,
        ).toBe(auditBefore[0]?.count);

        currentConfig = availableConfig;
        const recovered = yield* service.bootstrap;
        expect(recovered.spaces).toContainEqual(expect.objectContaining({ id: systemSpace.id }));
        expect(recovered.items).toContainEqual(expect.objectContaining({ id: existing.id }));
      }).pipe(Effect.provide(makeTestLayerFrom(Effect.sync(() => currentConfig))));
    },
  );
}

it.effect("updates an exact-space Item with CAS semantics and emits one typed event", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const sql = yield* SqlClient.SqlClient;
    const created = yield* service.createItem({
      requestId: "item-cas-example",
      spaceId: studioSpace.id,
      kind: "task",
      priority: "normal",
      title: "Prepare sample release",
    });
    const input = decodeItemUpdate({
      itemId: created.id,
      spaceId: created.spaceId,
      expectedUpdatedAt: created.updatedAt,
      patch: {
        status: "in_progress",
        priority: "high",
        title: "Prepare reviewed sample release",
      },
    });

    const first = yield* service.updateItem(input);
    expect(first.duplicate).toBe(false);
    expect(first.item).toMatchObject({
      id: created.id,
      spaceId: created.spaceId,
      status: "in_progress",
      priority: "high",
      title: "Prepare reviewed sample release",
    });
    expect(first.item.updatedAt).not.toBe(created.updatedAt);

    const replay = yield* service.updateItem(input);
    expect(replay).toEqual({ item: first.item, duplicate: true });
    const events = yield* sql<{
      readonly action: string;
      readonly payloadJson: string;
    }>`
      SELECT action, payload_json AS "payloadJson"
      FROM command_center_audit_events
      WHERE action = 'cc.items.changed' AND space_id = ${created.spaceId}
        AND payload_json LIKE ${`%${created.id}%`}
    `;
    expect(events).toHaveLength(1);
    expect(
      decodeItemChangedPayload(decodeUnknownJsonString(events[0]?.payloadJson ?? "{}")),
    ).toEqual({
      itemId: created.id,
      change: "updated",
      kind: "task",
      status: "in_progress",
    });
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("denies stale conflicting and cross-Space Item updates", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const created = yield* service.createItem({
      requestId: "item-cas-denial",
      spaceId: studioSpace.id,
      kind: "decision",
      priority: "normal",
      title: "Choose a sample option",
    });
    yield* service.updateItem(
      decodeItemUpdate({
        itemId: created.id,
        spaceId: created.spaceId,
        expectedUpdatedAt: created.updatedAt,
        patch: { status: "review" },
      }),
    );

    const stale = yield* service
      .updateItem(
        decodeItemUpdate({
          itemId: created.id,
          spaceId: created.spaceId,
          expectedUpdatedAt: created.updatedAt,
          patch: { priority: "urgent" },
        }),
      )
      .pipe(Effect.flip);
    expect(stale.reason).toBe("conflict");

    const crossSpace = yield* service
      .updateItem(
        decodeItemUpdate({
          itemId: created.id,
          spaceId: systemSpace.id,
          expectedUpdatedAt: created.updatedAt,
          patch: { status: "done" },
        }),
      )
      .pipe(Effect.flip);
    expect(crossSpace.reason).toBe("not_found");
  }).pipe(Effect.provide(makeTestLayer())),
);
