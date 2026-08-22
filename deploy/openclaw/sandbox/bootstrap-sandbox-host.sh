#!/bin/bash
# Prepare this host to run per-thread container sandboxes for Command Center.
#
# Bash, not sh: the verification section needs arrays and process substitution to
# mirror the backend's argv exactly rather than re-quoting it through a string.
#
# Everything here is root-required and idempotent. Re-running is safe and is the
# supported way to repair a partial run. Each numbered step is independently
# re-runnable; STEPS=5,8 runs only those.
#
# This script does NOT enable sandboxing. It installs the runtime, proves it
# works, and leaves the systemd drop-in fully commented out. Turning sandboxing
# on is a separate, deliberate operator action -- see docs/operations/sandbox-host.md.
set -euo pipefail

readonly SERVICE_USER=commandcenter
readonly SERVICE_UID=986
# gid is 984, deliberately not equal to the uid on this host. Never assume they match.
readonly SERVICE_GID=984
readonly SERVICE_HOME=/var/lib/command-center
readonly SANDBOX_MOUNT=/var/lib/command-center/sandbox
readonly SANDBOX_IMAGE_FILE=/var/lib/command-center/sandbox-storage.img
readonly WRAPPER_DIR=/opt/command-center/bin
readonly DROPIN_DIR=/etc/systemd/system/command-center.service.d
# Referenced by the drop-in as `EnvironmentFile=-`, holds the provider token.
# This script never creates or reads it: it is a secret, and a bootstrap script
# that writes secrets is one that leaks them into logs and backups.
readonly CREDENTIALS_FILE=/etc/command-center/sandbox-credentials.env
readonly RUNTIME_SOCKET_DIR=/run/user/986/podman
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SOURCE_DIR

# Size of the XFS loopback image, in GiB. The file is created sparse, so it
# consumes only what the containers actually write -- but it can grow to this
# size, and if the underlying ext4 filesystem fills first, writes inside the
# sandbox fail in confusing ways. Default 40G against ~78G free. Override with
# SANDBOX_IMAGE_SIZE_GIB=80 if you have grown the volume.
SANDBOX_IMAGE_SIZE_GIB="${SANDBOX_IMAGE_SIZE_GIB:-40}"
# Refuse to create the image if doing so would leave the root filesystem with
# less than this much headroom, counting the image at its full (not sparse) size.
readonly FREE_SPACE_MARGIN_GIB=15

# Pinned podman runtime. Apt's podman 4.9.3 + netavark 1.14.0 (Ubuntu 24.04) has
# a structural bug in rootless podman's shared per-UID rootless-netns pause
# namespace: it never bind-mounts a custom network's actual JSON config into its
# view for graphroots under /var/lib-class paths (only netavark.lock ever shows
# up there), so `podman run --network <custom>` fails with "network not found"
# once the pause process is already alive from an earlier network -- not a
# netavark-version/DNS-threshold issue, so no empirical "does the distro version
# already work" probe can catch it (the probe network is often the first one
# created, before the bug's precondition holds).
#
# podman v5.8.4 via the mgoltzsche/podman-static static bundle (bundled netavark
# 1.17.2) fixes both this and internal-network DNS; verified directly on this
# host against a /var/lib-class graphroot with the pause process already live.
#
# NOTE ON VERIFICATION: upstream publishes only a detached GPG .asc signature
# for this release, no sha256sums.txt, and this host's keyserver access is
# blocked. These hashes were captured by hand (2026-08-18) from a downloaded,
# inspected copy of the release assets and pinned here; there is no GPG
# signature check. This is trust-on-first-use of a third-party repackager --
# the explicit sign-off, the upstream signing-key fingerprint, and the
# re-verification procedure for when keyserver access is available live in
# docs/operations/sandbox-host.md, section "Supply chain".
readonly PODMAN_STATIC_VERSION=v5.8.4
readonly PODMAN_STATIC_SHA256_AMD64=a58765fe8be6ab3fb79f892f1a027b4ce4a7e8eb589df1ef960c167cbde08d69
readonly PODMAN_STATIC_SHA256_ARM64=a2f6b73cc0f7018e2e8518338a4ec27db70148e1af86e16719235605aefd1df3
# Every file a bundle places under /usr/local is recorded here, so the next
# upgrade can remove exactly what the previous one installed (a bare cp merge
# can never delete, so a future bundle that drops a helper binary would leave
# the old copy first on podman's search path forever).
readonly PODMAN_STATIC_MANIFEST_DIR=/usr/local/share/podman-static

# Image used by the verification step only. Never used at runtime by the server.
# Pinned by digest so a compromised tag cannot change what we execute as the
# service user. Override for an air-gapped host with a local mirror.
VERIFY_IMAGE="${VERIFY_IMAGE:-docker.io/library/alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc}"

# Two independent quota controls, mirroring the backend exactly (see
# ContainerSandboxBackend.ts and 50-sandbox.conf). They used to be one switch
# here and in the backend, which left no working bounded configuration: over
# `podman --remote` the container flag is rejected outright, and turning it off
# also threw away the volume quotas that do work.
#
# T3_SANDBOX_CONTAINER_STORAGE_QUOTA=enabled adds `--storage-opt size=` to the
# hardened run. OFF by default: everything in step 8 goes through the wrapper,
# which is `podman --remote` by construction, and remote podman rejects it.
case "${T3_SANDBOX_CONTAINER_STORAGE_QUOTA:-}" in
  [Ee][Nn][Aa][Bb][Ll][Ee][Dd]) CONTAINER_STORAGE_QUOTA=1 ;;
  *) CONTAINER_STORAGE_QUOTA=0 ;;
esac
readonly CONTAINER_STORAGE_QUOTA
# T3_SANDBOX_VOLUME_STORAGE_QUOTA=disabled drops the volume `--opt o=size=`
# quotas and skips their create/echo-back/enforcement checks. ON by default:
# these are the real per-thread disk bound in this deployment and they work
# over the socket. Only disable it on a host where rootless podman cannot
# administer XFS project quotas at all -- and accept unbounded thread disk.
case "${T3_SANDBOX_VOLUME_STORAGE_QUOTA:-}" in
  [Dd][Ii][Ss][Aa][Bb][Ll][Ee][Dd]) VOLUME_STORAGE_QUOTA=0 ;;
  *) VOLUME_STORAGE_QUOTA=1 ;;
esac
readonly VOLUME_STORAGE_QUOTA

STEPS="${STEPS:-1,2,3,4,5,6,7,8,9}"

say() { printf '\n== %s\n' "$*"; }
info() { printf '   %s\n' "$*"; }
warn() { printf '   WARNING: %s\n' "$*" >&2; }
die() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

