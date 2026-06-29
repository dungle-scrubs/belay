# Vim Motions UI - Implementation Plan

## 0. Hard Dependencies

- [ ] `03-filesystem-root-taxonomy` - user config path and shape must be settled before adding the Vim preference.
- [x] `.plans/trevor-v2` D-083/D-084 prompt composer recovery/history - prompt input/history behavior exists and must not regress.
- [x] `.plans/trevor-v2` D-092 image attachment UX - composer tokens and the `+` upload button placement exist and must not regress.
- [x] `02.12-prompt-surface-editor` - the full-surface prompt editor (a takeover textarea for long prompts) exists; it is a SECOND prompt-writing surface the Vim controller + mode indicator must also serve. <!-- D-007 -->`apps/web/src/components/panel/prompt-surface-editor.tsx`, opened via `apps/web/src/hooks/use-prompt-editor.ts`.

## 1. Architecture

This plan extracts D-097 into a narrow, prompt-input-first Vim mode. It does not add Vim navigation across the whole UI. The first cut gives users who opt in a modal prompt composer with a small, visible mode indicator next to the bottom-row `+` upload button.

Trevor now has **two** prompt-writing textareas, and Vim mode applies to both: the inline composer (`PromptInput`) and the full-surface prompt editor (`02.12-prompt-surface-editor`), a takeover for editing long prompts with room. Because the large editor is exactly where motions matter most, the Vim prompt controller (mode state machine + motions) and the mode indicator are authored as ONE reusable unit that attaches to any prompt textarea, not coupled to `PromptInput`. The first-cut ordering stays composer-first, but the controller is built reusable from the start and the integration milestone wires both surfaces (so the editor never silently lacks Vim mode). <!-- D-007 -->

The mode model is:

```text
insert --Esc--> normal --v/V/Ctrl+V--> visual
normal --i/a/o/etc.--> insert
visual --Esc--> normal
normal/visual --Enter submit only when the command path explicitly allows it
```

Every focused Vim-enabled composer starts in **insert** mode. Escape enters **normal** mode. Visual mode is reachable only from normal mode. The feature is gated by a user preference stored under `TREVOR_HOME` (`~/.trevorV2` by default), not by browser-only local state, so the preference follows Trevor sessions on the same machine.

`vimeejs/vimee` is a candidate implementation library, not a foregone conclusion. The plan includes a spike to decide whether it handles textarea/composer constraints better than a small local mode/motion engine.

### Key Constraints

| Constraint | Impact |
|---|---|
| Starts in insert | Users can type normally; opt-in Vim mode does not make the composer hostile. |
| Esc enters normal | Vim behavior is explicit and discoverable through the mode indicator. |
| Visual only from normal | No insert-to-visual shortcut path in the first cut. |
| Preference gated | Disabled by default unless enabled in `~/.trevorV2` config. |
| Storybook first | All visual and interaction states are reviewed before app wiring. |
| Prompt surfaces only | Vim mode covers the prompt-writing textareas - the composer AND the full-surface editor (D-007) - but not the sidebar, command menu, transcript, or global app bindings in this plan. |
| Reusable controller | The mode engine + indicator attach to any prompt textarea, so both surfaces share one implementation. |
| No composer regression | Slash commands, shell lane, upload, image tokens, history recall, submit, and accessibility keep working. |

### Boundaries

- **User config:** owns persisted `vim.enabled` or equivalent preference under `TREVOR_HOME`.
- **Host/config bridge:** reads the preference and exposes it to the web without putting secrets or local paths in browser state.
- **Prompt Vim controller:** owns mode state, key interpretation, selection changes, cursor movement, and command execution inside a textarea. Authored reusable (it attaches to a textarea ref), so the composer and the full-surface editor share one engine (D-007).
- **PromptInput UI:** renders the mode indicator next to the upload `+`/shell glyph area without changing composer height.
- **Full-surface editor UI (`prompt-surface-editor.tsx`):** hosts the same controller + a mode indicator in its header row, so Vim mode is available while editing long prompts (and the 02.10 generated-handoff edit).
- **Storybook harness:** exercises insert/normal/visual, selection, shell lane, slash menu, image-token, upload, and narrow-width states before app wiring; includes the full-surface editor surface.

### Mode Indicator

The indicator appears in the composer bottom row next to the `+` upload button:

```text
[ + ] [ INSERT ]
[ + ] [ NORMAL ]
[ + ] [ VISUAL ]
```

In shell mode, where the `+` is replaced by the shell glyph, the mode indicator still occupies the same bottom row:

