/**
 * The Vim prompt mode (plan 06): the three-state model shared by the mode indicator and the prompt
 * controller. A focused Vim-enabled prompt starts in `insert` (so typing is never hostile); Escape
 * enters `normal`; `visual` is reachable only from `normal`. Deliberately small - no operator-pending
 * or replace state in the first cut.
 */
export type VimMode = "insert" | "normal" | "visual";

/** The mode order, for stories/tests that iterate every state. */
export const VIM_MODES: readonly VimMode[] = ["insert", "normal", "visual"];
