import { join } from "node:path";
import { idSlug, shortHash } from "@belay/session";

/**
 * The Belay-managed worktree registry (D-091): persistent bookkeeping for worktrees Belay
 * creates under `<state-home>/.worktrees/<repo-hash>/<branch-slug>-<id>`, grouped by base repo.
 * Pure over an injected `WorktreeFs` so every branch (load, add, reconcile stale paths, group)
 * is unit-tested with an in-memory fake. The base-repo identity is the realpath'd repo root,
 * hashed - so the same repo reached by a different spelling, a symlink, or a nested cwd groups
 * to ONE bucket, and the on-disk directory names never leak the full project path.
 *
 * Responsible for: persisting worktree records + the grouped/hashed on-disk path layout.
 * Not for: running git or lifecycle decisions - git.ts / manager.ts own those.
 */

/** The small synchronous filesystem the registry needs (mirrors the launcher's seam). */
export interface WorktreeFs {
  readFile(path: string): string | null;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
}

/** A worktree's lifecycle state. "active" is live; "archived" is retained but not offered. */
export type WorktreeState = "active" | "archived";

/** One Belay-managed worktree record. */
export interface WorktreeRecord {
  readonly id: string;
  /** Canonical (realpath'd) base repo root - the stable identity, spelling/symlink-independent. */
  readonly baseRepo: string;
  /** Base repo basename, for display + grouping. */
  readonly baseRepoName: string;
  /** The managed worktree directory. */
  readonly worktreePath: string;
  readonly branch: string;
  /** The commit the worktree branched from. */
  readonly baseCommit: string;
  /** The latest known commit on the worktree, when read. */
  readonly currentCommit?: string;
  /** The durable Belay session bound to this worktree. */
  readonly sessionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: WorktreeState;
}

const registryPath = (home: string): string => join(home, ".worktrees", "registry.json");

/** The grouped on-disk root for a base repo's managed worktrees (hashed, never the full path). */
export function repoWorktreesDir(home: string, baseRepo: string): string {
  return join(home, ".worktrees", shortHash(baseRepo));
}

/** A filesystem-safe slug for a branch name (`feat/x` -> `feat-x`), via the shared slug owner. */
export function branchSlug(branch: string): string {
  return idSlug(branch, "wt");
}

/** The path a new worktree for `branch` in `baseRepo` with `id` lives at (grouped + slugged). */
export function worktreePathFor(
  home: string,
  baseRepo: string,
  branch: string,
  id: string,
): string {
  return join(repoWorktreesDir(home, baseRepo), `${branchSlug(branch)}-${id}`);
}

/** Parses JSON from a `WorktreeFs` file, returning `fallback` for missing/malformed content (never
 *  throws). Shared by the worktree registry and the serial-run journal (the two host JSON registries). */
export function readJson<T>(fs: WorktreeFs, path: string, fallback: T): T {
  const raw = fs.readFile(path);
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Writes a value as pretty JSON (trailing newline) to a `WorktreeFs` path. */
export function writeJson(fs: WorktreeFs, path: string, value: unknown): void {
  fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** The persisted id→record map, or {} when none / unreadable. Malformed entries are dropped. */
export function loadWorktrees(fs: WorktreeFs, home: string): Record<string, WorktreeRecord> {
  const raw = readJson<Record<string, WorktreeRecord>>(fs, registryPath(home), {});
  const out: Record<string, WorktreeRecord> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      value &&
      typeof value.id === "string" &&
      typeof value.worktreePath === "string" &&
      typeof value.baseRepo === "string"
    ) {
      out[key] = value;
    }
  }
  return out;
}

/** Records (or replaces) a worktree by id. */
export function saveWorktree(fs: WorktreeFs, home: string, record: WorktreeRecord): void {
  const all = loadWorktrees(fs, home);
  all[record.id] = record;
  writeJson(fs, registryPath(home), all);
}

/** Drops a worktree record by id (registry only - the directory removal is the git layer's job). */
export function removeWorktreeRecord(fs: WorktreeFs, home: string, id: string): void {
  const all = loadWorktrees(fs, home);
  if (all[id]) {
    delete all[id];
    writeJson(fs, registryPath(home), all);
  }
}

/** An active worktree record annotated with whether its on-disk path still exists. */
export interface WorktreeView extends WorktreeRecord {
  /** True when the recorded worktree directory is gone (a stale entry needing reconcile). */
  readonly missing: boolean;
}

/**
 * The active worktrees as views, each flagged `missing` when its directory no longer exists, so a
 * deleted-on-disk worktree surfaces as a stale entry rather than silently vanishing or throwing.
 * Archived records are excluded. Tolerant of a missing/empty registry (returns []).
 */
export function listWorktrees(fs: WorktreeFs, home: string): WorktreeView[] {
  return Object.values(loadWorktrees(fs, home))
    .filter((r) => r.status === "active")
    .map((r) => ({ ...r, missing: !fs.exists(r.worktreePath) }));
}

/** The active worktrees for one base repo (by canonical identity), each with its `missing` flag. */
export function worktreesForRepo(fs: WorktreeFs, home: string, baseRepo: string): WorktreeView[] {
  return listWorktrees(fs, home).filter((r) => r.baseRepo === baseRepo);
}
