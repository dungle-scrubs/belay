import type { WorktreeSummary } from "@trevor/session";
import { useMemo } from "react";
import { CommandModal, type FooterHint } from "@/components/command-modal";
import { buildWorktreeRows, type WorktreeRowsContext } from "./worktree-rows";

const WORKTREE_HINTS: readonly FooterHint[] = [
  { keys: "↑↓", label: "navigate" },
  { keys: "↵", label: "switch" },
  { keys: "esc", label: "close" },
];

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
 * The managed-worktree switcher (D-091): the shared `CommandModal` fed by the worktree-row
 * adapter over the host-announced worktrees, grouped by base repo with the baseline checkout
 * first. Presentational - App owns the host-announced data and the switch action. Selecting an
 * enabled row switches and closes; the current worktree, a missing (repair) row, and - while the
 * workspace is busy - every other row are disabled and never fire.
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
  const rows = useMemo(() => buildWorktreeRows(worktrees, context), [worktrees, context]);
  return (
    <CommandModal
      open={open}
      onOpenChange={onOpenChange}
      title="Switch worktree"
      placeholder="Search worktrees…"
      rows={rows}
      loading={loading}
      error={error ?? undefined}
      emptyLabel="No worktrees"
      footerHints={WORKTREE_HINTS}
      onSelect={(id) => {
        onSwitch(id);
        onOpenChange(false);
      }}
    />
  );
}
