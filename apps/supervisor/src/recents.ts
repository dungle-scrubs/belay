import { type LauncherFs, loadProjectMap } from "@belay/launcher";
import type { SupervisorProject } from "@belay/session";

/**
 * The supervisor's recent-projects reader (plan 44.1): the launcher-owned `projects.json` (root ->
 * session map), returned to the browser recency-sorted (newest `updatedAt` first) for the "open a
 * recent project" list. It REUSES the launcher's `loadProjectMap` rather than re-parsing the file, so
 * the registry has one reader; an absent/unreadable registry yields an empty list (never throws). ISO
 * `updatedAt` strings sort lexicographically = chronologically, so no date parsing is needed.
 */
export function readRecents(fs: LauncherFs, home: string): SupervisorProject[] {
  return Object.values(loadProjectMap(fs, home))
    .map((record) => ({
      root: record.root,
      sessionId: record.sessionId,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}
