/**
 * Responsible for: the ignore-pruned, depth- and entry-capped workspace file walk shared by the init
 * and CLAUDE.md scans. The walk is synchronous (it runs on the /doctor and tool paths), so the caps
 * are what make it genuinely bounded on a pathological tree - not just the ignore pruning.
 */
import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";

/**
 * Directories pruned from every context workspace walk (VCS, deps, build output, generated).
 * Single-segment names (e.g. `node_modules`) prune a directory of that basename at ANY depth;
 * multi-segment entries (e.g. `.trevor/generated`) prune by relative-path prefix from the walk root.
 */
export const CONTEXT_IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".trevor/generated",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

/** Deepest directory nesting the walk descends below the root before pruning. */
export const MAX_CONTEXT_WALK_DEPTH = 20;

/** Total directory entries (files + dirs) the walk examines before stopping. */
export const MAX_CONTEXT_WALK_ENTRIES = 25_000;

/** Test-facing overrides for the walk bounds; production callers use the defaults. */
export interface WalkContextOptions {
  readonly maxDepth?: number;
  readonly maxEntries?: number;
}

// The ignore policy, split once by shape: bare names prune by basename anywhere; path entries prune
// by root-relative prefix. (The old segment-split matcher could never match a multi-segment entry,
// so `.trevor/generated` was silently walked despite being listed.)
const IGNORED_NAMES = new Set([...CONTEXT_IGNORED_DIRS].filter((entry) => !entry.includes("/")));
const IGNORED_PREFIXES = [...CONTEXT_IGNORED_DIRS].filter((entry) => entry.includes("/"));

/** Whether a directory is pruned: its basename is an ignored name, or its root-relative path sits
 *  at/under an ignored multi-segment prefix. */
function isIgnoredDir(root: string, dir: string): boolean {
  if (IGNORED_NAMES.has(basename(dir))) {
    return true;
  }
  const rel = relative(root, dir);
  return IGNORED_PREFIXES.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
}

/**
 * Recursively walks a workspace tree from `root`, pruning the shared {@link CONTEXT_IGNORED_DIRS} and
 * stopping at the depth/entry caps, and returns the sorted absolute paths of files matching `accept`
 * (every file when omitted). The ONE owner of the ignore policy + bounded prune-traversal that both
 * the AGENTS.md init scan and the CLAUDE.md migration scan need - each passes only its own basename
 * filter, so adding an ignored dir is one edit here.
 */
export function walkContextTree(
  root: string,
  accept?: (name: string) => boolean,
  opts: WalkContextOptions = {},
): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const maxDepth = opts.maxDepth ?? MAX_CONTEXT_WALK_DEPTH;
  let budget = opts.maxEntries ?? MAX_CONTEXT_WALK_ENTRIES;
  const files: string[] = [];
  const visit = (dir: string, depth: number): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (budget <= 0) {
        return; // entry cap: stop examining anything further (bounded, never unbounded)
      }
      budget -= 1;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth && !isIgnoredDir(root, path)) {
          visit(path, depth + 1);
        }
      } else if (entry.isFile() && (!accept || accept(entry.name))) {
        files.push(path);
      }
    }
  };
  visit(root, 0);
  return files.sort();
}
