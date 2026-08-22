# Sandbox runtime operation

Host bootstrap (podman, quotas, networking) is covered by
[sandbox-host.md](./sandbox-host.md). This page covers what the server does
once the runtime exists: how sandboxing switches on, how a thread's sandbox
lives and dies, and where its exported data goes.

## Enabling

Two variables gate everything, both digest-pinned images:

- `T3_SANDBOX_IMAGE` — the workspace image. Unset means sandboxing is off and
  threads run directly on the host, exactly as before. A project's `.t3` file
  `sandbox.image` overrides it per project.
- `T3_SANDBOX_PREVIEW_PROXY_IMAGE` — the preview/signaling sidecar, required
  whenever the workspace image is set. With the image set but this missing,
  provisioning refuses and the thread gets a "sandbox isolation is disabled"
  notice instead of a container.

Everything else is optional: `T3_SANDBOX_EGRESS_PROXY_IMAGE` (no egress
without it), `T3_SANDBOX_CREDENTIAL_PROXY_IMAGE`, `T3_SANDBOX_DESKTOP=disabled`
for headless hosts. The full list with defaults is in the repository root
`.env.example`.

## Disk quotas

Two independent controls, because the two mechanisms behave differently over a
remote podman socket:

- `T3_SANDBOX_VOLUME_STORAGE_QUOTA` — the XFS project quotas on the thread's
  workspace and desktop volumes (`--opt o=size=`). **On by default.** These
  work over `podman --remote` and are the real per-thread disk bound. Each
  quota is read back after the volume is created, and a runtime that does not
  echo it verbatim fails the provision rather than pretending to enforce it.
  Set `disabled` only on a host where rootless podman cannot administer XFS
  project quotas at all — it needs `CAP_SYS_ADMIN` in the filesystem's owning
  namespace, or a privileged helper — where a quota-bearing volume create
  fails outright instead of going quietly unenforced. Disabling it leaves
  thread disk use unbounded.
- `T3_SANDBOX_CONTAINER_STORAGE_QUOTA` — the container writable layer's
  `--storage-opt size=`. **Off by default**, enable with `enabled`.
  `podman --remote` rejects the flag, and every socket deployment is remote by
  construction (see `deploy/openclaw/sandbox/podman-wrapper.sh`), so leaving it
  on would fail every provision. Omitting it loses nothing: the container
  rootfs is `--read-only` and every writable path is either one of the
  quota-bearing volumes above or a size-bounded tmpfs. Turn it on only on a
  local daemon that accepts it.

These were a single switch until they were split. That configuration had no
setting that was both working and bounded: enabling it broke provisioning on
remote podman, and disabling it also discarded the volume quotas that do work.
`bootstrap-sandbox-host.sh` step 8 reads both variables with the same defaults,
so its verification mirrors what the server will issue.

## Lifecycle

A sandboxed thread's container moves through `provisioning → ready`, then
eventually `stopping → stopped` (user- or settle-driven) or `expired` (the
server's periodic pass, which runs every minute, enforces the idle timeout and
maximum lifetime). A stop or expiry first **exports** the thread's work, then
tears down the container, its sidecars, network, and volumes.

A later turn on a stopped or expired thread **re-provisions from the export**:
the branch bundle seeds the repository at the exported head commit, and the
archived provider conversation store restores the agent's context. A missing
or tampered artifact degrades this to a plain clone at the recorded base
commit — the thread still works, but the previous session's commits and the
agent's memory of the conversation are gone.

A server restart deliberately fail-closes running sandboxes; affected threads
re-provision on their next turn (see sandbox-host.md, Known caveats).

## Export artifacts

Each export writes one artifact set to `<stateDir>/sandbox-artifacts/`
(overridable with `T3_SANDBOX_ARTIFACT_DIR`), named `sha256(threadId)`:

- `<id>.bundle` — git bundle of the thread branch.
- `<id>.json` — manifest: digests, sizes, branch/commit provenance.
- `<id>.store.tar` — the provider's archived conversation store, capped at
  `T3_SANDBOX_STORE_MAX_BYTES` (default 50MB; an oversized store is skipped,
  the branch still exports).

Every export for a thread overwrites the same set, so per-thread disk use is
bounded. The bundle and manifest are downloadable at
`/api/sandbox-artifacts/<id>/bundle|manifest`. The store is deliberately **not
served over HTTP** — it is transcript data used server-side for restore only,
and the manifest marks it `storeServed: false`.

## Retention

- **Thread deletion** removes the thread's artifact set immediately, along
  with its container if one is running: transcripts and commits must not
  outlive the thread.
- **Age sweep**: the same periodic pass that expires idle sandboxes deletes
  artifact sets whose newest file is older than
  `T3_SANDBOX_ARTIFACT_MAX_AGE_SECONDS` (default 30 days; set `0` to disable).
  Sets belonging to threads whose sandbox is in a non-terminal lifecycle are
  kept regardless of age. The 30-day default trades disk growth against
  restore quality: a thread revived after the cap still provisions, but from a
  plain clone, without the previous session's commits or agent memory. Raise
  the cap (or disable the sweep) on hosts where very long-dormant threads are
  expected back.
