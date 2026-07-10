#!/usr/bin/env bash
# assistant-ui vendored-component drift check (plan 58.6.1 M3).
#
# Trevor OWNS copies of the assistant-ui components under
# apps/web/src/components/assistant-ui/ (see CONTEXT.md "assistant-ui dependency
# governance"). Upstream changes to those components reach us only through a
# deliberate re-vendor - never automatically. This script runs the assistant-ui
# CLI's `add --dry` (a dry-run that prints what it WOULD write) for each vendored
# component, so an upstream drift is visible at review time before we adopt it.
#
# Review aid, not a CI gate: `assistant-ui add --dry` needs network access to the
# assistant-ui registry, so run it locally when considering a bump. A non-empty diff
# for a component means upstream moved; reconcile by hand and update the ledger.
#
# Usage: pnpm --filter @trevor/web check:assistant-ui-drift
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR_DIR="${SCRIPT_DIR}/../src/components/assistant-ui"

# The vendored components that track an upstream assistant-ui source. Lazy wrappers,
# Trevor-authored helpers, and *.test/*.stories files are intentionally excluded -
# they are ours, not copies of an upstream registry component.
COMPONENTS=(
  reasoning
  diff-viewer
  tool-fallback
  tool-group
  tooltip-icon-button
  attachment
  model-selector
)

echo "assistant-ui vendored-component drift check"
echo "vendored dir: ${VENDOR_DIR}"
echo "pins: @assistant-ui/react 0.14.23, @assistant-ui/react-markdown 0.14.4 (see CONTEXT.md)"
echo

for component in "${COMPONENTS[@]}"; do
  echo "--- ${component} ---"
  # --dry prints the would-write output without touching the tree; --overwrite makes
  # the dry-run compare against the existing vendored copy instead of skipping it.
  npx assistant-ui add --dry --overwrite "${component}" || {
    echo "  (dry-run unavailable - needs network access to the assistant-ui registry)"
  }
  echo
done

echo "Done. A non-empty would-write diff means upstream moved; reconcile by hand,"
echo "re-run the render smoke tests, and update the CONTEXT.md ledger."
