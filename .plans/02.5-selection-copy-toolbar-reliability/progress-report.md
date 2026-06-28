# Selection Copy Toolbar Reliability - Progress Report

## Summary

- **Current focus:** M1 - Browser-Aligned Repro
- **Completed:** 6 / 58
- **Current cutoff blockers:** 52
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0

## 0. Hard Dependencies

- [x] Existing `QuoteSelectionToolbar` component in `apps/web/src/components/assistant-ui/quote-selection-toolbar.tsx`.
- [x] Existing transcript message scoping through `data-message-id`.
- [x] Existing toolbar tests in `apps/web/src/components/assistant-ui/quote-selection-toolbar.test.tsx`.
- [x] Existing Storybook story in `apps/web/src/components/chat/quote-selection-toolbar.stories.tsx`.
- [x] Existing transcript virtualization/render path in `VirtualTranscript` and `PanelHost`.
- [x] Existing browser clipboard path through `navigator.clipboard.writeText`.

## Current Cutoff Blockers

### Phase 1: Reproduction and Failure Capture

#### M1: Browser-Aligned Repro

- [ ] RED: Add a test that selects text, opens the toolbar, then makes `window.getSelection()` return an empty/collapsed selection before clicking Copy.
- [ ] RED: Add a test that verifies Quote cannot depend on a later live selection read after selection collapse.
- [ ] RED: Add a test or fixture for transcript re-render/host tick while a toolbar is open.
- [ ] RED: Add Storybook reproduction notes/states for vanished native selection with retained toolbar payload.
- [ ] REFACTOR: Keep reproduction helpers explicit about selection lifecycle instead of hiding the collapse behind generic mocks.

#### M2: Edge Placement Repro

- [ ] RED: Add placement tests for left-edge anchors, right-edge anchors, narrow viewport, and wide toolbar content.
- [ ] RED: Add a visual story for drag-ending near the left edge without clipping.
- [ ] RED: Add a visual story for drag-ending near the right edge without clipping.
- [ ] GREEN: Introduce pure placement fixtures or helpers that can be tested without browser layout flakiness.
- [ ] REFACTOR: Keep placement math independent from DOM event wiring.

#### Gate 1->2

- [ ] Copy failure after native selection collapse is reproduced.
- [ ] Quote failure after native selection collapse is reproduced.
- [ ] Left/right/narrow clipping is reproduced in tests or Storybook fixtures.

### Phase 2: Stable Selection Snapshot

#### M3: Snapshot Model

- [ ] RED: Add tests for captured selected text, message id, anchor, and action availability stored at toolbar-open time.
- [ ] GREEN: Replace anchor-only toolbar state with a `SelectionSnapshot` model.
- [ ] RED: Add tests proving cross-message selections and empty selections do not create a snapshot.
- [ ] GREEN: Keep the toolbar visible and actionable from the snapshot when native selection later collapses.
- [ ] REFACTOR: Centralize trimming, source-message lookup, and focus-end anchor capture in one selection-capture function.

#### M4: Copy and Quote Reliability

- [ ] RED: Add tests proving Copy writes the snapshot text after native selection is empty.
- [ ] GREEN: Wire Copy to `snapshot.text` and keep the toolbar payload stable through click.
- [ ] RED: Add tests proving Quote receives the snapshot text after native selection is empty.
- [ ] GREEN: Wire Quote to `snapshot.text` and dismiss only after action dispatch.
- [ ] REFACTOR: Ensure Copy does not call `removeAllRanges`; only dismisses toolbar state.

#### Gate 2->3

- [ ] Copy succeeds after selection collapse.
- [ ] Quote succeeds after selection collapse.
- [ ] Copy does not require or clear live browser selection.

### Phase 3: Edge-Aware Toolbar Placement

#### M5: Viewport Clamp

- [ ] RED: Add tests for clamped x/y placement with viewport padding.
- [ ] GREEN: Implement edge-aware placement using measured or declared toolbar dimensions.
- [ ] RED: Add tests for toolbar width changes when Tangent is enabled.
- [ ] GREEN: Keep pointer/focus-end preference while clamping final placement inside viewport.
- [ ] REFACTOR: Keep placement helper pure and cover it with table-driven cases.

#### M6: Visual and Accessibility Polish

- [ ] RED: Add Storybook states for center, left edge, right edge, narrow width, stale selection, and clipboard failure.
- [ ] GREEN: Ensure action buttons remain visible, focusable, and non-overlapping across those states.
- [ ] RED: Add tests for keyboard activation of Copy and Quote after snapshot capture.
- [ ] GREEN: Preserve accessible labels/tooltips for Copy, Quote, and future Tangent.
- [ ] REFACTOR: Keep visual changes scoped to the selection toolbar.

#### Gate 3->4

- [ ] Toolbar is edge-aware and not clipped at left/right viewport boundaries.
- [ ] Storybook covers edge and stale-selection states.
- [ ] Keyboard activation works from the snapshot model.

### Phase 4: Transcript Integration and Regression Testing

#### M7: Transcript Re-render Resilience

- [ ] RED: Add web tests for transcript re-render while toolbar is open.
- [ ] GREEN: Ensure toolbar payload persists through host recency ticks, streaming deltas, and virtual-list refreshes when the source message still exists.
- [ ] RED: Add tests for source message disappearing, session switch, or takeover opening while toolbar is open.
- [ ] GREEN: Dismiss safely when the source message no longer exists or the active surface changes.
- [ ] REFACTOR: Keep dismissal reasons explicit and avoid broad document listeners that fight native selection.

#### M8: Manual EZE and Browser Validation

- [ ] RED: Add a manual EZE checklist for drag-highlight-copy in a live transcript with streaming/recency updates.
- [ ] GREEN: Validate Copy writes to the real clipboard after waiting at least one second before clicking.
- [ ] GREEN: Validate left-edge and right-edge drag ending keeps the toolbar visible.
- [ ] GREEN: Validate Quote still populates the composer after native highlight disappears.
- [ ] REFACTOR: Remove stale comments that claim Copy is robust while depending on live selection.

#### Gate 4

- [ ] Unit/web tests pass for snapshot copy, quote, placement, and transcript re-render behavior.
- [ ] Storybook states are reviewed.
- [ ] Manual EZE confirms drag-highlight-copy works after delay and at viewport edges.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.
