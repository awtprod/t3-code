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

/**
 * Judge transport. `off` is the safe default: no judge model is called and every
 * consumer falls through to today's deterministic behavior. `typesafe` speaks the
 * TypeSafe System One protocol; `openai-compatible` posts to a `/chat/completions`
 * endpoint (the host's cliproxyapi gateway by default).
 */
export const JudgeTransport = Schema.Literals(["off", "typesafe", "openai-compatible"]);
export type JudgeTransport = typeof JudgeTransport.Type;

/**
 * Judge model configuration. Additive and fully defaulted so existing settings
 * JSON decodes to a disabled judge. `model` and `apiKeyEnv` carry the TypeSafe
 * defaults; the Judge service swaps them for the gateway defaults when
 * `transport` is `openai-compatible` and the operator left them untouched (see
 * `resolveJudgeConfig` in `apps/server/src/efficiency/Judge.ts`).
 *
 * `apiKeyEnv` is the NAME of the environment variable that holds the key, never a
 * key value.
 */
export const EfficiencyJudgeSettings = Schema.Struct({
  transport: JudgeTransport.pipe(Schema.withDecodingDefault(Effect.succeed("off" as const))),
  baseUrl: Schema.optional(TrimmedNonEmptyString),
  model: TrimmedNonEmptyString.pipe(Schema.withDecodingDefault(Effect.succeed("jev-latest"))),
  apiKeyEnv: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed("TYPESAFE_API_KEY")),
  ),
  timeoutMs: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(15000))),
  maxStateChars: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(120000))),
});
export type EfficiencyJudgeSettings = typeof EfficiencyJudgeSettings.Type;

/**
 * Confidence-gated tier judgment. When `enabled`, an auto-routed turn asks the
 * judge to score task complexity; the mapped tier only overrides the static tier
 * when `confidence >= minConfidence`.
 */
export const EfficiencyTierJudgmentSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  minConfidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(0.6)),
  ),
});
export type EfficiencyTierJudgmentSettings = typeof EfficiencyTierJudgmentSettings.Type;

export const EfficiencySieveMode = Schema.Literals(["off", "shadow", "active"]);
export type EfficiencySieveMode = typeof EfficiencySieveMode.Type;

/**
 * Tool-result sieve (winnow). Additive and defaulted; `mode: "off"` keeps every
 * tool result byte-for-byte. `dropBelow < keepAbove` is enforced at the boundary
 * so the "hide" band can never overlap the "keep/error gate" band. Slice B
 * depends on this exact shape.
 */
export const EfficiencySieveSettings = Schema.Struct({
  mode: EfficiencySieveMode.pipe(Schema.withDecodingDefault(Effect.succeed("off" as const))),
  // May only narrow from the default. Bash stays opt-in (re-running has side
  // effects) and is off by default.
  tools: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(["Read", "Grep"])),
  ),
  minChars: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(1500))),
  blockLines: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(25))),
  maxBlocks: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(200))),
  // Hide a block when P(needed) < dropBelow.
  dropBelow: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(0.1)),
  ),
  // Error gate and the upper bound of the "uncertain" band.
  keepAbove: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(0.5)),
  ),
  // Skip the rewrite unless at least this fraction of chars would be hidden.
  minPruneRatio: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(0.2)),
  ),
}).check(
  Schema.makeFilter((sieve) =>
    sieve.dropBelow < sieve.keepAbove
      ? true
      : "Tool-result sieve dropBelow must be strictly less than keepAbove",
  ),
);
export type EfficiencySieveSettings = typeof EfficiencySieveSettings.Type;

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
          model: "gpt-6-terra",
          options: [{ id: "reasoningEffort", value: "low" }],
          enabled: true,
        },
        {
          candidateId: EfficiencyCandidateId.make("codex-balanced-terra"),
          tier: "balanced" as const,
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-6-terra",
          options: [{ id: "reasoningEffort", value: "medium" }],
          enabled: true,
        },
        {
          candidateId: EfficiencyCandidateId.make("codex-quality-sol"),
          tier: "quality" as const,
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-6-sol",
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
  judge: EfficiencyJudgeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  tierJudgment: EfficiencyTierJudgmentSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  sieve: EfficiencySieveSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type EfficiencySettings = typeof EfficiencySettings.Type;

export const EfficiencyModelSelection = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
});

/**
 * Confidence-gated tier judgment recorded on a decision. `applied` is true only
 * when the judgment actually overrode the static tier (no rule matched and
 * `confidence >= minConfidence`); otherwise `reason` explains why it was kept for
 * the log only. `score` is the probability-weighted rubric level (0..2).
 */
export const EfficiencyTierJudgment = Schema.Struct({
  score: Schema.Number,
  confidence: Schema.Number,
  tier: EfficiencyTier,
  applied: Schema.Boolean,
  reason: Schema.optional(TrimmedNonEmptyString),
  model: TrimmedNonEmptyString,
});
export type EfficiencyTierJudgment = typeof EfficiencyTierJudgment.Type;

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
  judgment: Schema.optional(EfficiencyTierJudgment),
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
