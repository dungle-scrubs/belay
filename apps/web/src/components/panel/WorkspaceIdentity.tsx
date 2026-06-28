import type { GitStatus } from "@trevor/session";
import { GitBranch } from "lucide-react";

/**
 * The structured pieces of the sidebar git line, derived from a host `GitStatus`. Kept as
 * a pure projection (no JSX) so the format - `branch*`, `↑N`, `↓N`, detached HEAD - is
 * unit-testable independently of rendering.
 */
export interface GitLine {
  /** The branch name, or `detached <sha>` when HEAD is detached. */
  readonly ref: string;
  /** Whether HEAD is detached (so the ref renders muted). */
  readonly detached: boolean;
  /** Trailing `*` shown when the work tree is dirty. */
  readonly dirty: boolean;
  /** Commits ahead of upstream (rendered as `↑N` when > 0). */
  readonly ahead: number;
  /** Commits behind upstream (rendered as `↓N` when > 0). */
  readonly behind: number;
}

/** Projects a host `GitStatus` into the sidebar line, or null when there's no ref to show. */
export function gitLine(git: GitStatus): GitLine | null {
  if (git.branch) {
    return {
      ref: git.branch,
      detached: false,
      dirty: git.dirty,
      ahead: git.ahead,
      behind: git.behind,
    };
  }
  if (git.detached) {
    return {
      ref: `detached ${git.detached}`,
      detached: true,
      dirty: git.dirty,
      ahead: git.ahead,
      behind: git.behind,
    };
  }
  // A repo with no branch and no commit yet: nothing meaningful to show as a ref.
  return null;
}

/**
 * The sidebar workspace identity block: the effective cwd on the first line, and the git
 * branch/status underneath it. Purely presentational and fixture-driven - the live app
 * passes the host's structured `GitStatus`; Storybook drives every state by hand. A
 * non-git cwd (`git` null/undefined) renders the cwd alone with no second line.
 *
 * The cwd and ref truncate independently; the ahead/behind counters are `shrink-0` so a
 * long branch never pushes them off or overlaps the context meter below.
 */
export function WorkspaceIdentity({
  cwd,
  git,
  worktreeCount = 0,
  onOpenWorktrees,
}: {
  readonly cwd: string;
  readonly git?: GitStatus | null;
  /** How many OTHER managed worktrees this project has (switch targets beyond the current one). */
  readonly worktreeCount?: number;
  /** Opens the worktree switcher (same as `/worktree`); the `+N worktrees` link is shown only when set. */
  readonly onOpenWorktrees?: () => void;
}) {
  const line = git ? gitLine(git) : null;
  const showWorktrees = worktreeCount > 0 && onOpenWorktrees != null;
  return (
    <div className="flex flex-col gap-1 border border-border bg-background px-3 py-2 text-xs">
      <code className="truncate text-foreground">{cwd}</code>
      {line ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className={`min-w-0 truncate ${line.detached ? "italic" : ""}`} title={line.ref}>
            {line.ref}
            {line.dirty ? <span className="text-smui-yellow">*</span> : null}
          </span>
          {line.ahead > 0 ? (
            <span className="shrink-0 tabular-nums" title={`${line.ahead} ahead of upstream`}>
              ↑{line.ahead}
            </span>
          ) : null}
          {line.behind > 0 ? (
            <span className="shrink-0 tabular-nums" title={`${line.behind} behind upstream`}>
              ↓{line.behind}
            </span>
          ) : null}
        </div>
      ) : null}
      {showWorktrees ? (
        <button
          type="button"
          onClick={onOpenWorktrees}
          title="Switch worktree (/worktree)"
          className="flex w-fit items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          <GitBranch className="size-2.5 shrink-0" />
          <span>
            +{worktreeCount} worktree{worktreeCount === 1 ? "" : "s"}
          </span>
        </button>
      ) : null}
    </div>
  );
}
