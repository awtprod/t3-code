import {
  ModelId,
  ProviderId,
  type EfficiencyCandidateId,
  type EfficiencyTier,
  type ProviderModelCandidate,
  resolveProviderModelSelection,
} from "@command-center/core";
import {
  type EfficiencyDecision,
  type EfficiencyRule,
  type EfficiencySettings,
  type ModelSelection,
  ProviderInstanceId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";

import { providerAvailability } from "../command-center/ProviderAvailability.ts";
import { assignExperiment } from "./Experiments.ts";

type TurnStartCommand = Extract<OrchestrationCommand, { readonly type: "thread.turn.start" }>;

export interface InteractiveEfficiencyInput {
  readonly command: TurnStartCommand;
  readonly thread?: OrchestrationThreadShell;
  readonly settings: EfficiencySettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly projectIdOverride?: string;
  readonly attachmentCountOverride?: number;
}

export interface InteractiveEfficiencyResolution {
  readonly command: TurnStartCommand;
  readonly decision?: EfficiencyDecision;
}

export function toCommandCenterSelection(selection: ModelSelection): {
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
} {
  return {
    providerId: ProviderId.make(selection.instanceId),
    modelId: ModelId.make(selection.model),
  };
}

export function fromCommandCenterSelection(selection: {
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
}): ModelSelection {
  return {
    instanceId: ProviderInstanceId.make(selection.providerId),
    model: selection.modelId,
  };
}

function matchesRule(
  rule: EfficiencyRule,
  input: {
    readonly projectId: string | undefined;
    readonly interactionMode: "default" | "plan";
    readonly attachmentCount: number;
  },
): boolean {
  if (rule.workload !== undefined && rule.workload !== "interactive") return false;
  if (rule.automation !== undefined && rule.automation) return false;
  // Interactive tasks have no Command Center Space identity. A Space-scoped
  // rule must therefore remain ineligible instead of silently becoming global.
  if (rule.spaceId !== undefined) return false;
  if (rule.projectId !== undefined && rule.projectId !== input.projectId) return false;
  if (rule.interactionMode !== undefined && rule.interactionMode !== input.interactionMode)
    return false;
  if (rule.minAttachmentCount !== undefined && input.attachmentCount < rule.minAttachmentCount)
    return false;
  return true;
}

function fallbackSelection(
  command: TurnStartCommand,
  thread: OrchestrationThreadShell | undefined,
): ModelSelection | undefined {
  return (
    command.modelSelection ??
    command.bootstrap?.createThread?.modelSelection ??
    thread?.modelSelection
  );
}

function effectiveRoutingMode(
  command: TurnStartCommand,
  thread: OrchestrationThreadShell | undefined,
): "manual" | "auto" {
  return (
    command.routingMode ??
    command.bootstrap?.createThread?.routingMode ??
    thread?.routingMode ??
    "manual"
  );
}

function selectedTier(input: InteractiveEfficiencyInput): {
  readonly tier: EfficiencyTier;
  readonly matchedRuleId?: string;
} {
  const projectId =
    input.projectIdOverride ??
    input.command.bootstrap?.createThread?.projectId ??
    input.thread?.projectId;
  const rule = input.settings.rules.find((candidate) =>
    matchesRule(candidate, {
      projectId,
      interactionMode: input.command.interactionMode,
      attachmentCount: input.attachmentCountOverride ?? input.command.message.attachments.length,
    }),
  );
  const tier =
    rule?.tier ??
    input.command.efficiencyTier ??
    input.command.bootstrap?.createThread?.efficiencyTier ??
    input.thread?.efficiencyTier ??
    input.settings.defaultTier;
  return rule === undefined ? { tier } : { tier, matchedRuleId: rule.id };
}

function candidateOverlay(
  candidates: EfficiencySettings["candidates"],
  candidateId: EfficiencyCandidateId | undefined,
): EfficiencySettings["candidates"][number] | undefined {
  return candidateId === undefined
    ? undefined
    : candidates.find((candidate) => candidate.candidateId === candidateId);
}

export function resolveInteractiveEfficiency(
  input: InteractiveEfficiencyInput,
): InteractiveEfficiencyResolution {
  const mode = effectiveRoutingMode(input.command, input.thread);
  if (mode !== "auto" || !input.settings.enabled) return { command: input.command };

  const fallback = fallbackSelection(input.command, input.thread);
  if (fallback === undefined) return { command: input.command };

  const selected = selectedTier(input);
  const experimentAssignment = input.settings.experiments
    .map((experiment) =>
      assignExperiment({
        experiment,
        threadId: input.command.threadId,
        eligible:
          input.command.bootstrap?.createThread !== undefined &&
          input.command.retryOfTurnId === undefined,
      }),
    )
    .find((assignment) => assignment !== undefined);
  const tier = experimentAssignment?.tier ?? selected.tier;
  const matchedRuleId = selected.matchedRuleId;
  const enabledCandidates = input.settings.candidates.filter(
    (candidate) => candidate.enabled && candidate.tier === tier,
  );
  const tierCandidates: ReadonlyArray<ProviderModelCandidate> = enabledCandidates.map(
    (candidate) => ({
      candidateId: candidate.candidateId,
      providerId: ProviderId.make(candidate.instanceId),
      modelId: ModelId.make(candidate.model),
    }),
  );
  const fallbackCore = toCommandCenterSelection(fallback);
  const selection = resolveProviderModelSelection({
    tierCandidates,
    fallback: fallbackCore,
    providers: providerAvailability(input.providers, "interactive-routing"),
  });
  if (selection.providerId === null || selection.modelId === null) {
    return { command: input.command };
  }

  const overlay = candidateOverlay(enabledCandidates, selection.candidateId);
  const effectiveSelection: ModelSelection = {
    ...fromCommandCenterSelection({
      providerId: selection.providerId,
      modelId: selection.modelId,
    }),
    ...(overlay?.options === undefined
      ? selection.providerSource === "fallback" && fallback.options !== undefined
        ? { options: fallback.options }
        : {}
      : { options: overlay.options }),
  };
  const fallbackReason =
    selection.providerSource === "fallback"
      ? (selection.reasons[0] ??
        (tierCandidates.length === 0
          ? `No enabled ${tier} candidate is configured`
          : `No healthy ${tier} candidate is available`))
      : undefined;
  const decision: EfficiencyDecision = {
    tier,
    ...(selection.candidateId === undefined ? {} : { candidateId: selection.candidateId }),
    modelSelection: effectiveSelection,
    ...(matchedRuleId === undefined ? {} : { matchedRuleId }),
    source: selection.providerSource,
    workload: "interactive",
    contextThresholdPercent: input.settings.contextThresholds[tier],
    toolWarningThreshold: input.settings.toolWarnings[tier],
    ...(fallbackReason === undefined ? {} : { fallbackReason }),
    ...(input.command.retryOfTurnId === undefined
      ? {}
      : { retryOfTurnId: input.command.retryOfTurnId }),
    ...(experimentAssignment === undefined ? {} : { experimentArm: experimentAssignment.arm }),
  };

  return {
    command: {
      ...input.command,
      modelSelection: effectiveSelection,
      routingMode: "auto",
      efficiencyTier: tier,
      efficiencyDecision: decision,
      ...(input.command.bootstrap?.createThread === undefined
        ? {}
        : {
            bootstrap: {
              ...input.command.bootstrap,
              createThread: {
                ...input.command.bootstrap.createThread,
                modelSelection: effectiveSelection,
                routingMode: "auto" as const,
                efficiencyTier: tier,
              },
            },
          }),
    },
    decision,
  };
}
