#!/usr/bin/env bash
# Builds the two sandbox images and prints digest-pinned refs for them.
#
# The server refuses any image reference that is not pinned by digest
# (apps/server/src/sandbox/ContainerSandboxBackend.ts and ThreadPreviewProxy.ts
# both test /^[a-z0-9][a-z0-9._/-]{0,200}@sha256:[a-f0-9]{64}$/i), so a tag is
# never a usable answer here. The output of this script is four environment
# assignments meant to be pasted into the server's unit file or sourced:
#
#   T3_SANDBOX_IMAGE=...@sha256:...
#   T3_SANDBOX_PREVIEW_PROXY_IMAGE=...@sha256:...
#   T3_SANDBOX_EGRESS_PROXY_IMAGE=...@sha256:...
#   T3_SANDBOX_CREDENTIAL_PROXY_IMAGE=...@sha256:...
#
# The last three name the same sidecar image and therefore the same digest.
#
# Idempotent: re-running with unchanged sources rebuilds from layer cache and
# prints the same digests. Safe to run repeatedly.
#
# Usage:
#   ./build-sandbox-images.sh                 # build both, print refs
#   ./build-sandbox-images.sh --output env    # same, as a sourceable env file
#   REGISTRY=registry.example.com/t3 ./build-sandbox-images.sh --push
set -euo pipefail

script_dir=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(CDPATH='' cd -- "${script_dir}/../../.." && pwd)

REGISTRY=${REGISTRY:-localhost/t3}
TAG=${TAG:-dev}
PODMAN=${PODMAN:-podman}
BASE_IMAGE=${BASE_IMAGE:-docker.io/library/node:22-bookworm-slim}
push=0
output=shell

while [ "$#" -gt 0 ]; do
  case "$1" in
    --push) push=1 ;;
    --output)
      shift
      output=${1:-shell}
      ;;
    --output=*) output=${1#--output=} ;;
    -h | --help)
      sed -n '2,20p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

case "${output}" in
  shell | env) ;;
  *)
    printf 'unknown --output value: %s (expected shell or env)\n' "${output}" >&2
    exit 2
    ;;
esac

if ! command -v "${PODMAN}" >/dev/null 2>&1; then
  printf 'podman is required but was not found on PATH (set PODMAN= to override)\n' >&2
  exit 3
fi

workspace_ref="${REGISTRY}/sandbox-workspace-headless:${TAG}"
sidecar_ref="${REGISTRY}/sandbox-sidecar:${TAG}"
context_dir="${script_dir}/context"
bundle_dir="${repo_root}/packages/sandbox-bridge/dist"

# The build context is regenerated on every run so a stale bundle can never be
# baked into an image that then claims a fresh digest.
rm -rf "${context_dir}"
mkdir -p "${context_dir}/bin"

printf 'building sandbox-bridge bundles\n' >&2
(cd "${repo_root}/packages/sandbox-bridge" && node build.ts >&2)

for binary in t3-preview-bridge t3-egress-proxy t3-credential-proxy; do
  if [ ! -f "${bundle_dir}/${binary}.mjs" ]; then
    printf 'missing bundle: %s/%s.mjs\n' "${bundle_dir}" "${binary}" >&2
    exit 4
  fi
  install -m 0555 "${bundle_dir}/${binary}.mjs" "${context_dir}/bin/${binary}.mjs"
done

build_image() {
  local containerfile=$1 ref=$2
  printf 'building %s\n' "${ref}" >&2
  "${PODMAN}" build \
    --file "${script_dir}/${containerfile}" \
    --build-arg "BASE_IMAGE=${BASE_IMAGE}" \
    --tag "${ref}" \
    "${context_dir}" >&2
}

# Resolves a local tag to `name@sha256:<64 hex>`. `podman image inspect
# --format '{{.Digest}}'` reports the manifest digest of the local image, which
# is what a digest-pinned local reference must carry. After --push the registry
# copy carries the same manifest digest, so the ref stays valid remotely.
pinned_ref() {
  local ref=$1 name digest
  name=${ref%:*}
  digest=$("${PODMAN}" image inspect --format '{{.Digest}}' "${ref}")
  case "${digest}" in
    sha256:*) ;;
    *)
      printf 'podman reported a non-sha256 digest for %s: %s\n' "${ref}" "${digest}" >&2
      exit 5
      ;;
  esac
  if ! printf '%s' "${digest#sha256:}" | grep -Eq '^[a-f0-9]{64}$'; then
    printf 'digest for %s is not 64 hex characters: %s\n' "${ref}" "${digest}" >&2
    exit 5
  fi
  printf '%s@%s' "${name}" "${digest}"
}

verify_ref() {
  local ref=$1
  printf 'verifying %s\n' "${ref}" >&2
  "${PODMAN}" run --rm "${ref}" true >/dev/null
}

build_image Containerfile.workspace-headless "${workspace_ref}"
build_image Containerfile.sidecar "${sidecar_ref}"

if [ "${push}" -eq 1 ]; then
  # Fallback when the server runs on a different host from the builder: a
  # `localhost/` ref only resolves where it was built. Push to a registry both
  # hosts can reach and export REGISTRY= so the pinned refs name that registry;
  # the manifest digest survives the push unchanged, so the refs this script
  # prints stay correct on the far side. Without a registry, the alternative is
  # `podman save`/`podman load`, which also preserves the manifest digest.
  for ref in "${workspace_ref}" "${sidecar_ref}"; do
    printf 'pushing %s\n' "${ref}" >&2
    "${PODMAN}" push "${ref}" >&2
  done
fi

workspace_pinned=$(pinned_ref "${workspace_ref}")
sidecar_pinned=$(pinned_ref "${sidecar_ref}")

verify_ref "${workspace_pinned}"
verify_ref "${sidecar_pinned}"

# The sidecar image serves the preview-proxy, egress-proxy and credential-proxy
# roles; the server chooses the binary through the container argv, not through
# the image, so those three share one digest. All four are emitted because an
# operator pasting three of four required variables is a silent misconfiguration.
if [ "${output}" = "env" ]; then
  printf 'T3_SANDBOX_IMAGE=%s\n' "${workspace_pinned}"
  printf 'T3_SANDBOX_PREVIEW_PROXY_IMAGE=%s\n' "${sidecar_pinned}"
  printf 'T3_SANDBOX_EGRESS_PROXY_IMAGE=%s\n' "${sidecar_pinned}"
  printf 'T3_SANDBOX_CREDENTIAL_PROXY_IMAGE=%s\n' "${sidecar_pinned}"
else
  printf 'export T3_SANDBOX_IMAGE=%s\n' "${workspace_pinned}"
  printf 'export T3_SANDBOX_PREVIEW_PROXY_IMAGE=%s\n' "${sidecar_pinned}"
  printf 'export T3_SANDBOX_EGRESS_PROXY_IMAGE=%s\n' "${sidecar_pinned}"
  printf 'export T3_SANDBOX_CREDENTIAL_PROXY_IMAGE=%s\n' "${sidecar_pinned}"
fi
