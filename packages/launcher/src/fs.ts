import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The small synchronous filesystem the launcher needs, as an interface so every module that touches
 * local state (the project map, host ownership records, the per-session lock) is pure over it and the
 * tests drive it with an in-memory fake. Sync is deliberate: the launcher is a short-lived CLI, so
 * sync fs keeps the orchestration linear and the tests trivial.
 */
export interface LauncherFs {
  /** File contents, or null when the path does not exist / is unreadable. */
  readFile(path: string): string | null;
  /** Writes the file, creating parent directories as needed. */
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  remove(path: string): void;
}

/** The real node-backed filesystem. */
export const nodeFs: LauncherFs = {
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  writeFile(path, content) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  },
  exists(path) {
    return existsSync(path);
  },
  remove(path) {
    try {
      rmSync(path, { force: true });
    } catch {
      // already gone
    }
  },
};

/** Parses JSON from a file, returning a fallback for missing/malformed content (never throws). */
export function readJson<T>(fs: LauncherFs, path: string, fallback: T): T {
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

/** Writes a value as pretty JSON. */
export function writeJson(fs: LauncherFs, path: string, value: unknown): void {
  fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
