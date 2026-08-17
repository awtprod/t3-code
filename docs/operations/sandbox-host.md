# Sandbox host bootstrap, canary, and flip

Per-thread container sandboxing runs each thread's work inside its own container
instead of directly on the host filesystem. The code shipped inert: the runtime
it needs is not installed, and the environment variables that switch it on are
not set.

This runbook covers making the runtime available, proving it works, switching
sandboxing on deliberately, and switching it back off.

Everything root-required lives in one reviewed script,
`deploy/openclaw/sandbox/bootstrap-sandbox-host.sh`. The service account
(uid 986) runs under `NoNewPrivileges=yes` and `ProtectSystem=strict` and cannot
perform any of it; an operator runs the script once as root.

> The bootstrap script does not enable sandboxing and does not restart the
> service. It installs, configures, and verifies. Turning sandboxing on is a
> separate, explicit edit described in section 6.

## 1. Why this host needs more than `apt-get install podman`

Four constraints drive the whole design. They are not preferences; each one was
established against this host.

**The server cannot be told where the container socket is.** It resolves its
container binary by bare name through `PATH`, and `NodeSandboxCommandExecutor`
spawns it with `env: { PATH: process.env.PATH }` — every other variable is
stripped. `CONTAINER_HOST` set in the systemd unit never reaches the CLI. The fix
is a wrapper at `/opt/command-center/bin/podman` that sets `CONTAINER_HOST`
itself and execs `/usr/bin/podman --remote`. That directory is already first on
the service's `PATH`.

**Rootless docker cannot enforce volume quotas.** `volume create --opt o=size=N`
passes the backend's echo-back check, and the volume then fails to mount because
`o` was given without `type`/`device`. Rootless podman via the user socket
honours `o=size` through XFS project quotas and echoes the option back verbatim.
It also works under `NoNewPrivileges` because the daemon lives outside the unit.

**The root filesystem is ext4, and `o=size` requires XFS with pquota.** Hence a
sparse XFS loopback image mounted at `/var/lib/command-center/sandbox` and used
as the podman graphroot.

**Ubuntu 24.04 ships netavark 1.4, which has no DNS on `--internal` networks.**
The design requires the workspace container to resolve `egress-proxy`,
`credential-proxy`, and preview aliases by name on exactly such a network. The
script installs SHA256-pinned newer helpers — but only after empirically proving
the stock version fails, so a future Ubuntu update silently makes the override
disappear rather than becoming permanent cruft.

## 2. Prerequisites

Confirm before running anything:

- The service account is uid 986, gid 984. The script hardcodes both and refuses
  to run if either differs, because the socket path and the drop-in embed them.
- `/opt/command-center/bin` exists and is first on the service `PATH`. Check with
  `systemctl show command-center.service -p Environment`.
- Root filesystem free space. The script creates a **sparse** loopback image,
  defaulting to 40 GiB, and refuses to proceed if that would leave under 15 GiB
  headroom. Sparse means it consumes only what containers actually write, but it
  can grow to its full size, so the check counts the full size deliberately.
  Override with `SANDBOX_IMAGE_SIZE_GIB=…` if the volume has been grown.
- Outbound HTTPS to `github.com` (pinned helper binaries) and to the registry
  holding the sandbox images.

## 3. Running the bootstrap

```sh
sudo /opt/command-center/current/deploy/openclaw/sandbox/bootstrap-sandbox-host.sh
```

It is idempotent; re-running is the supported way to repair a partial run.
Individual steps can be re-run in isolation:

```sh
sudo STEPS=8 /opt/command-center/current/deploy/openclaw/sandbox/bootstrap-sandbox-host.sh
```

The steps, in execution order:

| Step | What it does                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1    | Installs `uidmap`, `slirp4netns`, `passt`, `podman`, `netavark`, `aardvark-dns`, `catatonit`, `xfsprogs`, `dbus-user-session`. |
| 3    | Appends `commandcenter:231072:65536` to `/etc/subuid` and `/etc/subgid`, refusing on overlap.                                  |
| 4    | Enables linger, then waits for the uid 986 user manager to actually be active.                                                 |
| 5    | Creates and formats the sparse XFS image, installs and starts the mount unit, writes `storage.conf`.                           |
| 6    | Enables the **user** `podman.socket` for uid 986.                                                                              |
| 7    | Installs the `podman` wrapper and verifies it wins the `PATH` lookup.                                                          |
| 2    | Probes internal-network DNS; installs pinned netavark/aardvark-dns only if the probe fails.                                    |
| 8    | Verification. See section 4.                                                                                                   |
| 9    | Installs the systemd drop-in with every setting commented out.                                                                 |

