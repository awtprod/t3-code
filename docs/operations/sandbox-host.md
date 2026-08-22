# Sandbox host bootstrap, canary, and flip

Per-thread container sandboxing runs each thread's work inside its own container
instead of directly on the host filesystem. The code shipped inert: the runtime
it needs is not installed, and the environment variables that switch it on are
not set.

This runbook covers making the runtime available, proving it works, switching
sandboxing on deliberately, and switching it back off. What the server does
with the runtime once it exists — lifecycle, export artifacts, retention — is
covered separately in [sandbox-runtime.md](./sandbox-runtime.md).

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
itself and execs `/usr/local/bin/podman --remote` (the pinned podman-static
binary — see the fourth constraint). That directory is already first on the
service's `PATH`.

**Rootless docker cannot enforce volume quotas.** `volume create --opt o=size=N`
passes the backend's echo-back check, and the volume then fails to mount because
`o` was given without `type`/`device`. Rootless podman via the user socket
honours `o=size` through XFS project quotas and echoes the option back verbatim.
It also works under `NoNewPrivileges` because the daemon lives outside the unit.

**The root filesystem is ext4, and `o=size` requires XFS with pquota.** Hence a
sparse XFS loopback image mounted at `/var/lib/command-center/sandbox` and used
as the podman graphroot.

**Ubuntu 24.04's apt podman (4.9.3 with netavark 1.14.0) has a structural
rootless-netns bug this design trips over.** Rootless podman's shared per-UID
pause namespace never bind-mounts a custom network's JSON config into its view
for graphroots under `/var/lib`-class paths, so `podman run --network <custom>`
fails with "network not found" once the pause process is already alive from an
earlier network. This is not a netavark-version or DNS-feature threshold, so no
empirical "does the distro version already work" probe can catch it — the probe
network is typically the first one created, before the bug's precondition
holds. (An earlier revision of the bootstrap pinned only newer
netavark/aardvark-dns behind exactly such a probe; that both missed this bug
and left the 4.9.3 podman in place.) The script therefore unconditionally
installs a pinned **podman-static v5.8.4** bundle (podman, netavark 1.17.2,
aardvark-dns, conmon, crun, catatonit) into `/usr/local`, verified directly on
this host against a `/var/lib`-class graphroot with the pause process already
live. It also fixes internal-network DNS, which the design requires for the
workspace container to resolve `egress-proxy`, `credential-proxy`, and preview
aliases by name.

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
- Outbound HTTPS to `github.com` (the ~45 MB podman-static bundle from
  `mgoltzsche/podman-static` releases — see "Supply chain" below) and to the
  registry holding the sandbox images.

## 3. Running the bootstrap

```sh
sudo /opt/command-center/current/deploy/openclaw/sandbox/bootstrap-sandbox-host.sh
```

It is idempotent; re-running is the supported way to repair a partial run.
That includes a run at the same pinned version: step 2 does not skip on
`podman --version` alone, it also verifies every entry in the bundle manifest
(`/usr/local/share/podman-static/manifest`). The manifest records what each
installed file is and what it contains — a sha256 for a regular file, the link
target for a symlink — and the check reinstalls the pinned bundle when any
entry is missing, does not match its digest, is no longer a symlink, or points
somewhere new. Existence alone was not enough: an interrupted copy and a
hand-truncated helper both leave a file that is present and unusable, which
counted as complete and skipped the repair. A helper deleted or truncated by
hand, an interrupted copy, an absent manifest, or a manifest predating digest
recording is therefore repaired rather than reported as "already installed".
Individual steps can be re-run in isolation:

```sh
sudo STEPS=8 /opt/command-center/current/deploy/openclaw/sandbox/bootstrap-sandbox-host.sh
```

The steps, in execution order:

