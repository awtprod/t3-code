#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "bootstrap-data.sh must run as root" >&2
  exit 77
fi

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

clone_if_missing awtprod awtprod/command-center-config /var/lib/command-center/config runtime/openclaw-deployed
clone_if_missing awtprod awtprod/t3-code /srv/command-center/workspaces/awtprod/t3-code
clone_if_missing ccn Charlotte-Comedy-Network/ccn-web-app /srv/command-center/workspaces/ccn/ccn-web-app

run_cc awtprod sh -c 'cd /var/lib/command-center/config && exec /usr/local/bin/pnpm run check'

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

verify_identity awtprod awtprod /srv/command-center/workspaces/awtprod/t3-code
verify_identity ccn charlottecomedynetwork /srv/command-center/workspaces/ccn/ccn-web-app

if run_cc ccn sh -c 'cd /srv/command-center/workspaces/awtprod/t3-code && /opt/command-center/bin/gh api user --jq .login >/dev/null 2>&1'; then
  echo "CCN identity was not rejected in the awtprod workspace" >&2
  exit 77
fi
if run_cc awtprod sh -c 'cd /srv/command-center/workspaces/ccn/ccn-web-app && /opt/command-center/bin/gh api user --jq .login >/dev/null 2>&1'; then
  echo "awtprod identity was not rejected in the CCN workspace" >&2
  exit 77
fi

echo "Configuration and both initial workspace repositories are cloned and identity-verified."
echo "No service was enabled or started, and no Tailscale route was changed."
