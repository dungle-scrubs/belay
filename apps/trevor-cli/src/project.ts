import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { projectSessionId } from "@trevor/session";
import { type LauncherFs, readJson, writeJson } from "./fs";

/**
 * Project identity for the launcher (D-085): resolve the project root from cwd, derive its stable
 * session id, and persist the root→session mapping so the same project always reopens the same
 * session. Pure over an injected `LauncherFs` so root-walking and mapping persistence are unit-tested
 * without touching the real disk.
 */

/**
 * `~/.trevorV2` (or `$TREVOR_HOME`) - the same base directory the host's `paths.ts` uses. Duplicated
 * here (a one-liner) rather than imported, so the launcher does not depend on the host package, and so
 * the browser-bundled `@trevor/session` stays free of node built-ins (D-041); the env convention is
 * the shared contract.
 */
export const TREVOR_HOME = resolve(process.env.TREVOR_HOME ?? join(homedir(), ".trevorV2"));

/**
 * Resolves the project root as the nearest ancestor (from cwd up) that contains a `.git` marker - a
 * git worktree's root holds `.git` (a directory for a normal clone, a file for a linked worktree), so
 * `exists(join(dir, ".git"))` finds it either way. Falls back to cwd when no git root exists above it.
 */
export function resolveProjectRoot(cwd: string, fs: LauncherFs): string {
  let dir = resolve(cwd);
  for (;;) {
    if (fs.exists(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return resolve(cwd); // reached the filesystem root with no .git: use cwd
    }
    dir = parent;
  }
}

/** One persisted project→session record (the mapping plus light provenance). */
export interface ProjectRecord {
  readonly root: string;
  readonly sessionId: string;
  readonly updatedAt: string;
}

const projectsPath = (home: string): string => join(home, "projects.json");

/** The persisted root→session map (keyed by canonical root), or {} when none / unreadable. */
export function loadProjectMap(fs: LauncherFs, home: string): Record<string, ProjectRecord> {
  const raw = readJson<Record<string, ProjectRecord>>(fs, projectsPath(home), {});
  // Keep only well-formed entries (defensive against a hand-edited / partial file).
  const out: Record<string, ProjectRecord> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value && typeof value.sessionId === "string" && typeof value.root === "string") {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Resolves the session id for a project root: the persisted mapping if one exists (so an id, once
 * chosen, is reused verbatim - the seam an explicit `--session` override later writes through), else
 * the deterministic derivation, which is then remembered. Either way reopening the same root yields
 * the same session.
 */
export function resolveSession(fs: LauncherFs, home: string, root: string, now: string): string {
  const map = loadProjectMap(fs, home);
  const existing = map[root];
  if (existing) {
    return existing.sessionId;
  }
  const sessionId = projectSessionId(root);
  map[root] = { root, sessionId, updatedAt: now };
  writeJson(fs, projectsPath(home), map);
  return sessionId;
}
