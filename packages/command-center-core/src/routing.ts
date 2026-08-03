import * as Schema from "effect/Schema";

import {
  ActionKind,
  type CapabilityName,
  CapabilityName as CapabilityNameSchema,
  CommandId,
  CommandSubmission,
  EfficiencyCandidateId,
  IntentKind,
  ModelId,
  ProjectId,
  ProviderId,
  RepositoryId,
  RiskLevel,
  SpaceId,
  type Space as SpaceType,
} from "./domain.ts";
import { classifyActionRisk } from "./risk.ts";

export const RouteSelectionSource = Schema.Literals([
  "explicit",
  "policy",
  "tier-policy",
  "classifier",
  "fallback",
  "provider-default",
  "unresolved",
]);
export type RouteSelectionSource = typeof RouteSelectionSource.Type;

export const RouteSelection = Schema.Struct({
  spaceId: Schema.optional(SpaceId),
  repositoryId: Schema.optional(RepositoryId),
  projectId: Schema.optional(ProjectId),
  providerId: Schema.optional(ProviderId),
  modelId: Schema.optional(ModelId),
});
export type RouteSelection = typeof RouteSelection.Type;

export const ProviderModelCandidate = Schema.Struct({
  candidateId: EfficiencyCandidateId,
  providerId: ProviderId,
  modelId: ModelId,
});
export type ProviderModelCandidate = typeof ProviderModelCandidate.Type;

export const ClassifiedRoute = Schema.Struct({
  intent: IntentKind,
  actionKind: ActionKind,
  capabilities: Schema.Array(CapabilityNameSchema),
  spaceId: Schema.optional(SpaceId),
  repositoryId: Schema.optional(RepositoryId),
  projectId: Schema.optional(ProjectId),
  providerId: Schema.optional(ProviderId),
  modelId: Schema.optional(ModelId),
});
export type ClassifiedRoute = typeof ClassifiedRoute.Type;

export const ProviderAvailability = Schema.Struct({
  providerId: ProviderId,
  healthy: Schema.Boolean,
  priority: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  modelIds: Schema.Array(ModelId),
  defaultModelId: ModelId,
  capabilities: Schema.Array(CapabilityNameSchema),
});
export type ProviderAvailability = typeof ProviderAvailability.Type;

export const RouteResolutionInput = Schema.Struct({
  command: CommandSubmission,
  policy: Schema.optional(RouteSelection),
  classifier: ClassifiedRoute,
  tierCandidates: Schema.optional(Schema.Array(ProviderModelCandidate)),
  providers: Schema.Array(ProviderAvailability),
});
export type RouteResolutionInput = typeof RouteResolutionInput.Type;

export const RouteStatus = Schema.Literals(["ready", "approval-required", "blocked"]);
export type RouteStatus = typeof RouteStatus.Type;

export const RouteDecision = Schema.Struct({
  commandId: CommandId,
  status: RouteStatus,
  intent: IntentKind,
  spaceId: Schema.NullOr(SpaceId),
  repositoryId: Schema.NullOr(RepositoryId),
  projectId: Schema.NullOr(ProjectId),
  providerId: Schema.NullOr(ProviderId),
  modelId: Schema.NullOr(ModelId),
  capabilities: Schema.Array(CapabilityNameSchema),
  actionKind: ActionKind,
  risk: RiskLevel,
  approvalRequired: Schema.Boolean,
  sources: Schema.Struct({
    space: RouteSelectionSource,
    repository: RouteSelectionSource,
    project: RouteSelectionSource,
    provider: RouteSelectionSource,
    model: RouteSelectionSource,
  }),
  reasons: Schema.Array(Schema.String),
});
export type RouteDecision = typeof RouteDecision.Type;

export const SpaceAliasMatchKind = Schema.Literals([
  "id",
  "slug",
  "display-name",
  "alias",
  "repository-id",
  "repository-display-name",
  "repository-alias",
]);
export type SpaceAliasMatchKind = typeof SpaceAliasMatchKind.Type;

export const SpaceAliasResolution = Schema.Union([
  Schema.TaggedStruct("Resolved", {
    normalizedQuery: Schema.String,
    spaceId: SpaceId,
    matchedBy: SpaceAliasMatchKind,
    matchedValue: Schema.String,
  }),
  Schema.TaggedStruct("Ambiguous", {
    normalizedQuery: Schema.String,
    candidateSpaceIds: Schema.Array(SpaceId),
  }),
  Schema.TaggedStruct("NotFound", {
    normalizedQuery: Schema.String,
  }),
]);
export type SpaceAliasResolution = typeof SpaceAliasResolution.Type;

