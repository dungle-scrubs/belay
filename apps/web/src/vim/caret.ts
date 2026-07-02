import type { VimMode } from "./mode";

/**
 * The Vim caret shape (plan 06.1): in normal/visual the native caret renders as a thick block via the
 * CSS `caret-shape` property; insert keeps the default thin bar (no class). Chromium - the app's actual
 * runtime (Vite dev, Storybook, a future desktop shell) - renders the block; engines without
 * `caret-shape` (Firefox/Safari) simply fall back to the thin bar, today's behavior. Shared by both Vim
 * surfaces (the inline composer and the full-surface editor) so the mode->shape mapping lives in one
 * place. In visual mode the active selection highlight is the block the user sees; the property still
 * applies for the collapsed edges (D-005).
 */
export function vimCaretClass(mode: VimMode): string | null {
  return mode === "insert" ? null : "[caret-shape:block]";
}
