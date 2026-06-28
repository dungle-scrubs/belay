# Custom Transcript Scrollbar - Progress Report

## Summary

> Current focus: M1: Native Scrollbar Styling

- Total checklist items: 26
- Completed: 4
- Current cutoff blockers: 22

## 0. Hard Dependencies

- [x] Existing transcript scroll element in `PanelHost` with `data-transcript-scroll`
- [x] Existing `useScrollFollow` pinned/live-edge behavior
- [x] Existing `VirtualTranscript` TanStack virtualizer wiring against the same scroll ref
- [x] Existing transcript scroll Storybook fixture and web tests

## M1: Native Scrollbar Styling

- [ ] RED: Add Storybook coverage that distinguishes overflowing and non-overflowing transcript states with the scrollbar class applied
- [ ] GREEN: Add a scoped transcript scrollbar class or `data-transcript-scroll` CSS rule using native scrollbar APIs
- [ ] RED: Add visual states for default, hover-capable, dark theme, narrow/mobile height, and high-content overflow
- [ ] GREEN: Style Firefox with `scrollbar-color`/`scrollbar-width` and Chromium/WebKit with `::-webkit-scrollbar` selectors
- [ ] REFACTOR: Centralize scrollbar color choices through existing theme tokens instead of one-off hex values

## M2: App Wiring

- [ ] RED: Extend transcript scroll tests or DOM assertions to verify the scroll container still has `data-transcript-scroll`
- [ ] GREEN: Replace the current hidden-scrollbar classes on the transcript well with the new scoped scrollbar styling
- [ ] RED: Add a regression test that `VirtualTranscript` still receives and uses the same scroll ref
- [ ] GREEN: Preserve wheel, touch, pointer-intent, pinned-follow, and jump-to-bottom wiring unchanged
- [ ] RED: Cover empty/replaying/host-waiting states so the scrollbar styling does not disturb centered loading content
- [ ] REFACTOR: Keep any reusable scroll-area helper small and opt-in

## M3: Scroll Behavior Regression

- [ ] RED: Verify large transcript virtualization still mounts a bounded row set
- [ ] GREEN: Keep TanStack virtualizer scroll element unchanged
- [ ] RED: Verify pinned sessions follow appended output to the live edge
- [ ] GREEN: Preserve manual scroll-up unpinning and unseen-content chevron behavior
- [ ] RED: Verify `scrollToBottom` returns to the live edge with the styled scrollbar present
- [ ] REFACTOR: Keep scroll math in `scroll.ts`; do not duplicate bottom-distance logic in styling code

## M4: Accessibility and Browser Pass

- [ ] RED: Check high-contrast and forced-colors behavior so the scrollbar remains visible
- [ ] GREEN: Add forced-colors fallback rules only if needed
- [ ] RED: Check reduced-motion and keyboard scrolling with focus inside and outside the transcript
- [ ] GREEN: Preserve native keyboard and screen-reader scroll semantics
- [ ] REFACTOR: Document the browser support expectations in the Storybook fixture or CSS comment if the selectors are non-obvious
