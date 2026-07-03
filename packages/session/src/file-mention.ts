/**
 * The file-mention contract (plan 30): a workspace file surfaced by the composer's `@`-mention
 * picker. The host PRODUCES matches (workspace-confined path enumeration); the web composer RENDERS
 * them and, on selection, inserts a visible `@`-prefixed mention into the draft. Both surfaces share
 * this one wire type + the pure path helpers so a basename/directory rendering can never drift from
 * the path the host sent. Only the format + pure helpers live here; the composer's menu state, key
 * handling, and insertion stay web-side (like image-tokens keeps its editing model web-side).
 */

/** A workspace file match for the `@`-mention picker: a workspace-relative POSIX path only. */
export interface FileMatch {
  /** Workspace-relative POSIX path, e.g. "apps/web/src/app.tsx". Never absolute, never `../`-escaping. */
  readonly path: string;
}

/** A path split into its basename and (trailing-slash-free) directory portion. */
export interface PathParts {
  readonly basename: string;
  /** The directory portion WITHOUT a trailing slash, or "" for a root-level file. */
  readonly dir: string;
}

/** Splits a workspace-relative path into `{ basename, dir }` on POSIX `/`. Root files have `dir: ""`. */
export function splitWorkspacePath(path: string): PathParts {
  const slash = path.lastIndexOf("/");
  if (slash === -1) {
    return { basename: path, dir: "" };
  }
  return { basename: path.slice(slash + 1), dir: path.slice(0, slash) };
}

/** The visible mention text inserted into the draft for a selected file: `@` + the workspace path. */
export function fileMentionText(path: string): string {
  return `@${path}`;
}
