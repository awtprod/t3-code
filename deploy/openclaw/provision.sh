#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "provision.sh must run as root" >&2
  exit 77
fi

asset_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

getent group commandcenter >/dev/null 2>&1 || groupadd --system commandcenter
if ! id commandcenter >/dev/null 2>&1; then
  useradd --system --gid commandcenter --home-dir /var/lib/command-center \
    --create-home --shell /usr/sbin/nologin commandcenter
fi
usermod --home /var/lib/command-center --shell /usr/sbin/nologin commandcenter

install -d -o root -g root -m 0755 /opt/command-center /opt/command-center/releases /opt/command-center/bin /opt/command-center/provider-cli
install -d -o commandcenter -g commandcenter -m 0700 \
  /var/lib/command-center \
  /var/lib/command-center/runtime \
  /var/lib/command-center/config \
  /var/lib/command-center/gh/awtprod \
  /var/lib/command-center/gh/ccn \
  /var/lib/command-center/providers/codex/awtprod \
  /var/lib/command-center/providers/codex/ccn \
  /var/lib/command-center/providers/claude/awtprod \
  /var/lib/command-center/providers/claude/ccn \
  /var/lib/command-center/providers/kimi/awtprod \
  /var/lib/command-center/providers/kimi/ccn \
  /srv/command-center/workspaces/awtprod \
  /srv/command-center/workspaces/ccn

install -o root -g root -m 0755 "$asset_dir/gh" /opt/command-center/bin/gh
install -o root -g root -m 0755 "$asset_dir/git-credential-gh" /opt/command-center/bin/git-credential-gh
install -o root -g root -m 0755 "$asset_dir/provider-run" /opt/command-center/bin/provider-run
for instance in codex-awtprod codex-ccn claude-awtprod claude-ccn kimi-awtprod kimi-ccn; do
  install -o root -g root -m 0755 "$asset_dir/provider-instance" "/opt/command-center/bin/$instance"
done
install -o root -g root -m 0644 "$asset_dir/command-center.service" /etc/systemd/system/command-center.candidate.service

install -o commandcenter -g commandcenter -m 0600 "$asset_dir/gitconfig" /var/lib/command-center/.gitconfig
install -o commandcenter -g commandcenter -m 0600 "$asset_dir/gitconfig-awtprod" /var/lib/command-center/gitconfig-awtprod
install -o commandcenter -g commandcenter -m 0600 "$asset_dir/gitconfig-ccn" /var/lib/command-center/gitconfig-ccn
install -d -o commandcenter -g commandcenter -m 0700 /var/lib/command-center/runtime/userdata
if [ ! -e /var/lib/command-center/runtime/userdata/settings.json ]; then
  install -o commandcenter -g commandcenter -m 0600 "$asset_dir/settings.json" \
    /var/lib/command-center/runtime/userdata/settings.json
fi

systemctl daemon-reload
echo "Prepared commandcenter account, private state roots, wrappers, and command-center.candidate.service."
echo "No service was enabled or started, and no Tailscale route was changed."
