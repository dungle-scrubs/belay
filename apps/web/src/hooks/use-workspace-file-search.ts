import {
  decodeTrevorEvent,
  type FileMatch,
  type SessionEvent,
  searchWorkspaceFiles,
} from "@trevor/session";
import { useDebounce } from "ahooks";
import { useMemo } from "react";

/**
 * The browser side of the `@`-file-mention search (plan 30, decision D-004): the host answers ONE
 * `file.index.requested` per session with the workspace file index; this module derives that read
 * model from the stream and fuzzy-filters it LOCALLY per keystroke, so no per-keystroke traffic hits
 * the durable log. Filtering is pure (`searchWorkspaceFiles` over paths only), debounced so a large
 * index is not re-ranked on every keystroke, and always derived from the settled query so a stale
 * query can never overwrite a newer one.
 */

/** The cap on the file-mention menu's visible matches (the search reports truncation past it). */
export const FILE_MENTION_RESULT_CAP = 30;

export interface WorkspaceFileIndex {
  readonly files: readonly FileMatch[];
  /** True when the host capped the workspace index, so even a broad search cannot see every file. */
  readonly truncated: boolean;
  /** True once the host has answered at least one index request (else the menu shows "loading"). */
  readonly ready: boolean;
}

const EMPTY_INDEX: WorkspaceFileIndex = { files: [], truncated: false, ready: false };

/**
 * The latest workspace file index the host announced in this session - a later `file.index.result`
 * supersedes an earlier one (so a refresh's newer answer wins over a stale one). Only decodes the
 * (rare) result events, not the whole log. Returns a not-ready empty index until the host answers.
 */
export function fileIndexFrom(events: readonly SessionEvent[]): WorkspaceFileIndex {
  let latest: WorkspaceFileIndex = EMPTY_INDEX;
  for (const event of events) {
    if (event.type !== "file.index.result") {
      continue;
    }
    const decoded = decodeTrevorEvent(event);
    if (decoded?.type === "file.index.result") {
      latest = { files: decoded.files, truncated: decoded.truncated, ready: true };
    }
  }
  return latest;
}

export interface WorkspaceFileSearch {
  readonly results: readonly FileMatch[];
  /** True when the visible slice is incomplete (the search hit its cap OR the host index was capped). */
  readonly truncated: boolean;
}

/**
 * Fuzzy-searches the workspace `index` for the active mention `query`, debounced and capped. A null
 * query (no active mention) yields no results. Results always derive from the current settled query,
 * so a slower keystroke can never surface stale matches for an older query.
 */
export function useWorkspaceFileSearch(
  query: string | null,
  index: WorkspaceFileIndex,
  cap: number = FILE_MENTION_RESULT_CAP,
): WorkspaceFileSearch {
  const debouncedQuery = useDebounce(query ?? "", { wait: 80 });
  return useMemo(() => {
    if (query === null) {
      return { results: [], truncated: false };
    }
    const { matches, truncated } = searchWorkspaceFiles(index.files, debouncedQuery, cap);
    return { results: matches, truncated: truncated || index.truncated };
  }, [query, debouncedQuery, index, cap]);
}
