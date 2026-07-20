# Scoped-shell automation allowlist

`shell.scoped` is disabled by default. An automation file can contain only:

```json
{
  "kind": "shell.scoped",
  "config": { "allowlistId": "example.read" }
}
```

The node cannot specify an executable, arguments, working directory, filesystem roots, access level, timeout, output limits, resource ceilings, or retry behavior. Those fields come only from the server owner's runtime manifest or from fixed platform safety policy. There is no RPC or editor mutation API for this manifest or the platform resource ceilings.

## Runtime manifest

Provision `scoped-shell-allowlist.json` directly inside the server's configured `secretsDir`. The directory must be a canonical, non-symlink directory owned by the server user with no group or world permissions. The manifest must be a canonical, non-symlink regular file owned by the server user, owner-readable, no larger than 1 MiB, and have no group or world permissions. A typical mode is `0600` for the file and `0700` for the directory. Never add either location to Git.

The schema is versioned and rejects unknown fields:

```json
{
  "schemaVersion": 1,
  "entries": [
    {
      "allowlistId": "example.read",
      "spaceId": "example-space",
      "repositoryId": "example-repository",
      "executable": "<root-owned-canonical-executable>",
      "argv": ["<literal-argument>"],
      "access": "read",
      "cwd": "<canonical-workspace-directory>",
      "timeoutMs": 30000,
      "stdoutMaxBytes": 65536,
      "stderrMaxBytes": 65536,
      "retryable": false,
      "idempotent": true,
      "allowedRoots": [
        {
          "canonicalPath": "<canonical-workspace-root>",
          "access": "read"
        }
      ]
    }
  ]
}
```

`repositoryId` is mandatory and must exist in the entry's exact Space in the loaded private configuration. The server derives that repository's managed checkout path from the configured Space, repository ID, and canonical remote URL; membership in a list of repository IDs is not sufficient authority. A read-only `cwd` may be the exact managed checkout or a linked worktree whose Git metadata points back to it. A writable `cwd` must be a resolver-confirmed linked worktree under the managed worktree directory; the primary managed checkout can never be writable. Every allowed root must be exactly `cwd` or the managed checkout, and only the linked-worktree root may carry write access. Allowlist IDs are unique across the manifest. Arguments are literal and receive no shell interpolation or automation templating.

V1 admits only entries with `idempotent: true`; a non-idempotent entry is rejected before process start even when `retryable` is false. Retries additionally require `retryable: true`. The server derives an attempt-stable idempotency key from the durable execution and node IDs; the manifest cannot provide one. This means recovery can safely retry an admitted command, while v1 never auto-replays a non-idempotent command after a crash.

Before the first process start, the server hashes the canonical validated manifest entry and atomically pins that digest into the exact running `shell.scoped` node checkpoint. The execution ID, node ID, node kind, checkpoint state, and Space must all match the durable runtime record. Every retry or recovery must resolve to the same entry digest; manifest drift becomes a terminal policy error and the command is not started again.

## Isolation prerequisites

Execution fails closed unless all of these checks pass for every invocation:

- Linux, canonical `/usr/bin/bwrap`, and canonical `/usr/bin/prlimit` are available.
- The server is not running as root.
- Bubblewrap, `prlimit`, and the selected executable are root-owned executable files and are not group- or world-writable.
- Executable, working directory, Bubblewrap, `prlimit`, and every allowed root are canonical non-symlink paths.
- The working directory is inside a compatible allowed root, and no writable root contains Bubblewrap, `prlimit`, or the executable.
- Writable commands have single-link regular `.git`, `commondir`, and reverse `gitdir` control files whose canonical common Git directory is the selected managed checkout's `.git` directory.
- The common `config` and optional per-worktree `config.worktree` are canonical single-link regular files with no includes, malformed syntax, or executable callback keys. This blocks ambient hooks, filesystem monitors, filters, diff or merge drivers, credential helpers, alternate-ref commands, remote helpers, and equivalent local callbacks before writable admission.
- Linux `O_PATH` descriptors and `/proc/self/fd` identity checks are available.
- Bubblewrap accepts inherited `--bind-fd` / `--ro-bind-fd` sources.
- A writable workspace filesystem has at least 2.5 GiB available before launch so the runtime can preserve its 2 GiB safety reserve while granting the command's 512 MiB budget.

The server pins all validated paths with `O_PATH | O_NOFOLLOW`, verifies descriptor identity and ancestry, and passes only inherited descriptors for the resource controller, Bubblewrap, command, workspace, linked-worktree `.git` pointer, and common Git directory mounts. It never falls back to pathname execution or pathname mounts. `prlimit` executes Bubblewrap from its inherited descriptor after applying hard limits. The executable descriptor is used only as the source of a read-only bind at `/command`; Bubblewrap executes `/command`, not the host descriptor path. In writable worktrees, Bubblewrap overlays the exact `.git` pointer and its complete common Git directory read-only, so ordinary source writes remain available without allowing repository metadata changes. Single-link admission prevents a pre-existing hardlink in the writable tree from aliasing those read-only control or configuration files, while the separate metadata mount prevents new hardlinks into the workspace.

