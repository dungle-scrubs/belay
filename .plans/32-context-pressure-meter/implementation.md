# Context Pressure Meter - Implementation Plan

## 0. Hard Dependencies

- [x] Existing usage data contract: `Usage { input, output, contextWindow, genMs }` in `@trevor/session`.
- [x] Existing live `assistant.progress` flow that updates `panelModel` mid-turn.
- [x] Existing side panel context meter in `apps/web/src/components/panel/SidePanel.tsx`.
- [x] Existing SidePanel Storybook coverage and panel tests.
- [ ] `09.2-web-browser-test-suite` (lands first) - the manual "verify SidePanel desktop/narrow screenshots" step is replaced by 09.2's automated Storybook visual-regression lane; regenerate its committed baselines for the pressure-state SidePanel stories (normal/warning/danger/critical/full/over-window). <!-- D-003 -->

## 1. Architecture

The side panel context meter should communicate pressure through semantic color bands as context usage approaches the model window. The meter already knows `ctxUsed` and `ctxMax`; this plan adds a small pure policy layer that maps the usage ratio to a visual state and formats the display with both tokens and percent.

The UI should remain quiet until pressure matters. Color carries the semantic state; extra copy appears only when the critical band is reached or when the transcript already carries an explicit context pressure/overflow/recovery event.

### Threshold Policy

| Band | Ratio | Meaning | Visual token |
|---|---:|---|---|
| normal | `0%` to `<70%` | Context is being used; no user action implied | primary/accent |
| warning | `70%` to `<85%` | Long tool output, paste payloads, and reasoning could matter soon | warning |
| danger | `85%` to `<95%` | Meaningful risk of context pressure | destructive/error |
| critical | `95%` to `100%+` | Overflow/recovery likely or already in progress | destructive/error, optional stronger treatment |

### Boundaries

| Boundary | Owns | Does not own |
|---|---|---|
| `context-pressure` policy helper | Ratio calculation, band selection, label formatting | Rendering markup |
| `SidePanelBreakdown` | Meter layout, semantic color class application, token/percent display | Usage derivation |
| `panelModel` | Existing live/completed usage selection | Color thresholds |
| Host/protocol | Current usage emission | UI warning bands unless a missing data gap is found |

### Display Contract

The meter should show both a compact token count and percentage, e.g. `53.8k (42%)`, while still preserving the current `of 1M` context-window label where space permits. It should clamp the bar width to `100%` but keep the ratio/band calculation robust for over-window values.

## 2. Phases

### Phase 1: Policy and Storybook States

**Goal:** The threshold policy is pure, tested, and visually reviewable before live wiring changes.

#### M1: Context Pressure Policy

- **Dependencies:** hard dependencies
- **Effort:** S
- **Tasks:**
  1. RED: Add unit tests for ratio calculation at `0`, `69.9`, `70`, `84.9`, `85`, `94.9`, `95`, `100`, and `>100` percent.
  2. GREEN: Add a pure `contextPressureState(ctxUsed, ctxMax)` helper returning ratio, clampedPercent, band, and display labels.
  3. RED: Add tests for invalid/missing/max-zero values returning an absent state.
  4. GREEN: Keep `SidePanelBreakdown` from rendering a meter when policy returns absent.
  5. REFACTOR: Keep formatting helpers local to the panel domain unless reused elsewhere.

#### M2: Storybook Visual States

- **Dependencies:** M1
- **Effort:** S
- **Tasks:**
  1. RED: Add SidePanel stories for normal `42%`, warning `72%`, danger `91%`, critical `97%`, exactly full, and over-window.
  2. GREEN: Apply semantic color classes to the meter fill using the policy band.
  3. RED: Add visual/story tests for long context-window labels and narrow panel width.
  4. GREEN: Format the meter label as token count plus percent, preserving the max-window label where it fits.
  5. REFACTOR: Avoid layout shift when the band changes during live progress.

### Phase 2: Live Panel Integration

**Goal:** The live side panel changes color as the active or latest turn approaches context pressure.

#### M3: SidePanel Wiring

- **Dependencies:** M2
- **Effort:** S
- **Tasks:**
  1. RED: Extend `SidePanel.test.tsx` to verify normal, warning, danger, and critical class/state output.
  2. GREEN: Wire `SidePanelBreakdown` to consume the pure policy result and render semantic classes.
  3. RED: Add regression tests that replay/initial-load transition behavior still avoids animation churn.
  4. GREEN: Preserve existing width transition behavior from `useArmedAfterMount`.
  5. REFACTOR: Keep token formatting consistent with existing `fmtTok`/`fmtCtx` conventions.

#### M4: Context Event Awareness

- **Dependencies:** M3
- **Effort:** S
- **Tasks:**
  1. RED: Add tests for critical rendering when the ratio is high and when a context pressure/overflow status is visible elsewhere.
  2. GREEN: Keep the meter itself color-only for normal/warning/danger and allow critical to use a stronger but restrained treatment.
  3. RED: Verify no additional warning prose appears in normal/warning/danger bands.
  4. GREEN: If critical copy is added, keep it short and non-overlapping in narrow side panels.
  5. REFACTOR: Do not duplicate transcript alert wording in the panel.

### Phase 3: Validation

**Goal:** The meter is readable, accessible, and stable across side panel states.

#### M5: Accessibility and E2E

- **Dependencies:** M4
- **Effort:** S
- **Tasks:**
  1. RED: Add accessibility tests for `aria-label`/title text carrying tokens, percent, window, and band.
  2. GREEN: Expose the pressure band to assistive tech without relying on color alone.
  3. RED: Add reduced-motion and high-contrast checks where applicable.
  4. GREEN: Verify Storybook desktop and narrow panel screenshots.
  5. REFACTOR: Document thresholds in the helper test names so later threshold changes are deliberate.

## 3. Risk Register

| Risk | Severity | Likelihood | Mitigation |
|---|---:|---:|---|
| Warning threshold is noisy | medium | medium | Keep warning color only, no extra copy below critical |
| Meter implies exact tokenizer accounting when usage is estimated | medium | medium | Continue using existing usage source and label as context pressure, not exact billing |
| Color-only state is inaccessible | high | low | Include accessible label/title with band and percent |
| Critical treatment fights transcript context alerts | medium | medium | Keep panel treatment restrained and avoid duplicated prose |

## 4. Progress Report Accounting

Use `.plans/32-context-pressure-meter/progress-report.md` as the implementation resume state. Before resuming implementation, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "32-context-pressure-meter"
```

## 5. Validation Commands

```bash
pnpm --filter @trevor/web test -- --project web apps/web/src/components/panel/SidePanel.test.tsx
pnpm --filter @trevor/web test -- --project web apps/web/src/components/panel/context-pressure.test.ts
pnpm --filter @trevor/web storybook
pnpm test -- --project web
```

## 6. Decisions

Canonical decisions are in `.plans/32-context-pressure-meter/plan.db`. Query with:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "32-context-pressure-meter"
```
