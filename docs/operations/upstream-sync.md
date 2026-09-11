# Syncing T3 Code upstream

Command Center starts from T3 Code commit
`b511227b7ad421c422f1ebca65116776020e4799`. Its currently integrated upstream
baseline is recorded in `.command-center-public-baseline`. The public fork retains
T3 Code's MIT license in `LICENSE`; upstream copyright and attribution must remain intact.

Upstream updates only ever land through a reviewed pull request. The **Upstream sync** GitHub
workflow runs once a day against `refs/remotes/upstream/main` and can also be dispatched by hand
with an exact fetched `refs/tags/...` or `refs/remotes/upstream/...` name and, optionally, the full
40-character commit the ref must resolve to. It never runs on pushes or pull requests.

Each run:

1. Proves the fork contains the pinned baseline and the target descends from the original T3 Code
   baseline. A target already contained in `main` is a no-op.
2. Refuses to rebuild the sync branch if it carries commits that were not written by the workflow,
   so hand-made conflict fixes are never discarded. Merge or close that PR to resume automation.
3. Dry-runs the merge with `git merge-tree`. Any conflict fails the run and lists the conflicting
   paths in the job summary; no branch or PR is created.
4. Merges the target into `upstream-sync/<ref>` (one branch per tracked ref, rebuilt from `main` on
   every run) and fails if upstream and Command Center migrations share a number.
5. Runs the private-denylist and generic public-boundary scans plus a secret scan against the
   complete upstream delta, still against the old baseline, before anything is pushed.
6. Advances the baseline to the sync merge commit in a separate commit, force-pushes the branch,
   opens the pull request or refreshes the existing one, and dispatches CI on the branch. CI is the
   format, type, test, and build gate; its checks appear on the PR.

The baseline pins the merge commit rather than the upstream commit because the fork's early
history was squash-imported. Pinning an upstream commit would make the leak scan's first-parent
walk cover the entire fork history instead of the delta since the last sync.

The same ancestry check can be run locally after fetching the canonical repository:

```sh
node scripts/command-center/upstream-sync.ts plan \
  --upstream-ref refs/tags/<release-tag> [--expected-commit <full-commit-id>]
```

This local command is read-only. When the automated run reports a conflict, resolve it by hand:
branch from `main`, merge the target, renumber colliding migrations after the fork's highest, and
open a PR. Review every sync PR for preserved Command Center contracts, privacy boundaries,
migrations, responsive web, Electron behavior, and T3 Code attribution before merging.
