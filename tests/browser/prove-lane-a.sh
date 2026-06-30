#!/usr/bin/env bash
#
# One-shot demonstration (plan 09.2 M1, NOT a committed test) that the Storybook visual lane actually
# guards. In one container session it proves, against the committed baselines in CI mode:
#   1. no-op            -> the run PASSES (baselines are stable).
#   2. visual regression-> a global layout shift makes the run FAIL (smoke alone would pass it).
#   3. missing baseline -> removing one baseline makes the run FAIL (no silent pass, no auto-write).
# All edits are container-local; the committed tree is never mutated.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="mcr.microsoft.com/playwright:v1.50.0-noble"

docker run --rm --ipc=host -v "$REPO_ROOT":/src:ro "$IMAGE" bash -lc '
  set -uo pipefail
  mkdir -p /app
  cd /src && tar \
    --exclude=./node_modules --exclude="*/node_modules" \
    --exclude=./.git --exclude="*/storybook-static" \
    --exclude=./test-results --exclude="*/dist" \
    -cf - . | (cd /app && tar -xf -)
  cd /app
  git init -q
  npm install -g pnpm@11.5.2 >/dev/null 2>&1
  pnpm install --frozen-lockfile >/dev/null 2>&1
  run() { CI=true pnpm --filter @trevor/web test-storybook >/tmp/r.log 2>&1; echo $?; }

  echo "### 1. NO-OP (expect PASS) ###"
  pnpm --filter @trevor/web build-storybook >/dev/null 2>&1
  A=$(run); echo "no-op exit=$A"; grep -E "Tests:" /tmp/r.log | tail -1

  echo "### 2. REGRESSION: widen global padding p-8 -> p-40 (expect FAIL) ###"
  sed -i "s/bg-background p-8/bg-background p-40/" apps/web/.storybook/preview.tsx
  pnpm --filter @trevor/web build-storybook >/dev/null 2>&1
  B=$(run); echo "regression exit=$B"; grep -E "Tests:" /tmp/r.log | tail -1
  sed -i "s/bg-background p-40/bg-background p-8/" apps/web/.storybook/preview.tsx

  echo "### 3. MISSING BASELINE: remove one (expect FAIL) ###"
  pnpm --filter @trevor/web build-storybook >/dev/null 2>&1
  rm -f apps/web/__snapshots__/chat-modelswitchmarker--reasoning-only.png
  C=$(run); echo "missing exit=$C"; grep -E "Tests:" /tmp/r.log | tail -1

  echo "### SUMMARY: no-op=$A(want 0) regression=$B(want!=0) missing=$C(want!=0) ###"
  { [ "$A" = "0" ] && [ "$B" != "0" ] && [ "$C" != "0" ]; } && echo "PROOF: PASS" || echo "PROOF: FAIL"
'
