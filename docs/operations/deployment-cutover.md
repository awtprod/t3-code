# Deployment, cutover, and rollback gate

Production state belongs under `~/.command-center`, outside Git. The default server bind is
`127.0.0.1:4530`; the example unit never enables Tailscale Serve and never listens on a public
interface. If Tailnet access is desired, keep that routing separately managed and limited to the
Tailnet. Do not add a public listener to the service unit.

The operations utilities are deliberately unable to call `systemctl`, change routing, stop a process,
restore a database, or perform a cutover. They create an immutable rollback record and return a
read-only readiness decision. A successful report means only that a human may begin the separately
reviewed cutover procedure.

## 1. Prepare private state

Create the runtime directory and its config subdirectory with owner-only permissions. Keep the
private configuration checkout adjacent at `~/.command-center-config`, or set
`COMMAND_CENTER_CONFIG_DIR` in the owner-only environment file. Credentials, databases, logs,
attachments, memory indexes, and worktrees stay under the runtime directory and never enter either
repository.

The service account must exclusively own the private checkout, with directories mode `0700` and
files mode `0600` except Git's own executable helpers. The example unit grants that checkout write
access because the automation editor atomically updates one definition and creates a local commit.
It does not push. If `COMMAND_CENTER_CONFIG_DIR` points elsewhere, add that exact checkout to a
reviewed `ReadWritePaths=` override; otherwise saves will correctly fail under `ProtectSystem`.

Copy `examples/systemd/command-center.service` to the user systemd unit directory and review the
binary path, hardening, runtime paths, and port. Copy `examples/systemd/server.env.example` to
`~/.command-center/config/server.env` with mode `0600`. The environment example is intentionally
non-secret; credentials belong in the runtime credential store.

Do not enable or start the example unit yet. Do not alter existing services or Tailnet routing.

## 2. Require a completed backup

Use the selective migration staging process in `scripts/command-center/README.md`. Its applied bundle
must have a completed backup manifest whose file digests still match. Preserve the old database,
memory, automation files, service definitions, timers, and routing definitions. Delete nothing.

Generate a rollback manifest first in preview mode. Repeat `--legacy-service` and
`--state-definition` for every legacy unit and definition needed to restore the old deployment:

```sh
node scripts/command-center/rollback-manifest.ts \
  --backup-manifest /absolute/staging/manifest.json \
  --runtime-dir /absolute/runtime \
  --legacy-service legacy-console.service \
  --state-definition /absolute/legacy-console.service
```

After reviewing the preview, write it to a new private path. Existing files are never overwritten:

```sh
node scripts/command-center/rollback-manifest.ts \
  --backup-manifest /absolute/staging/manifest.json \
  --runtime-dir /absolute/runtime \
  --legacy-service legacy-console.service \
  --state-definition /absolute/legacy-console.service \
  --output /absolute/private/rollback-manifest.json \
  --write --confirm-reviewed
```

## 3. Rehearse and run the gate

Start only an isolated candidate against the isolated runtime and verify representative read-only
flows. The candidate endpoint in the rollback manifest must be loopback. Then run:

```sh
node scripts/command-center/deployment-preflight.ts \
  --rollback-manifest /absolute/private/rollback-manifest.json \
  --minimum-free-gib 5 \
  --output /absolute/private/preflight-report.json
```

The gate verifies the completed backup and every backup digest, rollback-definition snapshots,
non-Git runtime boundary, loopback-only endpoint, available disk, and live candidate health. The
default disk floor is 5 GiB. A missing or changed backup, a changed rollback definition, low disk, a
public bind, or failed health produces `cutover-refused` and a nonzero exit. Fix the prerequisite and
generate a fresh reviewed manifest; never bypass a failed check.

## 4. Manual cutover and rollback

Only an operator-approved `ready-for-manual-cutover` report permits the manual service-manager and
Tailnet steps. Immediately verify authenticated browser and Electron access, routing, connection
health, and representative acceptance prompts. Stop shared infrastructure only after dependency
inspection proves it is exclusive to the legacy console.

Rollback on any health, access, routing, or provenance failure. Follow the manifest's ordered manual
steps: stop the target, restore only digest-verified definitions and data to confirmed paths, restart
the recorded legacy units, restore the prior private routing definition, and verify legacy health.
Preserve the failed target state and reports for diagnosis. Delete nothing during cutover or rollback.
