import type { WorktreeCleanupNotice } from "@t3tools/contracts";

// Notices stay on the server for as long as the worktree is blocked, so an
// in-memory "seen" set re-toasts every one of them on each app launch. The
// toasted keys are remembered per device instead. createdAt is part of the
// key: a notice that clears and later comes back is a new event worth showing.
const TOASTED_NOTICES_STORAGE_KEY = "t3code:worktree-cleanup:toasted-notices";

export function worktreeCleanupNoticeToastKey(notice: WorktreeCleanupNotice): string {
  return `${notice.id}@${notice.createdAt}`;
}

export function readToastedWorktreeCleanupNoticeKeys(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TOASTED_NOTICES_STORAGE_KEY) ?? "[]");
    return new Set(
      Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : [],
    );
  } catch {
    return new Set();
  }
}

export function rememberToastedWorktreeCleanupNoticeKeys(keys: ReadonlySet<string>): void {
  try {
    localStorage.setItem(TOASTED_NOTICES_STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

/**
 * Splits the current notices into the ones to toast now and the key set to
 * remember. Keys for notices that no longer exist are dropped, except while
 * the list is empty: the atom starts empty before the server config loads,
 * and pruning then would forget everything and re-toast on the next update.
 */
export function planWorktreeCleanupNoticeToasts(
  notices: ReadonlyArray<WorktreeCleanupNotice>,
  toastedKeys: ReadonlySet<string>,
): { readonly toToast: ReadonlyArray<WorktreeCleanupNotice>; readonly nextKeys: Set<string> } {
  if (notices.length === 0) {
    return { toToast: [], nextKeys: new Set(toastedKeys) };
  }
  const nextKeys = new Set<string>();
  const toToast: WorktreeCleanupNotice[] = [];
  for (const notice of notices) {
    const key = worktreeCleanupNoticeToastKey(notice);
    if (!toastedKeys.has(key)) {
      toToast.push(notice);
    }
    nextKeys.add(key);
  }
  return { toToast, nextKeys };
}