| Step | What it does                                                                                                                                                                                                                                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Installs `uidmap`, `slirp4netns`, `passt`, `xfsprogs`, `dbus-user-session`. Podman itself deliberately does **not** come from apt.                                                                                                                                                                                   |
| 2    | Installs the SHA256-pinned podman-static v5.8.4 bundle into `/usr/local` (manifest-tracked), cleans up the previous strategy's leftovers, pins `helper_binaries_dir` via a `containers.conf.d` drop-in, and installs an AppArmor `userns` profile for `/usr/local/bin/podman` when the kernel restriction is active. |
| 3    | Appends `commandcenter:231072:65536` to `/etc/subuid` and `/etc/subgid`, refusing on overlap.                                                                                                                                                                                                                        |
| 4    | Enables linger, then waits for the uid 986 user manager to actually be active.                                                                                                                                                                                                                                       |
| 5    | Creates and formats the sparse XFS image, installs and starts the mount unit, writes `storage.conf`.                                                                                                                                                                                                                 |
| 6    | Enables the **user** `podman.socket` for uid 986.                                                                                                                                                                                                                                                                    |
| 7    | Installs the `podman` wrapper and verifies it wins the `PATH` lookup.                                                                                                                                                                                                                                                |
| 8    | Verification. See section 4.                                                                                                                                                                                                                                                                                         |
| 9    | Installs the systemd drop-in with every setting commented out.                                                                                                                                                                                                                                                       |

**Ordering is load-bearing, but less than it used to be.** Step 2 now runs
early and in numeric order: installing binaries into `/usr/local` needs no user
namespace, subuid ranges, linger, or storage — it merely has to happen before
step 6, which asserts the bundle's
`podman.socket` unit exists. (An earlier revision ran step 2 _after_ step 7
because it gated on a live container-to-container DNS probe; that probe is
gone.) Steps 3 and 4 must precede 6 — without subuid, rootless podman cannot
create a user namespace at all; without linger, there is no user manager to
enable a user unit in. Step 5 must precede 6 so the graphroot is on the XFS
mount before podman initialises it. Running `STEPS=6` alone assumes the earlier
steps already completed; it asserts its prerequisites and refuses rather than
proceeding. `STEPS=2` alone is safe on a live host: if it must stop the running
podman socket to swap binaries, it records what was active and restores it
before finishing — from an EXIT trap armed before the stop, so a failure
anywhere in between (the binary copy, the manifest write, the
`containers.conf` drop-in, the AppArmor profile load) still brings the socket
back rather than exiting with it down.

## 4. What the verification proves

Step 8 is the point of the exercise. Every command runs **as the service user,
through the wrapper** — the same path the server takes. Running them as root,
or against the podman binary directly instead of over the wrapper's `--remote`
socket, proves nothing.

- **Rootless check.** Runs `podman info --format '{{.Host.Security.Rootless}}'`
  and requires exactly `true`. The backend compares this string exactly and
  refuses to provision otherwise. Catches a socket pointing at a rootful daemon.
- **Volume quota echo-back.** Creates a volume with `--opt o=size=…` using the
  same byte value the backend computes, then checks `volume inspect` returns the
  option verbatim. The backend treats any difference as fatal. Governed by
  `T3_SANDBOX_VOLUME_STORAGE_QUOTA` (on by default); `disabled` skips this
  check and the enforcement check below, and must be set on the server too.
- **Quota enforcement.** Writes 64 MiB into a volume with a 16 MiB quota and
  demands failure. This is the check that matters: the echo-back above _also
  passes on rootless docker_, where nothing is enforced. Anything less than
  writing past the limit cannot tell the two apart.
- **Internal-network DNS.** Creates an `--internal` network and resolves both a
  peer container's name and the `egress-proxy` alias from inside the workspace
  container. Proves the pinned podman-static runtime (with its bundled netavark
  and aardvark-dns) is the one actually answering, and that no stale distro or
  legacy pinned helper shadows it.
