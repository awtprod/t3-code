/**
 * Confidence-gated tier judgment: builds the {@link Judge} request for one
 * auto-routed turn and maps its answers to the pure router input. Shared by the
 * command dispatcher and the settings-page preview so there is one definition of
 * the state, the questions, and the answer mapping.
 *
 * @module TierJudgment
 */
import type { EfficiencyDecision, TaskKind } from "@t3tools/contracts";

import type { JudgeAnswer, JudgeRequest } from "./Judge.ts";
import type { TierJudgmentInput } from "./EfficiencyRouting.ts";

const TIER_JUDGMENT_OPERATION = "tier-judgment";

/** The first slice of user text the judge sees (also applied to `taskMessage`). */
export const TIER_JUDGMENT_MESSAGE_CHARS = 4000;

/** `task_kind` options. Typed as a full record so a new {@link TaskKind} cannot
 * be added without a description the judge can classify against. */
export const TASK_KIND_CRITERIA: Readonly<Record<TaskKind, string>> = {
  review: "Review code, a diff, a pull request, or a document and report findings",
  debug: "Find and fix the cause of a bug, failure, or unexpected behavior",
  implement: "Build a feature or make a specified code change",
  refactor: "Restructure or clean up existing code without changing its behavior",
  design: "Plan an architecture, API, or approach before building it",
  question: "Answer a question or explain something without changing code",
  docs: "Write or update documentation, comments, or a README",
  ops: "Run, deploy, configure, or operate systems, CI, git, or infrastructure",
  research: "Investigate options or gather information from code or external sources",
  creative: "Produce non-code content such as copy, media, or visuals",
  other: "Anything that fits none of the other kinds",
};

const TASK_KINDS = Object.keys(TASK_KIND_CRITERIA) as ReadonlyArray<TaskKind>;

export interface TierJudgmentState {
  readonly message: string;
  readonly attachmentCount: number;
  readonly interactionMode: "default" | "plan";
  readonly projectId?: string;
  readonly priorTurnCount: number;
  readonly threadTitle?: string;
  /** The user message that started the thread's current route. */
  readonly taskMessage?: string;
}

/**
 * The tier-judgment request. Rubric levels are the tiers in order
 * (economy, balanced, quality); `complexity` drives the tier, `task_kind` picks
 * a specialist candidate within it, and `continuation` keeps the thread's
 * current route. `needs_investigation` is recorded for later calibration only.
 * `threadTitle` and `taskMessage` give a short follow-up message its context.
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
      ...(state.threadTitle === undefined ? {} : { threadTitle: state.threadTitle }),
      ...(state.taskMessage === undefined
        ? {}
        : { taskMessage: state.taskMessage.slice(0, TIER_JUDGMENT_MESSAGE_CHARS) }),
    },
    questions: {
      complexity: {
        type: "score",
        instructions:
          "Rate the complexity of the task described in `message`. When `message` is short, read it in the context of `threadTitle` and `taskMessage` if present.",
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
      task_kind: {
        type: "choice",
        instructions:
          "Classify the kind of work `message` asks for. When `message` is short, read it in the context of `threadTitle` and `taskMessage` if present.",
        criteria: TASK_KIND_CRITERIA,
      },
      continuation: {
        type: "noul",
        instructions:
          "`message` continues the task already under way in this thread (e.g. go-ahead, retry, pasted command output, 'commit and push', a status question) rather than starting a new task",
      },
    },
  };
}

/** Maps validated judge answers to the router input, or `undefined` when the
 * complexity answer is absent or the wrong type. `task_kind` and `continuation`
 * are optional: a missing or mistyped one is simply omitted. */
export function tierJudgmentFromAnswers(
  answers: Readonly<Record<string, JudgeAnswer>>,
  model: string,
): TierJudgmentInput | undefined {
  const complexity = answers.complexity;
  if (complexity === undefined || complexity.type !== "score") return undefined;
  const taskKind = answers.task_kind;
  const kind =
    taskKind?.type === "choice" && (TASK_KINDS as ReadonlyArray<string>).includes(taskKind.choice)
      ? { kind: taskKind.choice as TaskKind, kindConfidence: taskKind.confidence }
      : {};
  const continuation = answers.continuation;
  return {
    score: complexity.score,
    confidence: complexity.confidence,
    model,
    ...kind,
    ...(continuation?.type === "noul" ? { continuation: continuation.noul } : {}),
  };
}

/** The slice of a projected turn row {@link findRouteContext} reads. */
export interface RouteContextTurn {
  readonly turnId: string | null;
  readonly pendingMessageId: string | null;
  readonly requestedAt: string;
  readonly requestSequence: number | null;
  readonly efficiencyDecision?: EfficiencyDecision | null | undefined;
}

export interface RouteContext {
  /** The decision recorded on the thread's latest turn, when it was routed. */
  readonly priorDecision?: EfficiencyDecision;
  /** The user message id of the turn that started the current route: the
   * newest routed turn whose decision was not itself a sticky continuation. */
  readonly taskMessageId?: string;
}

/**
 * Finds the thread's current route from its projected turns: the latest turn's
 * decision (the sticky-routing candidate) and the message that started the
 * route (context for judging short follow-ups). Pure, so it is unit-tested
 * without a database.
 */
export function findRouteContext(
  turns: ReadonlyArray<RouteContextTurn>,
  latestTurnId: string,
): RouteContext {
  const priorDecision = turns.find((turn) => turn.turnId === latestTurnId)?.efficiencyDecision;
  if (priorDecision == null) return {};
  const routed = turns
    .filter((turn) => turn.turnId !== null && turn.efficiencyDecision != null)
    .toSorted(
      (a, b) =>
        a.requestedAt.localeCompare(b.requestedAt) ||
        (a.requestSequence ?? 0) - (b.requestSequence ?? 0),
    );
  const origin = routed.findLast((turn) => turn.efficiencyDecision?.judgment?.sticky !== true);
  return {
    priorDecision,
    ...(origin?.pendingMessageId == null ? {} : { taskMessageId: origin.pendingMessageId }),
  };
}
