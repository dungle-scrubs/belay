# Nested Command Menu - Progress Report

> Current focus: Hard Dependencies

## Summary

- Current cutoff blockers: 41
- Deferred follow-up: 0
- Superseded checklist debt: 0

## Hard Dependencies

- [x] `03-filesystem-root-taxonomy` complete before `/style` preference persistence starts (the root taxonomy shipped in `@trevor/session/node-paths` - `resolveTrevorHome` / `STORAGE_INVENTORY`)

## M1: Command Menu Data Model

- [x] RED: Add protocol/contract tests for nested command-menu payloads (`command-menu.test.ts`)
- [x] GREEN: Define shared structured payload and decode/encode helpers (`packages/session/src/command-menu.ts`: `CommandMenuPayload`/`CommandMenuRow` + `decodeCommandMenu`/`decodeCommandMenuRow` + `isActionable`/`isSubmenu`/`filterMenuRows`/`findMenuRow`)
- [x] RED: Add invalid/missing field and backward-compatible command-result tests (decode drops bad rows, returns null on missing core fields; wire round-trip with + without menu)
- [x] GREEN: Make command results tolerate nested-menu payloads (`commandResult` constructor + `command.result` decode carry an optional `menu`; plain results decode unchanged)
- [x] REFACTOR: Centralize command-family/menu types (one owner `command-menu.ts`, exported from the session index; host + web import it)

## M2: Generic Web Renderer

- [x] RED: Add Storybook states for root, child, breadcrumb/back, search, disabled, empty, long labels, narrow viewport, and keyboard navigation (`command-menu.stories.tsx`: Root, ChildMenu, DisabledRows, NotSearchable, Empty, LongLabels, NarrowViewport)
- [x] GREEN: Build reusable nested command-menu component using the shared command modal foundation (`command-menu.tsx` reuses the model-chooser takeover shape: back arrow + title/breadcrumb header, search box, row list; `use-command-menu.ts` owns nav/search/keyboard)
- [x] RED: Add web tests for keyboard navigation, back behavior, selection, disabled rows, search, and accessibility (`command-menu.test.tsx`, 9 tests)
- [x] GREEN: Wire generic renderer to structured command-menu payloads (the component renders ANY `CommandMenuPayload`; `defaultOpenId` deep-links a submenu)
- [x] REFACTOR: Keep command-specific mapping in data, not component branches (zero command-specific branches: labels/disabled/badges/submenus all come from the payload)

## M3: Command Execution Semantics

- [ ] RED: Add tests proving menu open/select for immediate actions does not start a model turn
- [ ] GREEN: Route selected actions through the host command action path
- [ ] RED: Add stale/unknown action, disabled action, and command-family error tests
- [ ] GREEN: Return structured success/error results for transcript rendering
- [ ] REFACTOR: Share dispatch with existing immediate slash command behavior where practical

## M4: Style Metadata and Menu Choices

- [x] RED: Add host tests for style metadata (`apps/agent-host/src/style/styles.test.ts`, 13 tests)
- [x] GREEN: Define built-in styles as host-owned metadata (`styles.ts BUILTIN_STYLES`: default/concise/diagnostic/reviewer/explanatory with id/label/description/guidance)
- [x] RED: Add tests proving `/style` choices come from host data, not web hardcoding (`buildStyleMenu` is a pure projection of `BUILTIN_STYLES`; the web renderer has no style branches)
- [x] GREEN: Implement bare `/style` as a menu payload with select/reset/default actions (`handleStyleCommand`: bare -> menu; `<id>`/`select <id>` -> selected; `reset`/`default` -> default; unknown -> structured error)
- [x] REFACTOR: Keep style metadata reusable by settings, `/doctor`, and future capability surfaces (`OutputStyle`/`resolveStyle`/`findStyle` are generic host data, importable anywhere)

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