The sandbox has a clean environment, isolated PID/proc and network namespaces, no host home mount, minimal read-only system mounts, one workspace mount at the requested access, bounded output, and a policy timeout with process-group cleanup. Host-side Git inspection and worktree operations also use fixed command-scope settings and an exact environment: hooks, filesystem monitors, signing callbacks, extension transports, ambient Git configuration, and ambient Git path overrides are unavailable. GitHub, GitLab, and Azure pull-request checkout adapters pass the same policy to the Git processes they launch through `GIT_CONFIG_COUNT`, while retaining only each connector's explicit authentication and configuration variables. The resource controller is created as a detached host process-group leader before asynchronous spawn observation begins, and Bubblewrap does not split the sandbox command into another host process group. On timeout, interruption, spawn failure, or scope release, the runtime signals the whole group, escalates from `SIGTERM` to `SIGKILL` when necessary, and retains its concurrency permit and pinned descriptors until Node has reaped the direct child and the process group no longer exists. An unreapable group therefore fails closed without admitting replacement work. Bubblewrap creates `/tmp` as a kernel-limited 64 MiB tmpfs, then creates `HOME` at `/tmp/home`; neither temporary files nor home-directory files can escape that same cap.

Trusted Git-hook execution is not implicit. Supporting it in the future requires a separately granted capability with pinned provenance, containment, and approval; repository configuration alone can never enable host-side callbacks.

## Host resource ceilings

These fixed ceilings apply before Bubblewrap starts and are inherited by every sandbox descendant:

| Resource                           |                                                                                               Ceiling |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------: |
| Concurrent scoped-shell executions |                            2; additional requests fail immediately and never enter an unbounded queue |
| Account tasks (`RLIMIT_NPROC`)     | Lower of the server account's startup/current task counts plus 16, with an absolute ceiling of 16,384 |
| CPU (`RLIMIT_CPU`)                 |                              The command timeout rounded up to seconds, capped at 60 seconds per task |
| Address space (`RLIMIT_AS`)        |                                                                                      512 MiB per task |
| Regular-file size (`RLIMIT_FSIZE`) |                                                                                      256 MiB per file |
| Open descriptors (`RLIMIT_NOFILE`) |                                                                                          256 per task |
| Core files (`RLIMIT_CORE`)         |                                                                                              Disabled |
| Private `/tmp` and `HOME` tmpfs    |                                                           64 MiB total, kernel-enforced by Bubblewrap |
| Writable-filesystem growth         |                              512 MiB net available-space reduction per execution, sampled every 25 ms |
| Writable-filesystem reserve        |                                          Execution is killed before available space falls below 2 GiB |

Writable commands fail closed if filesystem capacity cannot be inspected, the initial reserve is unavailable, or either filesystem threshold is crossed. The filesystem guard uses the already-pinned workspace descriptor and observes allocated filesystem capacity, so sparse and unlinked-but-open files are included. Because the guard is sampled rather than a kernel quota, production should still place runtime worktrees on a quota-bounded volume; the 2 GiB reserve and per-file limit bound the guard's detection window rather than replacing that deployment defense.

`RLIMIT_NPROC` is Unix-account-wide, not PID-namespace-local. Run the always-on service under its own unprivileged Unix account so the measured baseline represents Command Center and the 16-task headroom is meaningful. The ceiling can tighten as unrelated account tasks exit but never expands beyond its startup value. If the account is already above the absolute ceiling, process-table inspection fails, safe task headroom is exhausted, a hard limit cannot be installed, `prlimit` is missing or untrusted, or an inherited hard limit is stricter and cannot be preserved, execution fails and the selected command is never started.

## Verification

Run the focused suite normally to check policy, resource argument construction, and admission behavior. On a Linux host with Bubblewrap and `prlimit` configured, opt into the live boundary checks with `CC_SCOPED_SHELL_LIVE=1`. The live checks cover descriptor mounts, linked-worktree Git metadata immutability, normal workspace writes, read/write enforcement, environment and process isolation, network denial, inherited hard resource limits, address-space and file-size denial, kernel-enforced private tmpfs exhaustion, bounded concurrency, output truncation, timeout cleanup, acquisition and running-fiber interruption, stubborn `SIGTERM` escalation, durable child reap, and denial of replacement capacity until final process-group exit.

If the manifest is absent, malformed, permissive, symlinked, changes while read, omits repository binding, crosses the server-managed repository boundary, drifts from the checkpointed entry digest, references an unknown Space or repository, or fails any runtime boundary prerequisite, the node records a terminal failure and no command is started.
