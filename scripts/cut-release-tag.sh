#!/usr/bin/env bash
set -euo pipefail

VERSION=$(node -p "JSON.parse(require('fs').readFileSync('package.json')).version")
[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || { echo 'Only stable semantic versions are supported'; exit 1; }
TAG="v$VERSION"
REFERENCES=$(git ls-remote --tags origin "refs/tags/$TAG" "refs/tags/$TAG^{}")
EXISTING=$(awk -v tag="refs/tags/$TAG" '$2 == tag { direct=$1 } $2 == tag "^{}" { peeled=$1 } END { print peeled ? peeled : direct }' <<< "$REFERENCES")
if [[ -n "$EXISTING" ]]; then
  [[ "$EXISTING" == "$(git rev-parse HEAD)" ]] || { echo 'Version tag belongs to another commit'; exit 1; }
else
  git tag "$TAG"
  git push origin "$TAG"
fi
