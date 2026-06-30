# Vim Motions UI - Progress Report

> Current focus: Hard Dependencies

## Summary

- Current cutoff blockers: 0
- Deferred follow-up: 1
- Superseded checklist debt: 0

## Hard Dependencies

- [x] `03-filesystem-root-taxonomy` complete (no plan dir; TREVOR_HOME + config home settled in node-paths.ts)
- [x] `.plans/trevor-v2` D-083/D-084 prompt composer recovery/history exists
- [x] `.plans/trevor-v2` D-092 image attachment UX exists
- [x] `02.12-prompt-surface-editor` full-surface editor exists - a second prompt textarea Vim mode must serve (D-007)

## M1: Config Preference Boundary

- [x] RED: Add tests for reading a Vim-mode preference from the `~/.trevorV2` config file with `TREVOR_HOME` override support
- [x] GREEN: Implement a typed config reader/writer or extend the existing config model for `vim.enabled`
- [x] RED: Add tests for missing config, malformed config, and explicit disabled state
- [x] GREEN: Default Vim mode to disabled and surface parse errors without blocking Trevor startup
- [x] REFACTOR: Document the config key and keep browser-only storage out of the preference source of truth

## M2: Storybook Mode Indicator Contract

- [x] RED: Add Storybook/state tests or stories for the prompt bottom row with insert, normal, visual, disabled, shell lane, and narrow widths
- [x] GREEN: Render a compact stable mode indicator next to the upload `+` button when Vim mode is enabled
- [x] RED: Add visual states with the shell glyph replacing `+`, upload disabled, uploading, and upload error
- [x] GREEN: Keep indicator placement stable beside the `+`/shell glyph without composer height reflow
- [x] REFACTOR: Extract a small presentational component for mode indicator states

## M3: `vimeejs/vimee` Evaluation Spike

- [x] RED: Build a throwaway Storybook or test harness that exercises `vimeejs/vimee` against the production textarea constraints
- [x] GREEN: Evaluate insert, normal, visual, cursor movement, selection, undo/redo interaction, IME/composition behavior, and textarea selection APIs
- [x] RED: Add comparison cases for image tokens, slash menu, shell lane, history recall, and Enter submit
- [x] GREEN: Record whether to adopt `vimeejs/vimee`, wrap it, or write a small local prompt-only controller
- [x] REFACTOR: Remove spike-only code unless it becomes the chosen implementation

## M4: Prompt Vim State Machine

- [x] RED: Add unit tests for mode transitions: focus starts insert, Esc to normal, normal to visual, visual Esc to normal, normal insert commands back to insert
- [x] GREEN: Implement the prompt-local Vim mode state machine
- [x] RED: Add tests proving insert mode preserves existing textarea typing, paste, composition, and text selection behavior
- [x] GREEN: Route only normal/visual-mode keys through Vim handling; leave insert-mode typing native
- [x] REFACTOR: Keep the controller independent of React rendering so it is testable without jsdom where possible

## M5: Motion and Editing Subset

- [x] RED: Add tests for first-cut motions: `h/j/k/l`, `w`, `b`, `0`, `$`, `gg`, `G`, and line-aware movement in a textarea
- [x] GREEN: Implement the approved first-cut normal-mode movement subset
- [x] RED: Add tests for visual selection, yanking/copy semantics if included, deletion/change commands if included, and unsupported-key no-ops
- [x] GREEN: Implement the smallest useful visual-mode subset without breaking native clipboard shortcuts
- [x] REFACTOR: Keep destructive edit commands conservative and explicit; defer ambiguous Vim features

## M6: Prompt-Surface Integration (composer + full-surface editor)

- [x] RED: Add web tests proving Vim mode is inactive when the preference is disabled
- [x] GREEN: Wire enabled preference into `PromptInput` and the composer keydown path
- [x] RED: Add tests for slash menu, prompt shell lane, Enter submit, Shift+Enter newline, Up/Down history recall, and image-token atomic delete under Vim mode
- [x] GREEN: Resolve key precedence so mode handling never swallows existing composer behaviors incorrectly
- [x] RED: Add tests proving the SAME controller drives Vim mode in the full-surface editor (mode + motions in its textarea, indicator in its header, and Escape enters normal-mode rather than closing the editor) (D-007)
- [x] GREEN: Attach the controller + indicator in the full-surface editor and resolve Escape precedence (Vim normal-mode entry vs the editor's save-and-close)
- [x] REFACTOR: Keep App-owned slash/submit/history wiring and the editor's confirm contract outside the surface-agnostic Vim controller

## M7: Accessibility and Conflict Handling

- [x] RED: Add tests for screen-reader labels and keyboard accessibility of the mode indicator
- [x] GREEN: Give the indicator accessible text without adding visible instructional copy
- [x] RED: Add tests for browser/system shortcuts: Cmd/Ctrl+C, Cmd/Ctrl+V, Cmd/Ctrl+A, Escape behavior around modals/menus, and IME composition
- [x] GREEN: Preserve platform shortcuts and menu/modal Escape ownership
- [x] REFACTOR: Document conflict precedence between slash menu, command menus, shell lane, and Vim mode

## M8: Storybook and E2E Verification

- [x] RED: Add Storybook interaction tests for mode transitions and indicator updates
- [x] GREEN: Make Storybook states pass for insert, normal, visual, shell, slash, image tokens, upload, and narrow/mobile widths
- [x] RED: Add manual EZE script for enabling the config, opening Trevor, typing in insert, Esc to normal, selecting visual text, returning to insert, and submitting - in BOTH the composer and the full-surface editor (the script is the Deferred manual EZE section below)
- [x] REFACTOR: Update user-facing config docs and AGENTS guidance for the Vim preference

## Deferred manual EZE (needs the live app + a `vim.json` config)

- [ ] Verify live Vim behavior with the preference enabled AND disabled, on both prompt surfaces (composer + full-surface editor)

Set `~/.trevorV2/vim.json` to `{ "enabled": true }`, start the host + web, then in BOTH the composer
and the full-surface editor (open via the composer expand button): type in insert; Escape to normal
(the indicator flips, and in the editor Escape does NOT close it); move with `h/j/k/l/w/b/0/$/gg/G`;
`v` then a motion to select; `i`/`a` back to insert; submit with Enter. Confirm: with `vim.json` absent
or `{ "enabled": false }` the composer is exactly the plain composer (no indicator, native typing).
Every gate item's engineering is automatically covered (the controller, useVim, and editor tests); only
the live visual/interaction sign-off remains.
