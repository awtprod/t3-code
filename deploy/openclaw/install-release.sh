#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "install-release.sh must run as root" >&2
  exit 77
fi

commit=${1:-}
case "$commit" in
  ''|*[!0-9a-f]*) echo "usage: install-release.sh <full-commit>" >&2; exit 64 ;;
esac
if [ "${#commit}" -ne 40 ]; then
  echo "install-release.sh requires a full 40-character commit" >&2
  exit 64
fi

source_dir=/srv/command-center-release-$commit
release_root=/opt/command-center/releases
target=$release_root/$commit
staging=$release_root/.$commit.staging.$$

if [ ! -f "$source_dir/package.json" ]; then
  echo "release source is missing at $source_dir" >&2
  exit 66
fi
if [ -e "$target" ]; then
  echo "immutable release already exists at $target" >&2
  exit 73
fi
if systemctl is-active --quiet command-center.candidate.service; then
  echo "refusing to replace the candidate release while its service is active" >&2
  exit 77
fi
case "$staging" in
  /opt/command-center/releases/.*.staging.*) ;;
  *) echo "refusing unsafe staging path $staging" >&2; exit 77 ;;
esac

cleanup() {
  if [ -d "$staging" ]; then
    rm -rf -- "$staging"
  fi
}
trap cleanup EXIT HUP INT TERM

install -d -o root -g root -m 0755 "$staging"
cp -a "$source_dir/." "$staging/"
cd "$staging"
/usr/local/bin/pnpm install --frozen-lockfile
/usr/local/bin/pnpm run build

chown -R root:root "$staging"
chmod -R a-w "$staging"
mv "$staging" "$target"
ln -sfn "$target" /opt/command-center/current
trap - EXIT HUP INT TERM

echo "Installed immutable release $target and selected it as /opt/command-center/current."
echo "No service was enabled or started, and no Tailscale route was changed."
