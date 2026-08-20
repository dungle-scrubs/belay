#!/usr/bin/env bash
#
# Regenerate the Storybook visual-regression baselines INSIDE the pinned Playwright container (plan 09.2
# D-002), so the committed PNGs render with the SAME fonts + antialiasing as CI. Host-generated (macOS)
# baselines would fail every story on ubuntu, so visual baselines are ALWAYS produced this way.
#
# Run this after an intentional visual change, then review the diff and commit the updated PNGs:
#   tests/browser/update-storybook-baselines.sh
#   git add apps/web/__snapshots__ && git commit
#
# Requires Docker. The repo is copied into a writable container tree (see container.sh) so the linux
# install never touches the host's macOS node_modules; only the regenerated baselines are copied back out.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/container.sh"
SNAP_DIR="$REPO_ROOT/apps/web/__snapshots__"
mkdir -p "$SNAP_DIR"

docker run --rm --ipc=host \
  -v "$REPO_ROOT":/src:ro \
  -v "$SNAP_DIR":/out \
  "$IMAGE" bash -lc "$CONTAINER_PREP"'
    pnpm --filter @belay/web build-storybook
    # Full regen: clear the existing baselines so every story is "missing" and gets written fresh.
    # (jest-image-snapshot writes a MISSING baseline but only FAILS on a changed one without -u, so a
    # clean slate is the simplest, unambiguous way to overwrite at a new viewport/threshold.)
    rm -rf /app/apps/web/__snapshots__/*
    CI= pnpm --filter @belay/web test-storybook
    rm -rf /out/* || true
    cp -a /app/apps/web/__snapshots__/. /out/ 2>/dev/null || true
  '

echo "Baselines regenerated in $SNAP_DIR (container: $IMAGE). Review with: git status apps/web/__snapshots__"
