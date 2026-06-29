# Context Pressure Meter - Progress Report

## Summary

> Current focus: M1: Context Pressure Policy

- Total checklist items: 29
- Completed: 4
- Current cutoff blockers: 25

## 0. Hard Dependencies

- [x] Existing `Usage` contract
- [x] Existing live `assistant.progress` flow
- [x] Existing `SidePanelBreakdown` context meter
- [x] Existing SidePanel Storybook/tests

## M1: Context Pressure Policy

- [ ] RED: Unit tests for ratio thresholds at `0`, `69.9`, `70`, `84.9`, `85`, `94.9`, `95`, `100`, and `>100` percent
- [ ] GREEN: Add pure `contextPressureState(ctxUsed, ctxMax)` helper
- [ ] RED: Tests for invalid, missing, and zero-max values returning absent state
- [ ] GREEN: Keep `SidePanelBreakdown` from rendering a meter when policy returns absent
- [ ] REFACTOR: Keep formatting helpers local unless reused

## M2: Storybook Visual States

- [ ] RED: SidePanel stories for normal `42%`, warning `72%`, danger `91%`, critical `97%`, exactly full, and over-window
- [ ] GREEN: Apply semantic fill classes by pressure band
- [ ] RED: Visual/story tests for long window labels and narrow panel width
- [ ] GREEN: Format the meter label as token count plus percent, preserving max-window label where it fits
- [ ] REFACTOR: Avoid layout shift when the band changes live

## M3: SidePanel Wiring

- [ ] RED: Extend `SidePanel.test.tsx` for normal, warning, danger, and critical state output
- [ ] GREEN: Wire `SidePanelBreakdown` to the pure policy result
- [ ] RED: Regression tests for replay/initial-load transition behavior
- [ ] GREEN: Preserve existing width transition behavior
- [ ] REFACTOR: Keep token formatting consistent with `fmtTok`/`fmtCtx`

## M4: Context Event Awareness

- [ ] RED: Tests for critical rendering with high ratio and with explicit context-pressure/overflow events elsewhere
- [ ] GREEN: Keep normal/warning/danger color-only and critical restrained
- [ ] RED: Verify no additional warning prose appears below critical
- [ ] GREEN: Keep any critical copy short and non-overlapping
- [ ] REFACTOR: Do not duplicate transcript alert wording

## M5: Accessibility and E2E

- [ ] RED: Accessibility tests for tokens, percent, window, and band labels
- [ ] GREEN: Expose pressure band without relying on color alone
- [ ] RED: Reduced-motion and high-contrast checks
- [ ] GREEN: Verify Storybook desktop and narrow panel screenshots
- [ ] REFACTOR: Document thresholds in helper test names