- **Hardened run.** Starts a container with the backend's complete flag set —
  `--read-only`, `--init`, `--cap-drop ALL`, `--security-opt no-new-privileges`,
  `--user 1000:1000`, `--tmpfs /tmp`, `--cpus`, `--memory`, `--pids-limit`.
  Any one of these being unsupported fails provisioning. `--storage-opt size=`
  is deliberately **omitted** by default: `podman --remote` rejects it, so the
  backend leaves it off unless `T3_SANDBOX_CONTAINER_STORAGE_QUOTA=enabled`
  (see `ContainerSandboxBackend.ts`), and this step reads the same variable
  with the same default so the verification mirrors the backend exactly. The
  XFS project quotas on the workspace volumes — proven enforced by the quota
  checks above, and controlled separately by
  `T3_SANDBOX_VOLUME_STORAGE_QUOTA` — are the real disk bound.

  The two are separate variables on purpose. While one switch governed both,
  there was no working bounded setting: enabling quotas made provisioning fail
  on remote podman, and disabling them also discarded the volume quotas that
  work over the socket. A host that set the old single switch to `disabled`
  keeps its volume quotas off after the split: with
  `T3_SANDBOX_VOLUME_STORAGE_QUOTA` unset, both this script and the server
  still honour `T3_SANDBOX_CONTAINER_STORAGE_QUOTA=disabled` as also disabling
  them, and warn to migrate. Full description in
  [sandbox-runtime.md](./sandbox-runtime.md), section "Disk quotas".

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

### Supply chain: the podman-static bundle