const MATCH_RANK: Readonly<Record<SpaceAliasMatchKind, number>> = {
  id: 0,
  slug: 1,
  "display-name": 2,
  alias: 3,
  "repository-id": 4,
  "repository-display-name": 5,
  "repository-alias": 6,
};

export function normalizeSpaceAlias(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\.git$/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

interface AliasMatch {
  readonly spaceId: SpaceType["id"];
  readonly matchedBy: SpaceAliasMatchKind;
  readonly matchedValue: string;
}

function aliasesForSpace(space: SpaceType): ReadonlyArray<Omit<AliasMatch, "spaceId">> {
  const values: Array<Omit<AliasMatch, "spaceId">> = [
    { matchedBy: "id", matchedValue: space.id },
    { matchedBy: "slug", matchedValue: space.slug },
    { matchedBy: "display-name", matchedValue: space.displayName },
    ...space.aliases.map((matchedValue) => ({ matchedBy: "alias" as const, matchedValue })),
  ];
  for (const repository of space.repositories) {
    values.push(
      { matchedBy: "repository-id", matchedValue: repository.id },
      { matchedBy: "repository-display-name", matchedValue: repository.displayName },
      ...repository.aliases.map((matchedValue) => ({
        matchedBy: "repository-alias" as const,
        matchedValue,
      })),
    );
  }
  return values;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function resolveSpaceAlias(
  query: string,
  spaces: ReadonlyArray<SpaceType>,
): SpaceAliasResolution {
  const normalizedQuery = normalizeSpaceAlias(query);
  if (normalizedQuery.length === 0) return { _tag: "NotFound", normalizedQuery };

  const matchesBySpace = new Map<string, AliasMatch>();
  for (const space of spaces) {
    for (const candidate of aliasesForSpace(space)) {
      if (normalizeSpaceAlias(candidate.matchedValue) !== normalizedQuery) continue;
      const current = matchesBySpace.get(space.id);
      if (
        current === undefined ||
        MATCH_RANK[candidate.matchedBy] < MATCH_RANK[current.matchedBy]
      ) {
        matchesBySpace.set(space.id, { spaceId: space.id, ...candidate });
      }
    }
  }

  const matches = [...matchesBySpace.values()].sort((left, right) =>
    compareText(left.spaceId, right.spaceId),
  );
  if (matches.length === 0) return { _tag: "NotFound", normalizedQuery };
  if (matches.length > 1) {
    return {
      _tag: "Ambiguous",
      normalizedQuery,
      candidateSpaceIds: matches.map((match) => match.spaceId),
    };
  }
  const match = matches[0];
  if (match === undefined) return { _tag: "NotFound", normalizedQuery };
  return {
    _tag: "Resolved",
    normalizedQuery,
    spaceId: match.spaceId,
    matchedBy: match.matchedBy,
    matchedValue: match.matchedValue,
  };
}

function uniqueCapabilities(capabilities: ReadonlyArray<CapabilityName>): Array<CapabilityName> {
  return [...new Set(capabilities)].sort(compareText);
}

function providerSupports(
  provider: ProviderAvailability,
  capabilities: ReadonlyArray<CapabilityName>,
  modelId: ModelId | undefined,
): boolean {
  if (!provider.healthy) return false;
  if (!capabilities.every((capability) => provider.capabilities.includes(capability))) return false;
  return modelId === undefined || provider.modelIds.includes(modelId);
}

function compareProviders(left: ProviderAvailability, right: ProviderAvailability): number {
  return left.priority - right.priority || compareText(left.providerId, right.providerId);
}

interface SelectedProvider {
  readonly provider: ProviderAvailability;
  readonly providerSource: RouteSelectionSource;
  readonly modelId: ModelId;
  readonly modelSource: RouteSelectionSource;
  readonly candidateId?: EfficiencyCandidateId;
}

function selectPreferredProvider(
  selection: RouteSelection | undefined,
  source: "policy" | "classifier" | "fallback",
  providers: ReadonlyArray<ProviderAvailability>,
  capabilities: ReadonlyArray<CapabilityName>,
  explicitModelId: ModelId | undefined,
): SelectedProvider | undefined {
  if (selection?.providerId !== undefined) {
    const provider = providers.find((candidate) => candidate.providerId === selection.providerId);
    const modelId = explicitModelId ?? selection.modelId ?? provider?.defaultModelId;
    if (provider === undefined || modelId === undefined) return undefined;
    if (!providerSupports(provider, capabilities, modelId)) return undefined;
    return {
      provider,
      providerSource: source,
      modelId,
      modelSource:
        explicitModelId !== undefined
          ? "explicit"
          : selection.modelId !== undefined
            ? source
            : "provider-default",
    };
  }

  if (selection?.modelId !== undefined) {
    const requestedModelId = explicitModelId ?? selection.modelId;
    const provider = providers.find((candidate) =>
      providerSupports(candidate, capabilities, requestedModelId),
    );
    if (provider === undefined) return undefined;
    return {
      provider,
      providerSource: source,
      modelId: requestedModelId,
      modelSource: explicitModelId !== undefined ? "explicit" : source,
    };
  }
  return undefined;
}

function selectTierCandidate(
  candidates: ReadonlyArray<ProviderModelCandidate>,
  providers: ReadonlyArray<ProviderAvailability>,
  capabilities: ReadonlyArray<CapabilityName>,
  explicitModelId: ModelId | undefined,
): SelectedProvider | undefined {
  for (const candidate of candidates) {
    const provider = providers.find((entry) => entry.providerId === candidate.providerId);
    const modelId = explicitModelId ?? candidate.modelId;
    if (provider === undefined || !providerSupports(provider, capabilities, modelId)) continue;
    return {
      provider,
      providerSource: "tier-policy",
      modelId,
      modelSource: explicitModelId === undefined ? "tier-policy" : "explicit",
      candidateId: candidate.candidateId,
    };
  }
  return undefined;
}

function blockedExplicitProvider(
  input: {
    readonly providerId?: ProviderId;
    readonly modelId?: ModelId;
    readonly providers: ReadonlyArray<ProviderAvailability>;
  },
  capabilities: ReadonlyArray<CapabilityName>,
): { readonly selected: SelectedProvider | undefined; readonly reasons: Array<string> } {
  const explicitProviderId = input.providerId;
  if (explicitProviderId === undefined) return { selected: undefined, reasons: [] };
  const provider = input.providers.find((candidate) => candidate.providerId === explicitProviderId);
  if (provider === undefined)
    return { selected: undefined, reasons: ["Explicit provider is unavailable"] };
  const modelId = input.modelId ?? provider.defaultModelId;
  const reasons: Array<string> = [];
  if (!provider.healthy) reasons.push("Explicit provider is unhealthy");
  if (!capabilities.every((capability) => provider.capabilities.includes(capability))) {
    reasons.push("Explicit provider lacks a required capability");
  }
  if (!provider.modelIds.includes(modelId))
    reasons.push("Explicit model is unavailable on the provider");
  return {
    selected: {
      provider,
      providerSource: "explicit",
      modelId,
      modelSource: input.modelId === undefined ? "provider-default" : "explicit",
    },
    reasons,
  };
}

export interface ProviderModelSelectionInput {
  readonly explicit?: RouteSelection;
  readonly policy?: RouteSelection;
  readonly tierCandidates?: ReadonlyArray<ProviderModelCandidate>;
  readonly classifier?: RouteSelection;
  readonly fallback?: RouteSelection;
  readonly providers: ReadonlyArray<ProviderAvailability>;
  readonly capabilities?: ReadonlyArray<CapabilityName>;
}

export interface ProviderModelSelectionDecision {
  readonly providerId: ProviderId | null;
  readonly modelId: ModelId | null;
  readonly providerSource: RouteSelectionSource;
  readonly modelSource: RouteSelectionSource;
  readonly candidateId?: EfficiencyCandidateId;
  readonly reasons: ReadonlyArray<string>;
}

export function resolveProviderModelSelection(
  input: ProviderModelSelectionInput,
): ProviderModelSelectionDecision {
  const capabilities = uniqueCapabilities(input.capabilities ?? []);
  const sortedProviders = [...input.providers].sort(compareProviders);
  const reasons: Array<string> = [];
  let selectedProvider: SelectedProvider | undefined;
  if (input.explicit?.providerId !== undefined) {
    const explicit = blockedExplicitProvider(
      {
        providerId: input.explicit.providerId,
        ...(input.explicit.modelId === undefined ? {} : { modelId: input.explicit.modelId }),
        providers: input.providers,
      },
      capabilities,
    );
    selectedProvider = explicit.selected;
    reasons.push(...explicit.reasons);
  } else {
    selectedProvider = selectPreferredProvider(
      input.policy,
      "policy",
      sortedProviders,
      capabilities,
      input.explicit?.modelId,
    );
    selectedProvider ??= selectTierCandidate(
      input.tierCandidates ?? [],
      sortedProviders,
      capabilities,
      input.explicit?.modelId,
    );
    selectedProvider ??= selectPreferredProvider(
      input.classifier,
      "classifier",
      sortedProviders,
      capabilities,
      input.explicit?.modelId,
    );
    selectedProvider ??= selectPreferredProvider(
      input.fallback,
      "fallback",
      sortedProviders,
      capabilities,
      input.explicit?.modelId,
    );
    if (selectedProvider === undefined) {
      const fallback = sortedProviders.find((provider) =>
        providerSupports(provider, capabilities, input.explicit?.modelId),
      );
      if (fallback !== undefined) {
        selectedProvider = {
          provider: fallback,
          providerSource: "fallback",
          modelId: input.explicit?.modelId ?? fallback.defaultModelId,
          modelSource: input.explicit?.modelId === undefined ? "provider-default" : "explicit",
        };
      }
    }
  }

  if (selectedProvider === undefined && reasons.length === 0) {
    reasons.push("No healthy compatible provider is available");
  }
  return {
    providerId: selectedProvider?.provider.providerId ?? input.explicit?.providerId ?? null,
    modelId: selectedProvider?.modelId ?? input.explicit?.modelId ?? null,
    providerSource:
      selectedProvider?.providerSource ??
      (input.explicit?.providerId === undefined ? "unresolved" : "explicit"),
    modelSource:
      selectedProvider?.modelSource ??
      (input.explicit?.modelId === undefined ? "unresolved" : "explicit"),
    ...(selectedProvider?.candidateId === undefined
      ? {}
      : { candidateId: selectedProvider.candidateId }),
    reasons,
  };
}

function firstSelection<T>(
  explicit: T | undefined,
  policy: T | undefined,
  classifier: T | undefined,
): { readonly value: T | null; readonly source: RouteSelectionSource } {
  if (explicit !== undefined) return { value: explicit, source: "explicit" };
  if (policy !== undefined) return { value: policy, source: "policy" };
  if (classifier !== undefined) return { value: classifier, source: "classifier" };
  return { value: null, source: "unresolved" };
}

export function resolveRoute(input: RouteResolutionInput): RouteDecision {
  const capabilities = uniqueCapabilities(input.classifier.capabilities);
  const space = firstSelection(
    input.command.spaceId,
    input.policy?.spaceId,
    input.classifier.spaceId,
  );
  const repository = firstSelection(
    input.command.repositoryId,
    input.policy?.repositoryId,
    input.classifier.repositoryId,
  );
  const project = firstSelection(
    input.command.projectId,
    input.policy?.projectId,
    input.classifier.projectId,
  );
  const risk = classifyActionRisk(input.classifier.actionKind);
  const reasons: Array<string> = [];

  const selectedProvider = resolveProviderModelSelection({
    explicit: {
      ...(input.command.providerId === undefined ? {} : { providerId: input.command.providerId }),
      ...(input.command.modelId === undefined ? {} : { modelId: input.command.modelId }),
    },
    ...(input.policy === undefined ? {} : { policy: input.policy }),
    ...(input.tierCandidates === undefined ? {} : { tierCandidates: input.tierCandidates }),
    classifier: input.classifier,
    providers: input.providers,
    capabilities,
  });
  reasons.push(...selectedProvider.reasons);
  if (risk.level === "blocked") reasons.push("The requested action is blocked by policy");

  const status: RouteStatus =
    reasons.length > 0 ? "blocked" : risk.approvalRequired ? "approval-required" : "ready";

  return {
    commandId: input.command.commandId,
    status,
    intent: input.classifier.intent,
    spaceId: space.value,
    repositoryId: repository.value,
    projectId: project.value,
    providerId: selectedProvider.providerId,
    modelId: selectedProvider.modelId,
    capabilities,
    actionKind: input.classifier.actionKind,
    risk: risk.level,
    approvalRequired: risk.approvalRequired,
    sources: {
      space: space.source,
      repository: repository.source,
      project: project.source,
      provider: selectedProvider.providerSource,
      model: selectedProvider.modelSource,
    },
    reasons,
  };
}
