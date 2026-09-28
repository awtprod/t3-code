import type { WebPushPreferences } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { agentAwarenessPublishIdentity } from "../relay/AgentAwarenessRelay.ts";

// A finished thread older than this is not worth ringing: the user has moved on.
// Mirrors infra/relay/src/agentActivity/ApnsDeliveries.ts TERMINAL_NOTIFICATION_FRESHNESS_MS.
export const TERMINAL_NOTIFICATION_FRESHNESS_MS = 2 * 60 * 1_000;

const NULL_IDENTITY = agentAwarenessPublishIdentity(null);

// The phases a transition INTO warrants a notification.
const NOTIFIABLE_PHASES = new Set<RelayAgentActivityState["phase"]>([
  "waiting_for_approval",
  "waiting_for_input",
  "completed",
  "failed",
]);

export function isNotifiablePhase(phase: RelayAgentActivityState["phase"]): boolean {
  return NOTIFIABLE_PHASES.has(phase);
}

export type PublishAction =
  // The projected state matches the last handled state; nothing to do.
  | { readonly kind: "unchanged" }
  // A tombstone-while-live or completed-as-first-state needs a confirmation
  // window before it counts; arm the deadline and re-enqueue.
  | { readonly kind: "defer"; readonly deadlineMs: number }
  // The confirmation window is still open; wait for the re-enqueue.
  | { readonly kind: "await-deadline" }
  // Handle the transition: record the new identity, and deliver when `notify`.
  | { readonly kind: "proceed"; readonly notify: boolean };

/**
 * Pure transition decision, mirroring the relay's publish gating in
 * AgentAwarenessRelay.publishThreadUnsafe: dedupe by publish identity, and defer
 * a transient null (tombstone while a live state was last published) or a
 * completed-as-first-state for a 5s confirmation window. `notify` is true only
 * when the confirmed state is a phase a transition INTO warrants a notification;
 * per-subscription preference and terminal-freshness filtering happen at delivery.
 */
export function decidePublishAction(input: {
  readonly state: RelayAgentActivityState | null;
  readonly publishIdentity: string;
  readonly previousIdentity: string | undefined;
  readonly hasPrevious: boolean;
  readonly nowMs: number;
  readonly existingDeadlineMs: number | undefined;
}): PublishAction {
  if (input.previousIdentity === input.publishIdentity) {
    return { kind: "unchanged" };
  }
  const requiresConfirmation =
    (input.state === null && input.previousIdentity !== NULL_IDENTITY) ||
    (input.state?.phase === "completed" && !input.hasPrevious);
  if (requiresConfirmation) {
    if (input.existingDeadlineMs === undefined) {
      return { kind: "defer", deadlineMs: input.nowMs + 5_000 };
    }
    if (input.nowMs < input.existingDeadlineMs) {
      return { kind: "await-deadline" };
    }
  }
  return {
    kind: "proceed",
    notify: input.state !== null && isNotifiablePhase(input.state.phase),
  };
}

export function notificationAllowedForPreferences(
  preferences: WebPushPreferences,
  phase: RelayAgentActivityState["phase"],
): boolean {
  switch (phase) {
    case "waiting_for_approval":
      return preferences.notifyOnApproval;
    case "waiting_for_input":
      return preferences.notifyOnInput;
    case "completed":
      return preferences.notifyOnCompletion;
    case "failed":
      return preferences.notifyOnFailure;
    default:
      return false;
  }
}

/**
 * Terminal (completed/failed) states are only fresh enough to notify within the
 * freshness window; non-terminal states are always considered fresh.
 */
export function isNotificationFreshEnough(state: RelayAgentActivityState, nowMs: number): boolean {
  if (state.phase !== "completed" && state.phase !== "failed") {
    return true;
  }
  const updatedAtMs = Option.match(DateTime.make(state.updatedAt), {
    onNone: () => null,
    onSome: (dt) => dt.epochMilliseconds,
  });
  return updatedAtMs !== null && nowMs - updatedAtMs <= TERMINAL_NOTIFICATION_FRESHNESS_MS;
}
