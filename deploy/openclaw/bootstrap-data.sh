#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "bootstrap-data.sh must run as root" >&2
  exit 77
fi

: "${COMMAND_CENTER_CONFIG_REPOSITORY:?set COMMAND_CENTER_CONFIG_REPOSITORY}"
: "${COMMAND_CENTER_CONFIG_BRANCH:?set COMMAND_CENTER_CONFIG_BRANCH}"
: "${COMMAND_CENTER_PRIMARY_REPOSITORY:?set COMMAND_CENTER_PRIMARY_REPOSITORY}"
: "${COMMAND_CENTER_SECONDARY_REPOSITORY:?set COMMAND_CENTER_SECONDARY_REPOSITORY}"
: "${COMMAND_CENTER_PRIMARY_GITHUB_LOGIN:?set COMMAND_CENTER_PRIMARY_GITHUB_LOGIN}"
: "${COMMAND_CENTER_SECONDARY_GITHUB_LOGIN:?set COMMAND_CENTER_SECONDARY_GITHUB_LOGIN}"

run_cc() {
  identity=$1
  shift
  runuser -u commandcenter -- env \
    HOME=/var/lib/command-center \
    GIT_CONFIG_GLOBAL=/var/lib/command-center/.gitconfig \
    COMMAND_CENTER_GITHUB_IDENTITY="$identity" \
    COMMAND_CENTER_GITHUB_PROVISIONING_IDENTITY="$identity" \
    "$@"
}

clone_if_missing() {
  identity=$1
  repository=$2
  destination=$3
  branch=${4:-}
  if [ -d "$destination/.git" ]; then
    echo "Keeping existing clone at $destination"
    return
  fi
  if [ -e "$destination" ] && [ "$(find "$destination" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    echo "refusing to clone over non-empty $destination" >&2
    exit 73
  fi
  if [ -n "$branch" ]; then
    run_cc "$identity" /opt/command-center/bin/gh repo clone "$repository" "$destination" -- --branch "$branch"
  else
    run_cc "$identity" /opt/command-center/bin/gh repo clone "$repository" "$destination"
  fi
}

clone_if_missing primary "$COMMAND_CENTER_CONFIG_REPOSITORY" /var/lib/command-center/config "$COMMAND_CENTER_CONFIG_BRANCH"
clone_if_missing primary "$COMMAND_CENTER_PRIMARY_REPOSITORY" /srv/command-center/workspaces/primary/repository
clone_if_missing secondary "$COMMAND_CENTER_SECONDARY_REPOSITORY" /srv/command-center/workspaces/secondary/repository

run_cc primary sh -c 'cd /var/lib/command-center/config && exec /usr/local/bin/pnpm run check'

verify_identity() {
  identity=$1
  expected=$2
  repository=$3
  actual=$(run_cc "$identity" sh -c 'cd "$1" && exec /opt/command-center/bin/gh api user --jq .login' sh "$repository")
  if [ "$actual" != "$expected" ]; then
    echo "expected GitHub login $expected for $identity, got $actual" >&2
    exit 77
  fi
  run_cc "$identity" sh -c 'cd "$1" && git ls-remote origin HEAD >/dev/null && git var GIT_AUTHOR_IDENT' sh "$repository"
}

verify_identity primary "$COMMAND_CENTER_PRIMARY_GITHUB_LOGIN" /srv/command-center/workspaces/primary/repository
verify_identity secondary "$COMMAND_CENTER_SECONDARY_GITHUB_LOGIN" /srv/command-center/workspaces/secondary/repository

if run_cc secondary sh -c 'cd /srv/command-center/workspaces/primary/repository && /opt/command-center/bin/gh api user --jq .login >/dev/null 2>&1'; then
  echo "secondary identity was not rejected in the primary workspace" >&2
  exit 77
fi
if run_cc primary sh -c 'cd /srv/command-center/workspaces/secondary/repository && /opt/command-center/bin/gh api user --jq .login >/dev/null 2>&1'; then
  echo "primary identity was not rejected in the secondary workspace" >&2
  exit 77
fi

echo "Configuration and both initial workspace repositories are cloned and identity-verified."
echo "No service was enabled or started, and no Tailscale route was changed."
