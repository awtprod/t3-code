#!/bin/sh
set -eu

asset_url=${1:-}
expected_sha256=${2:-}
destination=${3:-}

https_prefix=https:
case "$asset_url" in "$https_prefix"//*) ;; *) echo "asset URL must use HTTPS" >&2; exit 2 ;; esac
case "$expected_sha256" in
  [0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]*) ;;
  *) echo "asset SHA-256 is required" >&2; exit 2 ;;
esac
[ "${#expected_sha256}" -eq 64 ] || { echo "asset SHA-256 must contain 64 hex characters" >&2; exit 2; }
[ -n "$destination" ] || { echo "asset destination is required" >&2; exit 2; }

temporary=$(mktemp)
trap 'rm -f "$temporary"' EXIT HUP INT TERM
curl --fail --location --proto '=https' --tlsv1.2 --output "$temporary" "$asset_url"
printf '%s  %s\n' "$expected_sha256" "$temporary" | sha256sum --check --status
install -m 0755 "$temporary" "$destination"
