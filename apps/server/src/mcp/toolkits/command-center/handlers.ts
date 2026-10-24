import {
  CommandCenterError,
  type CommandCenterItemUpdateInput,
  GoogleDraftCreateRequest,
} from "@t3tools/contracts";
import { type CapabilityName, RepositoryId, SpaceId } from "@command-center/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as CommandCenterService from "../../../command-center/Service.ts";
import * as AutomationDefinitionConfig from "../../../command-center/AutomationDefinitionConfig.ts";
import { automationConfigIsSafeForGit } from "../../../command-center/automation/Definition.ts";
import * as AutomationRuns from "../../../command-center/AutomationRuns.ts";
import * as GmailDrafts from "../../../command-center/GmailDrafts.ts";
import * as MemorySearchIndex from "../../../command-center/MemorySearchIndex.ts";
import * as GoogleReadConnector from "../../../command-center/GoogleReadConnector.ts";
import {
  googleCapabilityForDraft,
  googleCapabilityForOperation,
} from "../../../command-center/GoogleCapabilities.ts";
import * as ReadinessGate from "../../../command-center/ReadinessGate.ts";
import * as SpaceActivity from "../../../command-center/SpaceActivity.ts";
import { PhoneCalls } from "../../../command-center/phone/PhoneCalls.ts";
import { PhoneCallProposals } from "../../../command-center/phone/PhoneCallProposals.ts";
import { commandCenterProviderAvailability } from "../../../command-center/ProviderAvailability.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { CommandCenterToolkit } from "./tools.ts";

const bySpace = <A extends { readonly spaceId: string }>(
  values: ReadonlyArray<A>,
  spaceId: string | undefined,
): ReadonlyArray<A> =>
  spaceId === undefined ? values : values.filter((value) => value.spaceId === spaceId);

const requireScopedSpace = Effect.fn("CommandCenterToolkit.requireScopedSpace")(function* (
  capability: Parameters<typeof McpInvocationContext.requireCommandCenterCapability>[0],
  requestedSpaceId?: string,
) {
  const scope = yield* McpInvocationContext.requireCommandCenterCapability(capability);
  const readiness = yield* ReadinessGate.CommandCenterReadinessGate;
  yield* readiness.requireReady.pipe(
    Effect.mapError(
      () =>
        new CommandCenterError({
          reason: "config",
          message: "Command Center is temporarily unavailable.",
        }),
    ),
  );
  if (scope.spaceId === undefined) {
    return yield* new CommandCenterError({
      reason: "validation",
      message: "This MCP credential is not bound to a Space.",
    });
  }
  if (requestedSpaceId !== undefined && requestedSpaceId !== scope.spaceId) {
    return yield* new CommandCenterError({
      reason: "validation",
      message: "This MCP credential cannot access the requested Space.",
    });
  }
  if (scope.role === "space-agent") {
    // A Space agent credential outlives config edits; re-check the live
    // policy so disabling the agent, archiving the Space, or narrowing its
    // capabilities takes effect on the very next tool call.
    const service = yield* CommandCenterService.CommandCenterService;
    const space = yield* service.getConfiguredSpace(scope.spaceId);
    if (space.agent?.enabled !== true || !space.policy.allowedCapabilities.includes(capability)) {
      return yield* new CommandCenterError({
        reason: "validation",
        message: "This Space agent is disabled or no longer allowed to use this tool.",
      });
    }
  }
  // Command Center scopes are minted only for agent thread credentials; flatten
  // the V2 thread caller so tools can attribute writes to the thread.
  if (scope.thread === undefined) {
    return yield* new CommandCenterError({
      reason: "validation",
      message: "Command Center tools need an agent thread credential.",
    });
  }
  return {
    ...scope,
    spaceId: scope.spaceId,
    threadId: scope.thread.threadId,
    providerSessionId: scope.thread.providerSessionId,
    providerInstanceId: scope.thread.providerInstanceId,
  };
});

export const memoryVisibleToScope = (
  memory: {
    readonly spaceId: string;
    readonly repositoryId?: string | undefined;
  },
  scope: {
    readonly spaceId?: string | undefined;
    readonly repositoryId?: string | undefined;
  },
) =>
  memory.spaceId === scope.spaceId &&
  (memory.repositoryId === undefined || memory.repositoryId === scope.repositoryId);

