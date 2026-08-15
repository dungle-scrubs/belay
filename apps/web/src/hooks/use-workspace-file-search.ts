import {
  decodeTrevorEvent,
  type FileMatch,
  type SessionEvent,
  searchWorkspaceFiles,
} from "@belay/session";
import { useDebounce } from "ahooks";
import { useMemo, useRef } from "react";

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

/** The latest `file.index.result` event in `events` (last one wins), or null if none has arrived. */
function latestFileIndexEvent(events: readonly SessionEvent[]): SessionEvent | null {
  let latest: SessionEvent | null = null;
  for (const event of events) {
    if (event.type === "file.index.result") {
      latest = event;
    }
  }
  return latest;
}

/**
 * The latest workspace file index the host announced in this session - a later `file.index.result`
 * supersedes an earlier one (so a refresh's newer answer wins over a stale one). Only decodes the
 * (rare) result events, not the whole log. Returns a not-ready empty index until the host answers.
 *
 * A fresh call always builds a NEW object (even when the source event hasn't changed) - fine for a
 * one-off read, but unsafe to call straight from a component's render (see {@link useFileIndex}).
 */
export function fileIndexFrom(events: readonly SessionEvent[]): WorkspaceFileIndex {
  const latest = latestFileIndexEvent(events);
  if (!latest) {
    return EMPTY_INDEX;
  }
  const decoded = decodeTrevorEvent(latest);
  if (decoded?.type !== "file.index.result") {
    return EMPTY_INDEX;
  }
  return { files: decoded.files, truncated: decoded.truncated, ready: true };
}

/**
 * The render-safe variant of {@link fileIndexFrom}: returns the SAME `WorkspaceFileIndex` object
 * across renders as long as the latest `file.index.result` event is unchanged, even though `events`'
 * array identity changes on every incoming session event (a streaming delta, a tool call, ...) - not
 * just on a new index result. Without this, a consumer's `useMemo`/`useCallback` keyed on the index
 * (e.g. {@link useWorkspaceFileSearch}) would falsely invalidate on every unrelated event while a
 * mention menu is open, independently of any debounce.
 */
export function useFileIndex(events: readonly SessionEvent[]): WorkspaceFileIndex {
  const lastEventRef = useRef<SessionEvent | null>(null);
  const lastIndexRef = useRef<WorkspaceFileIndex>(EMPTY_INDEX);
  const latest = latestFileIndexEvent(events);
  if (latest !== lastEventRef.current) {
    lastEventRef.current = latest;
    lastIndexRef.current = latest ? fileIndexFrom(events) : EMPTY_INDEX;
  }
  return lastIndexRef.current;
}

export interface WorkspaceFileSearch {
  readonly results: readonly FileMatch[];
  /** True when the visible slice is incomplete (the search hit its cap OR the host index was capped). */
  readonly truncated: boolean;
}

const EMPTY_SEARCH: WorkspaceFileSearch = { results: [], truncated: false };

/**
 * Fuzzy-searches the workspace `index` for the active mention `query`, debounced and capped. A null
 * query (no active mention) yields no results. Results always derive from the current settled query,
 * so a slower keystroke can never surface stale matches for an older query.
 *
 * The expensive search is memoized ONLY on the settled `debouncedQuery` (+ `index`/`cap`) - `query`
 * itself must NOT be a memo dependency, or every keystroke would invalidate the memo before the
 * debounce ever gets a chance to coalesce them, defeating the whole point of debouncing. The
 * null-query short-circuit is handled OUTSIDE the memo for the same reason: it must not make the memo
 * depend on `query`.
 */
export function useWorkspaceFileSearch(
  query: string | null,
  index: WorkspaceFileIndex,
  cap: number = FILE_MENTION_RESULT_CAP,
): WorkspaceFileSearch {
  const debouncedQuery = useDebounce(query ?? "", { wait: 80 });
  const searched = useMemo(
    () => searchWorkspaceFiles(index.files, debouncedQuery, cap),
    [debouncedQuery, index, cap],
  );
  if (query === null) {
    return EMPTY_SEARCH;
  }
  return { results: searched.matches, truncated: searched.truncated || index.truncated };
}
