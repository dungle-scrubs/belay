# Custom Transcript Scrollbar - Implementation Plan

## 0. Hard Dependencies

- Existing transcript scroll element in `PanelHost` with `data-transcript-scroll`.
- Existing `useScrollFollow` pinned/live-edge behavior.
- Existing `VirtualTranscript` TanStack virtualizer wiring against the same scroll ref.
- Existing transcript scroll Storybook fixture and web tests.

## 1. Architecture

The transcript scrollbar is a visual refinement of the existing transcript scroll element, not a new scrolling model. The current app has one important scroll owner: `PanelHost` renders the `div` with `ref={scroll.transcriptRef}`, `onScroll`, wheel/touch/pointer intent tracking, and `data-transcript-scroll`. `VirtualTranscript` receives that same ref and uses it as the TanStack virtualizer scroll element.

The implementation should keep that element identity stable. The assistant-ui scrollbar reference is useful for visual direction, but Trevor should not introduce a JavaScript scrollbar wrapper for the transcript unless a later spike proves it preserves the exact same DOM scroll element and ref semantics. The first implementation should use native CSS scrollbar styling scoped to the transcript scroll area.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| The transcript scroll element identity cannot change | `useScrollFollow`, `VirtualTranscript`, and jump-to-bottom keep working |
| Styling is scoped to `data-transcript-scroll` or a small reusable class | Other app scroll areas are not restyled accidentally |
| Native scroll behavior remains browser-owned | Keyboard scroll, wheel, touch momentum, screen readers, and virtualization stay reliable |
| The scrollbar must be visible enough to signal scroll position | Do not hide it the way the current transcript fixture does |
| Mobile/touch viewports keep native feel | Avoid custom drag thumbs or synthetic scroll handling |

### Boundaries

- `PanelHost` continues to own the transcript scroll container and event wiring.
- `VirtualTranscript` continues to own row virtualization and live-edge scroll calls.
- A CSS primitive owns visual scrollbar tokens for the transcript. If later reused, it should remain opt-in.
- Storybook owns visual state coverage for empty, short, overflowing, mobile-height, and desktop-height transcript wells.

### Observability

No new runtime observability is required. This plan should rely on DOM tests and visual Storybook coverage. If implementation changes scroll event wiring, tests must assert that follow-bottom and unseen-content affordances still respond to the original scroll container.

## 2. Phases

### Phase 1: Scrollbar Primitive and Visual States

**Goal:** The transcript has a visible, themed custom scrollbar in Storybook without changing the scroll model.

#### M1: Native Scrollbar Styling

- **Dependencies:** hard dependencies
- **Effort:** S
- **Tasks:**
  1. RED: Add Storybook coverage that distinguishes overflowing and non-overflowing transcript states with the scrollbar class applied.
  2. GREEN: Add a scoped transcript scrollbar class or `data-transcript-scroll` CSS rule using native scrollbar APIs.
  3. RED: Add visual states for default, hover-capable, dark theme, narrow/mobile height, and high-content overflow.
  4. GREEN: Style Firefox with `scrollbar-color`/`scrollbar-width` and Chromium/WebKit with `::-webkit-scrollbar` selectors.
  5. REFACTOR: Centralize scrollbar color choices through existing theme tokens instead of one-off hex values.

#### M2: App Wiring

- **Dependencies:** M1
- **Effort:** S
- **Tasks:**
  1. RED: Extend transcript scroll tests or DOM assertions to verify the scroll container still has `data-transcript-scroll`.
  2. GREEN: Replace the current hidden-scrollbar classes on the transcript well with the new scoped scrollbar styling.
  3. RED: Add a regression test that `VirtualTranscript` still receives and uses the same scroll ref.
  4. GREEN: Preserve wheel, touch, pointer-intent, pinned-follow, and jump-to-bottom wiring unchanged.
  5. RED: Cover empty/replaying/host-waiting states so the scrollbar styling does not disturb centered loading content.
  6. REFACTOR: Keep any reusable scroll-area helper small and opt-in.

### Phase 2: Behavior and Accessibility Validation

**Goal:** The custom scrollbar is usable across browsers and does not regress transcript interaction.

#### M3: Scroll Behavior Regression

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Verify large transcript virtualization still mounts a bounded row set.
  2. GREEN: Keep TanStack virtualizer scroll element unchanged.
  3. RED: Verify pinned sessions follow appended output to the live edge.
  4. GREEN: Preserve manual scroll-up unpinning and unseen-content chevron behavior.
  5. RED: Verify `scrollToBottom` returns to the live edge with the styled scrollbar present.
  6. REFACTOR: Keep scroll math in `scroll.ts`; do not duplicate bottom-distance logic in styling code.

#### M4: Accessibility and Browser Pass

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Check high-contrast and forced-colors behavior so the scrollbar remains visible.
  2. GREEN: Add forced-colors fallback rules only if needed.
  3. RED: Check reduced-motion and keyboard scrolling with focus inside and outside the transcript.
  4. GREEN: Preserve native keyboard and screen-reader scroll semantics.
  5. REFACTOR: Document the browser support expectations in the Storybook fixture or CSS comment if the selectors are non-obvious.

## 3. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| A wrapper scroll component changes the scroll element | high | medium | Use native CSS first; require tests before any wrapper | web |
| Scrollbar styling is invisible in one browser | medium | medium | Cover Firefox and Chromium/WebKit selectors separately | web |
| Custom styling leaks to menus or sidebars | medium | low | Scope selectors to transcript only | web |
| Stable gutter changes transcript width unexpectedly | medium | low | Verify narrow and desktop Storybook states before enabling `scrollbar-gutter` | web |

## 4. Escape Hatches

1. **If native styling cannot meet the design target:** keep native CSS for the transcript and open a later spike for a wrapper component that proves ref identity, keyboard behavior, and virtualization compatibility.
2. **If stable gutter creates layout regressions:** omit `scrollbar-gutter` and accept overlay-style browser differences.
3. **If mobile browser styling is inconsistent:** leave mobile/touch scrollbars native and focus custom styling on desktop-capable hover/pointer environments.

## 5. Progress Report Accounting

Progress lives in `.plans/34-custom-transcript-scrollbar/progress-report.md`. Count only active unchecked implementation tasks as blockers. Do not mark a milestone complete unless the tests and Storybook states described in that milestone exist.

Before resuming implementation or declaring convergence, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "34-custom-transcript-scrollbar"
```

## 6. Validation Commands

```bash
pnpm --filter @trevor/web test -- --project web apps/web/src/components/chat/virtual-transcript.test.tsx
pnpm --filter @trevor/web test -- --project web apps/web/src/hooks/use-scroll-follow.test.tsx
pnpm --filter @trevor/web storybook
pnpm test -- --project web
```

## 7. Decisions

Canonical decisions live in `.plans/34-custom-transcript-scrollbar/plan.db`.
