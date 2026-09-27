import type { WorktreeCleanupNotice } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef } from "react";

import { primaryServerWorktreeCleanupNoticesAtom } from "../state/server";
import { toastManager } from "./ui/toast";
import { stackedThreadToast } from "./ui/toastHelpers";
import {
  planWorktreeCleanupNoticeToasts,
  readToastedWorktreeCleanupNoticeKeys,
  rememberToastedWorktreeCleanupNoticeKeys,
} from "./WorktreeCleanupToastCoordinator.logic";

const NOTICE_REASON_COPY: Record<WorktreeCleanupNotice["reason"], string> = {
  "local-changes": "has uncommitted changes",
  "local-files": "has untracked files",
  "no-upstream": "has no upstream branch to push to",
  "unpushed-commits": "has commits that haven't been pushed",
  "inspection-failed": "couldn't be inspected",
  "removal-failed": "couldn't be removed",
};

function describeNotice(notice: WorktreeCleanupNotice): string {
  const branch = notice.branch !== null ? ` (${notice.branch})` : "";
  return `${notice.worktreePath}${branch} ${NOTICE_REASON_COPY[notice.reason]}, so it was left in place.`;
}

export function WorktreeCleanupToastCoordinator() {
  const notices = useAtomValue(primaryServerWorktreeCleanupNoticesAtom);
  const toastedKeysRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    toastedKeysRef.current ??= readToastedWorktreeCleanupNoticeKeys();
    const { toToast, nextKeys } = planWorktreeCleanupNoticeToasts(notices, toastedKeysRef.current);
    toastedKeysRef.current = nextKeys;
    rememberToastedWorktreeCleanupNoticeKeys(nextKeys);

    for (const notice of toToast) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: `Worktree kept: ${notice.projectTitle}`,
          description: describeNotice(notice),
        }),
      );
    }
  }, [notices]);

  return null;
}
