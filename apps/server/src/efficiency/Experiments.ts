import type { EfficiencyExperiment, EfficiencyTier } from "@t3tools/contracts";

export type ExperimentArm = "control" | "challenger";

export interface ExperimentAssignment {
  readonly experimentId: string;
  readonly arm: ExperimentArm;
  readonly tier: EfficiencyTier;
}

export interface ExperimentOutcome {
  readonly arm: ExperimentArm;
  readonly tokens: number;
  readonly bad: boolean;
}

export interface ExperimentEvaluation {
  readonly controlCount: number;
  readonly challengerCount: number;
  readonly autoPause: boolean;
  readonly recommendCheaperArm: ExperimentArm | null;
}

export function stableExperimentBucket(value: string): 0 | 1 {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 2) as 0 | 1;
}

export function assignExperiment(input: {
  readonly experiment: EfficiencyExperiment;
  readonly threadId: string;
  readonly eligible: boolean;
}): ExperimentAssignment | undefined {
  if (!input.experiment.enabled || !input.eligible) return undefined;
  const arm = stableExperimentBucket(`${input.experiment.id}${input.threadId}`)
    ? "challenger"
    : "control";
  return {
    experimentId: input.experiment.id,
    arm,
    tier: arm === "control" ? input.experiment.controlTier : input.experiment.challengerTier,
  };
}

function rate(
  outcomes: ReadonlyArray<ExperimentOutcome>,
  predicate: (outcome: ExperimentOutcome) => boolean,
) {
  return outcomes.length === 0 ? 0 : outcomes.filter(predicate).length / outcomes.length;
}

function tokensPerSuccessfulOutcome(outcomes: ReadonlyArray<ExperimentOutcome>): number {
  const successes = outcomes.filter((outcome) => !outcome.bad);
  return successes.length === 0
    ? Number.POSITIVE_INFINITY
    : successes.reduce((sum, outcome) => sum + outcome.tokens, 0) / successes.length;
}

export function evaluateExperiment(
  outcomes: ReadonlyArray<ExperimentOutcome>,
): ExperimentEvaluation {
  const control = outcomes.filter((outcome) => outcome.arm === "control");
  const challenger = outcomes.filter((outcome) => outcome.arm === "challenger");
  const controlBadRate = rate(control, (outcome) => outcome.bad);
  const challengerBadRate = rate(challenger, (outcome) => outcome.bad);
  const autoPause =
    control.length >= 10 && challenger.length >= 10 && challengerBadRate - controlBadRate >= 0.1;

  let recommendCheaperArm: ExperimentArm | null = null;
  if (control.length >= 30 && challenger.length >= 30) {
    const controlTokens = tokensPerSuccessfulOutcome(control);
    const challengerTokens = tokensPerSuccessfulOutcome(challenger);
    if (challengerTokens <= controlTokens * 0.85 && challengerBadRate - controlBadRate <= 0.03) {
      recommendCheaperArm = "challenger";
    } else if (
      controlTokens <= challengerTokens * 0.85 &&
      controlBadRate - challengerBadRate <= 0.03
    ) {
      recommendCheaperArm = "control";
    }
  }
  return {
    controlCount: control.length,
    challengerCount: challenger.length,
    autoPause,
    recommendCheaperArm,
  };
}
