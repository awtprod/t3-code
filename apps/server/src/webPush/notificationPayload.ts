import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { agentAwarenessStatusWord } from "@t3tools/shared/agentAwareness";

import type { WebPushThreadNotificationPayload } from "./WebPushSender.ts";

// The service worker (apps/web/public/service-worker.js) drops any title or body
// over 120 characters, so clip to the same bound. Trim on both sides of the
// slice: the raw value may have surrounding whitespace, and slicing can leave a
// trailing space mid-word.
const MAX_NOTIFICATION_TEXT_LENGTH = 120;

export function clipNotificationText(text: string): string {
  return text.trim().slice(0, MAX_NOTIFICATION_TEXT_LENGTH).trim();
}

/**
 * Builds the exact payload apps/web/public/service-worker.js decodePushPayload
 * accepts for a thread notification: title is the thread title, body is
 * `${status}: ${projectTitle}` (status words from the shared awareness helper),
 * both clipped to 120 chars, and deepLink is the awareness deep link the state
 * already carries (`/threads/{env}/{thread}`).
 */
export function buildThreadNotificationPayload(
  state: RelayAgentActivityState,
): WebPushThreadNotificationPayload {
  return {
    title: clipNotificationText(state.threadTitle),
    body: clipNotificationText(`${agentAwarenessStatusWord(state.phase)}: ${state.projectTitle}`),
    environmentId: state.environmentId,
    threadId: state.threadId,
    deepLink: state.deepLink,
  };
}
