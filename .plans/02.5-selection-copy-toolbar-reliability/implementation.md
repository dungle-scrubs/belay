# Selection Copy Toolbar Reliability - Implementation Plan

## 0. Hard Dependencies

- [x] Existing `QuoteSelectionToolbar` component in `apps/web/src/components/assistant-ui/quote-selection-toolbar.tsx`.
- [x] Existing transcript message scoping through `data-message-id`.
- [x] Existing toolbar tests in `apps/web/src/components/assistant-ui/quote-selection-toolbar.test.tsx`.
- [x] Existing Storybook story in `apps/web/src/components/chat/quote-selection-toolbar.stories.tsx`.
- [x] Existing transcript virtualization/render path in `VirtualTranscript` and `PanelHost`.
- [x] Existing browser clipboard path through `navigator.clipboard.writeText`.

## 1. Architecture

The transcript text-selection toolbar must make drag-highlight-copy reliable before any higher-level selection actions depend on it. The current user-visible failure is that highlighted transcript text disappears shortly after mouse drag, and then the toolbar Copy button has no selected text to copy. A second failure is placement: when a drag starts or ends near the left edge, the toolbar can be clipped offscreen instead of staying edge-aware.

The fix should treat browser selection as volatile UI state. On selection completion, Trevor should snapshot the selected text and source message id immediately, then drive Copy/Quote/Tangent from that snapshot instead of requiring `window.getSelection()` to still contain text when the button is clicked. Native selection can remain visually highlighted while possible, but clipboard behavior must not depend on the selection surviving transcript re-renders, stream ticks, virtual-list refreshes, or focus changes. <!-- D-001 -->

The toolbar anchor should be edge-aware. It can prefer the pointer/focus-end anchor, but the final popover position must clamp within the viewport with enough padding that all actions remain reachable. This must work near left and right edges, at narrow widths, and when the toolbar grows to include Copy, Quote, and Tangent. <!-- D-002 -->

This is a bug-fix reliability plan, not the host clipboard tool plan. It does not add `/clip`, model-mediated clipboard writes, persisted clipboard state, or special transcript content extraction. It stabilizes direct user drag-highlight actions in the browser. <!-- D-003 -->

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Reproduce first | Start with EZE/browser-aligned reproduction of the selection disappearing and Copy failing. |
| Snapshot selected text | Copy/Quote/Tangent use captured selection data, not a later `window.getSelection()` read. |
| Preserve native selection when possible | Do not intentionally clear selection for Copy; Quote/Tangent may dismiss after action. |
| Edge-aware placement | Toolbar stays fully inside viewport with action buttons reachable. |
| Transcript re-render resilient | Streaming, host recency ticks, virtualization, and scroll updates must not erase the toolbar's payload. |
| Storybook first for UI states | Edge placement and stale-selection cases are visible in stories before live validation. |

### Boundaries

- `apps/web/src/components/assistant-ui/quote-selection-toolbar.tsx` owns selection capture, toolbar payload state, action dispatch, and viewport-aware placement.
- `apps/web/src/components/assistant-ui/quote-selection-toolbar.test.tsx` owns deterministic jsdom regressions for snapshotting, lost native selection, and viewport clamping logic.
- `apps/web/src/components/chat/quote-selection-toolbar.stories.tsx` owns visual review states for center, left-edge, right-edge, narrow width, stale native selection, and all action combinations.
- `PanelHost` should only wire callbacks. It should not own low-level browser selection recovery.
- The transcript renderer should preserve `data-message-id` boundaries and avoid unnecessary selection-destructive DOM churn where feasible, but toolbar actions must be correct even when churn happens.

### Observability

No host observability is required. Browser-side diagnostics should be testable through component state and failure handling:

- Copy success/failure can be represented in local toolbar state or test spies.
- Selection snapshot stores selected text, message id, anchor, capture time, and action availability.
- Development diagnostics may expose why a toolbar was dismissed: empty selection, cross-message selection, outside click, scroll reposition failure, or action complete.

## 2. Current State

`QuoteSelectionToolbar` currently reads `window.getSelection()` when the toolbar opens and then reads it again when Copy or Quote is clicked. That is fragile because transcript re-renders or selectionchange events can collapse the browser selection between mouseup and click. The code comment already acknowledges native Cmd+C is fragile, but the implementation still depends on the live selection at click time.

