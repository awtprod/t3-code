#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "install-provider-clis.sh must run as root" >&2
  exit 77
fi

install -d -o root -g root -m 0755 /opt/command-center/provider-cli
/usr/local/bin/npm install --prefix /opt/command-center/provider-cli --omit=dev --no-audit --no-fund \
  @openai/codex@0.147.0 \
  @anthropic-ai/claude-code@2.1.258 \
  @moonshot-ai/kimi-code@0.34.0
chown -R root:root /opt/command-center/provider-cli
chmod -R a-w /opt/command-center/provider-cli

for provider in codex claude kimi; do
  /opt/command-center/provider-cli/node_modules/.bin/$provider --version
done
