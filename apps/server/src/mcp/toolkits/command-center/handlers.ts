import { CommandCenterError } from "@t3tools/contracts";
import { ConnectionId, RepositoryId, SpaceId } from "@command-center/core";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import * as CommandCenterService from "../../../command-center/Service.ts";
import * as AutomationDefinitionConfig from "../../../command-center/AutomationDefinitionConfig.ts";
import { automationConfigIsSafeForGit } from "../../../command-center/automation/Definition.ts";
import * as AutomationRuns from "../../../command-center/AutomationRuns.ts";
import * as MemorySearchIndex from "../../../command-center/MemorySearchIndex.ts";
import * as GoogleReadConnector from "../../../command-center/GoogleReadConnector.ts";
import { googleCapabilityForOperation } from "../../../command-center/GoogleCapabilities.ts";
import * as ReadinessGate from "../../../command-center/ReadinessGate.ts";
import * as SalesPipeline from "../../../command-center/SalesPipeline.ts";
import * as ExternalProspectorConnector from "../../../command-center/ExternalProspectorConnector.ts";
import * as SalesProspectorRunner from "../../../command-center/SalesProspectorRunner.ts";
import { withSalesDraftCreateLock } from "../../../command-center/SalesDraftCreateCoordinator.ts";
import { commandCenterProviderAvailability } from "../../../command-center/ProviderAvailability.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CommandCenterToolkit } from "./tools.ts";

const bySpace = <A extends { readonly spaceId: string }>(
  values: ReadonlyArray<A>,
  spaceId: string | undefined,
): ReadonlyArray<A> =>
  spaceId === undefined ? values : values.filter((value) => value.spaceId === spaceId);

const gmailEvidenceIds = (
  value: unknown,
): { readonly messageId?: string; readonly threadId?: string } => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = gmailEvidenceIds(entry);
      if (found.messageId !== undefined || found.threadId !== undefined) return found;
    }
    return {};
  }
  if (value === null || typeof value !== "object") return {};
  const record = value as Readonly<Record<string, unknown>>;
  const messageId =
    typeof record.messageId === "string"
      ? record.messageId
      : typeof record.id === "string"
        ? record.id
        : undefined;
  const threadId = typeof record.threadId === "string" ? record.threadId : undefined;
  if (messageId !== undefined || threadId !== undefined) {
    return {
      ...(messageId === undefined ? {} : { messageId }),
      ...(threadId === undefined ? {} : { threadId }),
    };
  }
  for (const entry of Object.values(record)) {
    const found = gmailEvidenceIds(entry);
    if (found.messageId !== undefined || found.threadId !== undefined) return found;
  }
  return {};
};

