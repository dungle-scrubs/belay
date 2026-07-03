/**
 * Responsible for: the durable per-project record of CLAUDE.md files the user chose to ignore
 * PERMANENTLY, so a converted-or-declined file is never re-proposed across sessions (M5.4 / D-010).
 * Not for: pointer idempotence (that lives in the file itself, claude-migration.ts) or the one-off
 * "ignore once" action (which records nothing).
 *
 * State home: a single `claude-migration-ignores.json` under TREVOR_STATE_HOME (the storage taxonomy's
 * `state` category, registered in STORAGE_INVENTORY), keyed by absolute project root -> the
 * workspace-relative CLAUDE.md paths to skip. Backed by the shared JSON config scaffold
 * (boot/config.ts): reads never create the file and a corrupt store degrades to empty with a warning;
 * writes ride the shared atomic temp-write + rename and are skipped when the merged set is unchanged.
 */
import { resolve } from "node:path";
import { loadJsonConfig, writeJsonConfig } from "@host/boot/config";
import { storagePathByName } from "@trevor/session/node-paths";

type IgnoreStore = Readonly<Record<string, readonly string[]>>;

/** The default store path from the storage inventory; overridable for tests. */
export function ignoresStorePath(): string {
  return storagePathByName("claude-migration-ignores");
}

/** Decode the parsed store JSON, dropping anything that is not a string[] per project root. */
function parseStore(raw: unknown): IgnoreStore {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, readonly string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      out[key] = value.filter((item): item is string => typeof item === "string");
    }
  }
  return out;
}

function readStore(file: string): IgnoreStore {
  return loadJsonConfig(file, parseStore, {});
}

/** The set of workspace-relative CLAUDE.md paths permanently ignored for `projectRoot`. */
export function loadPermanentlyIgnored(
  projectRoot: string,
  file: string = ignoresStorePath(),
): ReadonlySet<string> {
  return new Set(readStore(file)[resolve(projectRoot)] ?? []);
}

/**
 * Record `claudePaths` as permanently ignored for `projectRoot` (deduped, idempotent, persisted
 * atomically). Returns whether a write happened - an add whose paths are all already recorded skips
 * the write entirely, so a re-run never churns the store file.
 */
export function addPermanentlyIgnored(
  projectRoot: string,
  claudePaths: readonly string[],
  file: string = ignoresStorePath(),
): boolean {
  if (claudePaths.length === 0) {
    return false;
  }
  const key = resolve(projectRoot);
  const store = readStore(file);
  const existing = store[key] ?? [];
  const merged = new Set([...existing, ...claudePaths]);
  if (merged.size === existing.length) {
    return false; // every path already recorded - nothing to persist
  }
  writeJsonConfig(file, { ...store, [key]: [...merged].sort() });
  return true;
}
