/**
 * Stable identifiers for a Space's always-on agent. Kept dependency-free so the
 * dispatcher, MCP registry, and activity feed can share them.
 */
const SPACE_AGENT_THREAD_ID_PREFIX = "cc-space-agent-";

/** The one persistent agent thread of a Space. Deliberately not a `cc:` Run thread. */
export const spaceAgentThreadId = (spaceId: string): string =>
  `${SPACE_AGENT_THREAD_ID_PREFIX}${spaceId}`;

export const isSpaceAgentThreadId = (threadId: string): boolean =>
  threadId.startsWith(SPACE_AGENT_THREAD_ID_PREFIX);

export const spaceIdFromSpaceAgentThreadId = (threadId: string): string | undefined => {
  if (!threadId.startsWith(SPACE_AGENT_THREAD_ID_PREFIX)) return undefined;
  const spaceId = threadId.slice(SPACE_AGENT_THREAD_ID_PREFIX.length);
  return spaceId.length === 0 ? undefined : spaceId;
};

/**
 * Audit event recorded when a Space agent authorizes a Run inside its auto-run
 * policy. The dispatcher reads it back to start that Run as unattended worker
 * work rather than as the user's router conversation.
 */
export const spaceAgentRunAuthorizedEventId = (runId: string): string =>
  `space-agent-run:${runId}:authorized`;