The runtime does not come from Ubuntu's archive. Step 2 downloads a release
asset of [`mgoltzsche/podman-static`](https://github.com/mgoltzsche/podman-static)
— a **third-party repackager** of upstream podman, not a containers-project or
distro artifact. This is an explicit, signed-off trust decision, and it is
worth knowing exactly what the pin does and does not prove:

- The script pins SHA256 hashes for the `v5.8.4` amd64 and arm64 tarballs and
  refuses to install on any mismatch. Upstream publishes only a detached GPG
  `.asc` signature per asset, no `sha256sums.txt`.
- The pinned hashes were **captured by hand on 2026-08-18** from downloaded
  copies of the assets whose contents were inspected and then verified working
  on this host. Keyserver access from this host was blocked at the time, so
  the GPG signature was **not** checked. This is trust-on-first-use: the pin
  guarantees every future install gets byte-identical artifacts to the ones
  inspected, not that those artifacts were authentic upstream releases.
- **Re-verify when keyserver access is available.** Upstream's documented
  procedure, using their published signing key fingerprint:

  ```sh
  gpg --keyserver hkps://keyserver.ubuntu.com \
      --recv-keys 0CCF102C4F95D89E583FF1D4F8B5AF50344BB503
  curl -fsSLO https://github.com/mgoltzsche/podman-static/releases/download/v5.8.4/podman-linux-amd64.tar.gz
  curl -fsSLO https://github.com/mgoltzsche/podman-static/releases/download/v5.8.4/podman-linux-amd64.tar.gz.asc
  gpg --batch --verify podman-linux-amd64.tar.gz.asc podman-linux-amd64.tar.gz
  sha256sum podman-linux-amd64.tar.gz   # must match PODMAN_STATIC_SHA256_AMD64 in the script
  ```

  If the signature verifies and the hash matches the script's pin, the TOFU
  gap is closed; record that here. If either fails, treat the host as running
  an unverified runtime and escalate before the next bootstrap run.

- Bumping the pinned version means repeating this: download, verify the `.asc`
  when possible, inspect, update both hashes and the version constant in
  `bootstrap-sandbox-host.sh` together.

## 5. Building the images, and the credential the sandbox runs on

### 5a. Images

The build produces exactly **two** images, both pinned by sha256 digest (the
backend rejects tags):

```sh
deploy/openclaw/sandbox-image/build-sandbox-images.sh
```

- `localhost/t3/sandbox-workspace-headless@sha256:…` → `T3_SANDBOX_IMAGE`
- `localhost/t3/sandbox-sidecar@sha256:…` → **all three** of
  `T3_SANDBOX_PREVIEW_PROXY_IMAGE`, `T3_SANDBOX_EGRESS_PROXY_IMAGE`, and
  `T3_SANDBOX_CREDENTIAL_PROXY_IMAGE`

One sidecar image serves all three roles; the server selects the binary through
the container argv. **There is no separate credential-proxy build output** — do
not go hunting for a third digest. Note the script prints only the workspace,
preview and egress lines, so the credential line has to be copied across by hand.

### 5b. The provider credential

A sandboxed thread has no provider credentials of its own, and the server will
not lend it the host's. `SandboxProviderProcess` strips any persistent provider
credential from the child environment and throws:

```
direct forwarding of persistent provider credential <NAME> is denied;
use a thread-scoped credential proxy
```

**This is deliberate fail-closed behaviour, not a bug to work around.** Setting a
host-level `ANTHROPIC_API_KEY` on the service does not help — it is exactly what
that check rejects. The supported path is the credential proxy sidecar, which
holds the secret and injects it per request so the token never enters the
container.

Two consequences to plan for:

- **The credential proxy makes egress mandatory.** `ThreadCredentialProxySidecar.start()`
  refuses to start without it. Egress is optional _only_ while the credential
  proxy is unset — which is to say, only while no thread can do any work.
- **If `T3_SANDBOX_CREDENTIAL_PROXY_IMAGE` is unset, no sidecar starts**, no proxy
  binding is created, and every provider spawn fails with the error above. On a
  host that has already flipped the one-way switch, that is total loss of service.

Mint a long-lived token as the identity the server should act as:

```sh
claude setup-token
```

Write it to a **root-owned 0600 file** — never into `50-sandbox.conf`, which is
installed world-readable (0644) and tracked in git:

```sh
sudo install -d -o root -g root -m 0755 /etc/command-center
sudo install -o root -g root -m 0600 /dev/null /etc/command-center/sandbox-credentials.env
sudo "${EDITOR:-vi}" /etc/command-center/sandbox-credentials.env
```

One line, no `Environment=` prefix and no quotes (systemd would take the quotes
as part of the value):

```
T3_SANDBOX_ANTHROPIC_AUTH_TOKEN=sk-ant-oat01-…
```

`T3_SANDBOX_ANTHROPIC_API_KEY` works as an alternative if you have a plain API
key rather than a subscription token; the proxy sends it as `x-api-key` instead
of a bearer. The bootstrap script never creates, reads, or rewrites this file.

**Rotation** is editing the file and restarting the service. Slice 2 re-resolves
the secret per session, so no thread state is involved and nothing needs
migrating:

```sh
sudo "${EDITOR:-vi}" /etc/command-center/sandbox-credentials.env
sudo systemctl restart command-center.service
```

## 6. The production flip

> **This is a one-way switch.** `ProviderCommandReactor.ensureExecutionTarget`
> takes the legacy-host fallback only while `T3_SANDBOX_IMAGE` or
> `T3_SANDBOX_PREVIEW_PROXY_IMAGE` is unset. The moment both are set, that
> fallback is gone and **every new thread on this host** must successfully
> provision a container or it cannot start at all. A bad digest, an unreachable
> registry, or a podman socket that failed to come back after a reboot then means
> no thread can start work. A missing credential proxy has the same effect one
> step later: the container starts and the provider refuses to spawn.

Canary on a scratch instance first — never flip production blind.

### 6a. Canary

Run a second server on a different port with a separate base directory, so it
shares the host and the container runtime but none of the production state:

```sh
sudo -u commandcenter env HOME=/var/lib/command-center \
  PATH=/opt/command-center/bin:/usr/local/bin:/usr/bin:/bin \
  T3_SANDBOX_RUNTIME=podman \
  T3_SANDBOX_IMAGE=localhost/t3/sandbox-workspace-headless@sha256:… \
  T3_SANDBOX_PREVIEW_PROXY_IMAGE=localhost/t3/sandbox-sidecar@sha256:… \
  T3_SANDBOX_CREDENTIAL_PROXY_IMAGE=localhost/t3/sandbox-sidecar@sha256:… \
  T3_SANDBOX_EGRESS_PROXY_IMAGE=localhost/t3/sandbox-sidecar@sha256:… \
  T3_SANDBOX_ANTHROPIC_AUTH_TOKEN="$(sudo sed -n 's/^T3_SANDBOX_ANTHROPIC_AUTH_TOKEN=//p' \
    /etc/command-center/sandbox-credentials.env)" \
  T3_SANDBOX_DESKTOP=disabled \
  /usr/local/bin/node /opt/command-center/current/apps/server/dist/bin.mjs serve \
    --base-dir /var/lib/command-center/canary --port 3899 --host 127.0.0.1 --no-browser
```

The last three sidecar digests are the same value — see section 5a. The canary is
where you find out whether the credential path works, so do not skip the token:
without it the containers come up and the first turn dies at provider spawn,
which is precisely the failure the canary exists to catch.

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
  `Environment=T3_SANDBOX_PREVIEW_PROXY_IMAGE=…` with the digests from section 5a.
- `Environment=T3_SANDBOX_CREDENTIAL_PROXY_IMAGE=…` and
  `Environment=T3_SANDBOX_EGRESS_PROXY_IMAGE=…` — **not optional.** Both carry the
  same sidecar digest as the preview proxy. Without the credential proxy every
  thread fails at provider spawn; the credential proxy in turn refuses to start
  without egress.
- `EnvironmentFile=-/etc/command-center/sandbox-credentials.env` — the token from
  section 5b. Safe to uncomment before the file exists (the `-` prefix keeps the
  unit starting).
- Optionally `T3_SANDBOX_ARTIFACT_DIR`, `T3_SANDBOX_DESKTOP=disabled`,
  `T3_SANDBOX_GIT_USER_NAME`, `T3_SANDBOX_GIT_USER_EMAIL`.

The minimum working set is **five `Environment=` lines plus the credential
file**, not two. Uncommenting only the two images produces a host where every
thread provisions a container and then cannot run its provider.

Disabling the desktop stack for the first flip is recommended; it removes a large
moving part from the critical path of starting a thread.

With `T3_SANDBOX_DESKTOP=disabled`, the thread's Sandbox panel (right panel →
`+` → Sandbox) reports the desktop as unavailable and hides the viewer and
"Take control". Stop and export stay available there — that panel is the only
place to release a sandbox or pull its branch bundle out, so operators should
know where it lives before the flip.

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

