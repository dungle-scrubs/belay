#!/usr/bin/env bash
#
# Run the Storybook visual-regression lane (plan 09.2 Lane A) INSIDE the pinned Playwright container the
# same way CI does: build the static Storybook, then screenshot-diff every story against the COMMITTED
# baselines with NO `--update-snapshots` (so a drift fails). Use this locally to reproduce a CI Lane A
# failure, or to confirm freshly regenerated baselines are stable.
#
#   tests/browser/check-storybook-baselines.sh
#
# Requires Docker. Like the update script, the repo is copied into a writable container tree so the linux
# install never touches the host's macOS node_modules.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="mcr.microsoft.com/playwright:v1.50.0-noble"

docker run --rm --ipc=host \
  -v "$REPO_ROOT":/src:ro \
  "$IMAGE" bash -lc '
    set -euo pipefail
    mkdir -p /app
    cd /src && tar \
      --exclude=./node_modules --exclude="*/node_modules" \
      --exclude=./.git --exclude="*/storybook-static" \
      --exclude=./test-results --exclude="*/dist" \
      -cf - . | (cd /app && tar -xf -)
    cd /app
    git init -q
    npm install -g pnpm@11.5.2 >/dev/null 2>&1
    pnpm install --frozen-lockfile
    pnpm --filter @trevor/web build-storybook
    # CI=true -> jest-image-snapshot fails on a drift OR a missing baseline (never writes).
    CI=true pnpm --filter @trevor/web test-storybook
  '
