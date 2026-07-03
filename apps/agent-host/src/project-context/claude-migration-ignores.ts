/**
 * Responsible for: the durable per-project record of CLAUDE.md files the user chose to ignore
 * PERMANENTLY, so a converted-or-declined file is never re-proposed across sessions (M5.4 / D-010).
 * Not for: pointer idempotence (that lives in the file itself, claude-migration.ts) or the one-off
 * "ignore once" action (which records nothing).
 *
 * State home: a single `claude-migration-ignores.json` under TREVOR_STATE_HOME (the storage taxonomy's
 * `state` category, registered in STORAGE_INVENTORY), keyed by absolute project root -> the
 * workspace-relative CLAUDE.md paths to skip. Reads never create the file; writes are best-effort and a
 * corrupt store degrades to empty rather than failing a turn.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { storagePathByName } from "@trevor/session/node-paths";

type IgnoreStore = Record<string, readonly string[]>;

/** The default store path from the storage inventory; overridable for tests. */
export function ignoresStorePath(): string {
  return storagePathByName("claude-migration-ignores");
}

function readStore(file: string): IgnoreStore {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as IgnoreStore;
  } catch {
    return {};
  }
}

/** The set of workspace-relative CLAUDE.md paths permanently ignored for `projectRoot`. */
export function loadPermanentlyIgnored(
  projectRoot: string,
  file: string = ignoresStorePath(),
): ReadonlySet<string> {
  const key = resolve(projectRoot);
  const entry = readStore(file)[key];
  return new Set(Array.isArray(entry) ? entry : []);
}

/** Record `claudePaths` as permanently ignored for `projectRoot` (deduped, idempotent, persisted). */
export function addPermanentlyIgnored(
  projectRoot: string,
  claudePaths: readonly string[],
  file: string = ignoresStorePath(),
): void {
  if (claudePaths.length === 0) {
    return;
  }
  const key = resolve(projectRoot);
  const store = readStore(file);
  const merged = new Set([...(store[key] ?? []), ...claudePaths]);
  const next: IgnoreStore = { ...store, [key]: [...merged].sort() };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}