export const resolveProposedMemoryRepository = <Repository extends string>(
  requestedRepositoryId: Repository | undefined,
  scopedRepositoryId: Repository | undefined,
):
  | { readonly allowed: true; readonly repositoryId?: Repository | undefined }
  | { readonly allowed: false } => {
  if (
    requestedRepositoryId !== undefined &&
    (scopedRepositoryId === undefined || requestedRepositoryId !== scopedRepositoryId)
  ) {
    return { allowed: false };
  }
  return scopedRepositoryId === undefined
    ? { allowed: true }
    : { allowed: true, repositoryId: scopedRepositoryId };
};

const collectRepositoryIds = (value: unknown): ReadonlyArray<string> => {
  if (Array.isArray(value)) return value.flatMap(collectRepositoryIds);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) =>
    key === "repositoryId" && typeof nested === "string" ? [nested] : collectRepositoryIds(nested),
  );
};

export const automationDefinitionIsSafeForAuthoring = (definition: {
  readonly nodes: ReadonlyArray<{
    readonly config: Readonly<Record<string, unknown>>;
  }>;
}): boolean => {
  return definition.nodes.every((node) => automationConfigIsSafeForGit(node.config));
};

export const automationDefinitionFitsScope = (
  definition: {
    readonly nodes: ReadonlyArray<{
      readonly kind: string;
      readonly config: Readonly<Record<string, unknown>>;
    }>;
  },
  scope: {
    readonly repositoryId: string | undefined;
    readonly spaceRepositoryIds: ReadonlyArray<string>;
  },
): boolean => {
  const allowedRepositories = new Set(scope.spaceRepositoryIds);
  if (scope.repositoryId !== undefined && !allowedRepositories.has(scope.repositoryId))
    return false;

  let sawScopedRepositoryBinding = false;
  for (const node of definition.nodes) {
    const repositoryIds = collectRepositoryIds(node.config);
    if (repositoryIds.some((repositoryId) => !allowedRepositories.has(repositoryId))) return false;
    if (
      scope.repositoryId !== undefined &&
      repositoryIds.some((repositoryId) => repositoryId !== scope.repositoryId)
    ) {
      return false;
    }
    if (
      scope.repositoryId !== undefined &&
      repositoryIds.some((repositoryId) => repositoryId === scope.repositoryId)
    ) {
      sawScopedRepositoryBinding = true;
    }
    if (
      scope.repositoryId !== undefined &&
      (node.kind === "agent.run" || node.kind === "agent") &&
      node.config.repositoryId !== scope.repositoryId
    ) {
      return false;
    }
    // shell.scoped has no repository field that can be bound by this tool.
    // Repository-scoped sessions must use a server-side manifest resolver.
    if (scope.repositoryId !== undefined && node.kind === "shell.scoped") return false;
  }
  return scope.repositoryId === undefined || sawScopedRepositoryBinding;
};

export const automationSaveRequiresRunCapability = (
  _currentEnabled: boolean,
  nextEnabled: boolean,
): boolean => nextEnabled;

export const automationReplacementFitsScope = (
  current: Parameters<typeof automationDefinitionFitsScope>[0],
  next: Parameters<typeof automationDefinitionFitsScope>[0],
  scope: Parameters<typeof automationDefinitionFitsScope>[1],
): boolean =>
  automationDefinitionFitsScope(current, scope) && automationDefinitionFitsScope(next, scope);

export const filterAutomationsForScope = <
  Automation extends {
    readonly spaceId: string;
    readonly nodes: ReadonlyArray<{
      readonly kind: string;
      readonly config: Readonly<Record<string, unknown>>;
    }>;
  },
>(
  automations: ReadonlyArray<Automation>,
  scope: {
    readonly spaceId: string;
    readonly repositoryId: string | undefined;
    readonly spaceRepositoryIds: ReadonlyArray<string>;
  },
): ReadonlyArray<Automation> =>
  automations.filter(
    (automation) =>
      automation.spaceId === scope.spaceId &&
      (scope.repositoryId === undefined || automationDefinitionFitsScope(automation, scope)),
  );

export const filterRunsAndApprovalsForScope = <
  Run extends {
    readonly id: string;
    readonly spaceId: string;
    readonly repositoryId?: string | undefined;
  },
  Approval extends { readonly spaceId: string; readonly runId: string },
