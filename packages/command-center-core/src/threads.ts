/** Mirrors the server's `COMMAND_CENTER_INTERACTIVE_THREAD_ID_PREFIX` (`CommandCenterProviderIsolation.ts`). */
const INTERACTIVE_RUN_THREAD_ID_PREFIX = "cc:interactive:";

/**
 * Whether nobody is watching a thread: an agent or the server opened it
 * (scheduled task runs, delegated tasks, the Space agent, automation Runs).
 * Such a thread notifies only when it needs the user and settles itself once
 * its run completes. A user-started Command Center Run's thread is opened by
 * the server on the user's behalf, so it stays attended.
 */
export const isUnattendedThread = (thread: {
  readonly id: string;
  readonly createdBy: string;
}): boolean =>
  thread.createdBy !== "user" && !thread.id.startsWith(INTERACTIVE_RUN_THREAD_ID_PREFIX);
