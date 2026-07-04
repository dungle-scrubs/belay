/**
 * The file-mention contract (plan 30): a workspace file surfaced by the composer's `@`-mention
 * picker. The host PRODUCES matches (workspace-confined path enumeration); the web composer RENDERS
 * them and, on selection, inserts a visible `@`-prefixed mention into the draft. Both surfaces share
 * this one wire type + the pure path helpers so a basename/directory rendering can never drift from
 * the path the host sent. Only the format + pure helpers live here; the composer's menu state, key
 * handling, and insertion stay web-side (like image-tokens keeps its editing model web-side).
 *
 * Non-goal (this slice, plan 30): selecting a file inserts a visible PATH REFERENCE only. It never
 * automatically reads or injects the file's contents, and adds no prompt attachment. `fileMentionsIn`
 * derives the structured mentions from the submitted text so a later content-injection plan can decide
 * whether mentions become attachments, context blocks, or tool-detail links - but this cut ships the
 * visible text as an ordinary prompt.
 */

/** A workspace file match for the `@`-mention picker: a workspace-relative POSIX path only. */
export interface FileMatch {
  /** Workspace-relative POSIX path, e.g. "apps/web/src/app.tsx". Never absolute, never `../`-escaping. */
  readonly path: string;
}

/**
 * The cap on a workspace file index: the ONE shared source for both the host's enumeration cap (it
 * never announces more than this many paths) and the wire decoder's re-cap (a malformed or oversized
 * `file.index.result` payload is clamped to the same limit rather than trusted at face value) - so the
 * write side and the read side can never drift on "how many files is too many".
 */
export const MAX_FILE_INDEX = 2000;

/**
 * Whether `path` is safe to treat as workspace-relative: non-empty, not `..` itself, not a
 * parent-escaping `../`-prefixed path, and not absolute (`/`-prefixed). The ONE shared predicate both
 * the host's file-index builder (drops a non-conforming enumerated path) and the wire decoder (drops
 * any path a malformed or malicious event could smuggle in) apply, so "what counts as
 * workspace-relative" can never drift between the write side and the read side.
 */
export function isWorkspaceRelativePath(path: string): boolean {
  return path !== "" && path !== ".." && !path.startsWith("../") && !path.startsWith("/");
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

/** Characters that, like whitespace, count as a safe boundary immediately before an opening `@`. */
const MENTION_OPEN_PUNCTUATION = new Set(["(", "[", "{", "<"]);

/**
 * Whether the position just before `at` is a safe mention boundary: the start of the text, whitespace,
 * or open punctuation. The ONE trigger rule shared by the picker (what opens on an active `@`) and the
 * submit-time derivation (what counts as a mention), so an email or a mid-word `@` is never a mention
 * in either place.
 */
export function isMentionBoundaryBefore(text: string, at: number): boolean {
  if (at <= 0) {
    return true;
  }
  const prev = text[at - 1];
  return prev === undefined || /\s/u.test(prev) || MENTION_OPEN_PUNCTUATION.has(prev);
}

/** A resolved file mention located in a submitted prompt: the visible `@<path>` token span + path. */
export interface FileMention {
  readonly path: string;
  /** The `@` character index (inclusive). */
  readonly start: number;
  /** The index just past the path (exclusive). */
  readonly end: number;
}

/**
 * Derives the structured file mentions from a prompt's visible text: every `@<token>` at a safe
 * boundary whose token `isKnownPath` (a real workspace file). Stateless - derived from the text
 * itself, so the metadata can never drift from what the user sees after edits - and it never invents a
 * mention for an ordinary `@word` or an email. The path-selection slice ships the visible text as the
 * prompt; this derivation is the structured half a later content-injection plan builds on.
 *
 * Intentionally UNUSED in production yet (plan 30 D-004: visible-text-only submission this cut, no
 * protocol slice for mention metadata) - tested and exported as the foundation a later plan wires up,
 * not accidental dead code.
 */
export function fileMentionsIn(
  text: string,
  isKnownPath: (path: string) => boolean,
): FileMention[] {
  const mentions: FileMention[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "@" || !isMentionBoundaryBefore(text, i)) {
      continue;
    }
    let end = i + 1;
    while (end < text.length) {
      const ch = text[end];
      if (ch === undefined || /\s/u.test(ch)) {
        break;
      }
      end += 1;
    }
    const path = text.slice(i + 1, end);
    if (path !== "" && isKnownPath(path)) {
      mentions.push({ path, start: i, end });
    }
  }
  return mentions;
}

