#!/bin/sh
# Installed as /opt/command-center/bin/podman.
#
# The server resolves its container binary by bare name through PATH, and
# NodeSandboxCommandExecutor spawns it with `env: { PATH: process.env.PATH }` --
# every other variable is stripped. So CONTAINER_HOST cannot be delivered through
# the systemd unit; it has to be set here, inside the process the server spawns.
#
# /opt/command-center/bin is already first on the service's PATH, ahead of
# /usr/bin, so this wrapper shadows the real podman for the service only.
set -eu

CONTAINER_HOST=unix:///run/user/986/podman/podman.sock
export CONTAINER_HOST

exec /usr/bin/podman --remote "$@"
