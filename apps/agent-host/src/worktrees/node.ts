import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { projectSessionId } from "@trevor/session";
import { type GitRunner, nodeGitRunner } from "../git-status";
import { TREVOR_HOME } from "../paths";
import { mainWorktreeRoot } from "./git";
import { type WorktreeContext, WorktreeManager } from "./manager";
import type { WorktreeFs } from "./registry";

/** The real node-backed filesystem for the worktree registry (mirrors the launcher's seam). */
export const nodeWorktreeFs: WorktreeFs = {
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  writeFile(path, content) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  },
  exists(path) {
    return existsSync(path);
  },
  remove(path) {
    try {
      rmSync(path, { force: true, recursive: true });
    } catch {
      // already gone
    }
  },
};

/** A node-backed worktree manager rooted at TREVOR_HOME; `abbrev` shortens display paths. */
export function nodeWorktreeManager(abbrev: (path: string) => string): WorktreeManager {
  return new WorktreeManager({
    fs: nodeWorktreeFs,
    home: TREVOR_HOME,
    gitRunnerFor: (cwd) => nodeGitRunner(cwd),
    abbrev,
    now: () => new Date().toISOString(),
    genId: () => randomUUID().slice(0, 8),
  });
}

function realpathSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Resolves the worktree context for a cwd: the canonical base-repo identity (realpath'd MAIN
 * worktree root, stable across spelling/symlinks/nested paths), its baseline session, and the
 * current path (for marking the active row). Null when cwd is not a git repository.
 */
export function worktreeContextFor(cwd: string): WorktreeContext | null {
  const run: GitRunner = nodeGitRunner(cwd);
  const mainRoot = mainWorktreeRoot(run);
  if (!mainRoot) {
    return null;
  }
  const baseRepo = realpathSafe(mainRoot);
  return {
    baseRepo,
    baseRepoName: basename(baseRepo),
    basePath: mainRoot,
    baselineSessionId: projectSessionId(baseRepo),
    currentPath: cwd,
  };
}

/** A stable durable session id for a (base repo, branch) managed worktree. */
export function worktreeSessionId(baseRepo: string, branch: string): string {
  return projectSessionId(`${baseRepo}#${branch}`);
}
