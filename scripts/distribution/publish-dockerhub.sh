#!/usr/bin/env bash
# Copy the attested GHCR manifest without rebuilding or changing digests.
set -euo pipefail
: "${DOCKERHUB_NAMESPACE:?Set the destination Docker Hub namespace}"
: "${DOCKERHUB_USERNAME:?Set the Docker Hub login name}"
: "${DOCKERHUB_TOKEN:?Supply a scoped Docker Hub access token}"
: "${RELEASE_TAG:?Set a stable release tag}"
[[ "$DOCKERHUB_NAMESPACE" =~ ^[a-z0-9][a-z0-9_-]+$ ]] || { echo 'Invalid Docker Hub namespace' >&2; exit 1; }
[[ "$RELEASE_TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || { echo 'A stable release tag is required' >&2; exit 1; }
version=${RELEASE_TAG#v}
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
umask 077
gh release download "$RELEASE_TAG" --repo thibautrey/multivibe --pattern container-release.json --dir "$work"
gh attestation verify "$work/container-release.json" --repo thibautrey/multivibe --signer-workflow thibautrey/multivibe/.github/workflows/provider-host-release.yml >/dev/null
node scripts/provider-host/provider-host-container-release.mjs verify "$work/container-release.json" "$version" "$(jq -r .sourceCommit "$work/container-release.json")"
source_image=$(jq -r .immutableReference "$work/container-release.json")
digest=$(jq -r .digest "$work/container-release.json")
destination="docker.io/$DOCKERHUB_NAMESPACE/multivibe-host"
printf '%s' "$DOCKERHUB_TOKEN" | skopeo login --authfile "$work/auth.json" --username "$DOCKERHUB_USERNAME" --password-stdin docker.io
unset DOCKERHUB_TOKEN
# Distinguish an unused tag from network/auth failures; never overwrite a version.
if skopeo inspect --authfile "$work/auth.json" "docker://$destination:$version" >"$work/existing.json" 2>"$work/error"; then
  [[ "$(jq -r .Digest "$work/existing.json")" == "$digest" ]] || { echo 'Version tag already contains a different image' >&2; exit 1; }
else
  if ! grep -qiE 'manifest unknown|name unknown' "$work/error"; then
    cat "$work/error" >&2; exit 1
  fi
  skopeo copy --all --preserve-digests --authfile "$work/auth.json" "docker://$source_image" "docker://$destination:$version"
fi
[[ "$(skopeo inspect --authfile "$work/auth.json" --format '{{.Digest}}' "docker://$destination:$version")" == "$digest" ]]
# Replaying an older release must not roll latest back.
if [[ "$(gh release view --repo thibautrey/multivibe --json tagName --jq .tagName)" == "$RELEASE_TAG" ]]; then
  skopeo copy --all --preserve-digests --authfile "$work/auth.json" "docker://$source_image" "docker://$destination:latest"
  [[ "$(skopeo inspect --authfile "$work/auth.json" --format '{{.Digest}}' "docker://$destination:latest")" == "$digest" ]]
fi
printf 'Published %s:%s@%s\n' "$destination" "$version" "$digest"
