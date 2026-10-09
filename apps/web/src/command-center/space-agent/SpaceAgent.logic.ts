import type { CommandCenterSpaceAgentSummary } from "@t3tools/contracts";

import { formatRelativeTimeLabel } from "../../timestampFormat";

/** Mirrors the server's `SPACE_AGENT_THREAD_ID_PREFIX` (`SpaceAgentIds.ts`). */
export const SPACE_AGENT_THREAD_ID_PREFIX = "cc-space-agent-";

export const SPACE_AGENT_ACTIVITY_LIMIT = 20;

export const isSpaceAgentThreadId = (threadId: string): boolean =>
  threadId.startsWith(SPACE_AGENT_THREAD_ID_PREFIX) &&
  threadId.length > SPACE_AGENT_THREAD_ID_PREFIX.length;

export const spaceIdFromSpaceAgentThreadId = (threadId: string): string | null =>
  isSpaceAgentThreadId(threadId) ? threadId.slice(SPACE_AGENT_THREAD_ID_PREFIX.length) : null;

/** Enabled agents only, in display-name order; the sidebar group lists exactly these. */
export const enabledSpaceAgents = (
  agents: ReadonlyArray<CommandCenterSpaceAgentSummary> | null | undefined,
): ReadonlyArray<CommandCenterSpaceAgentSummary> =>
  (agents ?? [])
    .filter((agent) => agent.enabled)
    .toSorted((left, right) => left.displayName.localeCompare(right.displayName));

/**
 * Thread ids the Spaces group already shows, so the project thread list can
 * skip them. Only enabled agents with a thread count: a disabled agent's
 * thread stays reachable in the normal list.
 */
export const spaceAgentThreadIds = (
  agents: ReadonlyArray<CommandCenterSpaceAgentSummary>,
): ReadonlySet<string> =>
  new Set(agents.flatMap((agent) => (agent.threadId === null ? [] : [agent.threadId])));

export const spaceAgentLastWakeLabel = (agent: { readonly lastWakeAt: string | null }): string => {
  if (agent.lastWakeAt === null) return "Never woken";
  const relative = formatRelativeTimeLabel(agent.lastWakeAt);
  return relative === "" ? "Never woken" : `Woke ${relative}`;
};

/** A user-facing message for a failed wake or pause. A busy agent is expected, not an error. */
export const describeSpaceAgentError = (cause: unknown, fallback: string): string => {
  if (typeof cause === "object" && cause !== null) {
    const reason = (cause as { readonly reason?: unknown }).reason;
    if (reason === "conflict") return "The agent is busy. Try again when its turn finishes.";
    const message = (cause as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (typeof cause === "string" && cause.trim()) return cause;
  return fallback;
};
