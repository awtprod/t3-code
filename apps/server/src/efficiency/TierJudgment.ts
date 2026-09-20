/**
 * Confidence-gated tier judgment: builds the {@link Judge} request for one
 * auto-routed turn and maps its answers to the pure router input. Shared by the
 * command dispatcher and the settings-page preview so there is one definition of
 * the state, the questions, and the answer mapping.
 *
 * @module TierJudgment
 */
import type { JudgeAnswer, JudgeRequest } from "./Judge.ts";
import type { TierJudgmentInput } from "./EfficiencyRouting.ts";

export const TIER_JUDGMENT_OPERATION = "tier-judgment";

/** The first slice of user text the judge sees. */
export const TIER_JUDGMENT_MESSAGE_CHARS = 4000;

export interface TierJudgmentState {
  readonly message: string;
  readonly attachmentCount: number;
  readonly interactionMode: "default" | "plan";
  readonly projectId?: string;
  readonly priorTurnCount: number;
}

/**
 * The tier-judgment request. Rubric levels are the tiers in order
 * (economy, balanced, quality); `complexity` drives routing, while
 * `needs_investigation` is recorded for later calibration only.
 */
export function buildTierJudgmentRequest(state: TierJudgmentState): JudgeRequest {
  return {
    operation: TIER_JUDGMENT_OPERATION,
    state: {
      message: state.message.slice(0, TIER_JUDGMENT_MESSAGE_CHARS),
      attachmentCount: state.attachmentCount,
      interactionMode: state.interactionMode,
      ...(state.projectId === undefined ? {} : { projectId: state.projectId }),
      priorTurnCount: state.priorTurnCount,
    },
    questions: {
      complexity: {
        type: "score",
        instructions: "Rate the complexity of the task described in `message`.",
        criteria: [
          "Trivial or mechanical: a small edit, a rename, a lookup, or a question answerable from one file",
          "Contained: a feature or fix touching a few files with clear requirements",
          "Hard: debugging an unknown root cause, a cross-cutting refactor, architecture or design judgment, or ambiguous requirements",
        ],
      },
      needs_investigation: {
        type: "noul",
        instructions:
          "`message` requires exploring or debugging code whose location or cause is not stated in the message.",
      },
    },
  };
}

/** Maps validated judge answers to the router input, or `undefined` when the
 * complexity answer is absent or the wrong type. */
export function tierJudgmentFromAnswers(
  answers: Readonly<Record<string, JudgeAnswer>>,
  model: string,
): TierJudgmentInput | undefined {
  const complexity = answers.complexity;
  if (complexity === undefined || complexity.type !== "score") return undefined;
  return { score: complexity.score, confidence: complexity.confidence, model };
}
