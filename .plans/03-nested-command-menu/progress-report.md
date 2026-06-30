# Nested Command Menu - Progress Report

> Current focus: Complete - M1-M8 + hard dependency green

## Summary

- Current cutoff blockers: 0
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

- [x] RED: Add tests proving menu open/select for immediate actions does not start a model turn (`transcript-row-view.test.tsx`: a menu row click calls `onMenuAction`/dispatches a command, never a model turn; `commands.test.ts` returns a `command.result`)
- [x] GREEN: Route selected actions through the host command action path (the menu's `onAction` -> `onMenuAction` -> `command("/style", id)` -> registry; `/style select <id>` shares the handler)
- [x] RED: Add stale/unknown action, disabled action, and command-family error tests (`styles.test.ts` unknown-id error; `command-menu.test.tsx` disabled row inert; `commands.test.ts` unknown /style id -> error, no menu)
- [x] GREEN: Return structured success/error results for transcript rendering (`CommandRunResult { text, ok, menu? }`; the row renders the menu inline or text)
- [x] REFACTOR: Share dispatch with existing immediate slash command behavior where practical (`/style` is a normal registry command; the menu dispatch reuses the same `command()` path as every other slash command)

## M4: Style Metadata and Menu Choices

- [x] RED: Add host tests for style metadata (`apps/agent-host/src/style/styles.test.ts`, 13 tests)
- [x] GREEN: Define built-in styles as host-owned metadata (`styles.ts BUILTIN_STYLES`: default/concise/diagnostic/reviewer/explanatory with id/label/description/guidance)
- [x] RED: Add tests proving `/style` choices come from host data, not web hardcoding (`buildStyleMenu` is a pure projection of `BUILTIN_STYLES`; the web renderer has no style branches)
- [x] GREEN: Implement bare `/style` as a menu payload with select/reset/default actions (`handleStyleCommand`: bare -> menu; `<id>`/`select <id>` -> selected; `reset`/`default` -> default; unknown -> structured error)
- [x] REFACTOR: Keep style metadata reusable by settings, `/doctor`, and future capability surfaces (`OutputStyle`/`resolveStyle`/`findStyle` are generic host data, importable anywhere)

## M5: Style Preference Persistence and Run Attribution

- [x] RED: Add tests for user-selected style persistence under the approved Trevor settings root (`style-store.test.ts`: parse/load/save round-trip under `<TREVOR_HOME>/style.json`)
- [x] GREEN: Persist active style id and source, with default fallback (`style-store.ts` loadStylePref/saveStylePref; `style-pref` config inventory entry; unknown/missing -> default)
- [x] RED: Add tests proving each run records active style id/source at turn start (the active style is read into the system prompt per turn via `activeStyleGuidance`; `/doctor` reports `activeStyle.id (source)` - `doctor` build test)
- [x] GREEN: Attach active style attribution to run diagnostics/transcript inspection (`DoctorRuntimeFacts.activeStyle` -> `/doctor` plaintext `style:` line; cache reloads on `/style` change)
- [x] REFACTOR: Keep style preference separate from provider/model/reasoning preferences (its own `style.json` file + module, untouched by model-preferences)

## M6: Presentation-Only Enforcement

- [x] RED: Add tests proving styles do not alter tools, model/source, reasoning, agents, or execution mode (`system-prompt.test.ts`: stripping the style sentence makes two different styles' prompts byte-identical; tool inventory unchanged)
- [x] GREEN: Thread active style facts only through response-shape guidance and run attribution (`SystemPromptContext.styleGuidance` -> a presentation-only block; nothing else reads the style)
- [x] RED: Add evals or prompt tests for concise, diagnostic, reviewer, explanatory, and default behavior (`styles.test.ts` covers the five named styles; the default carries no guidance; guidance text is observable in the prompt)
- [x] GREEN: Make style-specific response guidance observable enough for tests (the guidance string appears verbatim in the built system prompt, asserted in `system-prompt.test.ts`)
- [x] REFACTOR: Remove accidental coupling between style id and routing/policy (the only behavior-bearing field is `guidance`; the `OutputStyle` shape carries no model/tool/routing fields - pinned by a structural test)

## M7: Second Fixture Consumer

- [x] RED: Add a fixture command family with two-level nested choices independent of `/style` (`command-menu.test.tsx` DEPLOY_MENU: a `deploy` family with a nested Production submenu)
- [x] GREEN: Render and execute the fixture through the same component and action path ("a second, unrelated command family works through the same component + action path" - dispatch carries `deploy`, not `style`)
- [x] RED: Add tests proving data changes behavior without code changes (the same `CommandMenu` renders style and deploy menus with zero component changes; the family id flows from data)
- [x] GREEN: Document how future command families define nested menus (`command-menu.ts` module comment documents the contract; a family builds a `CommandMenuPayload` and returns it on a `command.result`)
- [x] REFACTOR: Extract any remaining `/style` assumptions from shared menu code (the renderer/hook/contract carry no `/style` knowledge - verified by the deploy fixture)

## M8: Verification

- [x] RED: Add integration tests for menu payload round-trip, web rendering, action dispatch, and transcript result rendering (`command-menu.test.ts` wire round-trip via `decodeTrevorEvent`; `transcript-row-view.test.tsx` renders the menu inline + dispatches; `commands.test.ts` /style -> menu result)
- [x] GREEN: Verify `/style` menu selection, reset/default, persistence, and run attribution (`styles.test.ts` select/reset/default; `style-store.test.ts` persistence; `/doctor` attribution)
- [x] RED: Add accessibility and keyboard regression tests (`command-menu.test.tsx`: region/search a11y names, arrow/enter/escape keyboard nav)
- [x] GREEN: Verify Storybook states at mobile and desktop widths (`command-menu.stories.tsx`: NarrowViewport + fullscreen states; `@container` responsive layout)
- [x] REFACTOR: Tighten names and docs for future plan dependencies (one owner `@trevor/session/command-menu` with documented contract; `CommandMenu` + `useCommandMenu` reusable by any family)
