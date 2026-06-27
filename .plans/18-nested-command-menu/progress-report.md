# Nested Command Menu - Progress Report

> Current focus: Hard Dependencies

## Summary

- Current cutoff blockers: 41
- Deferred follow-up: 0
- Superseded checklist debt: 0

## Hard Dependencies

- [ ] `02-filesystem-root-taxonomy` complete before `/style` preference persistence starts

## M1: Command Menu Data Model

- [ ] RED: Add protocol/contract tests for nested command-menu payloads
- [ ] GREEN: Define shared structured payload and decode/encode helpers
- [ ] RED: Add invalid/missing field and backward-compatible command-result tests
- [ ] GREEN: Make command results tolerate nested-menu payloads
- [ ] REFACTOR: Centralize command-family/menu types

## M2: Generic Web Renderer

- [ ] RED: Add Storybook states for root, child, breadcrumb/back, search, disabled, empty, long labels, narrow viewport, and keyboard navigation
- [ ] GREEN: Build reusable nested command-menu component using the shared command modal foundation
- [ ] RED: Add web tests for keyboard navigation, back behavior, selection, disabled rows, search, and accessibility
- [ ] GREEN: Wire generic renderer to structured command-menu payloads
- [ ] REFACTOR: Keep command-specific mapping in data, not component branches

## M3: Command Execution Semantics

- [ ] RED: Add tests proving menu open/select for immediate actions does not start a model turn
- [ ] GREEN: Route selected actions through the host command action path
- [ ] RED: Add stale/unknown action, disabled action, and command-family error tests
- [ ] GREEN: Return structured success/error results for transcript rendering
- [ ] REFACTOR: Share dispatch with existing immediate slash command behavior where practical

## M4: Style Metadata and Menu Choices

- [ ] RED: Add host tests for style metadata
- [ ] GREEN: Define built-in styles as host-owned metadata
- [ ] RED: Add tests proving `/style` choices come from host data, not web hardcoding
- [ ] GREEN: Implement bare `/style` as a menu payload with select/reset/default actions
- [ ] REFACTOR: Keep style metadata reusable by settings, `/doctor`, and future capability surfaces

## M5: Style Preference Persistence and Run Attribution

- [ ] RED: Add tests for user-selected style persistence under the approved Trevor settings root
- [ ] GREEN: Persist active style id and source, with default fallback
- [ ] RED: Add tests proving each run records active style id/source at turn start
- [ ] GREEN: Attach active style attribution to run diagnostics/transcript inspection
- [ ] REFACTOR: Keep style preference separate from provider/model/reasoning preferences

## M6: Presentation-Only Enforcement

- [ ] RED: Add tests proving styles do not alter tools, model/source, reasoning, agents, or execution mode
- [ ] GREEN: Thread active style facts only through response-shape guidance and run attribution
- [ ] RED: Add evals or prompt tests for concise, diagnostic, reviewer, explanatory, and default behavior
- [ ] GREEN: Make style-specific response guidance observable enough for tests
- [ ] REFACTOR: Remove accidental coupling between style id and routing/policy

## M7: Second Fixture Consumer

- [ ] RED: Add a fixture command family with two-level nested choices independent of `/style`
- [ ] GREEN: Render and execute the fixture through the same component and action path
- [ ] RED: Add tests proving data changes behavior without code changes
- [ ] GREEN: Document how future command families define nested menus
- [ ] REFACTOR: Extract any remaining `/style` assumptions from shared menu code

## M8: Verification

- [ ] RED: Add integration tests for menu payload round-trip, web rendering, action dispatch, and transcript result rendering
- [ ] GREEN: Verify `/style` menu selection, reset/default, persistence, and run attribution
- [ ] RED: Add accessibility and keyboard regression tests
- [ ] GREEN: Verify Storybook states at mobile and desktop widths
- [ ] REFACTOR: Tighten names and docs for future plan dependencies
