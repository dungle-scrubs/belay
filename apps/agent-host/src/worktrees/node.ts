import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { nodeGitRunner } from "../git-status";
import { TREVOR_STATE_HOME } from "../paths";
import { WorktreeManager } from "./manager";
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

/** A node-backed worktree manager rooted at the STATE home; `abbrev` shortens display paths. */
export function nodeWorktreeManager(abbrev: (path: string) => string): WorktreeManager {
  return new WorktreeManager({
    fs: nodeWorktreeFs,
    home: TREVOR_STATE_HOME,
    gitRunnerFor: (cwd) => nodeGitRunner(cwd),
    abbrev,
    realpath: realpathSafe,
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
