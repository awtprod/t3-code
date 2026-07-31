import {
  ModelId,
  ProjectId,
  ProviderId,
  RepositoryId,
  SpaceId,
  type Item,
  type RouteDecision,
  type Run,
  type RunStatus,
} from "@command-center/core";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type {
  CommandCenterBootstrap,
  CommandCenterCommandSubmitResult,
  CommandCenterTimelineEntry,
  ServerProvider,
} from "@t3tools/contracts";

import type {
  CommandCenterContext,
  CommandCenterConversation,
  CommandCenterMessage,
  CommandCenterProject,
  CommandCenterRouteControl,
  CommandCenterRouteOption,
  CommandCenterRouteOptions,
  CommandCenterRouteReceipt,
  CommandCenterRouteSelection,
  CommandCenterSpace,
} from "./types";

const COMMAND_CENTER_SYSTEM_PROJECT_ID = "command-center:system";

const EMPTY_ROUTE_OPTIONS: CommandCenterRouteOptions = {
  repositories: [],
  projects: [],
  providers: [],
  models: [],
};

export interface CommandCenterRouteDisplayContext {
  readonly projects: readonly CommandCenterProject[];
  readonly options: CommandCenterRouteOptions;
}

const ACTIVE_RUN_STATUSES = new Set<Run["status"]>([
  "queued",
  "running",
  "waiting_approval",
  "waiting",
  "failed",
]);

function titleCase(value: string): string {
  return value
    .replaceAll("_", " ")
    .replaceAll(".", " ")
    .replace(/\b\p{L}/gu, (character) => character.toLocaleUpperCase());
}

function spaceName(bootstrap: CommandCenterBootstrap, spaceId: SpaceId): string {
  return bootstrap.spaces.find((space) => space.id === spaceId)?.displayName ?? "Unknown Space";
}

function formatTime(value: string, now: Date): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return "Unknown time";

  const elapsedMs = Math.max(0, now.getTime() - timestamp.getTime());
  if (elapsedMs < 60_000) return "Now";
  if (elapsedMs < 3_600_000) return `${Math.floor(elapsedMs / 60_000)}m ago`;
  if (elapsedMs < 86_400_000) return `${Math.floor(elapsedMs / 3_600_000)}h ago`;
  return timestamp.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function conversationStatus(status: Run["status"]): CommandCenterConversation["status"] {
  if (status === "queued" || status === "running") return "running";
  if (status === "waiting" || status === "waiting_approval") return "waiting";
  if (status === "failed") return "failed";
  return "idle";
}

function needsYouReason(item: Item): "approval" | "decision" | "review" | "blocked" {
  if (item.kind === "approval") return "approval";
  if (item.kind === "decision") return "decision";
  if (item.status === "review") return "review";
  return "blocked";
}

function metadataString(item: Item, key: string): string | undefined {
  const value = item.metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export interface CommandCenterShellProjection {
  readonly spaces: readonly CommandCenterSpace[];
  readonly conversations: readonly CommandCenterConversation[];
  readonly context: CommandCenterContext;
}

function normalizedRepositoryRef(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^(?:https?|ssh|git):\/\//, "")
    .replace(/^git@/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

function repositoryRefsMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizedRepositoryRef(left);
  const normalizedRight = normalizedRepositoryRef(right);
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`/${normalizedRight}`) ||
    normalizedRight.endsWith(`/${normalizedLeft}`)
  );
}

function projectRepositoryRefs(project: EnvironmentProject): readonly string[] {
  const identity = project.repositoryIdentity;
  if (identity === null || identity === undefined) return [];
  return [
    identity.canonicalKey,
    identity.locator.remoteUrl,
    identity.owner !== undefined && identity.name !== undefined
      ? `${identity.owner}/${identity.name}`
      : undefined,
  ].filter((value): value is string => value !== undefined);
}