wants_step() {
  case ",${STEPS}," in
    *",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Run a command as the service user with a login-ish environment. The service
# user's shell is /usr/sbin/nologin, so runuser needs an explicit interpreter.
as_service_user() {
  runuser -u "$SERVICE_USER" -- env \
    HOME="$SERVICE_HOME" \
    XDG_RUNTIME_DIR="/run/user/${SERVICE_UID}" \
    PATH="${WRAPPER_DIR}:/usr/local/bin:/usr/bin:/bin" \
    "$@"
}

if [ "$(id -u)" -ne 0 ]; then
  cat >&2 <<'EOF'
bootstrap-sandbox-host.sh must run as root.

Everything it does -- installing packages, writing /etc/subuid, creating a
loopback filesystem, installing systemd units -- requires root. The Command
Center service account (uid 986) runs under NoNewPrivileges=yes and cannot
escalate, by design. Run this from an operator session:

    sudo /opt/command-center/current/deploy/openclaw/sandbox/bootstrap-sandbox-host.sh
EOF
  exit 77
fi

if [ ! -d /run/systemd/system ]; then
  die "systemd is not running; this script installs and enables systemd units"
fi

actual_uid="$(id -u "$SERVICE_USER" 2>/dev/null || true)"
[ -n "$actual_uid" ] || die "user $SERVICE_USER does not exist; run deploy/openclaw/provision.sh first"
[ "$actual_uid" = "$SERVICE_UID" ] ||
  die "expected $SERVICE_USER to be uid $SERVICE_UID, found $actual_uid; every path in this script and in 50-sandbox.conf hardcodes $SERVICE_UID"
actual_gid="$(id -g "$SERVICE_USER")"
[ "$actual_gid" = "$SERVICE_GID" ] ||
  die "expected $SERVICE_USER to be gid $SERVICE_GID, found $actual_gid"

case "$SANDBOX_IMAGE_SIZE_GIB" in
  ''|*[!0-9]*) die "SANDBOX_IMAGE_SIZE_GIB must be a positive integer, got '$SANDBOX_IMAGE_SIZE_GIB'" ;;
esac
[ "$SANDBOX_IMAGE_SIZE_GIB" -ge 10 ] || die "SANDBOX_IMAGE_SIZE_GIB must be at least 10"

say "Command Center sandbox host bootstrap"
info "service user : $SERVICE_USER (uid $SERVICE_UID, gid $SERVICE_GID)"
info "storage image: $SANDBOX_IMAGE_FILE (${SANDBOX_IMAGE_SIZE_GIB}G sparse, XFS)"
info "steps        : $STEPS"

# --------------------------------------------------------------------------
# Step 1: packages
# --------------------------------------------------------------------------
if wants_step 1; then
  say "Step 1: install container runtime packages"
  # uidmap provides newuidmap/newgidmap. Without them rootless podman cannot
  # create a user namespace at all and fails before doing anything useful.
  # podman/netavark/aardvark-dns/catatonit deliberately are NOT installed from
  # apt: Step 2 installs a pinned podman-static bundle instead (see its comment
  # for why).
  packages=(uidmap slirp4netns passt xfsprogs dbus-user-session)
  missing=()
  for pkg in "${packages[@]}"; do
    if ! dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q '^install ok installed$'; then
      missing+=("$pkg")
    fi
  done
  if [ "${#missing[@]}" -eq 0 ]; then
    info "all packages already installed"
  else
    info "installing: ${missing[*]}"
    DEBIAN_FRONTEND=noninteractive apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
  fi
  command -v newuidmap >/dev/null || die "newuidmap missing after installing uidmap"
  command -v mkfs.xfs >/dev/null || die "mkfs.xfs missing after installing xfsprogs"
fi

