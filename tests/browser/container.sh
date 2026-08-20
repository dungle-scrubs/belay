# Shared container setup for the Lane A baseline scripts (plan 09.2), sourced by update/check/prove so the
# pinned image, the repo-copy/install preamble, and the pnpm pin live in ONE place and can't drift.
# Keep IMAGE in sync with tests/browser/shared.ts PLAYWRIGHT_IMAGE (asserted by e2e/browser-ci-config.test.ts).

# shellcheck disable=SC2034
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC2034
IMAGE="mcr.microsoft.com/playwright:v1.62.1-noble"

# Run INSIDE the container before each script's body (concatenate as `bash -lc "$CONTAINER_PREP"'<body>'`):
# copy the repo (minus node_modules/.git/build output) into a writable tree, init a throwaway git
# (lefthook's `prepare` needs one), then install the pinned pnpm + deps. The container ships an older
# corepack whose keys reject the current pnpm signature, so pnpm is installed directly.
# shellcheck disable=SC2034
CONTAINER_PREP='
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
'
