# Keyboard Shortcuts - Progress Report

> Current focus: Hard Dependencies

## Summary

- Current cutoff blockers: 52
- Deferred follow-up: 0
- Superseded checklist debt: 0

## Hard Dependencies

- [ ] `06-vim-motions-ui` complete or coordinated before shortcut routing implementation
- [ ] `03-filesystem-root-taxonomy` complete before config-editing Vim toggle implementation
- [x] `03-nested-command-menu` exists as command-like UI foundation
- [x] `apps/web/HOTKEYS.md` exists as the shortcut policy ledger

## M1: HOTKEYS Policy Ledger Update

- [ ] RED: Add a check/test that expected Trevor bindings are represented in `apps/web/HOTKEYS.md`
- [ ] GREEN: Extend `apps/web/HOTKEYS.md` with policy classes, accepted `Mod+K` takeover rationale, and candidate bindings
- [ ] RED: Add tests or lint fixtures proving undocumented shortcut registrations fail
- [ ] GREEN: Add a declarative shortcut registry that can be compared to the ledger
- [ ] REFACTOR: Keep browser/OS reservation notes separate from Trevor-owned binding rows

## M2: Central Shortcut Router and Focus Guards

- [ ] RED: Add router tests for frontmost-surface ordering: command palette, modal/dialog, artifact carousel, composer, panels, global app
- [ ] GREEN: Implement a central shortcut router with `handled` / `pass` / `blocked` semantics
- [ ] RED: Add tests proving shortcuts do not fire behind a modal/menu/panel or from ordinary text-editing fields unless explicitly allowed
- [ ] GREEN: Add focus guards for `input`, `textarea`, `contenteditable`, command search fields, and code-like editors
- [ ] REFACTOR: Remove scattered global shortcut assumptions from individual components where the router can own them

## M3: Command Palette Shell

- [ ] RED: Add tests proving `Mod+K` opens the command palette and prevents the browser action when the app is focused
- [ ] GREEN: Implement the command palette using the existing command-menu pattern
- [ ] RED: Add tests for palette frontmost routing: while open, palette keys do not leak to composer, sidebars, transcript, or panels
- [ ] GREEN: Register palette navigation, selection, close, and empty-state behavior
- [ ] REFACTOR: Keep palette commands data-driven so later actions do not need bespoke key handlers

## M4: Persisted Vim Toggle Command

- [ ] RED: Add tests for a command-palette `Toggle Vim mode` action reading current config state
- [ ] GREEN: Add the palette command and display current enabled/disabled status
- [ ] RED: Add host/config tests proving toggling edits the Trevor config under `TREVOR_HOME` (`~/.trevorV2` by default) with override support
- [ ] GREEN: Persist `vim.enabled` through the host-owned config mutation path and refresh the web setting
- [ ] REFACTOR: Keep config read/write logic shared with `06-vim-motions-ui`

## M5: Vim and Escape Integration

- [ ] RED: Add tests proving Vim insert-mode `Esc` switches to normal mode and does not cancel a run or close a behind surface
- [ ] GREEN: Route Escape through the Vim layer before global cancel/clear behavior
- [ ] RED: Add tests for Vim normal/visual Escape behavior, palette Escape, modal Escape, and global Escape ordering
- [ ] GREEN: Implement Escape precedence exactly once in the shortcut router
- [ ] REFACTOR: Document Escape ownership in `apps/web/HOTKEYS.md`

## M6: Submit and Shortcuts Help

- [ ] RED: Add tests for `Mod+Enter` submit only when composer owns focus and submit is valid
- [ ] GREEN: Implement `Mod+Enter` as a composer-owned shortcut
- [ ] RED: Add tests for `Mod+/` opening shortcuts help without leaking to underlying surfaces
- [ ] GREEN: Implement a shortcuts help surface generated from the shortcut registry and HOTKEYS policy metadata
- [ ] REFACTOR: Ensure help text reflects platform-specific `Cmd` vs `Ctrl` labels

## M7: Panel Toggles

- [ ] RED: Add tests for left-sidebar toggle candidate `Mod+\` respecting focus guards and frontmost surfaces
- [ ] GREEN: Implement the left-sidebar toggle if browser verification passes
- [ ] RED: Add tests for right-panel toggle candidate `Mod+Shift+\` respecting focus guards and frontmost surfaces
- [ ] GREEN: Implement the right-panel toggle if browser verification passes
- [ ] REFACTOR: Update `apps/web/HOTKEYS.md` with final accepted panel bindings or rejected alternatives

## M8: Stop/Cancel Binding Decision

- [ ] RED: Add tests for candidate `Mod+.` behavior when a run is active, queued, or idle
- [ ] GREEN: Implement `Mod+.` only if it is accepted as a deliberate non-Escape stop/cancel path
- [ ] RED: Add tests proving `Mod+.` does not interfere with text input or Vim commands
- [ ] GREEN: Route the binding through the same cancel/stop semantics as the existing Escape path where appropriate
- [ ] REFACTOR: Document if `Mod+.` is rejected, deferred, or shipped

## M9: Browser and OS Matrix

- [ ] RED: Add a manual verification matrix sourced from `apps/web/HOTKEYS.md` for Chrome, Arc, Firefox, Zen, and Safari where relevant
- [ ] GREEN: Verify `Mod+K`, `Mod+Enter`, `Mod+/`, panel toggles, Escape routing, and any stop/cancel binding
- [ ] RED: Add Playwright or jsdom-level tests for preventDefault and focus routing where browser automation can represent it
- [ ] GREEN: Mark each binding as accepted, contextual, rude-but-accepted, rejected, or reserved in the ledger
- [ ] REFACTOR: Remove or reassign any binding that behaves unreliably

## M10: Full Regression Coverage

- [ ] RED: Add regression tests for every bug class: behind-surface interaction, text-field theft, Vim Escape ordering, palette leakage, modal leakage, and stale handlers
- [ ] GREEN: Make all router/component tests pass
- [ ] RED: Add test coverage that every registered shortcut appears in shortcuts help and `apps/web/HOTKEYS.md`
- [ ] GREEN: Finalize docs/help/ledger consistency
- [ ] REFACTOR: Keep shortcut registration centralized and remove duplicate component-local shortcut tables
