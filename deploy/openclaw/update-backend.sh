#!/bin/sh
# update-backend.sh — fetch, build, and activate the latest backend release on this host.
#
# Orchestrates the full update that install-release.sh deliberately stops short of:
#   fetch origin/main -> stage source -> install-release.sh (build + symlink flip)
#   -> quiet gate -> online DB backup -> systemctl restart -> health check
#   -> automatic rollback (symlink + DB) if the new release fails its health check.
#
# A restart interrupts any agent turn that is in flight (sessions are in-process
# and the server settles orphaned turns instead of resuming them), so the restart
# is gated: it proceeds automatically only when zero turns are running, prompts
# for confirmation on a TTY otherwise, and defers (exit 75) when non-interactive.
#
# CAVEAT: if this script is launched from a Command Center thread, that thread
# itself counts as a running turn and the gate will never see quiet. Run it from
# ssh/cron, or pass --yes.
#
# Flags:
#   --check-only     report pending commit + running-turn count, change nothing
#   --commit <sha>   deploy a specific commit instead of the origin/main tip
#   --yes            restart even if turns are running (no prompt)
#   --wait <secs>    poll for quiet up to <secs> before prompting/deferring
#   --no-restart     stage + install only; do not restart the service
#
# Exit codes:
#   0  updated (or already up to date / check-only)
#  64  usage error
#  65  preflight or update-step failure (service untouched)
#  75  deferred: turns running and no confirmation available; re-run later
#  30  new release failed health check; rollback succeeded
#  40  rollback also failed — manual intervention required
set -eu

LOG=${CC_UPDATE_LOG:-/var/log/command-center-update.log}
LOCK=/var/run/command-center-update.lock
REPO=${CC_UPDATE_REPO:-/srv/command-center/workspaces/awtprod/t3-code}
CURRENT=/opt/command-center/current
RELEASES=/opt/command-center/releases
STAGING_PREFIX=/srv/command-center-release-
DB=/var/lib/command-center/runtime/userdata/state.sqlite
SERVICE=command-center.service
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:3773/}
HEALTH_TIMEOUT=60
NODE=/usr/local/bin/node
KEEP_RELEASES=5
KEEP_BACKUPS=5
KEEP_STAGING=3
QUIET_POLL_INTERVAL=30

# Re-exec once so everything (including installer/pnpm output) lands in the log
# without losing the exit code (POSIX sh has no pipefail).
if [ "${CC_UPDATE_INNER:-}" != 1 ]; then
  rcf=$(mktemp)
  { rc=0; CC_UPDATE_INNER=1 sh "$0" "$@" 2>&1 || rc=$?; echo "$rc" >"$rcf"; } | tee -a "$LOG"
  rc=$(cat "$rcf")
  rm -f "$rcf"
  exit "${rc:-1}"
fi

log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
fail() { log "ERROR: $*"; exit 65; }

usage() {
  sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'
}

CHECK_ONLY=0 ASSUME_YES=0 WAIT_SECS=0 NO_RESTART=0 TARGET_COMMIT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check-only) CHECK_ONLY=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --wait)
      shift
      case "${1:-}" in ''|*[!0-9]*) echo "--wait requires seconds" >&2; exit 64 ;; esac
      WAIT_SECS=$1 ;;
    --commit)
      shift
      [ -n "${1:-}" ] || { echo "--commit requires a sha" >&2; exit 64; }
      TARGET_COMMIT=$1 ;;
    --no-restart) NO_RESTART=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown flag: $1" >&2; usage >&2; exit 64 ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || fail "must run as root"

exec 9>"$LOCK"
flock -n 9 || fail "another update is already running (lock: $LOCK)"

# --- helpers ---------------------------------------------------------------

# Run git in the checkout as its owning user so root does not litter .git with
# root-owned objects (the checkout is a working user workspace, not ours).
REPO_OWNER=$(stat -c %U "$REPO")
repo_git() {
  if [ "$REPO_OWNER" = root ]; then
    git -C "$REPO" "$@"
  else
    /usr/sbin/runuser -u "$REPO_OWNER" -- git -C "$REPO" "$@"
  fi
}

# Count turns the server itself would consider running. Mirrors the orphan
# predicate in ProviderRuntimeIngestion (active_turn_id set, or latest turn in
# a non-settled state per ProjectionSnapshotQuery.mapLatestTurn). No sqlite3
# CLI on this host, so use Node's built-in node:sqlite, read-only.
running_turns() {
  CC_DB="$DB" "$NODE" --no-warnings <<'EOF'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.CC_DB, { readOnly: true });
