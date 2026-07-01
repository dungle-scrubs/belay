#!/usr/bin/env bash
#
# Run the Storybook visual-regression lane (plan 09.2 Lane A) INSIDE the pinned Playwright container the
# same way CI does: build the static Storybook, then screenshot-diff every story against the COMMITTED
# baselines with NO `--update-snapshots` (so a drift fails). Use this locally to reproduce a CI Lane A
# failure, or to confirm freshly regenerated baselines are stable.
#
#   tests/browser/check-storybook-baselines.sh
#
# Requires Docker. Like the update script, the repo is copied into a writable container tree (container.sh)
# so the linux install never touches the host's macOS node_modules.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/container.sh"

docker run --rm --ipc=host \
  -v "$REPO_ROOT":/src:ro \
  "$IMAGE" bash -lc "$CONTAINER_PREP"'
    pnpm --filter @trevor/web build-storybook
    # CI=true -> jest-image-snapshot fails on a drift OR a missing baseline (never writes).
    CI=true pnpm --filter @trevor/web test-storybook
  '
