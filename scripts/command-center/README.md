# Selective migration staging

This directory contains a deliberately narrow migration tool for moving useful legacy data into a
reviewable staging bundle. It does not import directly into an application database, manipulate a
service manager, or delete source data.

The allowlist is intentionally small:

- coding session and specification flow summaries become read-only archive records;
- memory chunks become an **untrusted** rebuildable memory-index input with source provenance;
- valid JSON automation definitions are copied with `enabled: false`;
- job, run, browser, approval, capture-queue, checkpoint, embedding, and other operational history is
  classified as skipped.

## Dry run

All paths must be explicit and absolute. Dry run is the default and does not create the target.

```sh
node scripts/command-center/migrate.ts \
  --state-db /absolute/path/to/state.sqlite \
  --memory-db /absolute/path/to/memory.sqlite \
  --automations-dir /absolute/path/to/automations \
  --alias-map /absolute/path/to/aliases.json \
  --exclude-automation examples/placeholder.json \
  --target /absolute/path/to/new-staging-directory
```

The alias file is a JSON object (or an object with an `aliases` property) mapping an exact legacy
source label to its stable replacement label:

```json
{
  "aliases": {
    "Legacy Workspace": "current-space"
  }
}
```

Alias matching is case-insensitive and collapses whitespace. Every imported record retains the
original label, resolved label, whether an alias was applied, source table/key, and a source-row
digest.

## Apply to an isolated bundle

After reviewing the dry-run manifest, repeat the command with `--apply`. Apply mode is accepted only
when the target is absent or an empty real directory. It creates:

```text
manifest.json
backups/state.sqlite
backups/memory.sqlite
backups/automations/...
imports/archive-records.jsonl
imports/untrusted-memory-index.jsonl
imports/disabled-automations.jsonl
```

The SQLite backups are consistent snapshots made through SQLite's backup API. Automation backups
retain the exact source bytes, including definitions explicitly excluded from import. The manifest
records checksums for every backup and import file, classifications, manual cutover preconditions,
and a manual rollback procedure. It never executes those cutover or rollback actions. Keep the
generated bundle in private storage because it can contain personal or operational source data.

## Import into an isolated target

Run the importer in dry-run mode after the new target database has completed its application
migrations and loaded its private Spaces:

```sh
node scripts/command-center/import.ts \
  --bundle /absolute/path/to/reviewed-staging-bundle \
  --database /absolute/path/to/isolated-command-center.sqlite \
  --space-map /absolute/path/to/private-space-map.json
```

The private Space map is a JSON object from legacy/resolved labels to stable target Space IDs. An
optional `--default-space` handles records with no source label. Dry run verifies the target, all
import digests and counts, disabled automation state, and Space resolution without writing anything.

After the isolated target service is stopped, apply with a new rollback-backup path:

```sh
node scripts/command-center/import.ts \
  --bundle /absolute/path/to/reviewed-staging-bundle \
  --database /absolute/path/to/isolated-command-center.sqlite \
  --space-map /absolute/path/to/private-space-map.json \
  --apply --confirm-target-offline \
  --backup /absolute/path/to/absent-target-before-import.sqlite
```

Only read-only archive Artifacts and untrusted archive Memory are inserted. The importer records a
hash-chained audit entry and an idempotency receipt. Imported automation definitions remain disabled
in the private adapter-review workflow; they are never enabled or executed by the importer.

## Deployment safety gate

Migration completion does not authorize cutover. After reviewing the staged bundle, use
`rollback-manifest.ts` to bind its verified backup digests to snapshots of the legacy service and
routing definitions. Then use `deployment-preflight.ts` to verify those snapshots, the non-Git
runtime boundary, at least 5 GiB of free disk by default, loopback-only binding, and live candidate
health.

Both tools are manual-only by construction: neither contains service-manager, routing, restore, or
cutover operations. The preflight exits nonzero with `cutover-refused` when any prerequisite fails.
See `docs/operations/deployment-cutover.md` for the complete rehearsal and rollback procedure and
the hardened user-systemd example in `examples/systemd/`.

## Upstream sync

`upstream-sync.ts plan` verifies an exact upstream ref and full expected commit against the pinned
public baseline without fetching or writing Git state. The dispatch-only GitHub workflow owns merge,
verification, branch push, and draft PR creation. See `docs/operations/upstream-sync.md`.
