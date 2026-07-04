# Action Shimmer Status - Progress Report

## Summary

> Current focus: M1: Shimmer Component

- Total checklist items: 33
- Completed: 22
- Current cutoff blockers: 11

> M3 note (decision D-005): no new host protocol events were added. Every action label is a
> deterministic web-side projection of already-decoded structured state (tool name/args,
> assistant.progress usage, context.compacting tokens/budget, reconnect attempt/maxAttempts).
> Redaction/truncation and the V1->V2 verb map live in the pure `action-label.ts` module and are
> unit-tested in isolation with a missing-evidence fallback.

## 0. Hard Dependencies

- [x] Existing web transcript `WorkingIndicator` and tool rendering
- [x] Existing assistant-ui Tailwind shimmer pattern in the repo
- [x] Existing V1 action vocabulary references in `~/dev/trevor`
- [x] `09.2-web-browser-test-suite` merged (Storybook visual-regression lane + baseline scripts under `tests/browser/`)
- [x] Reorg plan 22.1 merged (`apps/agent-host/src/agent/turn.ts`; turn tests co-located under `apps/agent-host/src/agent/`)

## M1: Shimmer Component

- [x] RED: Storybook states for fallback working, thinking, steering, reading, searching, running shell, classifying, reconnecting, and reduced motion
- [x] GREEN: Build a reusable shimmer status component using assistant-ui's `shimmer` class pattern
- [x] RED: Component tests for label text, elapsed meta, interruptible meta, reduced-motion fallback, and stable layout
- [x] GREEN: Preserve existing `WorkingIndicator` call sites through a compatibility wrapper or controlled migration
- [x] REFACTOR: Remove pulse-dot-only assumptions from the component API

## M2: Projection Rules

- [x] RED: Unit-test turn-level labels for active status, steering, reconnect/recovery, silent streaming, and fallback working
- [x] GREEN: Add pure projection helpers for turn-level action labels
- [x] RED: Unit-test tool labels for read, glob, grep, bash, write/edit/multi_edit, web search, docs, skill, process, and unknown fallback
- [x] GREEN: Add tool-label helpers using structured tool name/input and V1 vocabulary as reference
- [x] REFACTOR: Share projection between compact and full transcript rows

## M3: Host Progress Labels

- [x] RED: Protocol tests for `assistant.progress`, `tool.progress`, reconnecting, recovery, and compaction progress label fields
- [x] GREEN: Preserve existing protocol labels and add missing structured labels where host-owned context is required
- [x] RED: Host tests for archive labels, steering labels, provider reconnect labels, and no raw/debug-only text leakage
- [x] GREEN: Route host-owned labels into transcript projection without web prose parsing
- [x] RED: Regression tests for short, redacted, single-line labels
- [x] GREEN: Add truncation/redaction rules for label fragments
- [x] REFACTOR: Deduplicate V1-derived keyword tables into a small V2 label map

## M4: Live UI Wiring

- [ ] RED: Web transcript tests for silent turn, running tool body, shell running, concurrent tool batch, compaction, reconnect, and cancellation
- [ ] GREEN: Replace `WorkingIndicator` rendering in transcript rows and status-aware tool renderers
- [ ] RED: Storybook/visual tests for shimmer in message rows, running tool rows, and compact row candidates
- [ ] GREEN: Apply shimmer consistently across active transcript status rows without animating settled rows
- [ ] RED: Accessibility tests for readable label text and no screen-reader duplication
- [ ] REFACTOR: Keep active state available to future tool-detail takeover and compact transcript layout

## M5: Validation and E2E

- [ ] RED: Live EZE test notes for silent model delay, running read/search, long bash, and reconnect/recovery
- [ ] GREEN: Run Storybook and web tests; inspect desktop and narrow viewport screenshots
- [ ] RED: Reduced-motion test coverage
- [ ] GREEN: Confirm no remaining user-facing literal `working...` placeholders except fallback copy
- [ ] REFACTOR: Document label vocabulary and source priority
