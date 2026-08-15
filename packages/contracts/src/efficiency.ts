import { EfficiencyCandidateId, EfficiencyTier, RouteSelectionSource } from "@command-center/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ProviderOptionSelections } from "./model.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export { EfficiencyCandidateId, EfficiencyTier } from "@command-center/core";

export const ThreadRoutingMode = Schema.Literals(["manual", "auto"]);
export type ThreadRoutingMode = typeof ThreadRoutingMode.Type;

export const EfficiencyWorkload = Schema.Literals(["interactive", "automation"]);
export type EfficiencyWorkload = typeof EfficiencyWorkload.Type;

export const EfficiencyTierCandidate = Schema.Struct({
  candidateId: EfficiencyCandidateId,
  tier: EfficiencyTier,
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optional(ProviderOptionSelections),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type EfficiencyTierCandidate = typeof EfficiencyTierCandidate.Type;

export const EfficiencyRule = Schema.Struct({
  id: TrimmedNonEmptyString,
  tier: EfficiencyTier,
  workload: Schema.optional(EfficiencyWorkload),
  projectId: Schema.optional(ProjectId),
  spaceId: Schema.optional(TrimmedNonEmptyString),
  interactionMode: Schema.optional(Schema.Literals(["default", "plan"])),
  automation: Schema.optional(Schema.Boolean),
  minAttachmentCount: Schema.optional(NonNegativeInt),
});
export type EfficiencyRule = typeof EfficiencyRule.Type;

export const EfficiencyThresholds = Schema.Struct({
  economy: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(65))),
  balanced: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(80))),
  quality: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(90))),
});
export type EfficiencyThresholds = typeof EfficiencyThresholds.Type;

export const EfficiencyToolWarnings = Schema.Struct({
  economy: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(6))),
  balanced: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(12))),
  quality: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(24))),
});
export type EfficiencyToolWarnings = typeof EfficiencyToolWarnings.Type;

export const EfficiencyExperiment = Schema.Struct({
  id: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  controlTier: EfficiencyTier,
  challengerTier: EfficiencyTier,
}).check(
  Schema.makeFilter((experiment) => {
    const rank = { economy: 0, balanced: 1, quality: 2 } as const;
    return (
      Math.abs(rank[experiment.controlTier] - rank[experiment.challengerTier]) === 1 ||
      "Efficiency experiments must compare neighboring tiers"
    );
  }),
);
export type EfficiencyExperiment = typeof EfficiencyExperiment.Type;

export const EfficiencySettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  defaultTier: EfficiencyTier.pipe(Schema.withDecodingDefault(Effect.succeed("economy"))),
  candidates: Schema.Array(EfficiencyTierCandidate).pipe(
    Schema.withDecodingDefault(
      Effect.succeed([
        {
          candidateId: EfficiencyCandidateId.make("codex-economy-terra"),
          tier: "economy" as const,
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-terra",
          options: [{ id: "reasoningEffort", value: "low" }],
          enabled: true,
        },
        {
          candidateId: EfficiencyCandidateId.make("codex-balanced-terra"),
          tier: "balanced" as const,
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-terra",
          options: [{ id: "reasoningEffort", value: "medium" }],
          enabled: true,
        },
        {
          candidateId: EfficiencyCandidateId.make("codex-quality-sol"),
          tier: "quality" as const,
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "high" }],
          enabled: true,
        },
      ]),
    ),
  ),
  rules: Schema.Array(EfficiencyRule).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  contextThresholds: EfficiencyThresholds.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  toolWarnings: EfficiencyToolWarnings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  experiments: Schema.Array(EfficiencyExperiment).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type EfficiencySettings = typeof EfficiencySettings.Type;

export const EfficiencyModelSelection = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
});

export const EfficiencyDecision = Schema.Struct({
  tier: EfficiencyTier,
  candidateId: Schema.optional(EfficiencyCandidateId),
  modelSelection: EfficiencyModelSelection,
  matchedRuleId: Schema.optional(TrimmedNonEmptyString),
  source: RouteSelectionSource,
  workload: EfficiencyWorkload,
  contextThresholdPercent: PositiveInt,
  toolWarningThreshold: PositiveInt,
  fallbackReason: Schema.optional(TrimmedNonEmptyString),
  retryOfTurnId: Schema.optional(TurnId),
  experimentArm: Schema.optional(Schema.Literals(["control", "challenger"])),
});
export type EfficiencyDecision = typeof EfficiencyDecision.Type;

export const EfficiencyPreviewInput = Schema.Struct({
  threadId: Schema.optional(TrimmedNonEmptyString),
  projectId: Schema.optional(ProjectId),
  modelSelection: EfficiencyModelSelection,
  tier: Schema.optional(EfficiencyTier),
  interactionMode: Schema.Literals(["default", "plan"]),
  attachmentCount: NonNegativeInt,
});
export type EfficiencyPreviewInput = typeof EfficiencyPreviewInput.Type;

export const EfficiencyPreviewResult = Schema.Struct({
  modelSelection: EfficiencyModelSelection,
  decision: Schema.NullOr(EfficiencyDecision),
});
export type EfficiencyPreviewResult = typeof EfficiencyPreviewResult.Type;

export const InternalGenerationUsage = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  operation: Schema.Literals(["title", "branch", "commit", "pull-request", "schedule"]),
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optional(ProviderOptionSelections),
  durationMs: NonNegativeInt,
  inputTokens: Schema.NullOr(NonNegativeInt),
  outputTokens: Schema.NullOr(NonNegativeInt),
  costMicroUsd: Schema.NullOr(NonNegativeInt),
  status: Schema.Literals(["success", "error"]),
  completedAt: TrimmedNonEmptyString,
});
export type InternalGenerationUsage = typeof InternalGenerationUsage.Type;