```text
[ terminal ] [ INSERT ]
```

The indicator is compact, stable-width, and accessible. It must not wrap, resize the composer, or push submit/composer content around.

### Observability

- `/doctor` or a future settings/debug surface can report whether Vim mode is enabled and which config file provided it.
- Storybook stories document every visual state before app wiring.
- Debug logs are not needed for ordinary keystrokes, but initialization/config parse errors should be visible in host diagnostics.

## 2. Phases

### Phase 1: Preference and Design Contract

**Goal:** Define the opt-in config and the Storybook surface before behavior is wired into the app.

**Gate from previous:** `TREVOR_HOME` config policy is settled.

#### M1: Config Preference Boundary

- **Dependencies:** hard dependencies
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for reading a Vim-mode preference from the `~/.trevorV2` config file with `TREVOR_HOME` override support.
  2. GREEN: Implement a typed config reader/writer or extend the existing config model for `vim.enabled`.
  3. RED: Add tests for missing config, malformed config, and explicit disabled state.
  4. GREEN: Default Vim mode to disabled and surface parse errors without blocking Trevor startup.
  5. REFACTOR: Document the config key and keep browser-only storage out of the preference source of truth.

#### M2: Storybook Mode Indicator Contract

- **Dependencies:** M1 can be stubbed in stories
- **Effort:** S
- **Tasks:**
  1. RED: Add Storybook/state tests or stories for the prompt bottom row with insert, normal, visual, disabled, shell lane, and narrow widths.
  2. GREEN: Render a compact stable mode indicator next to the upload `+` button when Vim mode is enabled.
  3. RED: Add visual states with the shell glyph replacing `+`, upload disabled, uploading, and upload error.
  4. GREEN: Keep indicator placement stable beside the `+`/shell glyph without composer height reflow.
  5. REFACTOR: Extract a small presentational component for mode indicator states.

### Phase 2: Engine Decision and Prompt Controller

**Goal:** Choose the implementation engine and prove prompt-only Vim behavior can coexist with existing composer features.

**Gate from previous:** Storybook indicator states are approved.

#### M3: `vimeejs/vimee` Evaluation Spike

- **Dependencies:** M1-M2
- **Effort:** M
- **Tasks:**
  1. RED: Build a throwaway Storybook or test harness that exercises `vimeejs/vimee` against the production textarea constraints.
  2. GREEN: Evaluate insert, normal, visual, cursor movement, selection, undo/redo interaction, IME/composition behavior, and textarea selection APIs.
  3. RED: Add comparison cases for image tokens, slash menu, shell lane, history recall, and Enter submit.
  4. GREEN: Record whether to adopt `vimeejs/vimee`, wrap it, or write a small local prompt-only controller.
  5. REFACTOR: Remove spike-only code unless it becomes the chosen implementation.

#### M4: Prompt Vim State Machine

- **Dependencies:** M3 decision
- **Effort:** L
- **Tasks:**
  1. RED: Add unit tests for mode transitions: focus starts insert, Esc to normal, normal to visual, visual Esc to normal, normal insert commands back to insert.
  2. GREEN: Implement the prompt-local Vim mode state machine.
  3. RED: Add tests proving insert mode preserves existing textarea typing, paste, composition, and text selection behavior.
  4. GREEN: Route only normal/visual-mode keys through Vim handling; leave insert-mode typing native.
  5. REFACTOR: Keep the controller independent of React rendering so it is testable without jsdom where possible.

#### M5: Motion and Editing Subset

- **Dependencies:** M4
- **Effort:** L
- **Tasks:**
  1. RED: Add tests for first-cut motions: `h/j/k/l`, `w`, `b`, `0`, `$`, `gg`, `G`, and line-aware movement in a textarea.
  2. GREEN: Implement the approved first-cut normal-mode movement subset.
  3. RED: Add tests for visual selection, yanking/copy semantics if included, deletion/change commands if included, and unsupported-key no-ops.
  4. GREEN: Implement the smallest useful visual-mode subset without breaking native clipboard shortcuts.
  5. REFACTOR: Keep destructive edit commands conservative and explicit; defer ambiguous Vim features.

### Phase 3: Integration With Existing Composer Paths

**Goal:** Wire Vim mode into the real composer without breaking prompt behavior users already rely on.

**Gate from previous:** motion/controller tests and Storybook states pass.

#### M6: Prompt-Surface Integration (composer + full-surface editor)