/**
 * The index of the first character of `needle` in `haystack` when `needle` is a subsequence of it (its
 * characters appear in order, not necessarily adjacent), or -1. An empty needle matches at 0.
 */
function subsequenceStart(needle: string, haystack: string): number {
  if (needle === "") {
    return 0;
  }
  let n = 0;
  let first = -1;
  for (let h = 0; h < haystack.length && n < needle.length; h += 1) {
    if (haystack[h] === needle[n]) {
      if (first === -1) {
        first = h;
      }
      n += 1;
    }
  }
  return n === needle.length ? first : -1;
}

/**
 * A file's rank for a query: a discrete `tier` (higher is a better kind of match), the match `at`
 * position (earlier is better), and the matched string `length` (shorter, more specific is better).
 * The tiers, best first: exact basename, basename prefix, exact path segment, basename substring, path
 * substring, basename fuzzy subsequence, path fuzzy subsequence. An empty query ranks everything at a
 * neutral tier so the whole (capped) index sorts shortest-full-path-first (by raw character length,
 * not directory depth - a short deep path can outrank a longer root-level file). Content is never read.
 */
interface FileRank {
  readonly tier: number;
  readonly at: number;
  readonly length: number;
}

function rankFile(path: string, query: string): FileRank | null {
  const q = query.toLowerCase();
  const { basename } = splitWorkspacePath(path);
  const base = basename.toLowerCase();
  const full = path.toLowerCase();
  if (q === "") {
    return { tier: 0, at: 0, length: path.length };
  }
  if (base === q) {
    return { tier: 7, at: 0, length: basename.length };
  }
  if (base.startsWith(q)) {
    return { tier: 6, at: 0, length: basename.length };
  }
  if (full.split("/").includes(q)) {
    return { tier: 5, at: full.indexOf(q), length: path.length };
  }
  const baseIndex = base.indexOf(q);
  if (baseIndex !== -1) {
    return { tier: 4, at: baseIndex, length: basename.length };
  }
  const pathIndex = full.indexOf(q);
  if (pathIndex !== -1) {
    return { tier: 3, at: pathIndex, length: path.length };
  }
  const baseFuzzy = subsequenceStart(q, base);
  if (baseFuzzy !== -1) {
    return { tier: 2, at: baseFuzzy, length: basename.length };
  }
  const pathFuzzy = subsequenceStart(q, full);
  if (pathFuzzy !== -1) {
    return { tier: 1, at: pathFuzzy, length: path.length };
  }
  return null;
}

/** Best-first order for two ranked matches: tier, then match position, then length, then path (stable). */
function compareRanked(
  a: { rank: FileRank; path: string },
  b: { rank: FileRank; path: string },
): number {
  return (
    b.rank.tier - a.rank.tier ||
    a.rank.at - b.rank.at ||
    a.rank.length - b.rank.length ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  );
}

/** The result of searching a workspace file index for a query: the ranked, capped matches + a flag. */
export interface FileSearchResult {
  readonly matches: readonly FileMatch[];
  /** True when more files matched than `cap`, so the returned slice is the best-ranked prefix only. */
  readonly truncated: boolean;
}

/**
 * Ranks `index` against `query` and returns the best `cap` matches (see {@link rankFile}). Pure over
 * paths only - no filesystem, no content reads - so it runs in the browser over a host-supplied index.
 * An empty query returns the shortest-path-first index (capped). Reports truncation when matches
 * exceed the cap so the menu can say "more exist, narrow your query".
 */
export function searchWorkspaceFiles(
  index: readonly FileMatch[],
  query: string,
  cap: number,
): FileSearchResult {
  const ranked: { rank: FileRank; path: string; match: FileMatch }[] = [];
  for (const match of index) {
    const rank = rankFile(match.path, query);
    if (rank !== null) {
      ranked.push({ rank, path: match.path, match });
    }
  }
  ranked.sort(compareRanked);
  return {
    matches: ranked.slice(0, cap).map((entry) => entry.match),
    truncated: ranked.length > cap,
  };
}
