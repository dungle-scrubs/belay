import type { WorktreeSummary } from "@trevor/session";
import { type RowChooserAdapter, RowChooserModal } from "@/components/command-modal";
import { buildWorktreeRows, type WorktreeRowsContext } from "./worktree-rows";

/** The worktree switcher's chrome + row projection (D-091); the structure lives in RowChooserModal. */
const WORKTREE_CHOOSER: RowChooserAdapter<readonly WorktreeSummary[], WorktreeRowsContext> = {
  title: "Switch worktree",
  placeholder: "Search worktrees…",
  emptyLabel: "No worktrees",
  footerHints: [
    { keys: "↑↓", label: "navigate" },
    { keys: "↵", label: "switch" },
    { keys: "esc", label: "close" },
  ],
  buildRows: buildWorktreeRows,
};

export interface WorktreeModalProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly worktrees: readonly WorktreeSummary[];
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly context: WorktreeRowsContext;
  /** Called with the chosen worktree id (`"baseline"` for the base checkout) on an enabled row. */
  readonly onSwitch: (id: string) => void;
}

/**
 * The managed-worktree switcher (D-091): binds the worktree adapter + host-announced worktrees
 * (grouped by base repo, baseline first) to the shared `RowChooserModal`. Presentational - App owns
 * the data and the switch action. Selecting an enabled row switches and closes; the current worktree,
 * a missing (repair) row, and - while the workspace is busy - every other row are disabled.
 */
export function WorktreeModal({
  open,
  onOpenChange,
  worktrees,
  loading,
  error,
  context,
  onSwitch,
}: WorktreeModalProps) {
  return (
    <RowChooserModal
      adapter={WORKTREE_CHOOSER}
      open={open}
      onOpenChange={onOpenChange}
      data={worktrees}
      context={context}
      loading={loading}
      error={error}
      onSelect={onSwitch}
    />
  );
}
