# Vim Cursor Shape and Indicator Alignment - Progress Report

## Summary

> Current focus: M1: Cursor shape (block in normal/visual, thin line in insert)

- Total checklist items: 17
- Completed: 2
- Current cutoff blockers: 15

## 0. Hard Dependencies

- [x] Vim feature (plan 06, merged): `useVim`, `VimMode`, `VimModeIndicator`, controller, composer + editor integration
- [x] Storybook visual-regression lane (plan 09.2, merged): `test-storybook` + committed baselines under `apps/web/__snapshots__/`

## M1: Cursor shape (block in normal/visual, thin line in insert)

- [ ] RED: Composer component test - focused Vim composer carries the block caret-shape class after Escape (normal) and `v` (visual), and the thin/default class in insert (initial + after `i`)
- [ ] GREEN: Add the `vim.mode`→caret-shape class (`[caret-shape:block]` in normal/visual, thin default otherwise) to the textarea in `prompt-input.tsx`
- [ ] RED: Full-surface editor test - same block-in-normal/visual, thin-in-insert assertion in `prompt-surface-editor.test.tsx`
- [ ] GREEN: Apply the identical `vim.mode`→caret-shape class to the editor textarea in `prompt-surface-editor.tsx`
- [ ] REFACTOR: Extract the mode→caret-shape class mapping to one shared helper co-located with the Vim layer; confirm the disabled (non-Vim) path adds no caret-shape class

## M2: Indicator left-alignment

- [ ] RED: Assert the mode-indicator pill has no preceding `flex-1` spacer and renders immediately after the composer controls (prompt-input test)
- [ ] GREEN: Remove `<span className="flex-1" />` before `<VimModeIndicator>` in `prompt-input.tsx`
- [ ] RED: Same DOM-order assertion for the full-surface editor header in `prompt-surface-editor.test.tsx`
- [ ] GREEN: Remove the `flex-1` spacer in `prompt-surface-editor.tsx`; drop the spacer in the `BottomRow` mock in `vim-mode-indicator.stories.tsx`
- [ ] RED: Confirm the pill's stable width still prevents row reflow across insert/normal/visual (extend the narrow/mode-cycle story assertion)
- [ ] GREEN: Regenerate the affected Storybook baselines in the pinned container (`components-promptinput--vim-mode`, `--vim-shell-lane`, `chat-vimmodeindicator--*`)
- [ ] REFACTOR: Confirm no other story/caller depended on the removed spacer; keep the pill's `shrink-0`/`min-w`

## M3: Verification

- [ ] RED: EZE note - focused real app: Esc→block, `i`/`a`→thin line, `v`/`V`→block/selection; pill sits just right of the +/expand icons and does not move as the mode changes
- [ ] GREEN: Run `pnpm test:web`, `pnpm typecheck`, `pnpm lint`, `pnpm test-storybook`; inspect composer + editor at desktop and narrow widths
- [ ] REFACTOR: Note the off-Chromium degradation (thin bar on FF/Safari) in the component doc-comment