**Ordering is load-bearing.** Step 2 runs late on purpose: its gate is a real
container-to-container DNS lookup, which needs a working rootless podman, which
needs subuid ranges (3), linger (4), storage (5), and the socket (6). Steps 3 and
4 must precede 6 — without subuid, rootless podman cannot create a user
namespace at all; without linger, there is no user manager to enable a user unit
in. Step 5 must precede 6 so the graphroot is on the XFS mount before podman
initialises it. Running `STEPS=2` or `STEPS=6` alone assumes the earlier steps
already completed; both assert their prerequisites and refuse rather than
proceeding.

## 4. What the verification proves

Step 8 is the point of the exercise. Every command runs **as the service user,
through the wrapper** — the same path the server takes. Running them as root, or
against `/usr/bin/podman` directly, proves nothing.

- **Rootless check.** Runs `podman info --format '{{.Host.Security.Rootless}}'`
  and requires exactly `true`. The backend compares this string exactly and
  refuses to provision otherwise. Catches a socket pointing at a rootful daemon.
- **Volume quota echo-back.** Creates a volume with `--opt o=size=…` using the
  same byte value the backend computes, then checks `volume inspect` returns the
  option verbatim. The backend treats any difference as fatal.
- **Quota enforcement.** Writes 64 MiB into a volume with a 16 MiB quota and
  demands failure. This is the check that matters: the echo-back above _also
  passes on rootless docker_, where nothing is enforced. Anything less than
  writing past the limit cannot tell the two apart.
- **Internal-network DNS.** Creates an `--internal` network and resolves both a
  peer container's name and the `egress-proxy` alias from inside the workspace
  container. Proves the netavark decision was right.
- **Hardened run.** Starts a container with the backend's complete flag set —
  `--read-only`, `--init`, `--cap-drop ALL`, `--security-opt no-new-privileges`,
  `--user 1000:1000`, `--tmpfs /tmp`, `--cpus`, `--memory`, `--pids-limit`,
  `--storage-opt size=`. Any one of these being unsupported fails provisioning.
- **`exec --interactive` stdin round-trip.** Provider sessions speak their entire
  protocol over that pipe. If stdin does not survive the socket, providers hang
  with no error — the worst failure mode to debug in production. Also checks
  `--env NAME` value-less forwarding, which is how credentials reach the provider.
- **`podman cp` both directions.** Delivers the repository bundle in and the
  exported thread bundle out.
- **Egress.** A container on a routed network reaching the internet. Warns rather
  than aborts, since a host requiring an outbound proxy is legitimate — but image
  pulls inside sandboxes will fail until that is configured.
- **Graphroot placement.** Confirms podman's store is actually on the XFS mount,
  not on ext4 underneath it.

Any failure aborts with a diagnostic naming the likely cause. Do not proceed to
section 6 with a failing verification.

## 5. Building the images

Sandboxing needs two images at minimum, both pinned by sha256 digest — the
backend rejects tags. Build them with:

```sh
deploy/openclaw/sandbox-image/build-sandbox-images.sh
```

Record the resulting digests; they go into the drop-in in the next section. The
egress proxy image is optional but recommended: without it the workspace
container has whatever egress the internal network provides, rather than a
policy-enforcing proxy.

## 6. The production flip

> **This is a one-way switch.** `ProviderCommandReactor.ensureExecutionTarget`
> takes the legacy-host fallback only while `T3_SANDBOX_IMAGE` or
> `T3_SANDBOX_PREVIEW_PROXY_IMAGE` is unset. The moment both are set, that
> fallback is gone and **every new thread on this host** must successfully
> provision a container or it cannot start at all. A bad digest, an unreachable
> registry, or a podman socket that failed to come back after a reboot then means
> no thread can start work.

Canary on a scratch instance first — never flip production blind.

### 6a. Canary

Run a second server on a different port with a separate base directory, so it
shares the host and the container runtime but none of the production state:

```sh
sudo -u commandcenter env HOME=/var/lib/command-center \
  PATH=/opt/command-center/bin:/usr/local/bin:/usr/bin:/bin \
  T3_SANDBOX_RUNTIME=podman \
  T3_SANDBOX_IMAGE=localhost/t3-sandbox@sha256:… \
  T3_SANDBOX_PREVIEW_PROXY_IMAGE=localhost/t3-preview-proxy@sha256:… \
  T3_SANDBOX_DESKTOP=disabled \
  /usr/local/bin/node /opt/command-center/current/apps/server/dist/bin.mjs serve \
    --base-dir /var/lib/command-center/canary --port 3899 --host 127.0.0.1 --no-browser
```

