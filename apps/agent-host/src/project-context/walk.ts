import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/** Directories pruned from every context workspace walk (VCS, deps, build output, generated). */
export const CONTEXT_IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".trevor/generated",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

/** Whether a directory lies under one of the ignored names (relative to the walk root). */
function isIgnoredDir(root: string, dir: string): boolean {
  return relative(root, dir)
    .split("/")
    .some((part) => CONTEXT_IGNORED_DIRS.has(part));
}

/**
 * Recursively walks a workspace tree from `root`, pruning the shared {@link CONTEXT_IGNORED_DIRS}, and
 * returns the sorted absolute paths of files matching `accept` (every file when omitted). The ONE owner
 * of the ignore policy + prune-traversal that both the AGENTS.md init scan and the CLAUDE.md migration
 * scan need - each passes only its own basename filter, so adding an ignored dir is one edit here.
 */
export function walkContextTree(root: string, accept?: (name: string) => boolean): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const files: string[] = [];
  const visit = (dir: string): void => {
    if (isIgnoredDir(root, dir)) {
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && (!accept || accept(entry.name))) {
        files.push(path);
      }
    }
  };
  visit(root);
  return files.sort();
}
