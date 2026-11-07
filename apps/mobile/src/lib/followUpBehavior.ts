import type { ActiveTurnComposerAction } from "@t3tools/client-runtime/state/composer-dispatch";

export type FollowUpBehavior = Extract<ActiveTurnComposerAction, "queue" | "steer">;

// Command Center keeps queue as the default; steer stays one long-press away.
export const DEFAULT_FOLLOW_UP_BEHAVIOR: FollowUpBehavior = "queue";
