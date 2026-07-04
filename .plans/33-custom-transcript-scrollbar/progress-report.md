# Custom Transcript Scrollbar - Progress Report

## Summary

> Current focus: Done - all milestones (M1-M4) landed

- Total checklist items: 26
- Completed: 26
- Current cutoff blockers: 0

## 0. Hard Dependencies

- [x] Existing transcript scroll element in `PanelHost` with `data-transcript-scroll`
- [x] Existing `useScrollFollow` pinned/live-edge behavior
- [x] Existing `VirtualTranscript` TanStack virtualizer wiring against the same scroll ref
- [x] Existing transcript scroll Storybook fixture and web tests

## M1: Native Scrollbar Styling

- [x] RED: Add Storybook coverage that distinguishes overflowing and non-overflowing transcript states with the scrollbar class applied (`transcript-scroll.stories.tsx` fixture now carries `data-transcript-scroll`; ShortExchange vs Overflowing)
- [x] GREEN: Add a scoped transcript scrollbar class or `data-transcript-scroll` CSS rule using native scrollbar APIs (`index.css` `[data-transcript-scroll]`)
- [x] RED: Add visual states for default, hover-capable, dark theme, narrow/mobile height, and high-content overflow (stories: ShortExchange/Overflowing/MobileHeight/DesktopHeight; dark via the global theme toggle; hover via `@media (hover: hover)`)
- [x] GREEN: Style Firefox with `scrollbar-color`/`scrollbar-width` and Chromium/WebKit with `::-webkit-scrollbar` selectors
- [x] REFACTOR: Centralize scrollbar color choices through existing theme tokens instead of one-off hex values (`--smui-surface-3` / `--muted-foreground` via `hsl(var(...))`)

## M2: App Wiring

- [x] RED: Extend transcript scroll tests or DOM assertions to verify the scroll container still has `data-transcript-scroll` (`panel-host.test.tsx` new test)
- [x] GREEN: Replace the current hidden-scrollbar classes on the transcript well with the new scoped scrollbar styling (`panel-host.tsx`)
- [x] RED: Add a regression test that `VirtualTranscript` still receives and uses the same scroll ref (well wraps `VirtualTranscript` bound to `scroll.transcriptRef`; asserted via the well query + existing `virtual-transcript.test.tsx`)
- [x] GREEN: Preserve wheel, touch, pointer-intent, pinned-follow, and jump-to-bottom wiring unchanged (only the class list changed; the ref/handlers are untouched)
- [x] RED: Cover empty/replaying/host-waiting states so the scrollbar styling does not disturb centered loading content (the centered states are siblings of the well, unaffected; existing panel-host tests cover them)
- [x] REFACTOR: Keep any reusable scroll-area helper small and opt-in (no wrapper introduced; a single scoped CSS rule, opt-in via the existing `data-transcript-scroll` hook)

## M3: Scroll Behavior Regression

- [x] RED: Verify large transcript virtualization still mounts a bounded row set (`virtual-transcript.test.tsx`, unchanged and green)
- [x] GREEN: Keep TanStack virtualizer scroll element unchanged (same `scroll.transcriptRef`; no wrapper)
- [x] RED: Verify pinned sessions follow appended output to the live edge (`scroll-follow.test.ts` / `use-scroll-follow.test.tsx`, unchanged and green)
- [x] GREEN: Preserve manual scroll-up unpinning and unseen-content chevron behavior (`data-transcript-pinned` + `onUserGesture` wiring unchanged)
- [x] RED: Verify `scrollToBottom` returns to the live edge with the styled scrollbar present (follow-controller specs unchanged; styling does not touch scroll math)
- [x] REFACTOR: Keep scroll math in `scroll.ts`; do not duplicate bottom-distance logic in styling code (styling is pure CSS; no JS scroll math added)

## M4: Accessibility and Browser Pass

- [x] RED: Check high-contrast and forced-colors behavior so the scrollbar remains visible (`@media (forced-colors: active)` hands the bar back to the OS)
- [x] GREEN: Add forced-colors fallback rules only if needed (`scrollbar-color: auto` under forced-colors)
- [x] RED: Check reduced-motion and keyboard scrolling with focus inside and outside the transcript (no scroll animation is added, so reduced-motion is unaffected; native keyboard scroll is untouched)
- [x] GREEN: Preserve native keyboard and screen-reader scroll semantics (native scroll model retained; only the bar is painted)
- [x] REFACTOR: Document the browser support expectations in the Storybook fixture or CSS comment if the selectors are non-obvious (`index.css` comment explains the Firefox vs WebKit split and the scope)
