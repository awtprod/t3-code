import type { WorktreeCleanupNotice } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  planWorktreeCleanupNoticeToasts,
  worktreeCleanupNoticeToastKey,
} from "./WorktreeCleanupToastCoordinator.logic";

function notice(path: string, createdAt = "2026-09-20T00:00:00.000Z"): WorktreeCleanupNotice {
  return {
    id: `no-upstream:${path}`,
    worktreePath: path,
    projectTitle: "t3-code",
    branch: null,
    reason: "no-upstream",
    createdAt,
  };
}

describe("planWorktreeCleanupNoticeToasts", () => {
  it("toasts only notices this device has not shown before", () => {
    const shown = notice("/w/a");
    const fresh = notice("/w/b");
    const plan = planWorktreeCleanupNoticeToasts(
      [shown, fresh],
      new Set([worktreeCleanupNoticeToastKey(shown)]),
    );
    expect(plan.toToast).toEqual([fresh]);
    expect(plan.nextKeys).toEqual(
      new Set([worktreeCleanupNoticeToastKey(shown), worktreeCleanupNoticeToastKey(fresh)]),
    );
  });

  it("keeps remembered keys while the notice list is still empty", () => {
    const remembered = new Set([worktreeCleanupNoticeToastKey(notice("/w/a"))]);
    const plan = planWorktreeCleanupNoticeToasts([], remembered);
    expect(plan.toToast).toEqual([]);
    expect(plan.nextKeys).toEqual(remembered);
  });

  it("forgets resolved notices and toasts one that comes back later", () => {
    const first = notice("/w/a");
    const other = notice("/w/b");
    const pruned = planWorktreeCleanupNoticeToasts(
      [other],
      new Set([worktreeCleanupNoticeToastKey(first), worktreeCleanupNoticeToastKey(other)]),
    );
    expect(pruned.nextKeys).toEqual(new Set([worktreeCleanupNoticeToastKey(other)]));

    const returned = notice("/w/a", "2026-09-27T00:00:00.000Z");
    const plan = planWorktreeCleanupNoticeToasts([other, returned], pruned.nextKeys);
    expect(plan.toToast).toEqual([returned]);
  });
});