The tests cover basic Copy and Quote with a mocked stable selection, but they do not cover the real failure mode: selection exists on mouseup, disappears before the click, and Copy still needs to write the captured text. Tests also do not cover viewport clamping for the toolbar.

## 3. Phases

### Phase 1: Reproduction and Failure Capture

**Goal:** The disappearing-selection and clipped-toolbar failures are reproducible before fixing.

**Gate from previous:** Existing quote-selection toolbar tests and Storybook story are understood.

#### M1: Browser-Aligned Repro

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add a test that selects text, opens the toolbar, then makes `window.getSelection()` return an empty/collapsed selection before clicking Copy.
  2. RED: Add a test that verifies Quote cannot depend on a later live selection read after selection collapse.
  3. RED: Add a test or fixture for transcript re-render/host tick while a toolbar is open.
  4. RED: Add Storybook reproduction notes/states for vanished native selection with retained toolbar payload.
  5. REFACTOR: Keep reproduction helpers explicit about selection lifecycle instead of hiding the collapse behind generic mocks.

#### M2: Edge Placement Repro

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add placement tests for left-edge anchors, right-edge anchors, narrow viewport, and wide toolbar content.
  2. RED: Add a visual story for drag-ending near the left edge without clipping.
  3. RED: Add a visual story for drag-ending near the right edge without clipping.
  4. GREEN: Introduce pure placement fixtures or helpers that can be tested without browser layout flakiness.
  5. REFACTOR: Keep placement math independent from DOM event wiring.

### Gate 1->2

- [ ] Copy failure after native selection collapse is reproduced.
- [ ] Quote failure after native selection collapse is reproduced.
- [ ] Left/right/narrow clipping is reproduced in tests or Storybook fixtures.

### Phase 2: Stable Selection Snapshot

**Goal:** Toolbar actions use captured selected text and message metadata even after native selection disappears.

**Gate from previous:** Failure cases are covered by failing tests/stories.

#### M3: Snapshot Model

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for captured selected text, message id, anchor, and action availability stored at toolbar-open time.
  2. GREEN: Replace anchor-only toolbar state with a `SelectionSnapshot` model.
  3. RED: Add tests proving cross-message selections and empty selections do not create a snapshot.
  4. GREEN: Keep the toolbar visible and actionable from the snapshot when native selection later collapses.
  5. REFACTOR: Centralize trimming, source-message lookup, and focus-end anchor capture in one selection-capture function.

#### M4: Copy and Quote Reliability

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Add tests proving Copy writes the snapshot text after native selection is empty.
  2. GREEN: Wire Copy to `snapshot.text` and keep the toolbar payload stable through click.
  3. RED: Add tests proving Quote receives the snapshot text after native selection is empty.
  4. GREEN: Wire Quote to `snapshot.text` and dismiss only after action dispatch.
  5. REFACTOR: Ensure Copy does not call `removeAllRanges`; only dismisses toolbar state.

### Gate 2->3

- [ ] Copy succeeds after selection collapse.
- [ ] Quote succeeds after selection collapse.
- [ ] Copy does not require or clear live browser selection.

### Phase 3: Edge-Aware Toolbar Placement

**Goal:** Toolbar actions stay reachable at viewport edges and narrow widths.

**Gate from previous:** Snapshot-driven actions are working in tests.

#### M5: Viewport Clamp

- **Dependencies:** M2, M3
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for clamped x/y placement with viewport padding.
  2. GREEN: Implement edge-aware placement using measured or declared toolbar dimensions.
  3. RED: Add tests for toolbar width changes when Tangent is enabled.
  4. GREEN: Keep pointer/focus-end preference while clamping final placement inside viewport.
  5. REFACTOR: Keep placement helper pure and cover it with table-driven cases.

#### M6: Visual and Accessibility Polish

- **Dependencies:** M5
- **Effort:** S
- **Tasks:**
  1. RED: Add Storybook states for center, left edge, right edge, narrow width, stale selection, and clipboard failure.
  2. GREEN: Ensure action buttons remain visible, focusable, and non-overlapping across those states.
  3. RED: Add tests for keyboard activation of Copy and Quote after snapshot capture.
  4. GREEN: Preserve accessible labels/tooltips for Copy, Quote, and future Tangent.
  5. REFACTOR: Keep visual changes scoped to the selection toolbar.

