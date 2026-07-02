# Vim Cursor Shape and Indicator Alignment - Implementation Plan

A small fix off the shipped Vim feature (plan 06). Two independent defects in the composer's Vim
surface:

1. **Cursor shape was never implemented.** `apps/web/src/vim/controller.ts` enters normal mode with a
   *collapsed* caret (`selStart === selEnd`), so the textarea shows the native thin line in every mode.
   Vim convention is a **thick block** cursor in normal/visual and a **thin line** in insert.
2. **The mode indicator is right-shoved.** `apps/web/src/components/chat/prompt-input.tsx` renders
   `<span className="flex-1" />` before `<VimModeIndicator>`, pushing the pill to the far right of the
   bottom row. It should be **left-aligned immediately to the right of the two composer icons** (the
   `+`/attach and the expand `⤢`). The same right-push is duplicated in the full-surface editor header
   (`prompt-surface-editor.tsx`) and the Storybook `BottomRow` mock.

## 0. Hard Dependencies

- [x] Vim feature (plan 06 `06-vim-motions-ui`, merged/removed): the `useVim` hook, `VimMode` model,
  `VimModeIndicator`, the controller, and the composer + full-surface editor integration (D-007). This
  plan modifies plan 06's artifacts directly. <!-- D-003 -->
- [x] Storybook visual-regression lane (plan 09.2 `09.2-web-browser-test-suite`, merged): `test-storybook`
  + `@storybook/test-runner` + committed baselines under `apps/web/__snapshots__/`, regenerated in the
  pinned container via `apps/web/tests/browser/update-storybook-baselines.sh`. The alignment change
  requires regenerating the affected baselines. <!-- D-004 -->

No plan is in flight (clean `main`); this is a decimal off its dependency (plan 06), not the current
plan. <!-- D-003 -->

## 1. Architecture

Web-local and host-untouched. Both changes live entirely in `apps/web/src` - no host, protocol, or
config change. Both Vim surfaces (the inline composer `prompt-input.tsx` and the full-surface editor
`prompt-surface-editor.tsx`) attach the SAME `useVim` hook, so both get the fix from one code path per
concern.

### Cursor shape (D-001)

The native `<textarea>` caret cannot be reshaped by ordinary CSS, so the fix uses the CSS
**`caret-shape`** property:

- normal/visual mode → `caret-shape: block` (a thick block over/after the caret position),
- insert mode → the default thin bar (`caret-shape: bar`, or simply omit the block class).

Applied as a conditional class on the textarea keyed off `vim.mode`. `useVim` already re-renders the
host component on every mode change (its `commit` guard sets React state when `mode` changes), so a
`vim.mode`-derived class is always current. Tailwind v4 has no `caret-shape` utility, so use an
arbitrary-property class (`[caret-shape:block]`) - no per-component `cursor-*` and no global CSS-layer
change (the global base layer owns `cursor-pointer`, not caret shape).

Why native `caret-shape` over a mirror-overlay block:

| Concern | `caret-shape` (chosen) | Mirror-overlay block (rejected) |
|---|---|---|
| Positioning / blink / wrap / scroll | free (native caret) | must be re-derived and kept in sync |
| Proportional + mono fonts | both work | per-glyph width measurement needed |
| Maintenance surface | ~1 class | mirror div + scroll-sync + glyph math |
| Cross-engine | Chromium only; degrades to thin bar on FF/Safari | portable |

The app's real runtime is Chromium (Vite dev, Storybook, any future Tauri/Electron), so the block
renders there; off-Chromium it degrades to today's thin bar - no regression. <!-- D-001 -->

**Visual-mode nuance (D-005):** `caret-shape: block` applies in visual mode too, but the browser draws
the selection highlight (a filled block region) during an active selection rather than a separate block
caret at the moving end. That is accepted - it reads as a filled block, not a thin bar, satisfying the
insert-vs-normal/visual distinction. No overlay block is added for the visual moving-end. <!-- D-005 -->

### Indicator alignment (D-002)

Remove the `<span className="flex-1" />` spacer that precedes `<VimModeIndicator>` so the pill sits
immediately after the preceding controls (left-aligned), in three places:

- `prompt-input.tsx` bottom row (after the `+`/attach and expand `⤢` icons),
- `prompt-surface-editor.tsx` header (after the title label),
- `vim-mode-indicator.stories.tsx` `BottomRow` mock (so the story matches the real layout).

The pill keeps its stable width (`min-w-[3.5rem]`, monospace 6-char labels), so removing the spacer does
not reintroduce row reflow as the mode changes. <!-- D-002 -->

### Boundaries

| Boundary | Owns | Does not own |
|---|---|---|
| `prompt-input.tsx` (composer) | Applies the `vim.mode`→caret-shape class; left-aligns the pill in the bottom row | The Vim state machine; the pill's own styling |
| `prompt-surface-editor.tsx` (editor) | Same caret-shape class + left-aligned pill in the header | The Vim state machine |
| `useVim` / `controller.ts` | Owns `vim.mode`; unchanged by this plan | Any caret *rendering* (CSS-only concern) |
| `vim-mode-indicator.stories.tsx` | The `BottomRow` mock mirrors the real bottom-row layout | Production layout |

No module-level comment additions or new target files: both changes are edits to existing files.

## 2. Phases

### Phase 1: Vim composer polish

**Goal:** Vim mode shows a thick block cursor in normal/visual and a thin line in insert, and the mode
indicator is left-aligned right of the composer icons, on both Vim surfaces - with tests and regenerated
visual baselines proving it.

#### M1: Cursor shape (block in normal/visual, thin line in insert)