Create a thread, run a turn end to end, and confirm from the host that the
containers exist:

```sh
sudo -u commandcenter env HOME=/var/lib/command-center \
  PATH=/opt/command-center/bin:/usr/bin:/bin podman ps --filter label=com.t3tools.sandbox.managed=true
```

Stop the canary by the PID you started, and remove `--base-dir
/var/lib/command-center/canary` when done. Only proceed once a full turn has
succeeded inside a container.

### 6b. Flip production

Edit `/etc/systemd/system/command-center.service.d/50-sandbox.conf` and uncomment:

- `ReadWritePaths=/run/user/986/podman` — required regardless;
  `ProtectSystem=strict` makes `/run` read-only for the unit, so without it the
  server cannot reach the socket at all. Safe on its own.
- `Environment=T3_SANDBOX_RUNTIME=podman` — **without this nothing else matters.**
  The server defaults to `docker`, never invokes the wrapper, and lands on the
  rootful daemon it cannot use. Set it together with the images, never after.
- `Environment=T3_SANDBOX_IMAGE=…` and
  `Environment=T3_SANDBOX_PREVIEW_PROXY_IMAGE=…` with the digests from section 5.
- Optionally `T3_SANDBOX_EGRESS_PROXY_IMAGE`, `T3_SANDBOX_ARTIFACT_DIR`,
  `T3_SANDBOX_DESKTOP=disabled`, `T3_SANDBOX_GIT_USER_NAME`,
  `T3_SANDBOX_GIT_USER_EMAIL`.

Disabling the desktop stack for the first flip is recommended; it removes a large
moving part from the critical path of starting a thread.

```sh
sudo systemctl daemon-reload
sudo systemctl restart command-center.service
sudo systemctl status command-center.service
```

Watch the first thread through a complete turn before considering it done.

## 7. Rollback

Re-comment the two image lines and restart:

```sh
sudo sed -i 's/^Environment=T3_SANDBOX_IMAGE=/# &/; s/^Environment=T3_SANDBOX_PREVIEW_PROXY_IMAGE=/# &/' \
  /etc/systemd/system/command-center.service.d/50-sandbox.conf
sudo systemctl daemon-reload
sudo systemctl restart command-center.service
```

The legacy-host fallback returns instantly — unsetting either image is enough,
and new threads run on the host again as before. Leaving `ReadWritePaths` and
`T3_SANDBOX_RUNTIME` in place is harmless.

Rollback does not need the runtime uninstalled. Leave podman, the mount, and the
socket alone; they cost nothing while unused and make the next attempt cheap.

## 8. Known caveats

**A server restart fail-closes running sandboxes.** The backend deliberately
refuses to adopt containers discovered after a restart: a running workspace label
alone cannot prove the project declarations, teardown hooks, credentials, caches,
or egress generation that produced it. Threads with a live sandbox at restart
re-provision on their next turn. Expect a slower first turn after every deploy,
and prefer restarting when threads are idle.

**Orphaned containers accumulate if the server is killed hard.** Reconciliation
removes containers whose thread label is not in the expected set, but only on a
clean path. After a hard kill, sweep manually:

```sh
sudo -u commandcenter env HOME=/var/lib/command-center \
  PATH=/opt/command-center/bin:/usr/bin:/bin \
  podman ps --all --filter label=com.t3tools.sandbox.managed=true
```

**The loopback image is sparse and does not shrink.** Blocks stay allocated once
written, even after volumes are removed. If `/var/lib/command-center/sandbox`
reports plenty free while the root filesystem does not, that is why. Reclaiming
means recreating the image with sandboxing off.

**The mount must come back before the socket after a reboot.** If podman ever
starts with the mount absent, it initialises a graphroot on the underlying ext4
directory and quotas silently stop being enforced — indistinguishable from
success at every layer, including the backend's own readback check. Rather than
rely on unit ordering against a lingering user manager, which races, the
bootstrap installs a `ConditionPathIsMountPoint` drop-in so `podman.socket`
refuses to start without the mount. If sandboxes stop provisioning after a
reboot, check the mount unit first:

```sh
systemctl status "$(systemd-escape -p --suffix=mount /var/lib/command-center/sandbox)"
```

The verification's graphroot check (`STEPS=8`) confirms the store is on XFS.

**AppArmor restricts unprivileged user namespaces on this host**
(`kernel.apparmor_restrict_unprivileged_userns=1`). Stock profiles for
`/usr/bin/podman` and `rootlesskit` grant `userns`, so the packaged binaries are
fine. If a future change moves podman to an unprofiled path, rootless containers
will fail to start with a confusing permission error.
