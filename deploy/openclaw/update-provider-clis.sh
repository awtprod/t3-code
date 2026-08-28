#!/bin/sh
# update-provider-clis.sh — bump the pinned, root-owned provider CLIs and
# restart the service to pick them up.
#
# /opt/command-center is normally mounted read-only, so a live update is:
# remount rw -> install-provider-clis.sh (pinned npm install, then re-locks
# the tree root-owned + read-only) -> remount ro -> systemctl restart.
#
# A restart interrupts any agent turn in flight (sessions are in-process and
# the server settles orphaned turns instead of resuming them), so the restart
# is gated exactly like update-backend.sh: proceeds automatically when zero
# turns are running, prompts for confirmation on a TTY otherwise, and defers
# (exit 75) when non-interactive.
#
# CAVEAT: if this script is launched from a Command Center thread, that
# thread itself counts as a running turn and the gate will never see quiet.
# Run it from ssh/cron, or pass --yes.
#
# Flags:
#   --check-only   report running-turn count and installed versions, change nothing
#   --yes          restart even if turns are running (no prompt)
#   --wait <secs>  poll for quiet up to <secs> before prompting/deferring
#
# Exit codes:
#   0  updated (or check-only)
#  64  usage error
#  65  preflight or update-step failure
#  66  updated and restarted, but the mount could not be confirmed read-only
#      afterward — providers are on the new version; remount manually:
#      mount -o remount,ro /opt/command-center
#  75  deferred: turns running and no confirmation available; re-run later
set -eu

LOG=${CC_UPDATE_LOG:-/var/log/command-center-provider-update.log}
LOCK=/var/run/command-center-provider-update.lock
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALL_SCRIPT=$SCRIPT_DIR/install-provider-clis.sh
OPT_MOUNT=/opt/command-center
DB=/var/lib/command-center/runtime/userdata/state.sqlite
SERVICE=command-center.service
NODE=/usr/local/bin/node
QUIET_POLL_INTERVAL=30

# Re-exec once so everything (including the npm install output) lands in the
# log without losing the exit code (POSIX sh has no pipefail).
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

CHECK_ONLY=0 ASSUME_YES=0 WAIT_SECS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check-only) CHECK_ONLY=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --wait)
      shift
      case "${1:-}" in ''|*[!0-9]*) echo "--wait requires seconds" >&2; exit 64 ;; esac
      WAIT_SECS=$1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown flag: $1" >&2; usage >&2; exit 64 ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || fail "must run as root"
[ -x "$INSTALL_SCRIPT" ] || fail "missing $INSTALL_SCRIPT"
[ -x "$NODE" ] || fail "node not found at $NODE"
[ -f "$DB" ] || fail "state db not found at $DB"
command -v flock >/dev/null || fail "flock not found"

exec 9>"$LOCK"
flock -n 9 || fail "another provider update is already running (lock: $LOCK)"

report_versions() {
  for provider in codex claude kimi; do
    installed=$("$OPT_MOUNT/provider-cli/node_modules/.bin/$provider" --version 2>/dev/null || echo "not installed")
    log "$provider: $installed"
  done
}

# First mount option for $OPT_MOUNT from /proc/mounts ("ro" or "rw"). Used
# instead of trusting `mount`'s exit code alone, since remount can race a
# just-closed write handle (e.g. npm/postinstall settling) and report EBUSY
# for a mount that clears moments later.
mount_option() {
  awk -v t="$OPT_MOUNT" '$2 == t { print $4; exit }' /proc/mounts | cut -d, -f1
}

# Count turns the server itself would consider running: mirrors the orphan
# predicate in ProviderRuntimeIngestion (active_turn_id set, or latest turn in
# a non-settled state). Same query update-backend.sh uses to gate its
# restart — reused here rather than a bespoke check so both scripts agree on
# what "active" means. No sqlite3 CLI on this host, so read-only node:sqlite.
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

if [ "$CHECK_ONLY" -eq 1 ]; then
  turns=$(running_turns)
  log "running turns: $turns"
  report_versions
  exit 0
fi

# --- quiet gate --------------------------------------------------------

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
    printf '%s turn(s) are still running; updating providers requires a restart that will interrupt them. Continue anyway? [y/N] ' "$turns"
    read -r answer || answer=n
    case "$answer" in
      y|Y|yes|YES) ;;
      *)
        log "deferred: $turns turn(s) running, restart declined; nothing changed, re-run later"
        exit 75 ;;
    esac
  else
    log "deferred: $turns turn(s) running and no TTY; nothing changed, re-run later or pass --yes"
    exit 75
  fi
fi

# --- remount rw, install, remount ro ------------------------------------

log "remounting $OPT_MOUNT read-write"
mount -o remount,rw "$OPT_MOUNT" || fail "failed to remount $OPT_MOUNT read-write; nothing changed"

# Never returns non-zero (this runs from an EXIT trap under `set -e`, where a
# failing trap command has inconsistent, shell-dependent effects on the exit
# code). Success/failure is instead recorded in $mount_ro_ok for the caller
# to check explicitly.
remounted_ro=0 mount_ro_ok=0
remount_ro() {
  if [ "$remounted_ro" -eq 1 ]; then
    return 0
  fi
  remounted_ro=1

  log "remounting $OPT_MOUNT read-only"
  attempt=1
  while [ "$attempt" -le 5 ]; do
    if mount -o remount,ro "$OPT_MOUNT" 2>&1; then
      mount_ro_ok=1
      return 0
    fi
    [ "$attempt" -lt 5 ] && log "remount read-only attempt $attempt failed (mount busy?); retrying in 2s"
    sleep 2
    attempt=$((attempt + 1))
  done

  if [ "$(mount_option)" = "ro" ]; then
    log "remount read-only reported failure but $OPT_MOUNT is ro now; continuing"
    mount_ro_ok=1
    return 0
  fi
  log "WARNING: failed to remount $OPT_MOUNT read-only after 5 attempts; fix this manually"
  return 0
}
trap remount_ro EXIT

log "running $INSTALL_SCRIPT"
if ! sh "$INSTALL_SCRIPT"; then
  fail "install-provider-clis.sh failed; $OPT_MOUNT will be restored read-only, service left untouched"
fi

remount_ro
trap - EXIT

# --- restart --------------------------------------------------------------

log "restarting $SERVICE"
systemctl restart "$SERVICE" \
  || fail "restart failed; provider CLIs are updated on disk but $SERVICE may still be running old binaries"

report_versions

if [ "$mount_ro_ok" -eq 1 ]; then
  log "update complete; $OPT_MOUNT is read-only"
  exit 0
fi

log "update complete, but $OPT_MOUNT is still $(mount_option) -- remount manually: mount -o remount,ro $OPT_MOUNT"
exit 66