**"direct forwarding of persistent provider credential … is denied" means the
credential proxy is off, not that the credential is wrong.** Containers start,
the thread looks healthy, and the turn dies at provider spawn. Check
`T3_SANDBOX_CREDENTIAL_PROXY_IMAGE` is set, `T3_SANDBOX_EGRESS_PROXY_IMAGE` is
set alongside it, and the credential file is present and non-empty. Do not
"fix" it by exporting a provider key into the service environment — that is the
condition the error is reporting.

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
(`kernel.apparmor_restrict_unprivileged_userns=1`). Ubuntu's stock profiles
cover only `/usr/bin/podman` and `rootlesskit`; the pinned runtime lives at
`/usr/local/bin/podman`, which unprofiled would fail to start any rootless
container, with a confusing permission error. Step 2 therefore installs
`/etc/apparmor.d/podman-static` — modeled on the stock `podman` profile:
`flags=(unconfined)` plus the `userns` grant, nothing else — whenever AppArmor
is active and the restriction sysctl is 1, and reloads it with
`apparmor_parser -r` only when the content changed. Verification step 8a
(`podman info` as the service user through the wrapper) is the assertion that
catches a missing or unloaded profile. If rootless podman ever fails with
`EPERM` creating user namespaces after a kernel or AppArmor update, check that
profile is still loaded before debugging anything else.