# --------------------------------------------------------------------------
# Step 2: pinned podman-static runtime
# --------------------------------------------------------------------------
# `podman --version` needs no user namespace, subuid, or linger, so this step
# has no dependency on steps 3/4 and can run immediately after step 1 -- unlike
# the DNS probe this step used to run (deferred to after step 7, since it needed
# a live rootless environment). It only has to run before step 6, which checks
# for a podman.socket unit to exist. If it has to stop a running socket/service
# to replace the binaries, it restarts them itself before it ends, so STEPS=2
# alone leaves the host as it found it.
if wants_step 2; then
  say "Step 2: install the pinned podman-static runtime (podman/netavark/aardvark-dns/conmon/crun/catatonit)"
  arch="$(uname -m)"
  case "$arch" in
    x86_64) podman_static_asset=podman-linux-amd64.tar.gz; podman_static_sha256="$PODMAN_STATIC_SHA256_AMD64" ;;
    aarch64) podman_static_asset=podman-linux-arm64.tar.gz; podman_static_sha256="$PODMAN_STATIC_SHA256_ARM64" ;;
    *) die "unsupported architecture '$arch'; only x86_64 and aarch64 have pinned podman-static checksums in this script" ;;
  esac

  # A rootless per-user containers.conf would outrank both /etc/containers/
  # containers.conf and the conf.d drop-in this step writes for the service
  # user -- every pin below would be silently overridden. Nothing in this
  # deployment creates one, so its existence means someone configured podman by
  # hand as uid 986. Assert this FIRST, before the install stops any live
  # socket, so failing leaves the host untouched.
  rootless_conf="${SERVICE_HOME}/.config/containers/containers.conf"
  if [ -e "$rootless_conf" ]; then
    die "$rootless_conf exists.
       A rootless containers.conf overrides /etc/containers/containers.conf AND
       /etc/containers/containers.conf.d for the service user, so it would
       outrank the helper_binaries_dir pin this step writes and could point
       podman back at the buggy distro netavark. Nothing in this deployment
       creates that file. Review it, merge anything intentional into the
       system-level config, delete it, and re-run STEPS=2."
  fi

  # Set by install_podman_static when it has to stop a live socket/service to
  # replace the binaries; the end of this step restores exactly what was active.
  podman_socket_was_active=0
  podman_service_was_active=0

  # Restores exactly what install_podman_static stopped. Idempotent: it clears
  # the flags, so the success-path call and the EXIT trap cannot both act.
  #
  # It has to be reachable from a trap because everything between the stop and
  # the restore runs under `set -e` -- the binary copy, the manifest write, the
  # containers.conf drop-in, the AppArmor profile load. Any one of them failing
  # used to exit with the host's podman socket still down, taking the running
  # server's sandboxes with it. Called with "fatal" on the success path (a
  # socket that will not come back is worth failing the step over) and with
  # "warn" from the trap, where an exit is already in progress and a `die`
  # would only mask the real error.
  restore_podman_services() {
    local severity="${1:-warn}" socket_was="$podman_socket_was_active" service_was="$podman_service_was_active"
    podman_socket_was_active=0
    podman_service_was_active=0
    [ "$socket_was" = 1 ] || [ "$service_was" = 1 ] || return 0
    info "restarting the podman socket/service stopped for the binary swap"
    if [ "$socket_was" = 1 ]; then
      if ! as_service_user systemctl --user start podman.socket; then
        local message="podman.socket was active before this step and failed to restart.
       Bring it back by hand: STEPS=6, or
       runuser -u $SERVICE_USER -- env XDG_RUNTIME_DIR=/run/user/${SERVICE_UID} \\
         systemctl --user start podman.socket"
        if [ "$severity" = fatal ]; then die "$message"; else warn "$message"; fi
      fi
    fi
    if [ "$service_was" = 1 ]; then
      # Socket-activated; starting the service directly is only needed if it
      # was running on its own. Failure is not fatal -- the socket re-spawns it
      # on first use.
      as_service_user systemctl --user start podman.service ||
        warn "podman.service did not restart; the socket will re-activate it on demand"
    fi
    info "podman socket/service restored"
  }
  # Armed for the whole step, before anything can stop the socket. Step 8
  # installs its own EXIT trap later; step 2 clears this one when it ends, so
  # the two never contend.
  trap 'restore_podman_services warn' EXIT

  # A function so `trap ... RETURN` actually fires: RETURN traps only run on
  # function (or sourced-script) return, so at top level the temp dir -- ~45MB
  # once the bundle is extracted -- would leak on every run.
  install_podman_static() {
    local asset="$1" expected="$2" tmp actual bundle_root manifest old
    tmp="$(mktemp -d)"
    # shellcheck disable=SC2064 # expand tmp now; the trap must survive this function
    trap "rm -rf '$tmp'" RETURN
    curl --fail --silent --show-error --location --max-time 180 \
      --output "${tmp}/podman.tar.gz" \
      "https://github.com/mgoltzsche/podman-static/releases/download/${PODMAN_STATIC_VERSION}/${asset}" ||
      die "could not download podman-static ${PODMAN_STATIC_VERSION}"
    actual="$(sha256sum "${tmp}/podman.tar.gz" | cut -d' ' -f1)"
    [ "$actual" = "$expected" ] ||
      die "SHA256 mismatch for podman-static ${PODMAN_STATIC_VERSION} ${asset}
         expected $expected
         actual   $actual
         Refusing to install an unverified binary. (This upstream project only
         publishes a detached GPG .asc signature, not a checksums file; this
         hash was captured by hand from a verified download -- see
         docs/operations/sandbox-host.md, section 'Supply chain'.)"

    tar -xzf "${tmp}/podman.tar.gz" -C "$tmp"
    bundle_root="$(printf '%s\n' "${tmp}"/podman-linux-*/usr/local | head -n1)"
    [ -d "$bundle_root" ] ||
      die "unexpected bundle layout: no usr/local directory inside ${asset}"

    # If a previous version is a live, running daemon (podman.service), `cp`
    # truncating its backing file in place would fail with ETXTBSY. Record what
    # was active, stop it, and let the end of this step restore it.
    if as_service_user systemctl --user is-active --quiet podman.socket 2>/dev/null; then
      podman_socket_was_active=1
    fi
    if as_service_user systemctl --user is-active --quiet podman.service 2>/dev/null; then
      podman_service_was_active=1
    fi
    if [ "$podman_socket_was_active" = 1 ] || [ "$podman_service_was_active" = 1 ]; then
      info "stopping the running podman socket/service before replacing binaries"
      as_service_user systemctl --user stop podman.service podman.socket || true
    fi

    # Remove exactly what the previous bundle installed before copying the new
    # one in. A bare `cp -r` merge can only ever add files, so a future bundle
    # that drops a helper binary would otherwise leave the old version's copy
    # behind, first on podman's search path.
    manifest="${PODMAN_STATIC_MANIFEST_DIR}/manifest"
    if [ -f "$manifest" ]; then
      while IFS= read -r old; do
        case "$old" in
          /usr/local/*) rm -f "$old" ;;
          *) warn "ignoring suspicious manifest entry '$old'" ;;
        esac
      done <"$manifest"
      info "removed the previous bundle's files (recorded in $manifest)"
    fi

    # Only usr/local/{bin,lib,libexec,share}: never the tarball's own etc/, which
    # ships its own containers.conf/storage.conf/registries.conf/policy.json that
    # would silently replace the ones this script manages.
    cp -r "${bundle_root}/." /usr/local/
    install -d -o root -g root -m 0755 "$PODMAN_STATIC_MANIFEST_DIR"
    (cd "$bundle_root" && find . \( -type f -o -type l \) | sed 's|^\.|/usr/local|') >"$manifest"
    info "installed podman-static ${PODMAN_STATIC_VERSION} into /usr/local ($(wc -l <"$manifest") files recorded in $manifest)"
  }

  installed_version="$(/usr/local/bin/podman --version 2>/dev/null | awk '{print $3}' || true)"
  if [ "$installed_version" = "${PODMAN_STATIC_VERSION#v}" ]; then
    info "podman-static ${PODMAN_STATIC_VERSION} already installed"
  else
    info "installing podman-static ${PODMAN_STATIC_VERSION} (${podman_static_asset})"
    install_podman_static "$podman_static_asset" "$podman_static_sha256"
  fi
  command -v /usr/local/bin/podman >/dev/null || die "podman missing at /usr/local/bin/podman after install"
  info "podman: $(/usr/local/bin/podman --version)"

  # Leftovers from this script's previous strategy (pinned netavark/aardvark-dns
  # only, into their own libexec dir). They predate the bundle manifest, resolve
  # ahead of nothing now that the drop-in below pins /usr/local/lib/podman, and
  # are the buggy versions this step exists to replace. Remove only the two
  # files that old script placed; the directory may hold bundle files (quadlet).
  for legacy_helper in /usr/local/libexec/podman/netavark /usr/local/libexec/podman/aardvark-dns; do
    if [ -e "$legacy_helper" ]; then
      rm -f "$legacy_helper"
      info "removed stale legacy helper $legacy_helper"
    fi
  done

  # The old script also appended a [network] helper_binaries_dir block directly
  # to /etc/containers/containers.conf. Remove it when the file is exactly that
  # block (the old script created the file itself on a fresh host, so this is
  # the common case); if an operator has since added anything else, leave the
  # file alone -- the conf.d drop-in below outranks it either way.
  legacy_conf=/etc/containers/containers.conf
  if [ -f "$legacy_conf" ] &&
     grep -q '^# Pinned by deploy/openclaw/sandbox/bootstrap-sandbox-host.sh' "$legacy_conf"; then
    legacy_block='[network]
# Pinned by deploy/openclaw/sandbox/bootstrap-sandbox-host.sh: Ubuntu 24.04'"'"'s
# netavark 1.4 provides no DNS on --internal networks, which the thread sandbox
# design requires.
helper_binaries_dir = ["/usr/local/libexec/podman", "/usr/lib/podman", "/usr/libexec/podman"]'
    if [ "$(cat "$legacy_conf")" = "$legacy_block" ]; then
      rm -f "$legacy_conf"
      info "removed the old script's appended helper_binaries_dir block ($legacy_conf)"
    else
      warn "$legacy_conf contains the old pinned-netavark block plus other content;"
      warn "leaving it alone (the containers.conf.d drop-in below overrides it)."
      warn "Reconcile by hand when convenient."
    fi
  fi

  # The bundle's usr/local/lib/podman layout matches podman's own compiled-in
  # default helper_binaries_dir search path, so no config is normally needed.
  # BUT: the old block above (when it survives, or on hosts where an operator
  # merged other keys into it) pins an explicit helper_binaries_dir, and an
  # explicit list REPLACES podman's compiled defaults rather than extending
  # them -- left alone it would shadow this bundle's netavark and silently
  # keep resolving the old, buggy 1.14.0 binary. A containers.conf.d drop-in
  # loads after and overrides the base file for this key, so it wins regardless
  # of what an older script run left behind.
  install -d -o root -g root -m 0755 /etc/containers/containers.conf.d
  cat >/etc/containers/containers.conf.d/10-podman-static.conf <<EOF
# Installed by deploy/openclaw/sandbox/bootstrap-sandbox-host.sh (step 2).
# Pins helper_binaries_dir to the pinned podman-static bundle installed by this
# script, overriding any narrower helper_binaries_dir an older version of this
# script may have written directly into /etc/containers/containers.conf.
[network]
helper_binaries_dir = ["/usr/local/lib/podman"]
EOF
  info "wrote /etc/containers/containers.conf.d/10-podman-static.conf"

  # AppArmor: with kernel.apparmor_restrict_unprivileged_userns=1, only binaries
  # with a profile granting `userns` may create unprivileged user namespaces.
  # Ubuntu's stock profiles cover /usr/bin/podman and rootlesskit -- not the
  # /usr/local/bin/podman this bundle installs -- so without a profile every
  # rootless container fails with a confusing permission error (the exact trap
  # docs/operations/sandbox-host.md section 8 warns about). Model the stock
  # /etc/apparmor.d/podman profile: unconfined flags, userns grant, nothing else.
  userns_restricted="$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)"
  if [ -d /sys/kernel/security/apparmor ] && [ "$userns_restricted" = "1" ]; then
    apparmor_profile=/etc/apparmor.d/podman-static
    apparmor_tmp="$(mktemp)"
    cat >"$apparmor_tmp" <<'EOF'
# Installed by deploy/openclaw/sandbox/bootstrap-sandbox-host.sh (step 2).
# Modeled on Ubuntu's stock /etc/apparmor.d/podman profile: it allows
# everything and exists only so the binary has a label with the `userns`
# permission, which kernel.apparmor_restrict_unprivileged_userns=1 requires
# for creating unprivileged user namespaces. The stock profile covers only
# /usr/bin/podman; this one covers the pinned podman-static binary.

abi <abi/4.0>,
include <tunables/global>

profile podman-static /usr/local/bin/podman flags=(unconfined) {
  userns,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/podman-static>
}
EOF
    if [ -f "$apparmor_profile" ] && cmp -s "$apparmor_tmp" "$apparmor_profile"; then
      info "AppArmor profile for /usr/local/bin/podman already installed"
      rm -f "$apparmor_tmp"
    else
      install -o root -g root -m 0644 "$apparmor_tmp" "$apparmor_profile"
      rm -f "$apparmor_tmp"
      apparmor_parser -r "$apparmor_profile" ||
        die "apparmor_parser failed to load $apparmor_profile.
       With apparmor_restrict_unprivileged_userns=1 and no profile, rootless
       podman at /usr/local/bin/podman cannot create user namespaces at all."
      info "installed and loaded AppArmor profile $apparmor_profile"
    fi
  else
    info "AppArmor userns restriction not active; no profile needed"
  fi

  # Restore whatever install_podman_static stopped, so STEPS=2 on its own does
  # not leave the host without its podman socket (the header promises each step
  # is independently re-runnable; a full run's step 6 would mask this).
  restore_podman_services fatal
  trap - EXIT
fi

# --------------------------------------------------------------------------
# Step 3: subuid / subgid ranges
# --------------------------------------------------------------------------
if wants_step 3; then
  say "Step 3: allocate subordinate uid/gid ranges for $SERVICE_USER"
  # 231072 = 165536 + 65536, i.e. the next free range after the last
  # existing allocation on this host. Append only; never rewrite lines
  # belonging to other users.
  for file in /etc/subuid /etc/subgid; do
    [ -f "$file" ] || : >"$file"
    if grep -q "^${SERVICE_USER}:" "$file"; then
      info "$file already has an entry: $(grep "^${SERVICE_USER}:" "$file")"
      continue
    fi
    # Refuse to hand out a range that overlaps an existing allocation rather
    # than silently creating two users who can forge each other's files.
    if awk -F: -v start=231072 -v count=65536 '
        $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ {
          if (start < $2 + $3 && $2 < start + count) { found = 1 }
        }
        END { exit(found ? 0 : 1) }' "$file"; then
      die "range 231072:65536 overlaps an existing allocation in $file; pick a free range manually"
    fi
    printf '%s:231072:65536\n' "$SERVICE_USER" >>"$file"
    info "appended ${SERVICE_USER}:231072:65536 to $file"
  done
fi

# --------------------------------------------------------------------------
# Step 4: linger
# --------------------------------------------------------------------------
if wants_step 4; then
  say "Step 4: enable linger for $SERVICE_USER"
  # Linger keeps the uid 986 user manager (and therefore the podman socket) alive
  # with no login session. Without it the socket exists only while someone is
  # logged in, so the server would lose its container runtime at an arbitrary
  # moment. This MUST happen before step 6 enables the user socket.
  if [ -e "/var/lib/systemd/linger/${SERVICE_USER}" ]; then
    info "linger already enabled"
  else
    loginctl enable-linger "$SERVICE_USER"
    info "linger enabled"
  fi
  # Wait for the user manager to actually come up; `enable-linger` returns before
  # it is running, and step 6 needs a live user bus to enable a user unit in.
  user_manager="user@${SERVICE_UID}"
  user_manager="${user_manager}.service"
  for _ in $(seq 1 30); do
    systemctl is-active --quiet "$user_manager" && break
    sleep 1
  done
  systemctl is-active --quiet "$user_manager" ||
    die "the uid ${SERVICE_UID} user manager did not become active after enabling linger.
       Check: systemctl status $user_manager"
  info "the uid ${SERVICE_UID} user manager is active"
fi

# --------------------------------------------------------------------------
# Step 5: XFS loopback storage
# --------------------------------------------------------------------------
if wants_step 5; then
  say "Step 5: XFS loopback storage with project quotas"

  install -d -o root -g root -m 0755 /etc/containers
  install -d -o "$SERVICE_UID" -g "$SERVICE_GID" -m 0700 "$SANDBOX_MOUNT"

  if [ -f "$SANDBOX_IMAGE_FILE" ]; then
    # Never resize or reformat an existing image: it may hold live thread
    # workspaces. Report the mismatch and let the operator decide.
    existing_gib="$(( $(stat -c %s "$SANDBOX_IMAGE_FILE") / 1024 / 1024 / 1024 ))"
    info "storage image already exists at $SANDBOX_IMAGE_FILE (${existing_gib}G)"
    if [ "$existing_gib" != "$SANDBOX_IMAGE_SIZE_GIB" ]; then
      warn "existing image is ${existing_gib}G but SANDBOX_IMAGE_SIZE_GIB is ${SANDBOX_IMAGE_SIZE_GIB}."
      warn "Leaving it alone. Resizing would risk data in live thread workspaces;"
      warn "do it deliberately with sandboxing disabled."
    fi
  else
    # Sparse allocation: the file reports its full size but consumes only written
    # blocks. Check free space against the FULL size anyway -- a sparse file that
    # fills up is an outage, and the whole point of the check is to notice before
    # the operator commits to it.
    avail_gib="$(df -B1G --output=avail /var/lib/command-center | tail -n1 | tr -d ' ')"
    info "root filesystem has ${avail_gib}G available; image will claim ${SANDBOX_IMAGE_SIZE_GIB}G"
    if [ "$((avail_gib - SANDBOX_IMAGE_SIZE_GIB))" -lt "$FREE_SPACE_MARGIN_GIB" ]; then
      die "creating a ${SANDBOX_IMAGE_SIZE_GIB}G image would leave less than ${FREE_SPACE_MARGIN_GIB}G free (currently ${avail_gib}G).
       Either free space, grow the volume, or re-run with a smaller
       SANDBOX_IMAGE_SIZE_GIB. This is a hard refusal: filling the root
       filesystem takes the whole service down, not just sandboxing."
    fi
    info "creating sparse ${SANDBOX_IMAGE_SIZE_GIB}G image (this is instant; blocks are allocated on write)"
    truncate -s "${SANDBOX_IMAGE_SIZE_GIB}G" "$SANDBOX_IMAGE_FILE"
    chown "$SERVICE_UID:$SERVICE_GID" "$SANDBOX_IMAGE_FILE"
    chmod 0600 "$SANDBOX_IMAGE_FILE"
    if ! mkfs.xfs -q "$SANDBOX_IMAGE_FILE"; then
      # Do not leave a half-formatted image behind; a re-run would skip creation
      # and then fail to mount forever.
      rm -f "$SANDBOX_IMAGE_FILE"
      die "mkfs.xfs failed; removed the partial image so this step can be re-run"
    fi
    info "formatted XFS"
  fi

  # systemd derives a mount unit's name from its mount point and refuses any
  # other name. The shipped template carries a safe filename; the real unit name
  # contains an escaped hyphen (var-lib-command\x2dcenter-sandbox.mount).
  mount_unit="$(systemd-escape -p --suffix=mount "$SANDBOX_MOUNT")"
  install -o root -g root -m 0644 "${SOURCE_DIR}/sandbox-storage.mount.in" \
    "/etc/systemd/system/${mount_unit}"
  info "installed /etc/systemd/system/${mount_unit}"
  systemctl daemon-reload
  systemctl enable "$mount_unit"
  # `start` on an already-mounted unit is a no-op, which is the idempotent
  # behaviour we want. Deliberately not `restart`: that would unmount the
  # graphroot out from under any running sandbox.
  if systemctl is-active --quiet "$mount_unit"; then
    info "$mount_unit already active; not restarting (would unmount a live graphroot)"
  else
    systemctl start "$mount_unit"
  fi

  findmnt --mountpoint "$SANDBOX_MOUNT" >/dev/null ||
    die "$SANDBOX_MOUNT is not mounted after starting $mount_unit"
  mount_fstype="$(findmnt -no FSTYPE --mountpoint "$SANDBOX_MOUNT")"
  [ "$mount_fstype" = "xfs" ] || die "$SANDBOX_MOUNT is $mount_fstype, expected xfs"
  # Prove pquota is actually live. If it is not, `--opt o=size=` is accepted and
  # echoed back but never enforced -- silent, and invisible to the backend's
  # readback check. This is the single most important assertion in this step.
  # The kernel normalises the `pquota` mount option to `prjquota` in /proc/mounts,
  # but accept either spelling rather than fail on a naming detail.
  findmnt -no OPTIONS --mountpoint "$SANDBOX_MOUNT" | tr ',' '\n' | grep -qxE 'prjquota|pquota' ||
    die "project quotas are not active on $SANDBOX_MOUNT.
       findmnt reports: $(findmnt -no OPTIONS --mountpoint "$SANDBOX_MOUNT")
       Without prjquota, podman accepts 'volume create --opt o=size=N' and echoes
       the option back, but enforces nothing. A runaway thread would fill the
       filesystem. Check the Options= line in $mount_unit."
  info "mounted xfs with project quotas active"

  install -d -o "$SERVICE_UID" -g "$SERVICE_GID" -m 0700 "${SANDBOX_MOUNT}/storage"
  install -d -o "$SERVICE_UID" -g "$SERVICE_GID" -m 0700 "${SERVICE_HOME}/.config"
  install -d -o "$SERVICE_UID" -g "$SERVICE_GID" -m 0700 "${SERVICE_HOME}/.config/containers"
  storage_conf="${SERVICE_HOME}/.config/containers/storage.conf"
  if [ -f "$storage_conf" ] && ! cmp -s "${SOURCE_DIR}/storage.conf" "$storage_conf"; then
    # Changing graphroot under an existing store orphans every image and volume
    # already there, including live thread workspaces.
    warn "$storage_conf exists and differs from the shipped template."
    warn "Leaving it alone. Reconcile by hand against ${SOURCE_DIR}/storage.conf;"
    warn "changing graphroot on a populated store orphans existing volumes."
  else
    install -o "$SERVICE_UID" -g "$SERVICE_GID" -m 0644 "${SOURCE_DIR}/storage.conf" "$storage_conf"
    info "wrote $storage_conf (graphroot on the XFS mount)"
  fi

  # The artifact directory the drop-in points at, created now so enabling that
  # line later does not fail on a missing path.
  install -d -o "$SERVICE_UID" -g "$SERVICE_GID" -m 0700 \
    "${SERVICE_HOME}/runtime/sandbox-artifacts"
fi

# --------------------------------------------------------------------------
# Step 6: rootless podman socket
# --------------------------------------------------------------------------
if wants_step 6; then
  say "Step 6: enable the rootless podman socket for uid $SERVICE_UID"
  # Requires linger (step 4) -- without it there is no user manager to enable a
  # user unit in, and `systemctl --user` below fails with a connection error.
  [ -e "/var/lib/systemd/linger/${SERVICE_USER}" ] ||
    die "linger is not enabled for $SERVICE_USER; run step 4 first (STEPS=4)"
  [ -f /usr/local/lib/systemd/user/podman.socket ] ||
    die "/usr/local/lib/systemd/user/podman.socket is missing; run step 2 first (STEPS=2)"
  findmnt --mountpoint "$SANDBOX_MOUNT" >/dev/null ||
    die "$SANDBOX_MOUNT is not mounted; run step 5 first (STEPS=5).
       Starting podman without it would initialise a graphroot on ext4, where
       volume quotas are silently unenforced."

  # Fail-closed guard: if the XFS mount is ever absent at boot, the socket
  # refuses to start rather than quietly building an unquotable store.
  socket_dropin_dir="${SERVICE_HOME}/.config/systemd/user/podman.socket.d"
  install -d -o "$SERVICE_UID" -g "$SERVICE_GID" -m 0700 "${SERVICE_HOME}/.config/systemd"
  install -d -o "$SERVICE_UID" -g "$SERVICE_GID" -m 0700 "${SERVICE_HOME}/.config/systemd/user"
  install -d -o "$SERVICE_UID" -g "$SERVICE_GID" -m 0700 "$socket_dropin_dir"
  install -o "$SERVICE_UID" -g "$SERVICE_GID" -m 0644 \
    "${SOURCE_DIR}/podman-socket-dropin.conf" "${socket_dropin_dir}/10-require-storage.conf"
  info "installed the fail-closed storage guard for podman.socket"

  # `systemctl --user --machine=user@.host` is the other way to do this, but it
  # needs systemd-container, which is not installed here. Going through runuser
  # with XDG_RUNTIME_DIR set lets systemctl find the user bus at
  # /run/user/986/bus directly, with no extra package.
  as_service_user systemctl --user daemon-reload
  as_service_user systemctl --user enable --now podman.socket

  for _ in $(seq 1 30); do
    [ -S "${RUNTIME_SOCKET_DIR}/podman.sock" ] && break
    sleep 1
  done
  [ -S "${RUNTIME_SOCKET_DIR}/podman.sock" ] ||
    die "${RUNTIME_SOCKET_DIR}/podman.sock did not appear after enabling podman.socket"
  info "socket live at ${RUNTIME_SOCKET_DIR}/podman.sock"
fi

# --------------------------------------------------------------------------
# Step 7: PATH wrapper
# --------------------------------------------------------------------------
if wants_step 7; then
  say "Step 7: install the podman wrapper on the service PATH"
  # The server resolves its container binary by bare name through PATH, and
  # NodeSandboxCommandExecutor strips every variable except PATH. CONTAINER_HOST
  # set in the unit would never reach the CLI, so it is set inside the wrapper.
  [ -d "$WRAPPER_DIR" ] || die "$WRAPPER_DIR does not exist; this host is not a Command Center deployment"
  install -o root -g root -m 0755 "${SOURCE_DIR}/podman-wrapper.sh" "${WRAPPER_DIR}/podman"
  info "installed ${WRAPPER_DIR}/podman"

  # The wrapper is only useful if it wins the PATH lookup. Read the effective
  # PATH out of the running unit rather than trusting the checked-in file.
  service_path="$(systemctl show command-center.service -p Environment --value 2>/dev/null |
    tr ' ' '\n' | sed -n 's/^PATH=//p' | tail -n1)"
  if [ -z "$service_path" ]; then
    warn "could not read PATH from command-center.service; verify manually that $WRAPPER_DIR precedes /usr/bin"
  else
    first_hit=""
    IFS=: read -r -a path_entries <<<"$service_path"
    for entry in "${path_entries[@]}"; do
      if [ -x "${entry}/podman" ]; then first_hit="${entry}/podman"; break; fi
    done
    if [ "$first_hit" = "${WRAPPER_DIR}/podman" ]; then
      info "service PATH resolves podman to the wrapper"
    else
      die "service PATH resolves podman to '${first_hit:-nothing}', not ${WRAPPER_DIR}/podman.
       The server would talk to the wrong binary (or a rootful daemon).
       Service PATH is: $service_path"
    fi
  fi
fi

# --------------------------------------------------------------------------
# Step 8: verification -- mirror the backend's exact commands
# --------------------------------------------------------------------------
if wants_step 8; then
  say "Step 8: verification (mirrors ContainerSandboxBackend command-for-command)"
  # Everything below runs AS THE SERVICE USER THROUGH THE WRAPPER, which is the
  # only configuration that matters. Running these as root, or against
  # /usr/bin/podman directly, proves nothing about what the server will do.
  V_SUFFIX="verify$$"
  V_NET="t3-net-${V_SUFFIX}"
  V_VOL="t3-workspace-${V_SUFFIX}"
  V_CTR="t3-thread-${V_SUFFIX}"
  V_PEER="t3-peer-${V_SUFFIX}"

  verify_cleanup() {
    as_service_user podman rm -f "$V_CTR" "$V_PEER" >/dev/null 2>&1 || true
    as_service_user podman volume rm -f "$V_VOL" >/dev/null 2>&1 || true
    as_service_user podman network rm -f "$V_NET" >/dev/null 2>&1 || true
  }
  trap verify_cleanup EXIT
  verify_cleanup

  as_service_user podman pull --quiet "$VERIFY_IMAGE" >/dev/null ||
    die "could not pull the verification image $VERIFY_IMAGE"

  # -- 8a. rootless check, byte-for-byte what #validateRootless runs ---------
  # This is also the step-8 assertion that `podman info` works at all as the
  # service user through the wrapper: with apparmor_restrict_unprivileged_userns=1
  # and no profile on /usr/local/bin/podman (step 2 installs one), the daemon
  # behind the socket cannot create its user namespace and this fails here,
  # loudly, rather than at first thread provisioning.
  info "8a. rootless check"
  rootless="$(as_service_user podman info --format '{{.Host.Security.Rootless}}' || true)"
  [ "$rootless" = "true" ] ||
    die "podman info --format '{{.Host.Security.Rootless}}' returned '$rootless', not 'true'.
       ContainerSandboxBackend.#validateRootless compares this string exactly and
       refuses to provision otherwise. A rootful socket or a CONTAINER_HOST
       pointing at the wrong daemon both look like this."
  info "    rootless = true"

  # -- 8b. volume quota create + readback ------------------------------------
  # Mirrors the workspace volume: Math.floor(diskBytes * 0.9) with the default
  # 20GiB disk limit. The backend compares `volume inspect` output against the
  # option string with the leading "o=" stripped, so the runtime must echo it
  # back verbatim -- not normalised, not reordered.
  if [ "$VOLUME_STORAGE_QUOTA" = 0 ]; then
    info "8b. volume quota with echo-back -- SKIPPED (T3_SANDBOX_VOLUME_STORAGE_QUOTA=disabled)"
    as_service_user podman volume create \
      --label com.t3tools.sandbox.managed=true "$V_VOL" >/dev/null ||
      die "podman volume create (no quota) failed"
  else
    info "8b. volume quota with echo-back"
    V_QUOTA="o=size=$(( (20 * 1024 * 1024 * 1024 * 9) / 10 ))"
    as_service_user podman volume create \
      --label com.t3tools.sandbox.managed=true \
      --opt "$V_QUOTA" "$V_VOL" >/dev/null ||
      die "podman volume create --opt $V_QUOTA failed.
       If this host's rootless podman cannot administer XFS project quotas
       (confirm with: sudo xfs_quota -x -c 'report -p' $SANDBOX_MOUNT succeeding
       as real root while this fails), re-run with
       T3_SANDBOX_VOLUME_STORAGE_QUOTA=disabled to accept that limitation
       instead of enforcing per-thread quotas -- and set the same variable on
       the server, or every provision will fail on the same volume create."
    readback="$(as_service_user podman volume inspect --format '{{index .Options "o"}}' "$V_VOL")"
    [ "$readback" = "${V_QUOTA#o=}" ] ||
      die "volume quota was not echoed back verbatim.
       expected: ${V_QUOTA#o=}
       actual  : $readback
       The backend treats any difference as fatal ('runtime did not preserve the
       workspace volume quota')."
    info "    quota echoed back as '$readback'"
  fi

  # -- 8c. quota actually enforced -------------------------------------------
  # The echo-back above passes even when nothing is enforced (that is exactly the
  # rootless-docker trap). The only trustworthy check is writing past the limit
  # and demanding failure. A small volume keeps this fast.
  if [ "$VOLUME_STORAGE_QUOTA" = 0 ]; then
    info "8c. quota enforcement -- SKIPPED (no volume quota is applied when disabled; nothing to enforce)"
  else
    info "8c. quota enforcement (writing past the limit must fail)"
    V_SMALL="t3-quota-${V_SUFFIX}"
    as_service_user podman volume rm -f "$V_SMALL" >/dev/null 2>&1 || true
    # Byte count rather than "16m": the backend always emits a raw byte value
    # (Math.floor(diskBytes * 0.9)), so this exercises the same code path.
    as_service_user podman volume create --opt "o=size=16777216" "$V_SMALL" >/dev/null ||
      die "could not create the small probe volume"
    # dd alone is not enough -- busybox dd can report success on a short write.
    # Demand that the file really is smaller than what we asked for.
    # The probe body runs inside the container, so it must reach the container's
    # shell unexpanded -- single quotes are required here, not a style choice.
    # shellcheck disable=SC2016
    quota_probe='dd if=/dev/zero of=/quota/fill bs=1M count=64 2>/dev/null; [ "$(stat -c %s /quota/fill)" -ge 67108864 ]'
    if as_service_user podman run --rm \
        --mount "type=volume,src=${V_SMALL},dst=/quota" \
        "$VERIFY_IMAGE" \
        sh -c "$quota_probe" \
        >/dev/null 2>&1; then
      as_service_user podman volume rm -f "$V_SMALL" >/dev/null 2>&1 || true
      die "wrote a full 64MiB file into a volume with a 16MiB quota.
       The quota is NOT being enforced. This is the failure mode that rootless
       docker exhibits and that the echo-back check in 8b cannot detect.
       Confirm $SANDBOX_MOUNT is XFS mounted with pquota and that the podman
       graphroot really is on it (podman info --format '{{.Store.GraphRoot}}')."
    fi
    as_service_user podman volume rm -f "$V_SMALL" >/dev/null 2>&1 || true
    info "    writing past the quota failed with ENOSPC, as required"
  fi

  # -- 8d. internal network DNS ----------------------------------------------
  # The workspace container resolves 'egress-proxy', 'credential-proxy' and
  # preview aliases by name on exactly this kind of network.
  info "8d. DNS between containers on an --internal network"
  as_service_user podman network create --internal \
    --label com.t3tools.sandbox.managed=true "$V_NET" >/dev/null ||
    die "podman network create --internal failed"
  # The extended --network syntax registers both the container-name alias and
  # 'egress-proxy' in the same attachment. A separate `network connect --alias`
  # call to a network the container is already on fails (podman refuses a
  # second connect to the same network) -- that failure was previously
  # swallowed by `|| true`, which is why the alias never actually landed.
  as_service_user podman run --detach --name "$V_PEER" \
    --network "${V_NET}:alias=egress-proxy" \
    "$VERIFY_IMAGE" sleep 300 >/dev/null || die "could not start the DNS peer container"

  # -- 8e. hardened run, mirroring the backend's workspace container flags ----
  # --storage-opt size= mirrors ContainerSandboxBackend.ts: `podman --remote`
  # rejects it, so the backend leaves it off unless
  # T3_SANDBOX_CONTAINER_STORAGE_QUOTA=enabled. Everything in this step runs
  # through the wrapper, which is `podman --remote` by construction, so THIS
  # deployment is exactly the case the default is for. Omitting it costs no
  # disk bound: the rootfs is --read-only and every writable path is a volume
  # under the XFS prjquota `o=size=` quotas that 8b/8c prove are enforced --
  # those volume-level quotas are the real disk limit here, not --storage-opt,
  # and they are governed by their own T3_SANDBOX_VOLUME_STORAGE_QUOTA.
  info "8e. hardened container run"
  storage_opt_args=()
  if [ "$CONTAINER_STORAGE_QUOTA" = 1 ]; then
    storage_opt_args=(--storage-opt "size=21474836480")
    info "    including --storage-opt (T3_SANDBOX_CONTAINER_STORAGE_QUOTA=enabled)"
  else
    info "    omitting --storage-opt (rejected by podman --remote; the default)"
  fi
  as_service_user podman run --detach --name "$V_CTR" \
    --label com.t3tools.sandbox.managed=true \
    --network "$V_NET" \
    --mount "type=volume,src=${V_VOL},dst=/workspace" \
    --cpus 2 \
    --memory 4294967296 \
    --pids-limit 512 \
    "${storage_opt_args[@]}" \
    --read-only \
    --init \
    --tmpfs "/tmp:rw,nosuid,nodev,noexec,size=1g" \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --user 1000:1000 \
    --workdir /workspace \
    "$VERIFY_IMAGE" sleep infinity >/dev/null ||
    die "the hardened 'podman run' the backend issues failed.
       Re-run it by hand to see the error. If it mentions --storage-opt, note
       that flag is rejected over --remote connections and should have been
       omitted here (see the comment above this run)."
  info "    container started with the backend's full flag set"

  # DNS resolution from inside the workspace container, both by name and alias.
  # aardvark-dns registers asynchronously, so allow a few seconds before failing.
  resolves_from_workspace() {
    local target="$1"
    for _ in 1 2 3 4 5; do
      if as_service_user podman exec --user 1000:1000 -- "$V_CTR" \
          getent hosts "$target" >/dev/null 2>&1; then
        return 0
      fi
      sleep 2
    done
    return 1
  }
  resolves_from_workspace "$V_PEER" ||
    die "the workspace container cannot resolve peer '$V_PEER' on the internal network.
       Internal-network DNS is required so the workspace can reach its sidecars.
       Check which netavark/aardvark-dns podman actually resolves
       (as the service user: podman info --format '{{.Host.NetworkBackendInfo.Path}}')
       -- it must be the bundle's /usr/local/lib/podman copy, not a stale
       distro or legacy pinned binary. Re-running step 2 (STEPS=2) reinstalls
       the bundle and the helper_binaries_dir drop-in."
  resolves_from_workspace egress-proxy ||
    die "the workspace container cannot resolve the network alias 'egress-proxy'.
       The backend attaches its egress proxy under exactly this alias, so
       provisioning would produce a sandbox with no working egress."
  info "    resolved both the peer name and the 'egress-proxy' alias"

  # -- 8f. exec -i stdin round-trip ------------------------------------------
  # SandboxProviderProcess builds `exec --interactive --user 1000:1000 --workdir
  # <cwd> [--env KEY]... -- <container> <cmd>`, and the provider protocol lives
  # entirely on that stdin pipe. If stdin does not survive the socket, providers
  # hang with no error.
  info "8f. exec --interactive stdin round-trip"
  stdin_probe="sandbox-stdin-probe-${V_SUFFIX}"
  echo_back="$(printf '%s' "$stdin_probe" |
    as_service_user podman exec --interactive --user 1000:1000 --workdir /workspace \
      -- "$V_CTR" cat)" ||
    die "podman exec --interactive failed"
  [ "$echo_back" = "$stdin_probe" ] ||
    die "stdin did not survive 'podman exec --interactive'.
       sent '$stdin_probe', received '$echo_back'.
       Provider sessions speak their protocol over this pipe; they would hang."
  info "    stdin round-tripped intact"

  # --env forwards by name only (the value comes from the spawn environment),
  # which is what SandboxProviderProcess relies on.
  env_seen="$(as_service_user env SANDBOX_ENV_PROBE=forwarded \
    podman exec --interactive --user 1000:1000 --env SANDBOX_ENV_PROBE \
    -- "$V_CTR" printenv SANDBOX_ENV_PROBE || true)"
  [ "$env_seen" = "forwarded" ] ||
    die "'--env NAME' without a value did not forward the variable (got '$env_seen').
       SandboxProviderProcess passes credentials this way."
  info "    --env NAME forwarding works"

  # -- 8g. podman cp both directions -----------------------------------------
  # Used for the repository bundle in and the export bundle out.
  info "8g. podman cp"
  cp_tmp="$(mktemp -d)"
  chown "$SERVICE_UID:$SERVICE_GID" "$cp_tmp"
  printf 'bundle-probe\n' >"${cp_tmp}/in.txt"
  chown "$SERVICE_UID:$SERVICE_GID" "${cp_tmp}/in.txt"
  as_service_user podman cp "${cp_tmp}/in.txt" "${V_CTR}:/tmp/in.txt" ||
    die "podman cp host->container failed (used to deliver the repository bundle)"
  as_service_user podman cp "${V_CTR}:/tmp/in.txt" "${cp_tmp}/out.txt" ||
    die "podman cp container->host failed (used to export the thread Git bundle)"
  cmp -s "${cp_tmp}/in.txt" "${cp_tmp}/out.txt" ||
    die "podman cp round-trip corrupted the file"
  rm -rf "$cp_tmp"
  info "    copied in and out with matching contents"

  # -- 8h. egress ------------------------------------------------------------
  # The workspace network is --internal, so it has no route out by design; the
  # backend gives it egress through a proxy sidecar. What must work here is that
  # a container on a normal network can reach the internet, otherwise image pulls
  # and the egress proxy itself will not function.
  info "8h. egress from a container on a routed network"
  if as_service_user podman run --rm "$VERIFY_IMAGE" \
      timeout 20 wget -q -O /dev/null https://github.com >/dev/null 2>&1; then
    info "    reached https://github.com"
  else
    warn "a container on a routed network could not reach https://github.com."
    warn "If this host requires an outbound proxy that is expected; the sandbox"
    warn "egress proxy sidecar will need the same configuration. Not fatal here,"
    warn "but image pulls inside sandboxes will fail until it is resolved."
  fi

  # -- 8i. graphroot sanity --------------------------------------------------
  graphroot="$(as_service_user podman info --format '{{.Store.GraphRoot}}')"
  case "$graphroot" in
    "${SANDBOX_MOUNT}"/*) info "8i. graphroot is on the XFS mount: $graphroot" ;;
    *) die "graphroot is '$graphroot', not under $SANDBOX_MOUNT.
       Quotas would be unenforced. Check ${SERVICE_HOME}/.config/containers/storage.conf." ;;
  esac

  verify_cleanup
  trap - EXIT
  say "Verification passed. The container runtime is ready for the service user."
fi

# --------------------------------------------------------------------------
# Step 9: systemd drop-in (shipped inactive)
# --------------------------------------------------------------------------
if wants_step 9; then
  say "Step 9: install the systemd drop-in (INACTIVE)"
  install -d -o root -g root -m 0755 "$DROPIN_DIR"
  if [ -f "${DROPIN_DIR}/50-sandbox.conf" ]; then
    # Never clobber a drop-in the operator may have already activated. Silently
    # re-commenting a live production config would be an outage delivered by a
    # script that reported success.
    # EnvironmentFile= counts as active too: an operator who has wired up the
    # credential file but not yet uncommented the images is mid-rollout, and
    # overwriting that is the same outage as overwriting a finished one.
    if grep -Eq '^[[:space:]]*((Environment=)?T3_SANDBOX_[A-Z_]+=|EnvironmentFile=|ReadWritePaths=)' \
      "${DROPIN_DIR}/50-sandbox.conf"; then
      warn "${DROPIN_DIR}/50-sandbox.conf exists and has ACTIVE sandbox settings."
      warn "Leaving it untouched. Reconcile it by hand against"
      warn "${SOURCE_DIR}/50-sandbox.conf if this release changed the template."
    else
      install -o root -g root -m 0644 "${SOURCE_DIR}/50-sandbox.conf" "${DROPIN_DIR}/50-sandbox.conf"
      info "refreshed the inactive drop-in"
    fi
  else
    install -o root -g root -m 0644 "${SOURCE_DIR}/50-sandbox.conf" "${DROPIN_DIR}/50-sandbox.conf"
    info "installed ${DROPIN_DIR}/50-sandbox.conf with every setting commented out"
  fi
  systemctl daemon-reload
fi

cat <<EOF

========================================================================
 Bootstrap complete. Sandboxing is NOT enabled.
========================================================================

The container runtime is installed and verified, but the server is still
running every thread on the host exactly as before. Nothing about its
behaviour changed.

To turn sandboxing on you must edit
  ${DROPIN_DIR}/50-sandbox.conf
and uncomment the settings there.

  >>> BE AWARE: setting BOTH T3_SANDBOX_IMAGE and                    <<<
  >>> T3_SANDBOX_PREVIEW_PROXY_IMAGE removes the legacy-host         <<<
  >>> fallback. From that moment EVERY NEW THREAD on this host must  <<<
  >>> provision a container successfully or it cannot start at all.  <<<
  >>> This is a production one-way switch. Do the canary first.      <<<

  >>> AND: you must ALSO set T3_SANDBOX_RUNTIME=podman, or none of   <<<
  >>> what this script installed is used. The server defaults to     <<<
  >>> 'docker', never invokes ${WRAPPER_DIR}/podman,   <<<
  >>> and lands on the rootful daemon it cannot use. Set the runtime <<<
  >>> and the two images together, never the images alone.           <<<

  >>> AND: set T3_SANDBOX_CREDENTIAL_PROXY_IMAGE plus                <<<
  >>> T3_SANDBOX_EGRESS_PROXY_IMAGE and write the credential file    <<<
  >>> ${CREDENTIALS_FILE}.       <<<
  >>> Without them every thread provisions a container and then      <<<
  >>> fails at provider spawn: the server refuses to hand its own    <<<
  >>> credentials to a sandbox. This script does NOT create that     <<<
  >>> file -- it holds a secret and is yours to write (mode 0600).   <<<

Read docs/operations/sandbox-host.md before flipping it. Rollback is
re-commenting the two image lines and restarting the service.

No service was restarted and no Tailscale route was changed by this script.
EOF
