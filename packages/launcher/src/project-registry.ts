import { basename, join } from "node:path";
import { abbreviateHome } from "@trevor/session/node-paths";
import { type LauncherFs, readJson, writeJson } from "./fs";
import { loadProjectMap } from "./project";

/**
 * Project registry (plan 58): canonical-path-keyed project metadata - display name, collapsed state,
 * and timestamps - with NO session ids. This replaces the old one-root-one-session `projects.json`
 * model (`project.ts`) as the primary source of project metadata. The legacy file is kept as a backup
 * and read only for migration.
 *
 * Pure over an injected `LauncherFs` so registry persistence is unit-tested without real disk. Stored
 * under `TREVOR_STATE_HOME` (machine-local runtime state), not the config dir.
 */

/** One persisted project record: metadata only, never a session id. */
export interface ProjectRegistryRecord {
  /** Canonical absolute path - the registry key. */
  readonly path: string;
  /** User-friendly absolute or home-shortened path. */
  readonly displayPath: string;
  /** Defaults to basename; user-renamable. */
  readonly displayName: string;
  /** Whether the project is collapsed in the sidebar. */
  readonly collapsed: boolean;
  /** ISO timestamp of first registration. */
  readonly createdAt: string;
  /** ISO timestamp of last modification. */
  readonly updatedAt: string;
}

/** Shape of the on-disk JSON (path -> record). */
type RegistryJson = Record<string, ProjectRegistryRecord>;

/** The registry file path under the state home. */
export function projectRegistryPath(stateHome: string): string {
  return join(stateHome, "project-registry.json");
}

/**
 * Reads the registry JSON into a Map keyed by canonical path. Returns an empty map when the file is
 * absent or malformed (never throws). Malformed entries (missing required string fields) are dropped.
 */
export function loadProjectRegistry(
  fs: LauncherFs,
  stateHome: string,
): Map<string, ProjectRegistryRecord> {
  const raw = readJson<RegistryJson>(fs, projectRegistryPath(stateHome), {});
  const out = new Map<string, ProjectRegistryRecord>();
  for (const [key, value] of Object.entries(raw)) {
    if (isWellFormed(value) && value.path === key) {
      out.set(key, value);
    }
  }
  return out;
}

/** Writes the registry Map as pretty JSON. */
export function saveProjectRegistry(
  fs: LauncherFs,
  stateHome: string,
  registry: Map<string, ProjectRegistryRecord>,
): void {
  const obj: RegistryJson = {};
  for (const [key, value] of registry) {
    obj[key] = value;
  }
  writeJson(fs, projectRegistryPath(stateHome), obj);
}

/**
 * Adds a project, or bumps `updatedAt` if it already exists (preserving `createdAt` and any
 * user-set `displayName`/`collapsed`). Returns the record. Uses `abbreviateHome` for `displayPath`
 * and `basename` for the default `displayName`.
 */
export function addProject(
  fs: LauncherFs,
  stateHome: string,
  path: string,
  now: string,
  home: string,
): ProjectRegistryRecord {
  const registry = loadProjectRegistry(fs, stateHome);
  const existing = registry.get(path);
  const record: ProjectRegistryRecord = {
    path,
    displayPath: abbreviateHome(path, home),
    displayName: existing?.displayName ?? basename(path),
    collapsed: existing?.collapsed ?? false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  registry.set(path, record);
  saveProjectRegistry(fs, stateHome, registry);
  return record;
}

/**
 * Bumps `updatedAt` on an existing project, or adds it if missing. Returns the record.
 */
export function touchProject(
  fs: LauncherFs,
  stateHome: string,
  path: string,
  now: string,
  home: string,
): ProjectRegistryRecord {
  return addProject(fs, stateHome, path, now, home);
}

/**
 * Sets `displayName` and bumps `updatedAt`. Returns the record, or null if the path is not in the
 * registry.
 */
export function renameProject(
  fs: LauncherFs,
  stateHome: string,
  path: string,
  displayName: string,
  now: string,
): ProjectRegistryRecord | null {
  const registry = loadProjectRegistry(fs, stateHome);
  const existing = registry.get(path);
  if (!existing) {
    return null;
  }
  const record: ProjectRegistryRecord = { ...existing, displayName, updatedAt: now };
  registry.set(path, record);
  saveProjectRegistry(fs, stateHome, registry);
  return record;
}

/**
 * Sets `collapsed` and bumps `updatedAt`. Returns the record, or null if the path is not in the
 * registry.
 */
export function setCollapsed(
  fs: LauncherFs,
  stateHome: string,
  path: string,
  collapsed: boolean,
  now: string,
): ProjectRegistryRecord | null {
  const registry = loadProjectRegistry(fs, stateHome);
  const existing = registry.get(path);
  if (!existing) {
    return null;
  }
  const record: ProjectRegistryRecord = { ...existing, collapsed, updatedAt: now };
  registry.set(path, record);
  saveProjectRegistry(fs, stateHome, registry);
  return record;
}

/**
 * Deletes the record for `path`. Returns true if a record was removed, false if the path was not
 * found.
 */
export function removeProject(fs: LauncherFs, stateHome: string, path: string): boolean {
  const registry = loadProjectRegistry(fs, stateHome);
  if (!registry.has(path)) {
    return false;
  }
  registry.delete(path);
  saveProjectRegistry(fs, stateHome, registry);
  return true;
}

/** Returns all records sorted by `updatedAt` descending (most recent first). */
export function listProjects(fs: LauncherFs, stateHome: string): ProjectRegistryRecord[] {
  const registry = loadProjectRegistry(fs, stateHome);
  return [...registry.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Imports each root from the legacy `projects.json` (read via `loadProjectMap`) into the registry
 * using `addProject`. Idempotent: projects already in the registry are skipped, not duplicated.
 * Does NOT delete `projects.json` (left as a backup). Returns the count imported and skipped.
 */
export function importLegacyProjectMap(
  fs: LauncherFs,
  stateHome: string,
  home: string,
): { imported: number; skipped: number } {
  const legacy = loadProjectMap(fs, home);
  const existing = loadProjectRegistry(fs, stateHome);
  const now = new Date().toISOString();
  let imported = 0;
  let skipped = 0;
  for (const root of Object.keys(legacy)) {
    if (existing.has(root)) {
      skipped++;
      continue;
    }
    const record = legacy[root];
    addProject(fs, stateHome, root, record?.updatedAt || now, home);
    imported++;
  }
  return { imported, skipped };
}

/** Type guard: a record is well-formed when its core string fields are present and string-typed. */
function isWellFormed(value: unknown): value is ProjectRegistryRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.path === "string" &&
    typeof v.displayPath === "string" &&
    typeof v.displayName === "string" &&
    typeof v.collapsed === "boolean" &&
    typeof v.createdAt === "string" &&
    typeof v.updatedAt === "string"
  );
}
