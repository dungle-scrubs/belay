import type { WorktreeSummary } from "@trevor/session";
import { FolderGit2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The worktree badge for a sidebar session row (plan 58.2 M3): a compact `FolderGit2` icon with a
 * Radix tooltip listing the branch, abbreviated worktree path, and git state. Presentational only -
 * the row already holds a joined `WorktreeSummary`; this component never joins or scans state itself.
 *
 * The badge sits beside the session title (left content), never in the absolute right slot, so
 * timestamps and hover actions keep their stable layout.
 */

export interface WorktreeBadgeProps {
  readonly worktree: WorktreeSummary;
  readonly className?: string;
}

/**
 * Compact git-state chip for the tooltip: `missing`, `conflict`, `dirty`, `N ahead`, `N behind`,
 * composition of those, or `clean` when nothing special is happening.
 */
export function worktreeGitStateLabel(worktree: WorktreeSummary): string {
  if (worktree.missing) {
    return "missing";
  }
  if (worktree.conflict) {
    return "conflict";
  }
  const parts: string[] = [];
  if (worktree.dirty) {
    parts.push("dirty");
  }
  if (worktree.ahead > 0) {
    parts.push(`${worktree.ahead} ahead`);
  }
  if (worktree.behind > 0) {
    parts.push(`${worktree.behind} behind`);
  }
  return parts.length > 0 ? parts.join(", ") : "clean";
}

/** Builds the multi-line tooltip body for a joined worktree summary. */
export function worktreeTooltipText(worktree: WorktreeSummary): {
  readonly branch: string;
  readonly path: string;
  readonly state: string;
} {
  return {
    branch: worktree.branch,
    path: worktree.path,
    state: worktreeGitStateLabel(worktree),
  };
}

export function WorktreeBadge({ worktree, className }: WorktreeBadgeProps) {
  const tip = worktreeTooltipText(worktree);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label="worktree"
          className={cn("inline-flex shrink-0 items-center text-muted-foreground/70", className)}
        >
          <FolderGit2 className="size-3" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" align="center" className="max-w-64">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium text-foreground">{tip.branch}</span>
          <span className="truncate text-muted-foreground/70">{tip.path}</span>
          <span className="text-muted-foreground/70">{tip.state}</span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