### Gate 3->4

- [ ] Toolbar is edge-aware and not clipped at left/right viewport boundaries.
- [ ] Storybook covers edge and stale-selection states.
- [ ] Keyboard activation works from the snapshot model.

### Phase 4: Transcript Integration and Regression Testing

**Goal:** The toolbar remains reliable in the live transcript under re-render, scroll, and streaming conditions.

**Gate from previous:** Component behavior and placement pass in isolation.

#### M7: Transcript Re-render Resilience

- **Dependencies:** M4, M6
- **Effort:** M
- **Tasks:**
  1. RED: Add web tests for transcript re-render while toolbar is open.
  2. GREEN: Ensure toolbar payload persists through host recency ticks, streaming deltas, and virtual-list refreshes when the source message still exists.
  3. RED: Add tests for source message disappearing, session switch, or takeover opening while toolbar is open.
  4. GREEN: Dismiss safely when the source message no longer exists or the active surface changes.
  5. REFACTOR: Keep dismissal reasons explicit and avoid broad document listeners that fight native selection.

#### M8: Manual EZE and Browser Validation

- **Dependencies:** M7
- **Effort:** M
- **Tasks:**
  1. RED: Add a manual EZE checklist for drag-highlight-copy in a live transcript with streaming/recency updates.
  2. GREEN: Validate Copy writes to the real clipboard after waiting at least one second before clicking.
  3. GREEN: Validate left-edge and right-edge drag ending keeps the toolbar visible.
  4. GREEN: Validate Quote still populates the composer after native highlight disappears.
  5. REFACTOR: Remove stale comments that claim Copy is robust while depending on live selection.

### Gate 4

- [ ] Unit/web tests pass for snapshot copy, quote, placement, and transcript re-render behavior.
- [ ] Storybook states are reviewed.
- [ ] Manual EZE confirms drag-highlight-copy works after delay and at viewport edges.

## 4. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Browser selection remains visually gone even though Copy works | medium | high | Treat Copy reliability as the hard requirement; preserve visual selection when feasible but do not depend on it. | Web |
| Toolbar state becomes stale across session switch | high | medium | Store source message id and dismiss on source/session/takeover changes. | Web |
| Placement math is flaky in jsdom | medium | medium | Put clamp math in pure helpers and use Storybook/browser validation for visual checks. | Web |
| Clipboard API fails due to permissions/focus | medium | medium | Surface local failure state and keep snapshot available for retry while toolbar remains open. | Web |
| Fix breaks future Tangent action | medium | low | Define snapshot payload as text + source message id so Tangent can use the same model. | Web |

## 5. Escape Hatches

1. **If visual selection cannot be preserved through transcript re-renders:** keep the toolbar payload and Copy/Quote reliable, and accept visual highlight loss as a browser-rendering limitation.
2. **If clipboard permissions fail in a browser shell:** keep the toolbar open with an error/retry state and allow native selection/copy as fallback where possible.
3. **If dynamic measurement is brittle:** use stable expected toolbar dimensions plus viewport clamping, then revisit measurement when Tangent is enabled.

## 6. Progress Report Accounting

The progress report is `.plans/02.5-selection-copy-toolbar-reliability/progress-report.md`. It tracks only transcript text-selection toolbar reliability: selection snapshotting, Copy/Quote reliability after native selection collapse, edge-aware placement, Storybook states, and live transcript regression coverage. It does not track host clipboard tools, `/clip`, code-block copy buttons, or Tangent session behavior except as future consumers of the stable snapshot model.

Before resuming implementation or declaring convergence, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "02.5-selection-copy-toolbar-reliability"
```

## 7. Validation Commands

```bash
pnpm --filter @trevor/web test -- quote-selection-toolbar
pnpm --filter @trevor/web test -- panel
pnpm --filter @trevor/web storybook
pnpm --filter @trevor/web test
pnpm typecheck
pnpm biome check
```

## 8. Decisions

Canonical decisions are in `.plans/02.5-selection-copy-toolbar-reliability/plan.db`.