>(
  runs: ReadonlyArray<Run>,
  approvals: ReadonlyArray<Approval>,
  scope: { readonly spaceId: string; readonly repositoryId: string | undefined },
): { readonly runs: ReadonlyArray<Run>; readonly approvals: ReadonlyArray<Approval> } => {
  const visibleRuns = runs.filter(
    (run) =>
      run.spaceId === scope.spaceId &&
      (scope.repositoryId === undefined || run.repositoryId === scope.repositoryId),
  );
  if (scope.repositoryId === undefined) {
    return {
      runs: visibleRuns,
      approvals: approvals.filter((approval) => approval.spaceId === scope.spaceId),
    };
  }
  const visibleRunIds = new Set(visibleRuns.map((run) => run.id));
  return {
    runs: visibleRuns,
    approvals: approvals.filter(
      (approval) => approval.spaceId === scope.spaceId && visibleRunIds.has(approval.runId),
    ),
  };
};

const invocationAuthoritiesMatch = (
  left: McpInvocationContext.McpInvocationScope,
  right: McpInvocationContext.McpInvocationScope,
): boolean =>
  left.spaceId === right.spaceId &&
  left.repositoryId === right.repositoryId &&
  left.thread?.threadId === right.thread?.threadId &&
  left.thread?.providerSessionId === right.thread?.providerSessionId &&
  left.thread?.providerInstanceId === right.thread?.providerInstanceId;

export const resolveRunStartScope = (input: {
  readonly requestedSpaceId?: string;
  readonly requestedRepositoryId?: string;
  readonly requestedProjectId?: string;
  readonly scopedSpaceId: string;
  readonly scopedRepositoryId?: string;
}):
  | {
      readonly allowed: true;
      readonly spaceId: string;
      readonly repositoryId?: string;
    }
  | { readonly allowed: false } => {
  if (input.requestedSpaceId !== undefined && input.requestedSpaceId !== input.scopedSpaceId) {
    return { allowed: false };
  }
  if (
    input.scopedRepositoryId !== undefined &&
    ((input.requestedRepositoryId !== undefined &&
      input.requestedRepositoryId !== input.scopedRepositoryId) ||
      input.requestedProjectId !== undefined)
  ) {
    return { allowed: false };
  }
  return {
    allowed: true,
    spaceId: input.scopedSpaceId,
    ...(input.scopedRepositoryId === undefined
      ? input.requestedRepositoryId === undefined
        ? {}
        : { repositoryId: input.requestedRepositoryId }
      : { repositoryId: input.scopedRepositoryId }),
  };
};

export const memoryWriteOperationForScope = (scope: {
  readonly memoryWriteMode?: McpInvocationContext.McpMemoryWriteMode;
}): "remember" | "propose" => (scope.memoryWriteMode === "remember" ? "remember" : "propose");

/** Phone calls belong to the always-on Space agent; other credentials cannot place or file them. */
const requireSpaceAgentScope = <S extends { readonly role?: string | undefined }>(scope: S) =>
  scope.role === "space-agent"
    ? Effect.succeed(scope)
    : Effect.fail(
        new CommandCenterError({
          reason: "validation",
          message: "Only a Space agent can use the phone tools.",
        }),
      );

/** Space agent scopes act as the agent; every other credential keeps the default actor. */
const spaceAgentItemActor = (scope: {
  readonly role?: string | undefined;
  readonly threadId: string;
}): CommandCenterService.CommandCenterItemActor | undefined =>
  scope.role === "space-agent" ? { kind: "space-agent", threadId: scope.threadId } : undefined;

/**
 * The Space's Google connections that grant `capability`, narrowed to
 * `connectionId` when one is given. The connection check of `cc_google_read`
 * and `cc_google_draft_create`.
 */
const googleConnectionsGranting = <
  Connection extends {
    readonly id: string;
    readonly spaceId: string;
    readonly kind: string;
    readonly capabilities: ReadonlyArray<CapabilityName>;
  },
>(
  connections: ReadonlyArray<Connection>,
  input: {
    readonly spaceId: string;
    readonly capability: CapabilityName;
    readonly connectionId?: string | undefined;
  },
): ReadonlyArray<Connection> =>
  connections.filter(
    (connection) =>
      connection.spaceId === input.spaceId &&
      (input.connectionId === undefined || connection.id === input.connectionId) &&
      connection.kind === "google" &&
      connection.capabilities.includes(input.capability),
  );

const decodeGoogleDraftCreateRequest = Schema.decodeUnknownEffect(GoogleDraftCreateRequest);