const row = db.prepare(`
  SELECT COUNT(*) AS n FROM projection_threads t
  LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
  LEFT JOIN projection_turns turns
    ON turns.thread_id = t.thread_id AND turns.turn_id = t.latest_turn_id
  WHERE t.deleted_at IS NULL
    AND (s.active_turn_id IS NOT NULL
         OR (t.latest_turn_id IS NOT NULL
             AND turns.state NOT IN ('error','interrupted','completed')))
`).get();
console.log(Number(row.n));
EOF
}

# Online backup of the live WAL-mode DB (plain cp would race the WAL), then
# integrity-check the copy. Aborts the update (before any restart) on failure.
backup_db() {
  CC_DB="$DB" CC_BAK="$1" "$NODE" --no-warnings <<'EOF'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.CC_DB, { readOnly: true });
db.exec(`VACUUM INTO '${process.env.CC_BAK}'`);
db.close();
const bak = new DatabaseSync(process.env.CC_BAK, { readOnly: true });
const row = bak.prepare("PRAGMA quick_check").get();
const verdict = String(Object.values(row)[0]);
if (verdict !== "ok") {
  console.error("quick_check failed:", verdict);
  process.exit(1);
}
console.log("backup quick_check ok");
EOF
}

wait_healthy() {
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -sf -o /dev/null --max-time 5 "$HEALTH_URL" \
        && systemctl is-active --quiet "$SERVICE"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# --- preflight -------------------------------------------------------------

command -v flock >/dev/null || fail "flock not found"
command -v curl >/dev/null || fail "curl not found"
[ -x "$NODE" ] || fail "node not found at $NODE"
[ -f "$DB" ] || fail "state db not found at $DB"
[ -d "$REPO/.git" ] || fail "repo checkout not found at $REPO"

if systemctl is-active --quiet command-center.candidate.service; then
  fail "command-center.candidate.service is active; refusing to update"
fi

node_major=$("$NODE" -v | sed 's/^v\([0-9]*\).*/\1/')
want_node=$(sed -n 's/.*"node": *"[^0-9]*\([0-9]*\).*/\1/p' "$REPO/package.json" | head -1)
if [ -n "$want_node" ] && [ "$node_major" != "$want_node" ]; then
  fail "node major $node_major does not match engines pin $want_node (native module rebuild hazard)"
fi

pnpm_pin=$(sed -n 's/.*"packageManager": *"pnpm@\([0-9.]*\)".*/\1/p' "$REPO/package.json")
pnpm_have=$(/usr/local/bin/pnpm --version 2>/dev/null || echo unknown)
if [ -n "$pnpm_pin" ] && [ "${pnpm_have%%.*}" != "${pnpm_pin%%.*}" ]; then
  log "WARNING: pnpm $pnpm_have differs from packageManager pin $pnpm_pin (has worked historically; continuing)"
fi

for mount in /opt /srv; do
  avail_kb=$(df -Pk "$mount" | awk 'NR==2 {print $4}')
  [ "$avail_kb" -ge $((5 * 1024 * 1024)) ] \
    || fail "less than 5 GB free on $mount (${avail_kb} KB); refusing to build"
done

# --- resolve target commit -------------------------------------------------

log "fetching origin in $REPO (as $REPO_OWNER)"
repo_git fetch origin --quiet

if [ -n "$TARGET_COMMIT" ]; then
  commit=$(repo_git rev-parse --verify "$TARGET_COMMIT^{commit}") \
    || fail "cannot resolve --commit $TARGET_COMMIT"
else
  commit=$(repo_git rev-parse --verify origin/main^{commit})
fi

old_target=$(readlink -f "$CURRENT")
current_commit=$(basename "$old_target")

if [ "$CHECK_ONLY" -eq 1 ]; then
  turns=$(running_turns)
  log "current release: $current_commit"
  log "target release:  $commit"
  if [ "$current_commit" = "$commit" ]; then
    log "status: up to date"
  else
    log "status: update available"
  fi
  log "running turns: $turns"
  exit 0
fi

if [ "$current_commit" = "$commit" ]; then
  log "already running $commit; nothing to do"
  exit 0
fi

# --- stage + install (zero downtime: old process keeps running) -------------

source_dir=$STAGING_PREFIX$commit
target=$RELEASES/$commit

if [ -d "$target" ]; then
  log "release $commit already installed at $target; skipping build"
else
  if [ -f "$source_dir/package.json" ]; then
    log "staged source already present at $source_dir"
  else
    log "staging source for $commit at $source_dir"
    rm -rf "$source_dir"
    mkdir -p "$source_dir"
    repo_git archive "$commit" | tar -x -C "$source_dir"
  fi

  installer=$source_dir/deploy/openclaw/install-release.sh
  [ -f "$installer" ] || fail "staged source has no install-release.sh"

  # CI=true: pnpm's purge prompt otherwise aborts silently without a TTY and
  # leaves node_modules half-installed on this host.
  log "building and installing release $commit (this can take a while)"
  rc=0
  CI=true sh "$installer" "$commit" || rc=$?
  case "$rc" in
    0) ;;
    73) log "installer reports release already exists; continuing" ;;
    *) fail "install-release.sh failed with exit $rc" ;;
  esac
