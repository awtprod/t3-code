import type { AgentAwarenessPhase } from "@t3tools/shared/agentAwareness";

export type AgentNotificationKind = "approval-needed" | "input-needed" | "completed" | "failed";

const ACTIVE_PHASES: ReadonlySet<AgentAwarenessPhase> = new Set([
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
]);

// Classifies a phase transition into the event a user would want to know
// about. `previous === null` means this is the first observation of the
// thread (fresh mount, newly created, or the environment just connected) —
// never notifiable, so app launch never replays a backlog of past activity.
export function agentNotificationKind(
  previous: AgentAwarenessPhase | null,
  next: AgentAwarenessPhase,
): AgentNotificationKind | null {
  if (previous === null || next === previous) {
    return null;
  }
  if (next === "completed" && ACTIVE_PHASES.has(previous)) {
    return "completed";
  }
  if (next === "failed" && ACTIVE_PHASES.has(previous)) {
    return "failed";
  }
  if (next === "waiting_for_approval" && previous !== "waiting_for_approval") {
    return "approval-needed";
  }
  if (next === "waiting_for_input" && previous !== "waiting_for_input") {
    return "input-needed";
  }
  return null;
}