const handlers = {
  cc_spaces_list: (_input) =>
    Effect.gen(function* () {
      const scope = yield* requireScopedSpace("cc.items.read");
      const service = yield* CommandCenterService.CommandCenterService;
      const snapshot = yield* service.bootstrap;
      return {
        spaces: snapshot.spaces.filter((space) => space.id === scope.spaceId),
        connections: bySpace(snapshot.connections, scope.spaceId),
      };
    }),
  cc_items_list: ({ spaceId }) =>
    Effect.gen(function* () {
      const scope = yield* requireScopedSpace("cc.items.read", spaceId);
      const service = yield* CommandCenterService.CommandCenterService;
      const snapshot = yield* service.bootstrap;
      return {
        items: bySpace(snapshot.items, scope.spaceId),
        needsYou: bySpace(snapshot.needsYou, scope.spaceId),
      };
    }),
  cc_items_create: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireScopedSpace("cc.items.write", input.spaceId);
      const service = yield* CommandCenterService.CommandCenterService;
      return yield* service.createItem(input, spaceAgentItemActor(scope));
    }),
  cc_items_update: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireScopedSpace("cc.items.write", input.spaceId);
      const service = yield* CommandCenterService.CommandCenterService;
      const patch = Object.fromEntries(
        Object.entries(input.patch).filter(([, value]) => value !== undefined),
      ) as CommandCenterItemUpdateInput["patch"];
      if (Object.keys(patch).length === 0) {
        return yield* new CommandCenterError({
          reason: "validation",
          message: "An Item update must change the status, title, or description.",
        });
      }
      return yield* service.updateItem(
        { ...input, patch },
        // Non-agent credentials keep the user-actor path the Inbox UI uses.
        spaceAgentItemActor(scope),
      );
    }),
  cc_memory_list: ({ spaceId }) =>
    Effect.gen(function* () {
      const scope = yield* requireScopedSpace("cc.memory.read", spaceId);
      const service = yield* CommandCenterService.CommandCenterService;
      const snapshot = yield* service.bootstrap;
      return {
        memories: snapshot.memories.filter((memory) => memoryVisibleToScope(memory, scope)),
      };
    }),
  cc_memory_propose: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireScopedSpace("cc.memory.propose", input.spaceId);
      const repository = resolveProposedMemoryRepository(input.repositoryId, scope.repositoryId);
      if (!repository.allowed) {
        return yield* new CommandCenterError({
          reason: "validation",
          message: "This MCP credential cannot propose Memory for the requested repository.",
        });
      }
      const service = yield* CommandCenterService.CommandCenterService;
      const memory = {
        requestId: input.requestId,
        spaceId: input.spaceId,
        kind: input.kind,
        content: input.content,
        ...(input.sourceRef === undefined ? {} : { sourceRef: input.sourceRef }),
        ...(repository.repositoryId === undefined ? {} : { repositoryId: repository.repositoryId }),
      };
      if (memoryWriteOperationForScope(scope) !== "remember") {
        return yield* service.proposeMemory({ ...memory, confidence: input.confidence });
      }
      // Space agent Memory is approved but attributed to the agent thread.
      return yield* scope.role === "space-agent"
        ? service.rememberFromSpaceAgent(memory, { threadId: scope.threadId })
        : service.remember(memory);
    }),
  cc_space_brief: ({ spaceId }) =>
    Effect.gen(function* () {
      const scope = yield* requireScopedSpace("cc.memory.read", spaceId);
      const service = yield* CommandCenterService.CommandCenterService;
      return yield* service.spaceBrief({
        spaceId: scope.spaceId,
        ...(scope.repositoryId === undefined ? {} : { repositoryId: scope.repositoryId }),
      });
    }),
  cc_memory_search: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireScopedSpace("cc.memory.read", input.spaceId);
      if (
        input.repositoryId !== undefined &&
        (scope.repositoryId === undefined || input.repositoryId !== scope.repositoryId)
      ) {
        return yield* new CommandCenterError({
          reason: "validation",
          message: "This MCP credential cannot search the requested repository Memory.",
        });
      }
      const index = yield* MemorySearchIndex.MemorySearchIndex;
      const service = yield* CommandCenterService.CommandCenterService;
      yield* service.querySpaces({ spaceId: SpaceId.make(scope.spaceId) });
      const results = yield* index
        .search({
          query: input.query,
          spaceId: scope.spaceId,
          ...(scope.repositoryId === undefined ? {} : { repositoryRef: scope.repositoryId }),
          ...(input.includeArchives === undefined
            ? {}
            : { includeArchives: input.includeArchives }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new CommandCenterError({
                reason: cause.reason === "invalid-query" ? "validation" : "persistence",
                message: cause.message,
                cause,
              }),
          ),
        );
      return {
        results: results.map(({ repositoryRef, ...result }) => ({
          ...result,
          spaceId: SpaceId.make(result.spaceId),
          ...(repositoryRef === undefined
            ? {}
            : { repositoryId: RepositoryId.make(repositoryRef) }),
        })),
      };
    }),
  cc_automations_list: ({ spaceId }) =>
    Effect.gen(function* () {
      const scope = yield* requireScopedSpace("cc.automations.read", spaceId);
      const service = yield* CommandCenterService.CommandCenterService;
      const snapshot = yield* service.bootstrap;
      const selectedSpace = snapshot.spaces.find((space) => space.id === scope.spaceId);
      if (selectedSpace === undefined) {
        return yield* new CommandCenterError({
          reason: "not_found",
          message: "The requested automation Space was not found.",
        });
      }
      return {
        automations: filterAutomationsForScope(snapshot.automations, {
          spaceId: scope.spaceId,
          repositoryId: scope.repositoryId,
          spaceRepositoryIds: selectedSpace.repositories.map((repository) => repository.id),
        }),
      };
    }),
  cc_automations_create: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireScopedSpace("cc.automations.write", input.spaceId);
      const service = yield* CommandCenterService.CommandCenterService;
      const selectedSpace = (yield* service.querySpaces({ spaceId: scope.spaceId })).spaces[0];
      if (selectedSpace === undefined) {
        return yield* new CommandCenterError({
          reason: "not_found",
          message: "The requested automation Space was not found.",
        });
      }
      if (
        !automationDefinitionIsSafeForAuthoring(input) ||
        !automationDefinitionFitsScope(input, {
          repositoryId: scope.repositoryId,
          spaceRepositoryIds: selectedSpace.repositories.map((repository) => repository.id),
        })
      ) {
        return yield* new CommandCenterError({
          reason: "validation",
          message:
            "The automation draft contains a host path, credential-shaped field, or repository outside this MCP session scope.",
        });
      }
      const definitions = yield* AutomationDefinitionConfig.AutomationDefinitionConfig;
      return yield* definitions.create(input, (audit) =>
        service.recordAutomationDefinitionCommit({
          ...audit,
          actor: {
            kind: "agent",
            threadId: scope.threadId,
            providerSessionId: scope.providerSessionId,
            providerInstanceId: scope.providerInstanceId,
          },
        }),
      );
    }),
  cc_automations_save: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireScopedSpace("cc.automations.write", input.spaceId);
      const definitions = yield* AutomationDefinitionConfig.AutomationDefinitionConfig;
      const service = yield* CommandCenterService.CommandCenterService;
      const selectedSpace = (yield* service.querySpaces({ spaceId: scope.spaceId })).spaces[0];
      if (selectedSpace === undefined) {
        return yield* new CommandCenterError({
          reason: "not_found",
          message: "The requested automation Space was not found.",
        });
      }
      const definitionScope = {
        repositoryId: scope.repositoryId,
        spaceRepositoryIds: selectedSpace.repositories.map((repository) => repository.id),
      };
      if (
        !automationDefinitionIsSafeForAuthoring(input.definition) ||
        !automationDefinitionFitsScope(input.definition, definitionScope)
      ) {
        return yield* new CommandCenterError({
          reason: "validation",
          message:
            "The automation definition contains a host path, credential-shaped field, or repository outside this MCP session scope.",
        });
      }
      const current = yield* definitions.get(input);
      if (!automationReplacementFitsScope(current.definition, input.definition, definitionScope)) {
        return yield* new CommandCenterError({
          reason: "validation",
          message: "The existing automation is outside this MCP session repository scope.",
        });
      }
      if (
        automationSaveRequiresRunCapability(current.definition.enabled, input.definition.enabled)
      ) {
        const executionScope = yield* requireScopedSpace("cc.automations.run", input.spaceId);
        if (!invocationAuthoritiesMatch(scope, executionScope)) {
          return yield* new CommandCenterError({
            reason: "validation",
            message: "Automation execution authority does not match the authoring session scope.",
          });
        }
      }
      return yield* definitions.save(input, (audit) =>
        service.recordAutomationDefinitionCommit({
          ...audit,
          actor: {
            kind: "agent",
            threadId: scope.threadId,
            providerSessionId: scope.providerSessionId,
            providerInstanceId: scope.providerInstanceId,
          },
        }),
      );
    }),
  cc_runs_list: ({ spaceId }) =>
    Effect.gen(function* () {
      const scope = yield* requireScopedSpace("cc.runs.start", spaceId);
      const service = yield* CommandCenterService.CommandCenterService;
      const snapshot = yield* service.bootstrap;
      return filterRunsAndApprovalsForScope(snapshot.runs, snapshot.approvals, {
        spaceId: scope.spaceId,
        repositoryId: scope.repositoryId,
      });
    }),
  cc_runs_start: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireScopedSpace("cc.runs.start", input.spaceId);
      const resolved = resolveRunStartScope({
        ...(input.spaceId === undefined ? {} : { requestedSpaceId: input.spaceId }),
        ...(input.repositoryId === undefined ? {} : { requestedRepositoryId: input.repositoryId }),
        ...(input.projectId === undefined ? {} : { requestedProjectId: input.projectId }),
        scopedSpaceId: scope.spaceId,
        ...(scope.repositoryId === undefined ? {} : { scopedRepositoryId: scope.repositoryId }),
      });
      if (!resolved.allowed) {
        return yield* new CommandCenterError({
          reason: "validation",
          message: "This MCP credential cannot start a Run outside its Space or repository scope.",
        });
      }
      const service = yield* CommandCenterService.CommandCenterService;
      const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
      const {
        spaceId: _requestedSpaceId,
        repositoryId: _requestedRepositoryId,
        projectId: _requestedProjectId,
        ...unscopedCommand
      } = input;
      const command = {
        ...unscopedCommand,
        spaceId: SpaceId.make(resolved.spaceId),
        ...(resolved.repositoryId === undefined
          ? {}
          : { repositoryId: RepositoryId.make(resolved.repositoryId) }),
        ...(scope.repositoryId === undefined && input.projectId !== undefined
          ? { projectId: input.projectId }
          : {}),
      };
      const providers = commandCenterProviderAvailability(yield* providerRegistry.getProviders);
      if (scope.role === "space-agent") {
        // Server-side autonomy gate: out-of-policy work becomes a decision.
        return yield* service.submitSpaceAgentCommand(command, providers, {
          spaceId: scope.spaceId,
          threadId: scope.threadId,
          providerSessionId: scope.providerSessionId,
          providerInstanceId: scope.providerInstanceId,
        });
      }
      return yield* service.submitMcpChildCommand(command, providers, {
        spaceId: scope.spaceId,
        ...(scope.repositoryId === undefined ? {} : { repositoryId: scope.repositoryId }),
        threadId: scope.threadId,
        providerSessionId: scope.providerSessionId,
        providerInstanceId: scope.providerInstanceId,
      });
    }),
  cc_automations_run: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireScopedSpace("cc.automations.run", input.spaceId);
      const service = yield* CommandCenterService.CommandCenterService;
      const snapshot = yield* service.bootstrap;
      const automation = snapshot.automations.find(
        (candidate) => candidate.id === input.automationId && candidate.spaceId === scope.spaceId,
      );
      if (automation === undefined) {
        return yield* new CommandCenterError({
          reason: "not_found",
          message: "The automation was not found in this Space.",
        });
      }
      const selectedSpace = snapshot.spaces.find((space) => space.id === scope.spaceId);
      if (
        selectedSpace === undefined ||
        !automationDefinitionFitsScope(automation, {
          repositoryId: scope.repositoryId,
          spaceRepositoryIds: selectedSpace.repositories.map((repository) => repository.id),
        })
      ) {
        return yield* new CommandCenterError({
          reason: "validation",
          message: "The automation targets authority outside this MCP credential scope.",
        });
      }
      const automationRuns = yield* AutomationRuns.AutomationRuns;
      return yield* automationRuns.start(input);
    }),
  cc_google_read: (input) =>
    Effect.gen(function* () {
      const requiredCapability = googleCapabilityForOperation(input.operation);
      const scope = yield* requireScopedSpace(requiredCapability, input.spaceId);
      const connector = yield* GoogleReadConnector.GoogleReadConnector;
      const service = yield* CommandCenterService.CommandCenterService;
      const snapshot = yield* service.bootstrap;
      const accountIsScoped =
        googleConnectionsGranting(snapshot.connections, {
          spaceId: scope.spaceId,
          capability: requiredCapability,
          connectionId: input.connectionId,
        }).length > 0;
      if (!accountIsScoped) {
        return yield* new CommandCenterError({
          reason: "validation",
          message: "The requested Google connection is not available in this Space.",
        });
      }
      const toConnectorError = (cause: GoogleReadConnector.GoogleReadConnectorError) =>
        new CommandCenterError({
          reason: "connector" as const,
          message: cause.message,
          cause,
        });
      if (input.operation !== "drive.export") {
        return yield* connector.read(input).pipe(Effect.mapError(toConnectorError));
      }
      const exported = yield* connector.exportDrive(input).pipe(Effect.mapError(toConnectorError));
      const artifact = yield* service
        .recordArtifact({
          artifact: exported.artifact,
          sizeBytes: exported.sizeBytes,
          format: exported.format,
        })
        .pipe(Effect.tapError(() => connector.discardExport(exported)));
      return {
        operation: "drive.export" as const,
        contentTrust: "untrusted-external" as const,
        artifact,
        sizeBytes: exported.sizeBytes,
      };
    }),
  cc_space_activity: ({ since, limit }) =>
    Effect.gen(function* () {
      const scope = yield* requireScopedSpace("cc.items.read");
      if (scope.repositoryId !== undefined) {
        return yield* new CommandCenterError({
          reason: "validation",
          message:
            "Space activity spans every repository; a repository-scoped credential cannot read it.",
        });
      }
      const activity = yield* SpaceActivity.SpaceActivity;
      // `recent` leaves out mail and calendar rows unless asked: this tool needs
      // only `cc.items.read`, not a Google read capability, so an ordinary
      // credential must not see them. The Space agent already receives those
      // rows in its wake delta, and its wake text sends it here for the ones
      // that did not fit, so it (and only it) opts in. The rows are untrusted
      // external text.
      return {
        activity: yield* activity.recent({
          spaceId: scope.spaceId,
          ...(since === undefined ? {} : { since }),
          ...(limit === undefined ? {} : { limit }),
          ...(scope.role === "space-agent" ? { includeExternal: true } : {}),
        }),
      };
    }),
  cc_phone_call_me: ({ spaceId, purpose, brief, question }) =>
    Effect.gen(function* () {
      const scope = yield* requireSpaceAgentScope(
        yield* requireScopedSpace("cc.phone.call-owner", spaceId),
      );
      const phone = yield* PhoneCalls;
      return yield* phone.callOwner({
        spaceId: SpaceId.make(scope.spaceId),
        purpose,
        brief,
        ...(question === undefined ? {} : { question }),
      });
    }),
  cc_phone_call: ({ requestId, spaceId, ...plan }) =>
    Effect.gen(function* () {
      const scope = yield* requireSpaceAgentScope(
        yield* requireScopedSpace("cc.phone.call", spaceId),
      );
      // Files the plan for approval only; nothing here can dial.
      const proposals = yield* PhoneCallProposals;
      return yield* proposals.file({
        spaceId: scope.spaceId,
        threadId: scope.threadId,
        requestId,
        plan: { ...plan, spaceId: SpaceId.make(scope.spaceId) },
      });
    }),
  // Creation, the 24-hour limit, and the activity row and audit event are
  // GmailDrafts' (see there for why a draft needs no approval).
  cc_google_draft_create: ({ spaceId, connectionId, ...draft }) =>
    Effect.gen(function* () {
      const requiredCapability = googleCapabilityForDraft("gmail.draft.create");
      const scope = yield* requireScopedSpace(requiredCapability, spaceId);
      const service = yield* CommandCenterService.CommandCenterService;
      // Without `connectionId`, the Space's one connection that can create drafts.
      const eligible = googleConnectionsGranting((yield* service.bootstrap).connections, {
        spaceId: scope.spaceId,
        capability: requiredCapability,
        connectionId,
      });
      const connection = eligible.length === 1 ? eligible[0] : undefined;
      if (connection === undefined) {
        return yield* new CommandCenterError({
          reason: "validation",
          message:
            eligible.length > 1
              ? "More than one Google connection in this Space can create drafts; pass connectionId."
              : "The requested Google connection is not available in this Space.",
        });
      }
      const request = yield* decodeGoogleDraftCreateRequest({
        ...draft,
        spaceId: scope.spaceId,
        connectionId: connection.id,
        operation: "gmail.draft.create",
      }).pipe(
        Effect.mapError(
          (cause) =>
            new CommandCenterError({
              reason: "validation",
              message: "The Gmail draft request is invalid.",
              cause,
            }),
        ),
      );
      const drafts = yield* GmailDrafts.GmailDrafts;
      const { recorded, ...created } = yield* drafts.createForSpace({
        request,
        agentThreadId: scope.threadId,
      });
      const saved = `Draft saved in Gmail (not sent): ${request.subject}`;
      return {
        ...created,
        summary: recorded
          ? saved
          : `${saved}. Command Center could not record draft ${created.draftId}; do not create it again.`,
      };
    }),
} satisfies Parameters<typeof CommandCenterToolkit.toLayer>[0];