- **Dependencies:** M1-M5
- **Effort:** M
- **Tasks:**
  1. RED: Add web tests proving Vim mode is inactive when the preference is disabled.
  2. GREEN: Wire enabled preference into `PromptInput` and the composer keydown path.
  3. RED: Add tests for slash menu, prompt shell lane, Enter submit, Shift+Enter newline, Up/Down history recall, and image-token atomic delete under Vim mode.
  4. GREEN: Resolve key precedence so mode handling never swallows existing composer behaviors incorrectly.
  5. RED: Add tests proving the SAME controller drives Vim mode in the full-surface editor (`prompt-surface-editor.tsx`) - mode transitions + motions work in its textarea, the mode indicator shows in its header, and the editor's own Cmd-Enter/Escape confirm-and-close precedence is preserved (Escape in normal-mode does NOT close the editor; Escape in insert-mode enters normal-mode; close is the editor's existing back/Done). <!-- D-007 -->
  6. GREEN: Attach the controller + indicator in the full-surface editor and resolve the Escape precedence between Vim normal-mode entry and the editor's save-and-close.
  7. REFACTOR: Keep App-owned slash/submit/history wiring and the editor's confirm contract outside the Vim controller; the controller stays surface-agnostic.

#### M7: Accessibility and Conflict Handling

- **Dependencies:** M6
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for screen-reader labels and keyboard accessibility of the mode indicator.
  2. GREEN: Give the indicator accessible text without adding visible instructional copy.
  3. RED: Add tests for browser/system shortcuts: Cmd/Ctrl+C, Cmd/Ctrl+V, Cmd/Ctrl+A, Escape behavior around modals/menus, and IME composition.
  4. GREEN: Preserve platform shortcuts and menu/modal Escape ownership.
  5. REFACTOR: Document conflict precedence between slash menu, command menus, shell lane, and Vim mode.

### Phase 4: Verification

**Goal:** Verify the feature from Storybook to live app with the preference enabled and disabled.

**Gate from previous:** M1-M7 pass.

#### M8: Storybook and E2E Verification

- **Dependencies:** M1-M7
- **Effort:** M
- **Tasks:**
  1. RED: Add Storybook interaction tests for mode transitions and indicator updates.
  2. GREEN: Make Storybook states pass for insert, normal, visual, shell, slash, image tokens, upload, and narrow/mobile widths.
  3. RED: Add manual EZE script for enabling the config, opening Trevor, typing in insert, Esc to normal, selecting visual text, returning to insert, and submitting - in BOTH the composer and the full-surface editor (open via the composer expand button), confirming Escape enters normal-mode there without closing the editor.
  4. GREEN: Verify live behavior with preference enabled and disabled, on both prompt surfaces.
  5. REFACTOR: Update user-facing config docs and AGENTS guidance for the Vim preference.

## 3. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|---|---:|---:|---|---|
| Vim mode breaks ordinary typing | high | medium | Disabled by default; starts insert; insert mode preserves native typing. | Web |
| Escape conflicts with slash/menu/modal dismissal | high | medium | Explicit conflict precedence tests and App-owned menu handling. | Web |
| `vimeejs/vimee` does not fit textarea constraints | medium | medium | Spike before adoption; local controller fallback. | Web |
| Mode indicator clutters compact composer | medium | low | Storybook narrow-width states; stable small footprint next to `+`. | Design/Web |
| Preference config drifts from settings model | medium | medium | Use `TREVOR_HOME` config and typed decode tests. | Host/Web |

## 4. Escape Hatches

1. **If `vimeejs/vimee` fights the composer:** implement a small prompt-only controller for insert/normal/visual and defer advanced Vim commands.
2. **If visual mode is too broad for first cut:** ship insert/normal plus indicator first, keeping visual-mode entry tests pending in a later milestone.
3. **If config plumbing is not ready:** implement Storybook-only mode states and defer app wiring until `03-filesystem-root-taxonomy` or settings config lands.

## 5. Progress Report Accounting

The progress report is `.plans/24-vim-motions-ui/progress-report.md`. It tracks the prompt-surface Vim motion feature across both prompt textareas (the composer and the full-surface editor, D-007). Broader UI navigation, transcript motions, command-menu Vim control, and global app keybindings are not current-cutoff work.

Before implementation resumes, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "24-vim-motions-ui"
```

## 6. Validation Commands

```bash
pnpm --filter @trevor/web test
pnpm --filter @trevor/web storybook
pnpm --filter @trevor/web typecheck
pnpm test
pnpm typecheck
```

## 7. Decisions

Canonical decisions are in `.plans/24-vim-motions-ui/plan.db`. Query them with:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "24-vim-motions-ui"
```
