/**
 * Responsible for: the GitRunner seam + reading a structured GitStatus for one directory.
 * Not for: worktree mutations (add/remove/prune/merge) - git.ts owns those.
 */
import { spawnSync } from "node:child_process";
import type { GitStatus } from "@belay/session";

/**
 * Runs one git command in a fixed cwd and returns its exit status + trimmed stdout.
 * `status` is the process exit code, or `null` when git could not be spawned at all
 * (e.g. git not installed). The seam exists so `readGitStatus` is a pure function over
 * a runner and can be unit-tested with fixtures instead of a live repository.
 */
export type GitRunner = (args: readonly string[]) => {
  readonly status: number | null;
  readonly stdout: string;
};

/** A node-backed runner bound to `cwd`, using argv arrays (never a parsed shell string). */
export function nodeGitRunner(cwd: string): GitRunner {
  return (args) => {
    const out = spawnSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { status: out.status, stdout: typeof out.stdout === "string" ? out.stdout : "" };
  };
}

/**
 * Reads a structured git status for the runner's cwd, or `null` when the directory is
 * not inside a git work tree (or git is unavailable). Failures of individual commands
 * degrade that field rather than the whole read: a repo with no commits still reports a
 * branch + dirty flag, an upstream-less branch reports `upstream: false` with zero
 * ahead/behind. Every command is argv-based; nothing is shell-parsed.
 */
export function readGitStatus(run: GitRunner): GitStatus | null {
  const inside = run(["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    return null;
  }

  const branchOut = run(["branch", "--show-current"]);
  const branch = branchOut.status === 0 ? branchOut.stdout.trim() : "";

  // Detached HEAD: no current branch, so label by the short commit. A fresh repo with
  // no commits has neither - both stay null and the line renders just the dirty/worktree.
  let detached: string | null = null;
  if (!branch) {
    const head = run(["rev-parse", "--short", "HEAD"]);
    const sha = head.status === 0 ? head.stdout.trim() : "";
    detached = sha || null;
  }

  // Dirty = any porcelain output, untracked files included.
  const porcelain = run(["status", "--porcelain"]);
  const dirty = porcelain.status === 0 && porcelain.stdout.trim().length > 0;

  // Ahead/behind only against a configured upstream. `--count` prints "behind\tahead"
  // for `@{upstream}...HEAD` (left = upstream-only commits, right = HEAD-only). With no
  // upstream the command exits non-zero, so upstream stays false and the deltas stay 0.
  let upstream = false;
  let ahead = 0;
  let behind = 0;
  const counts = run(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
  if (counts.status === 0) {
    const parts = counts.stdout.trim().split(/\s+/);
    if (parts.length === 2) {
      upstream = true;
      behind = Number.parseInt(parts[0] ?? "", 10) || 0;
      ahead = Number.parseInt(parts[1] ?? "", 10) || 0;
    }
  }

  // A linked worktree has a `--git-dir` distinct from the shared `--git-common-dir`;
  // the main work tree has them equal.
  const gitDir = run(["rev-parse", "--git-dir"]);
  const commonDir = run(["rev-parse", "--git-common-dir"]);
  const worktree =
    gitDir.status === 0 &&
    commonDir.status === 0 &&
    gitDir.stdout.trim().length > 0 &&
    gitDir.stdout.trim() !== commonDir.stdout.trim();

  return {
    branch: branch || null,
    detached,
    dirty,
    ahead,
    behind,
    upstream,
    worktree,
  };
}
