import type { GitStatus } from "@trevor/session";
import { type GitRunner, readGitStatus } from "../git-status";

/**
 * Worktree-level git operations (D-091), each pure over the injectable `GitRunner` so the
 * exit-code → result mapping is unit-tested with fixtures rather than a live repository. The
 * runner is cwd-bound by the caller (`nodeGitRunner(path)`), so the same helpers read the base
 * repo or any worktree by pointing the runner at that directory. Read helpers degrade a failed
 * command to a null/empty value; mutating helpers return a typed ok/error result.
 */

export type GitResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** The repository root for the runner's cwd (`--show-toplevel`), or null when not a repo. */
export function repoToplevel(run: GitRunner): string | null {
  const out = run(["rev-parse", "--show-toplevel"]);
  const top = out.status === 0 ? out.stdout.trim() : "";
  return top || null;
}

/**
 * The MAIN worktree root for the runner's cwd - the directory holding the shared `.git`, so a
 * linked worktree and the main checkout resolve to the SAME root (the stable base-repo identity
 * for grouping). Falls back to `--show-toplevel` for unusual layouts (bare repos).
 */
export function mainWorktreeRoot(run: GitRunner): string | null {
  const out = run(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const common = out.status === 0 ? out.stdout.trim() : "";
  if (common.endsWith("/.git")) {
    return common.slice(0, -"/.git".length);
  }
  return repoToplevel(run);
}

/** The current HEAD commit (full sha), or null. */
export function headCommit(run: GitRunner): string | null {
  const out = run(["rev-parse", "HEAD"]);
  const sha = out.status === 0 ? out.stdout.trim() : "";
  return sha || null;
}

/** Whether the runner's worktree has unmerged paths (a rebase/merge conflict in progress). */
export function hasConflict(run: GitRunner): boolean {
  const out = run(["diff", "--name-only", "--diff-filter=U"]);
  return out.status === 0 && out.stdout.trim().length > 0;
}

/** A worktree's git status plus its conflict flag, for the switcher rows. */
export interface WorktreeGitState {
  readonly git: GitStatus | null;
  readonly conflict: boolean;
}

export function worktreeGitState(run: GitRunner): WorktreeGitState {
  return { git: readGitStatus(run), conflict: hasConflict(run) };
}

/**
 * Creates a new worktree at `path` on a fresh `branch` cut from `baseRef`. Uses `worktree add -b`
 * so the branch must not already exist (a safe-branch policy: never silently reuse an existing
 * ref). A non-zero exit (path taken, branch exists, dirty index) returns a typed error.
 */
export function addWorktree(
  run: GitRunner,
  path: string,
  branch: string,
  baseRef: string,
): GitResult {
  const out = run(["worktree", "add", "-b", branch, path, baseRef]);
  if (out.status !== 0) {
    return { ok: false, error: `git worktree add failed (exit ${out.status ?? "null"})` };
  }
  return { ok: true };
}

/**
 * Removes a worktree directory and prunes its admin entry. `force` is required to remove a dirty
 * worktree; the caller decides whether a dirty/unpushed tree is allowed (the confirmation gate).
 */
export function removeWorktree(run: GitRunner, path: string, force: boolean): GitResult {
  const args = force ? ["worktree", "remove", "--force", path] : ["worktree", "remove", path];
  const out = run(args);
  if (out.status !== 0) {
    return { ok: false, error: `git worktree remove failed (exit ${out.status ?? "null"})` };
  }
  return { ok: true };
}

/** Prunes admin entries for worktree directories that were deleted out from under git. */
export function pruneWorktrees(run: GitRunner): GitResult {
  const out = run(["worktree", "prune"]);
  return out.status === 0
    ? { ok: true }
    : { ok: false, error: `git worktree prune failed (exit ${out.status ?? "null"})` };
}

/**
 * Merges `branch` into the runner's current branch (the merge-back flow, M5). A non-zero exit is
 * reported as a conflict/error result so the caller can surface it rather than leaving a half-merge.
 */
export function mergeBranch(run: GitRunner, branch: string): GitResult {
  const out = run(["merge", "--no-edit", branch]);
  if (out.status !== 0) {
    return { ok: false, error: `git merge ${branch} reported conflicts or failed` };
  }
  return { ok: true };
}

/** A compact diff stat of `branch` against `baseRef` (the inspect-before-merge view, M5). */
export function diffStat(run: GitRunner, baseRef: string, branch: string): string {
  const out = run(["diff", "--stat", `${baseRef}...${branch}`]);
  return out.status === 0 ? out.stdout.trim() : "";
}