export function projectEnvironmentProjects(
  projects: readonly EnvironmentProject[],
  bootstrap: CommandCenterBootstrap | null,
): readonly CommandCenterProject[] {
  return projects
    .filter((project) => project.id !== COMMAND_CENTER_SYSTEM_PROJECT_ID)
    .map((project): CommandCenterProject => {
      const projectRefs = projectRepositoryRefs(project);
      const linked = bootstrap?.spaces.flatMap((space) =>
        space.repositories
          .filter(
            (repository) =>
              (repository.projectId !== undefined &&
                String(repository.projectId) === String(project.id)) ||
              (repository.remoteRef !== undefined &&
                projectRefs.some((reference) =>
                  repositoryRefsMatch(reference, repository.remoteRef as string),
                )),
          )
          .map((repository) => ({ repository, space })),
      )[0];
      const identity = project.repositoryIdentity;
      const identityName =
        identity?.displayName ??
        (identity?.owner !== undefined && identity.name !== undefined
          ? `${identity.owner}/${identity.name}`
          : identity?.name);
      return {
        id: project.id,
        name: project.title,
        repositoryName: linked?.repository.displayName ?? identityName,
        repositoryId: linked?.repository.id,
        spaceId: linked?.space.id,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function providerLabel(provider: ServerProvider): string {
  return provider.displayName ?? provider.driver ?? provider.instanceId;
}

export function buildRouteOptions(
  bootstrap: CommandCenterBootstrap | null,
  projects: readonly CommandCenterProject[],
  providers: readonly ServerProvider[],
  selectedProviderId?: string,
): CommandCenterRouteOptions {
  const repositories =
    bootstrap?.spaces.flatMap((space) =>
      space.repositories.map(
        (repository): CommandCenterRouteOption => ({
          id: repository.id,
          label: repository.displayName,
          detail: space.displayName,
        }),
      ),
    ) ?? [];
  const healthyProviders = providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      provider.availability !== "unavailable" &&
      provider.status !== "disabled" &&
      provider.status !== "error",
  );
  const modelProviders =
    selectedProviderId === undefined
      ? healthyProviders
      : healthyProviders.filter((provider) => provider.instanceId === selectedProviderId);
  const seenModels = new Set<string>();
  const models = modelProviders.flatMap((provider) =>
    provider.models.flatMap((model): CommandCenterRouteOption[] => {
      if (seenModels.has(model.slug)) return [];
      seenModels.add(model.slug);
      return [
        {
          id: model.slug,
          label: model.shortName ?? model.name,
          detail: providerLabel(provider),
        },
      ];
    }),
  );

  return {
    repositories: repositories.sort((left, right) => left.label.localeCompare(right.label)),
    projects: projects.map((project) => ({
      id: project.id,
      label: project.name,
      detail: project.repositoryName,
    })),
    providers: healthyProviders.map((provider) => ({
      id: provider.instanceId,
      label: providerLabel(provider),
      detail: provider.status === "ready" ? "Ready" : titleCase(provider.status),
    })),
    models,
  };
}

export function commandRouteOverrides(selection: CommandCenterRouteSelection) {
  return {
    ...(selection.spaceId === undefined ? {} : { spaceId: SpaceId.make(selection.spaceId) }),
    ...(selection.repositoryId === undefined
      ? {}
      : { repositoryId: RepositoryId.make(selection.repositoryId) }),
    ...(selection.projectId === undefined
      ? {}
      : { projectId: ProjectId.make(selection.projectId) }),
    ...(selection.providerId === undefined
      ? {}
      : { providerId: ProviderId.make(selection.providerId) }),
    ...(selection.modelId === undefined ? {} : { modelId: ModelId.make(selection.modelId) }),
  };
}

export function nextRouteSelection(
  current: CommandCenterRouteSelection,
  control: CommandCenterRouteControl,
  value: string | undefined,
  projects: readonly CommandCenterProject[],
  bootstrap: CommandCenterBootstrap | null,
  providers: readonly ServerProvider[],
): CommandCenterRouteSelection {
  if (control === "space") return { ...current, spaceId: value };
  if (control === "repository") {
    const owner = bootstrap?.spaces.find((space) =>
      space.repositories.some((repository) => repository.id === value),
    );
    return {
      ...current,
      repositoryId: value,
      ...(owner === undefined ? {} : { spaceId: owner.id }),
    };
  }
  if (control === "project") {
    const project = projects.find((candidate) => candidate.id === value);
    return {
      ...current,
      projectId: value,
      ...(project?.repositoryId === undefined ? {} : { repositoryId: project.repositoryId }),
      ...(project?.spaceId === undefined ? {} : { spaceId: project.spaceId }),
    };
  }
  if (control === "provider") {
    const provider = providers.find((candidate) => candidate.instanceId === value);
    const keepModel =
      current.modelId === undefined ||
      provider === undefined ||
      provider.models.some((model) => model.slug === current.modelId);
    return {
      ...current,
      providerId: value,
      ...(keepModel ? {} : { modelId: undefined }),
    };
  }
  return { ...current, modelId: value };
}

export function projectBootstrap(
  bootstrap: CommandCenterBootstrap,
  now = new Date(),
): CommandCenterShellProjection {
  const spaces = bootstrap.spaces.map(
    (space): CommandCenterSpace => ({
      id: space.id,
      name: space.displayName,
      kind: space.kind,
      description: space.instructions || undefined,
      unreadCount: bootstrap.needsYou.filter((item) => item.spaceId === space.id).length,
    }),
  );

  const conversations = [...bootstrap.runs]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 12)
    .map(
      (run): CommandCenterConversation => ({
        id: run.id,
        spaceId: run.spaceId,
        projectId: run.projectId,
        threadId: run.threadId,
        title: `${titleCase(run.kind)} run`,
        preview:
          run.modelId === undefined
            ? titleCase(run.status)
            : `${run.modelId} · ${titleCase(run.status)}`,
        updatedAtLabel: formatTime(run.createdAt, now),
        status: conversationStatus(run.status),
      }),
    );

  const todayKey = localDateKey(now);
  const today = bootstrap.items.flatMap((item) => {
    if (item.dueAt === undefined || item.status === "done" || item.status === "canceled") {
      return [];
    }
    const dueAt = new Date(item.dueAt);
    if (Number.isNaN(dueAt.getTime()) || localDateKey(dueAt) !== todayKey) return [];
    return [
      {
        id: item.id,
        spaceId: item.spaceId,
        kind: "task" as const,
        title: item.title,
        timeLabel: dueAt.toLocaleTimeString(undefined, {
          hour: "numeric",
          minute: "2-digit",
        }),
      },
    ];
  });

  const activeRuns = bootstrap.runs
    .filter((run) => ACTIVE_RUN_STATUSES.has(run.status))
    .map((run) => ({
      id: run.id,
      projectId: run.projectId,
      threadId: run.threadId,
      title: `${titleCase(run.kind)} run`,
      spaceName: spaceName(bootstrap, run.spaceId),
      status:
        run.status === "waiting" || run.status === "waiting_approval"
          ? ("waiting" as const)
          : run.status === "failed"
            ? ("failed" as const)
            : run.status === "queued"
              ? ("queued" as const)
              : ("running" as const),
      detail: run.modelId ?? titleCase(run.status),
    }));

  return {
    spaces,
    conversations,
    context: {
      needsYou: bootstrap.needsYou.map((item) => {
        const approval = bootstrap.approvals.find(
          (candidate) =>
            candidate.status === "requested" && candidate.runId === item.provenance.sourceRef,
        );
        const candidateMemoryId = metadataString(item, "memoryId");
        const memory = bootstrap.memories.find(
          (candidate) => candidate.status === "candidate" && candidate.id === candidateMemoryId,
        );
        return {
          id: item.id,
          spaceId: item.spaceId,
          title: item.title,
          spaceName: spaceName(bootstrap, item.spaceId),
          reason: needsYouReason(item),
          detail: item.description,
          ...(approval === undefined
            ? memory === undefined
              ? {}
              : {
                  action: {
                    kind: "memory" as const,
                    memoryId: memory.id,
                    spaceId: memory.spaceId,
                    repositoryId: memory.repositoryId,
                    content: memory.content,
                    confidence: memory.confidence,
                  },
                }
            : {
                action: {
                  kind: "approval" as const,
                  approvalId: approval.id,
                  proposal: approval.proposal,
                  payloadDigest: approval.payloadDigest,
                  expiresAt: approval.expiresAt,
                },
              }),
        };
      }),
      activeRuns,
      today,
      connections: bootstrap.connections.map((connection) => ({
        id: connection.id,
        name: connection.label,
        status:
          connection.health === "connected"
            ? ("healthy" as const)
            : connection.health === "degraded"
              ? ("degraded" as const)
              : ("offline" as const),
        detail: connection.capabilities.includes("cc.connections.google.read")
          ? "Read-only"
          : titleCase(connection.health),
      })),
    },
  };
}

export function initialRouteReceipt(
  bootstrap: CommandCenterBootstrap | null,
  selection: CommandCenterRouteSelection = {},
  display: CommandCenterRouteDisplayContext = { projects: [], options: EMPTY_ROUTE_OPTIONS },
): CommandCenterRouteReceipt {
  const selectedSpace = bootstrap?.spaces.find((space) => space.id === selection.spaceId);
  const selectedRepository = bootstrap?.spaces
    .flatMap((space) => space.repositories)
    .find((repository) => repository.id === selection.repositoryId);
  const selectedProject = display.projects.find((project) => project.id === selection.projectId);
  const selectedProvider = display.options.providers.find(
    (provider) => provider.id === selection.providerId,
  );
  const selectedModel = display.options.models.find((model) => model.id === selection.modelId);
  const sources = {
    space: selection.spaceId === undefined ? ("auto" as const) : ("explicit" as const),
    repository: selection.repositoryId === undefined ? ("auto" as const) : ("explicit" as const),
    project: selection.projectId === undefined ? ("auto" as const) : ("explicit" as const),
    provider: selection.providerId === undefined ? ("auto" as const) : ("explicit" as const),
    model: selection.modelId === undefined ? ("auto" as const) : ("explicit" as const),
  };
  const common = {
    spaceName: selectedSpace?.displayName ?? "Auto",
    repositoryName: selectedRepository?.displayName ?? "Auto",
    projectName: selectedProject?.name ?? "Auto",
    providerName: selectedProvider?.label ?? selection.providerId ?? "Auto",
    modelName: selectedModel?.label ?? selection.modelId ?? "Auto",
    capabilities: [],
    sources,
  };
  if (bootstrap?.configHealth.status === "missing") {
    return {
      ...common,
      risk: "blocked",
      status: "blocked",
      summary: "Private configuration has not been connected to this environment.",
    };
  }
  if (bootstrap?.configHealth.status === "invalid") {
    return {
      ...common,
      risk: "blocked",
      status: "blocked",
      summary: "Private configuration needs attention before commands can be routed.",
    };
  }
  return {
    ...common,
    risk: "low",
    status: "ready",
    summary:
      Object.keys(commandRouteOverrides(selection)).length > 0
        ? "Explicit selections take precedence; remaining route fields will be resolved automatically."
        : "Command Center will infer the route and use the first healthy compatible provider.",
  };
}

export function routeReceiptFromResult(
  result: CommandCenterCommandSubmitResult,
  bootstrap: CommandCenterBootstrap | null,
  display: CommandCenterRouteDisplayContext = { projects: [], options: EMPTY_ROUTE_OPTIONS },
): CommandCenterRouteReceipt {
  return routeReceiptFromRoute(result.route, result.run.status, bootstrap, display);
}

/**
 * Yield through two animation frames so React can commit and the browser can
 * paint the durable route receipt before the client acknowledges execution.
 */
export function waitForRouteReceiptPaint(
  scheduleFrame: (callback: () => void) => unknown = (callback) =>
    globalThis.requestAnimationFrame(() => callback()),
): Promise<void> {
  return new Promise((resolve) => {
    scheduleFrame(() => scheduleFrame(resolve));
  });
}

function routeStatusFromRunStatus(runStatus: RunStatus): CommandCenterRouteReceipt["status"] {
  switch (runStatus) {
    case "succeeded":
      return "complete";
    case "failed":
    case "canceled":
      return "failed";
    case "waiting":
    case "waiting_approval":
      return "waiting-approval";
    case "queued":
    case "running":
      return "running";
  }
  runStatus satisfies never;
  throw new Error("Unsupported run status");
}

export function routeReceiptFromRoute(
  route: RouteDecision,
  runStatus: RunStatus,
  bootstrap: CommandCenterBootstrap | null,
  display: CommandCenterRouteDisplayContext,
): CommandCenterRouteReceipt {
  const routedSpace = bootstrap?.spaces.find((space) => space.id === route.spaceId);
  const routedRepository = bootstrap?.spaces
    .flatMap((space) => space.repositories)
    .find((repository) => repository.id === route.repositoryId);
  const routedProject = display.projects.find((project) => project.id === route.projectId);
  const routedProvider = display.options.providers.find(
    (provider) => provider.id === route.providerId,
  );
  const routedModel = display.options.models.find((model) => model.id === route.modelId);
  const status: CommandCenterRouteReceipt["status"] =
    route.status === "blocked" ? "blocked" : routeStatusFromRunStatus(runStatus);
  const reasonSummary =
    route.reasons.length > 0
      ? route.reasons.join(" ")
      : "The command was routed using the active policy.";

  return {
    spaceName: routedSpace?.displayName ?? route.spaceId ?? "Unresolved",
    repositoryName: routedRepository?.displayName ?? route.repositoryId ?? undefined,
    projectName: routedProject?.name ?? route.projectId ?? undefined,
    providerName: routedProvider?.label ?? route.providerId ?? "Unavailable",
    modelName: routedModel?.label ?? route.modelId ?? "Unavailable",
    capabilities: route.capabilities,
    sources: route.sources,
    risk: route.risk,
    status,
    summary: reasonSummary,
  };
}

export function routeReceiptFromTimelineEntry(
  entry: CommandCenterTimelineEntry,
  bootstrap: CommandCenterBootstrap | null,
  display: CommandCenterRouteDisplayContext = { projects: [], options: EMPTY_ROUTE_OPTIONS },
): CommandCenterRouteReceipt {
  return routeReceiptFromRoute(entry.route, entry.status, bootstrap, display);
}

function timelineTimeLabel(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return "Unknown time";
  return timestamp.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function timelineMessages(
  entries: ReadonlyArray<CommandCenterTimelineEntry>,
  bootstrap: CommandCenterBootstrap | null,
  display: CommandCenterRouteDisplayContext = { projects: [], options: EMPTY_ROUTE_OPTIONS },
): readonly CommandCenterMessage[] {
  return entries.flatMap((entry) => {
    const createdAtLabel = timelineTimeLabel(entry.startedAt);
    const receipt = routeReceiptFromTimelineEntry(entry, bootstrap, display);
    const messages: CommandCenterMessage[] = [
      {
        id: `${entry.commandId}:user`,
        author: "user" as const,
        body: entry.text,
        createdAtLabel,
      },
      routeTimelineMessage(
        {
          run: {
            id: entry.runId,
            ...(entry.threadId === null ? {} : { threadId: entry.threadId }),
          },
          route: entry.route,
        },
        receipt,
        createdAtLabel,
      ),
    ];
    if (entry.response !== null) {
      messages.push({
        id: `${entry.runId}:response`,
        author: entry.response.kind === "assistant" ? "assistant" : "system",
        authorLabel: entry.response.kind === "assistant" ? "Command Center" : "Run failed",
        body: entry.response.text,
        createdAtLabel: timelineTimeLabel(entry.response.createdAt),
        linkedRunId: entry.runId,
        ...(entry.threadId === null ? {} : { linkedThreadId: entry.threadId }),
      });
    }
    if (entry.artifacts.length > 0) {
      messages.push({
        id: `${entry.runId}:artifacts`,
        author: "system",
        authorLabel: entry.artifacts.length === 1 ? "Artifact" : "Artifacts",
        body: entry.artifacts.map((artifact) => artifact.name).join(" · "),
        createdAtLabel: timelineTimeLabel(entry.artifacts.at(-1)!.createdAt),
        linkedRunId: entry.runId,
        ...(entry.threadId === null ? {} : { linkedThreadId: entry.threadId }),
      });
    }
    return messages;
  });
}

export function mergeAuthoritativeMessages(
  authoritative: ReadonlyArray<CommandCenterMessage>,
  optimistic: ReadonlyArray<CommandCenterMessage>,
): readonly CommandCenterMessage[] {
  const authoritativeIds = new Set(authoritative.map((message) => message.id));
  return [...authoritative, ...optimistic.filter((message) => !authoritativeIds.has(message.id))];
}

export function routeTimelineMessage(
  result: Pick<CommandCenterCommandSubmitResult, "route"> & {
    readonly run: Pick<CommandCenterCommandSubmitResult["run"], "id" | "threadId">;
  },
  receipt: CommandCenterRouteReceipt,
  createdAtLabel: string,
): CommandCenterMessage {
  const routeState =
    receipt.status === "blocked"
      ? "The route was blocked."
      : receipt.status === "waiting-approval"
        ? "The route is waiting for approval."
        : receipt.status === "complete"
          ? "The run completed."
          : receipt.status === "failed"
            ? "The run failed."
            : "The route is active.";
  const linkedContext = [receipt.repositoryName, receipt.projectName]
    .filter((value): value is string => value !== undefined)
    .join(" · ");
  const capabilitySummary =
    receipt.capabilities.length > 0
      ? `Capabilities: ${receipt.capabilities.join(", ")}.`
      : "No external capabilities were selected.";
  return {
    id: `${result.run.id}:route`,
    author: "system",
    authorLabel: "Route receipt",
    body: `${routeState} ${receipt.spaceName}${linkedContext ? ` · ${linkedContext}` : ""} · ${receipt.providerName} · ${receipt.modelName}. ${receipt.summary} ${capabilitySummary}`,
    createdAtLabel,
    linkedRunId: result.run.id,
    receipt,
    ...(result.run.threadId === undefined ? {} : { linkedThreadId: result.run.threadId }),
  };
}