/**
 * Drops object keys whose value is `undefined`, at any depth. Command Center
 * records carry optional fields as explicit `undefined` (`Schema.optional`),
 * and effect's MCP server rejects a `CallToolResult` whose `structuredContent`
 * is not strict JSON, so `cc_items_list`, `cc_runs_list` and friends failed
 * every call. An absent key and an `undefined` one mean the same here.
 */
const withoutUndefinedFields = <A>(value: A): A => {
  if (Array.isArray(value)) return value.map(withoutUndefinedFields) as A;
  if (value === null || typeof value !== "object") return value;
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, field]) =>
      field === undefined ? [] : [[key, withoutUndefinedFields(field)]],
    ),
  ) as A;
};

/** Wraps one handler so its success value is strict JSON (see above). */
const jsonSafe =
  <Args extends ReadonlyArray<unknown>, A, E, R>(
    handler: (...args: Args) => Effect.Effect<A, E, R>,
  ) =>
  (...args: Args): Effect.Effect<A, E, R> =>
    handler(...args).pipe(Effect.map(withoutUndefinedFields));

/** Every Command Center tool declares its access (see `McpToolAccess`). */
export const CommandCenterToolkitHandlersLive = McpToolAccess.toLayer(CommandCenterToolkit, {
  cc_spaces_list: McpToolAccess.reads(jsonSafe(handlers.cc_spaces_list)),
  cc_items_list: McpToolAccess.reads(jsonSafe(handlers.cc_items_list)),
  cc_memory_list: McpToolAccess.reads(jsonSafe(handlers.cc_memory_list)),
  cc_memory_search: McpToolAccess.reads(jsonSafe(handlers.cc_memory_search)),
  cc_space_brief: McpToolAccess.reads(jsonSafe(handlers.cc_space_brief)),
  cc_automations_list: McpToolAccess.reads(jsonSafe(handlers.cc_automations_list)),
  cc_runs_list: McpToolAccess.reads(jsonSafe(handlers.cc_runs_list)),
  cc_google_read: McpToolAccess.reads(jsonSafe(handlers.cc_google_read)),
  cc_space_activity: McpToolAccess.reads(jsonSafe(handlers.cc_space_activity)),
  // Writes check their Command Center capability in the handler.
  cc_items_create: McpToolAccess.writesWithCapability(jsonSafe(handlers.cc_items_create)),
  cc_items_update: McpToolAccess.writesWithCapability(jsonSafe(handlers.cc_items_update)),
  cc_memory_propose: McpToolAccess.writesWithCapability(jsonSafe(handlers.cc_memory_propose)),
  cc_automations_create: McpToolAccess.writesWithCapability(
    jsonSafe(handlers.cc_automations_create),
  ),
  cc_automations_save: McpToolAccess.writesWithCapability(jsonSafe(handlers.cc_automations_save)),
  cc_runs_start: McpToolAccess.writesWithCapability(jsonSafe(handlers.cc_runs_start)),
  cc_automations_run: McpToolAccess.writesWithCapability(jsonSafe(handlers.cc_automations_run)),
  cc_google_draft_create: McpToolAccess.writesWithCapability(
    jsonSafe(handlers.cc_google_draft_create),
  ),
  // Phone tools act (the owner call dials; the third-party call files an approval).
  cc_phone_call_me: McpToolAccess.writesWithCapability(jsonSafe(handlers.cc_phone_call_me)),
  cc_phone_call: McpToolAccess.writesWithCapability(jsonSafe(handlers.cc_phone_call)),
});