- **Dependencies:** hard dependencies
- **Effort:** S
- **Tasks:**
  1. RED: Component/DOM test (jsdom, alongside `vim-escape.test.tsx`) that mounts the composer with
     `vimEnabled`, focuses it, and asserts the textarea carries the block caret-shape class after
     `Escape` (normal) and after entering `visual` (`v`), and the thin/default class in `insert`
     (initial focus and after `i`). <!-- D-004 -->
  2. GREEN: In `prompt-input.tsx`, add a `vim.mode`-derived arbitrary-property class
     (`[caret-shape:block]` when `vim.mode` is `normal`/`visual`, else the thin default) to the textarea.
  3. RED: Same assertion for the full-surface editor (`prompt-surface-editor.test.tsx`): block class in
     normal/visual, thin in insert.
  4. GREEN: Apply the identical `vim.mode`-derived class to the editor textarea in
     `prompt-surface-editor.tsx`.
  5. REFACTOR: Extract the mode→caret-shape class mapping to one shared helper (co-located with the Vim
     layer) so both surfaces read from one source, and confirm the disabled (non-Vim) path is unchanged
     (no caret-shape class). <!-- D-001 -->

#### M2: Indicator left-alignment

- **Dependencies:** M1
- **Effort:** S
- **Tasks:**
  1. RED: Test asserting the mode-indicator pill is NOT preceded by a `flex-1` spacer and renders
     immediately after the preceding controls in the composer bottom row (DOM-order / class assertion in
     the prompt-input test). <!-- D-002 -->
  2. GREEN: Remove `<span className="flex-1" />` before `<VimModeIndicator>` in `prompt-input.tsx`.
  3. RED: Same DOM-order assertion for the full-surface editor header
     (`prompt-surface-editor.test.tsx`).
  4. GREEN: Remove the `flex-1` spacer in `prompt-surface-editor.tsx`; update the `BottomRow` mock in
     `vim-mode-indicator.stories.tsx` to drop its spacer so the story mirrors the real layout.
  5. RED: Confirm the pill's stable width still prevents row reflow across insert/normal/visual (extend
     the existing narrow/mode-cycle story assertion).
  6. GREEN: Regenerate the affected Storybook visual-regression baselines in the pinned container
     (`update-storybook-baselines.sh`): `components-promptinput--vim-mode`, `--vim-shell-lane`, and the
     `chat-vimmodeindicator--*` stories. <!-- D-004 -->
  7. REFACTOR: Confirm no other composer story or caller depended on the removed spacer; keep the pill's
     `shrink-0`/`min-w` so alignment and stability co-exist.

#### M3: Verification

- **Dependencies:** M2
- **Effort:** S
- **Tasks:**
  1. RED: EZE note - in the real focused app with Vim enabled: `Esc` shows a block cursor, `i`/`a`
     returns a thin line, `v`/`V` shows the block/selection; the pill sits just right of the `+`/expand
     icons and does not move as the mode changes. <!-- D-005 -->
  2. GREEN: Run `pnpm test:web`, `pnpm typecheck`, `pnpm lint`, and `pnpm test-storybook`; inspect the
     composer and editor at desktop and narrow widths.
  3. REFACTOR: Note the off-Chromium degradation (thin bar on FF/Safari) in the component doc-comment so
     the caret-shape choice is discoverable. <!-- D-001 -->

### Gate 1 (done)

- [ ] All M1-M3 tests pass (`pnpm test:web`), typecheck + lint clean.
- [ ] `pnpm test-storybook` passes against regenerated baselines.
- [ ] Manual EZE confirms block-in-normal/visual, thin-in-insert, and the left-aligned pill on both
  surfaces.

## 3. Risk Register

| Risk | Severity | Likelihood | Mitigation |
|---|---:|---:|---|
| `caret-shape` unsupported in the test-runner / target Chromium (block silently absent) | medium | low | App runtime is Chromium; M1 asserts the *class* (not a screenshot), so support is a rendering concern, verified in EZE; degrades to thin bar with no regression |
| Removing `flex-1` reflows or misaligns the bottom row | low | low | Pill keeps `shrink-0` + `min-w`; M2 re-asserts no-reflow and regenerates baselines |
| Stale visual baselines fail the Storybook lane after the layout change | medium | high (expected) | M2 regenerates the affected baselines in the pinned container as a plan task |
| caret-shape class collides with the `/loop` transparent-text + `caret-foreground` path | low | low | Non-goal below; loop-preview + Vim coexistence is out of scope for this fix |

## 4. Non-Goals

- Any host, protocol, or config change (web-local only).
- A mirror-overlay block cursor or cross-engine (FF/Safari) block support (explicitly rejected in D-001).
- A distinct block caret at the visual-mode moving-end atop the selection highlight (D-005).
- Vim + `/loop` transparent-text preview coexistence (separate concern).
- Any change to the Vim state machine, motions, or key precedence.

## 5. Progress Report Accounting

Use `.plans/06.1-vim-cursor-shape-and-indicator-alignment/progress-report.md` as the implementation
resume state. Before resuming implementation, run:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "06.1-vim-cursor-shape-and-indicator-alignment"
```

## 6. Validation Commands

```bash
pnpm test:web
pnpm typecheck
pnpm lint
pnpm test-storybook
# regenerate baselines after the alignment change (pinned container):
apps/web/tests/browser/update-storybook-baselines.sh
```

## 7. Decisions

Canonical decisions are in `.plans/06.1-vim-cursor-shape-and-indicator-alignment/plan.db`. Query with:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "06.1-vim-cursor-shape-and-indicator-alignment"
```

Key decisions referenced in this document use `<!-- D-NNN -->` markers.