fi

# The installer flips the symlink itself; re-flip for the already-installed
# path (e.g. after a rollback the release dir exists but current points back).
ln -sfn "$target" "$CURRENT"

if [ "$NO_RESTART" -eq 1 ]; then
  log "release $commit installed and selected; --no-restart set, service untouched"
  log "restart later with: systemctl restart $SERVICE (the old code keeps running until then)"
  exit 0
fi

# --- quiet gate ------------------------------------------------------------

turns=$(running_turns)
if [ "$turns" -gt 0 ] && [ "$WAIT_SECS" -gt 0 ]; then
  log "$turns turn(s) running; waiting up to ${WAIT_SECS}s for quiet"
  wait_deadline=$(( $(date +%s) + WAIT_SECS ))
  while [ "$turns" -gt 0 ] && [ "$(date +%s)" -lt "$wait_deadline" ]; do
    sleep "$QUIET_POLL_INTERVAL"
    turns=$(running_turns)
    log "running turns: $turns"
  done
fi

if [ "$turns" -gt 0 ] && [ "$ASSUME_YES" -ne 1 ]; then
  if [ -t 0 ]; then
    printf '%s turn(s) are still running; restarting will interrupt them. Restart anyway? [y/N] ' "$turns"
    read -r answer || answer=n
    case "$answer" in
      y|Y|yes|YES) ;;
      *)
        log "deferred: $turns turn(s) running, restart declined; release stays staged, re-run later"
        exit 75 ;;
    esac
  else
    log "deferred: $turns turn(s) running and no TTY; re-run later or pass --yes"
    exit 75
  fi
fi

# --- backup, restart, health check -----------------------------------------

backup=$DB.pre-$commit.bak
log "backing up state db to $backup"
rm -f "$backup"
backup_db "$backup" || fail "db backup failed; aborting before restart"
chown --reference="$DB" "$backup"

# prune old backups (keep newest KEEP_BACKUPS)
ls -1t "$DB".pre-*.bak 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | while read -r b; do
  log "pruning old backup $b"
  rm -f "$b"
done

log "restarting $SERVICE (release $commit)"
systemctl restart "$SERVICE" || true

if wait_healthy; then
  log "health check passed; $SERVICE is serving release $commit"
else
  log "HEALTH CHECK FAILED for release $commit; rolling back to $current_commit"
  systemctl stop "$SERVICE" || true
  ln -sfn "$old_target" "$CURRENT"
  # The failed release may have run migrations at boot; restore the pre-restart
  # snapshot. cp onto the existing file preserves its inode and ownership.
  rm -f "$DB-wal" "$DB-shm"
  cp -f "$backup" "$DB"
  systemctl start "$SERVICE" || true
  if wait_healthy; then
    log "rollback succeeded; $SERVICE is serving previous release $current_commit"
    log "the failed release remains at $target for inspection"
    exit 30
  else
    log "FATAL: ROLLBACK FAILED — $SERVICE is not healthy on $current_commit; manual intervention required"
    log "db backup preserved at $backup"
    exit 40
  fi
fi

# --- prune -----------------------------------------------------------------

ls -1t "$RELEASES" 2>/dev/null | grep -E '^[0-9a-f]{40}$' \
  | tail -n +$((KEEP_RELEASES + 1)) | while read -r rel; do
  [ "$RELEASES/$rel" = "$target" ] && continue
  [ "$RELEASES/$rel" = "$old_target" ] && continue
  log "pruning old release $RELEASES/$rel"
  rm -rf "$RELEASES/$rel"
done

# shellcheck disable=SC2012
ls -1dt "$STAGING_PREFIX"* 2>/dev/null | tail -n +$((KEEP_STAGING + 1)) | while read -r stage; do
  case "$stage" in
    "$STAGING_PREFIX"*) log "pruning old staging dir $stage"; rm -rf "$stage" ;;
  esac
done

log "update complete: $current_commit -> $commit"
exit 0
