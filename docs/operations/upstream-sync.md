# Syncing T3 Code upstream

Command Center starts from T3 Code commit
`b511227b7ad421c422f1ebca65116776020e4799`. The public fork retains T3 Code's MIT
license in `LICENSE`; upstream copyright and attribution must remain intact.

Upstream updates are intentionally pull-request-only. The **Upstream sync** GitHub workflow has no
schedule or push trigger. An operator must dispatch it with both:

- an exact fetched `refs/tags/...` or `refs/remotes/upstream/...` name; and
- the full 40-character commit expected at that ref.

The two values protect against a typo or a moved tag. The planner then proves that the current fork
and requested target both descend from `.command-center-public-baseline`. It refuses a dirty local
worktree, a divergent history, an abbreviated commit, an unsafe revision expression, and an existing
sync branch. A target already contained in `main` is a no-op.

For a new target, the workflow creates `upstream-sync/<commit>` and performs a normal merge. It keeps
the old public baseline in place while the private-denylist and generic boundary scans inspect the
complete upstream delta, then runs the format/lint, type, test, and desktop-build gates. Only after
those gates pass does it advance the baseline in a separate commit, push the branch, and open a draft
PR. Merge conflicts or verification failures leave `main` unchanged and do not push a sync candidate.

The same ancestry check can be run locally after fetching the canonical repository:

```sh
node scripts/command-center/upstream-sync.ts plan \
  --upstream-ref refs/tags/<release-tag> \
  --expected-commit <full-commit-id>
```

This local command is read-only. Fetching, merging, pushing, and opening the sync PR remain explicit
operator actions; the supported publication route is the manually dispatched workflow. Review every
sync PR for preserved Command Center contracts, privacy boundaries, migrations, responsive web,
Electron behavior, and T3 Code attribution before merging.
