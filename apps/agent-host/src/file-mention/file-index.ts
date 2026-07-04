/**
 * Responsible for: building the workspace file INDEX the `@`-file-mention picker searches - the
 * ignore-aware, depth/entry-capped list of workspace-relative POSIX paths. It is the host's
 * file-search primitive: the browser requests it once per session (durable request/result) and
 * fuzzy-filters it locally (see `@trevor/session` file-mention). Built over an INJECTED walk seam so
 * it is unit-testable without a real tree, and confined to the workspace root (relative paths only,
 * no `..` escape ever reaches the browser).
 * Not for: the fuzzy scoring/ranking (shared + browser-side in `@trevor/session`), the durable
 * protocol wiring (main.ts), or reading file contents (paths only).
 */
import { relative, sep } from "node:path";
import { WORKSPACE_ROOT } from "@host/boot/paths";
import { walkContextTree } from "@host/project-context/walk";
import { type FileMatch, isWorkspaceRelativePath, MAX_FILE_INDEX } from "@trevor/session";

export { MAX_FILE_INDEX };

/** Converts an OS path to POSIX separators, so the wire + browser always see `/`. */
function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

export interface FileIndex {
  readonly files: readonly FileMatch[];
  /** True when the workspace holds more files than the cap, so the searchable slice is incomplete. */
  readonly truncated: boolean;
}

export interface BuildFileIndexOptions {
  readonly root?: string;
  readonly cap?: number;
  /** Injected walk over the tree (absolute file paths); defaults to the shared bounded workspace walk
   *  (`walkContextTree`), which prunes the ignored dirs and is depth/entry capped. */
  readonly walk?: (root: string) => Iterable<string>;
}

/**
 * Walks the workspace once, relativizes to POSIX, drops anything escaping the root, de-dupes, sorts,
 * and caps. The ignore policy + bounded traversal come from the injected walk (the shared
 * `walkContextTree` by default), so this owns only the relative-path + confinement + cap shaping.
 */
export function buildFileIndex(options: BuildFileIndexOptions = {}): FileIndex {
  const root = options.root ?? WORKSPACE_ROOT;
  const cap = options.cap ?? MAX_FILE_INDEX;
  const walk = options.walk ?? ((r: string) => walkContextTree(r));
  const relativePaths = new Set<string>();
  for (const absolute of walk(root)) {
    const rel = toPosix(relative(root, absolute));
    // Confinement: never surface the root itself or a path that escapes it (`..`), so the browser
    // only ever sees a workspace-relative path - the write-side analogue of the tools' `confine()`.
    // The shared predicate (also applied at decode time) so "escaping" can't drift between the sides.
    if (!isWorkspaceRelativePath(rel)) {
      continue;
    }
    relativePaths.add(rel);
  }
  const sorted = [...relativePaths].sort();
  return {
    files: sorted.slice(0, cap).map((path) => ({ path })),
    truncated: sorted.length > cap,
  };
}