export const requireScopedSpace = Effect.fn("CommandCenterToolkit.requireScopedSpace")(function* (
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
  return { ...scope, spaceId: scope.spaceId };
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
  left.threadId === right.threadId &&
  left.providerSessionId === right.providerSessionId &&
  left.providerInstanceId === right.providerInstanceId;

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
      yield* requireScopedSpace("cc.items.write", input.spaceId);
      const service = yield* CommandCenterService.CommandCenterService;
      return yield* service.createItem(input);
    }),
  cc_sales_prospects_list: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireScopedSpace("cc.sales.read", input.spaceId);
      const salesOption = yield* Effect.serviceOption(SalesPipeline.SalesPipeline);
      if (Option.isNone(salesOption)) {
        return yield* new CommandCenterError({
          reason: "persistence",
          message: "The sales pipeline is unavailable.",
        });
      }
      const sales = salesOption.value;
      return yield* sales.query({ ...input, spaceId: SpaceId.make(scope.spaceId) });
    }),
  cc_sales_prospects_propose: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireScopedSpace("cc.sales.propose", input.spaceId);
      const salesOption = yield* Effect.serviceOption(SalesPipeline.SalesPipeline);
      if (Option.isNone(salesOption)) {
        return yield* new CommandCenterError({
          reason: "persistence",
          message: "The sales pipeline is unavailable.",
        });
      }
      const sales = salesOption.value;
      return yield* sales.propose({
        ...input,
        spaceId: SpaceId.make(scope.spaceId),
        provenanceKind: "agent",
        provenanceRef: scope.threadId,
      });
    }),
  cc_sales_prospector_import: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireScopedSpace("cc.sales.propose", input.spaceId);
      const salesOption = yield* Effect.serviceOption(SalesPipeline.SalesPipeline);
      if (Option.isNone(salesOption)) {
        return yield* new CommandCenterError({
          reason: "persistence",
          message: "The sales pipeline is unavailable.",
        });
      }
      const connectorOption = yield* Effect.serviceOption(
        ExternalProspectorConnector.ExternalProspectorConnector,
      );
      if (Option.isNone(connectorOption)) {
        return yield* new CommandCenterError({
          reason: "config",
          message: "The external prospecting source connector is unavailable.",
        });
      }
      return yield* ExternalProspectorConnector.importReadyProspects(
        connectorOption.value,
        salesOption.value,
        { ...input, spaceId: SpaceId.make(scope.spaceId) },
      );
    }),
  cc_sales_prospect_cycle: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireScopedSpace("cc.sales.propose", input.spaceId);
      const runnerOption = yield* Effect.serviceOption(SalesProspectorRunner.SalesProspectorRunner);
      const connectorOption = yield* Effect.serviceOption(
        ExternalProspectorConnector.ExternalProspectorConnector,
      );
      const salesOption = yield* Effect.serviceOption(SalesPipeline.SalesPipeline);
      if (
        Option.isNone(runnerOption) ||
        Option.isNone(connectorOption) ||
        Option.isNone(salesOption)
      ) {
        return yield* new CommandCenterError({
          reason: "config",
          message: "The sales prospecting cycle is not fully configured.",
        });
      }
      const runnerResult = yield* runnerOption.value
        .cycle({
          ...input,
          spaceId: SpaceId.make(scope.spaceId),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new CommandCenterError({
                reason: cause.reason === "configuration" ? "config" : "connector",
                message: cause.message,
                cause,
              }),
          ),
        );
      const imported = yield* ExternalProspectorConnector.importReadyProspects(
        connectorOption.value,
        salesOption.value,
        { spaceId: SpaceId.make(scope.spaceId), limit: input.qualificationLimit ?? 50 },
      );
      return SalesProspectorRunner.completeCycleResult(runnerResult, imported);
    }),
  cc_sales_gmail_draft_create: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireScopedSpace("cc.sales.write", input.spaceId);
      yield* requireScopedSpace("cc.connections.google.gmail.drafts.create", input.spaceId);
      const salesOption = yield* Effect.serviceOption(SalesPipeline.SalesPipeline);
      if (Option.isNone(salesOption)) {
        return yield* new CommandCenterError({
          reason: "connector",
          message: "The sales Gmail draft service is unavailable.",
        });
      }
      const service = yield* CommandCenterService.CommandCenterService;
      const google = yield* GoogleReadConnector.GoogleReadConnector;
      const candidates = (yield* service.queryConnections({
        spaceId: SpaceId.make(scope.spaceId),
      })).connections.filter((connection) =>
        connection.capabilities.includes("cc.connections.google.gmail.drafts.create"),
      );
      if (candidates.length !== 1) {
        return yield* new CommandCenterError({
          reason: "validation",
          message: "The sales Space must have exactly one enabled Gmail draft connection.",
        });
      }
      const sales = salesOption.value;
      return yield* withSalesDraftCreateLock(
        { spaceId: scope.spaceId, requestId: input.idempotencyKey },
        Effect.gen(function* () {
          const prepared = yield* sales.prepareAutomatedDraft({
            ...input,
            spaceId: SpaceId.make(scope.spaceId),
            connectionId: candidates[0]!.id,
          });
          if (prepared.request.status === "created") return prepared;
          const toConnectorError = (cause: GoogleReadConnector.GoogleReadConnectorError) =>
            new CommandCenterError({ reason: "connector" as const, message: cause.message, cause });
          const existing = yield* google
            .findSalesDraft(prepared.request)
            .pipe(Effect.mapError(toConnectorError));
          const result =
            existing === undefined
              ? yield* google
                  .createSalesDraft(prepared.request)
                  .pipe(Effect.mapError(toConnectorError))
              : { draftId: existing };
          return yield* sales.completeDraftCreate({
            requestId: prepared.request.id,
            spaceId: prepared.request.spaceId,
            payloadDigest: prepared.request.payloadDigest,
            draftId: result.draftId,
            reconciled: existing !== undefined,
          });
        }),
      );
    }),
  cc_sales_gmail_reconcile: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireScopedSpace("cc.sales.write", input.spaceId);
      yield* requireScopedSpace("cc.connections.google.gmail.read", input.spaceId);
      const salesOption = yield* Effect.serviceOption(SalesPipeline.SalesPipeline);
      if (Option.isNone(salesOption)) {
        return yield* new CommandCenterError({
          reason: "persistence",
          message: "The sales pipeline is unavailable.",
        });
      }
      const service = yield* CommandCenterService.CommandCenterService;
      const google = yield* GoogleReadConnector.GoogleReadConnector;
      const connections = (yield* service.queryConnections({
        spaceId: SpaceId.make(scope.spaceId),
      })).connections;
      if (
        !connections.some(
          (connection) =>
            connection.id === input.connectionId &&
            connection.capabilities.includes("cc.connections.google.gmail.read"),
        )
      ) {
        return yield* new CommandCenterError({
          reason: "validation",
          message: "The Gmail read connection is not enabled for this Space.",
        });
      }
      const sales = salesOption.value;
      const externalOption = yield* Effect.serviceOption(
        ExternalProspectorConnector.ExternalProspectorConnector,
      );
      if (Option.isSome(externalOption)) {
        const current = yield* sales.query({ spaceId: SpaceId.make(scope.spaceId) });
        const importedIds = new Set<string>(current.draftRequests.map((request) => request.id));
        const historical = yield* externalOption.value
          .loadHistoricalDrafts({ spaceId: SpaceId.make(scope.spaceId) })
          .pipe(
            Effect.mapError(
              (cause) =>
                new CommandCenterError({ reason: "connector", message: cause.message, cause }),
            ),
          );
        for (const record of historical) {
          if (importedIds.has(`prospector-send-${record.sourceSendId}`)) continue;
          const wasSent =
            record.sentAt !== undefined ||
            record.gmailMessageId !== undefined ||
            ["sent", "delivered", "opened", "replied", "bounced"].includes(record.status);
          const draftExists =
            !wasSent && record.gmailDraftId !== undefined
              ? yield* google
                  .salesDraftExists(
                    {
                      spaceId: SpaceId.make(scope.spaceId),
                      connectionId: ConnectionId.make(input.connectionId),
                    },
                    record.gmailDraftId,
                  )
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new CommandCenterError({
                          reason: "connector",
                          message: cause.message,
                          cause,
                        }),
                    ),
                  )
              : false;
          yield* sales.importHistoricalDraft({
            ...record,
            proposal: { ...record.proposal, spaceId: SpaceId.make(scope.spaceId) },
            connectionId: input.connectionId,
            state: wasSent ? "contacted" : draftExists ? "drafted" : "declined",
          });
        }
      }
      const snapshot = yield* sales.query({
        spaceId: SpaceId.make(scope.spaceId),
        stages: ["drafted", "contacted"],
      });
      const observedAt = DateTime.formatIso(yield* DateTime.now);
      let contacted = 0;
      let replied = 0;
      let bounced = 0;
      let deleted = 0;
      let followUpDrafted = 0;
      for (const prospect of snapshot.prospects) {
        if (prospect.contactEmail === undefined) continue;
        const latest = snapshot.draftRequests.find(
          (request) => request.prospectId === prospect.id && request.status === "created",
        );
        if (latest === undefined) continue;
        const safeSubject = latest.subject.replaceAll('"', "");
        const sentResult = yield* google
          .read({
            operation: "gmail.search",
            spaceId: prospect.spaceId,
            connectionId: ConnectionId.make(input.connectionId),
            query: `in:sent to:${prospect.contactEmail} subject:"${safeSubject}" newer_than:30d`,
            limit: 10,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new CommandCenterError({ reason: "connector", message: cause.message, cause }),
            ),
          );
        const sentEvidence =
          sentResult.operation === "gmail.search" ? gmailEvidenceIds(sentResult.data) : {};
        const replyResult = yield* google
          .read({
            operation: "gmail.search",
            spaceId: prospect.spaceId,
            connectionId: ConnectionId.make(input.connectionId),
            query: `in:inbox from:${prospect.contactEmail} newer_than:30d`,
            limit: 10,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new CommandCenterError({
                  reason: "connector",
                  message: cause.message,
                  cause,
                }),
            ),
          );
        const replyEvidence =
          replyResult?.operation === "gmail.search" ? gmailEvidenceIds(replyResult.data) : {};
        const bounceResult =
          prospect.stage === "contacted"
            ? yield* google
                .read({
                  operation: "gmail.search",
                  spaceId: prospect.spaceId,
                  connectionId: ConnectionId.make(input.connectionId),
                  query: `in:anywhere (from:mailer-daemon OR from:postmaster) "${prospect.contactEmail}" newer_than:30d`,
                  limit: 10,
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new CommandCenterError({
                        reason: "connector",
                        message: cause.message,
                        cause,
                      }),
                  ),
                )
            : undefined;
        const bounceEvidence =
          bounceResult?.operation === "gmail.search" ? gmailEvidenceIds(bounceResult.data) : {};
        const draftStillExists =
          latest.gmailDraftId !== undefined
            ? yield* google
                .salesDraftExists(
                  {
                    spaceId: prospect.spaceId,
                    connectionId: ConnectionId.make(input.connectionId),
                  },
                  latest.gmailDraftId,
                )
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new CommandCenterError({
                        reason: "connector",
                        message: cause.message,
                        cause,
                      }),
                  ),
                )
            : true;
        const evidenceMessageId = replyEvidence.messageId ?? sentEvidence.messageId;
        const evidenceThreadId = replyEvidence.threadId ?? sentEvidence.threadId;
        const reconciled = yield* sales.reconcileGmailEvidence({
          prospectId: prospect.id,
          spaceId: prospect.spaceId,
          sent: sentEvidence.messageId !== undefined || sentEvidence.threadId !== undefined,
          replied: replyEvidence.messageId !== undefined || replyEvidence.threadId !== undefined,
          bounced: bounceEvidence.messageId !== undefined || bounceEvidence.threadId !== undefined,
          deleted:
            !draftStillExists &&
            sentEvidence.messageId === undefined &&
            sentEvidence.threadId === undefined,
          draftRequestId: latest.id,
          campaignStep: latest.campaignStep,
          ...(evidenceMessageId === undefined ? {} : { messageId: evidenceMessageId }),
          ...(evidenceThreadId === undefined ? {} : { threadId: evidenceThreadId }),
          observedAt,
        });
        if (prospect.stage === "drafted" && reconciled.prospect.stage === "contacted")
          contacted += 1;
        if (prospect.stage === "contacted" && reconciled.prospect.stage === "replied") replied += 1;
        if (reconciled.prospect.bouncedAt !== undefined && prospect.bouncedAt === undefined)
          bounced += 1;
        if (
          reconciled.prospect.draftDeletedAt !== undefined &&
          prospect.draftDeletedAt === undefined
        )
          deleted += 1;
        const refreshed = yield* sales.query({
          spaceId: prospect.spaceId,
          stages: [reconciled.prospect.stage],
        });
        const dueFollowUps = refreshed.draftRequests.filter(
          (request) =>
            request.prospectId === prospect.id &&
            request.campaignStep > 0 &&
            request.status === "creating",
        );
        for (const request of dueFollowUps) {
          yield* withSalesDraftCreateLock(
            { spaceId: request.spaceId, requestId: request.id },
            Effect.gen(function* () {
              const existing = yield* google.findSalesDraft(request).pipe(
                Effect.mapError(
                  (cause) =>
                    new CommandCenterError({
                      reason: "connector",
                      message: cause.message,
                      cause,
                    }),
                ),
              );
              const result =
                existing === undefined
                  ? yield* google.createSalesDraft(request).pipe(
                      Effect.mapError(
                        (cause) =>
                          new CommandCenterError({
                            reason: "connector",
                            message: cause.message,
                            cause,
                          }),
                      ),
                    )
                  : { draftId: existing };
              yield* sales.completeDraftCreate({
                requestId: request.id,
                spaceId: request.spaceId,
                payloadDigest: request.payloadDigest,
                draftId: result.draftId,
                reconciled: existing !== undefined,
              });
            }),
          );
          followUpDrafted += 1;
        }
      }
      return {
        inspected: snapshot.prospects.length,
        contacted,
        replied,
        bounced,
        deleted,
        followUpDrafted,
      };
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
      return yield* memoryWriteOperationForScope(scope) === "remember"
        ? service.remember(memory)
        : service.proposeMemory({ ...memory, confidence: input.confidence });
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
      return yield* service.submitMcpChildCommand(
        command,
        commandCenterProviderAvailability(yield* providerRegistry.getProviders),
        {
          spaceId: scope.spaceId,
          ...(scope.repositoryId === undefined ? {} : { repositoryId: scope.repositoryId }),
          threadId: scope.threadId,
          providerSessionId: scope.providerSessionId,
          providerInstanceId: scope.providerInstanceId,
        },
      );
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
      const accountIsScoped = snapshot.connections.some(
        (connection) =>
          connection.spaceId === scope.spaceId &&
          connection.id === input.connectionId &&
          connection.kind === "google" &&
          connection.capabilities.includes(requiredCapability),
      );
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
} satisfies Parameters<typeof CommandCenterToolkit.toLayer>[0];

export const CommandCenterToolkitHandlersLive = CommandCenterToolkit.toLayer(handlers);
