import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { warn } from "./log";

/**
 * The shared scaffold for the host's small optional JSON config files under the config home (models.json,
 * style.json, ...), so each one stops re-spelling the same read/parse/warn and mkdir+write. Pure over the
 * injected `read`/`write` capabilities, so a load/save is unit-tested without touching disk.
 */

/**
 * Reads + parses an optional JSON config file. A missing/unreadable file yields `fallback` silently; a
 * present-but-malformed file warns once and falls back, never crashing the host on a typo. `parse` is a
 * pure decoder over the parsed JSON value.
 */
export function loadJsonConfig<T>(
  path: string,
  parse: (raw: unknown) => T,
  fallback: T,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): T {
  let text: string;
  try {
    text = read(path);
  } catch {
    return fallback; // no file (the common case)
  }
  try {
    return parse(JSON.parse(text));
  } catch (error) {
    warn("config", "config file present but not valid JSON; using default", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}

/** Writes a value as pretty JSON (trailing newline), creating the parent directory as needed. */
export function writeJsonConfig(
  path: string,
  value: unknown,
  write: (p: string, content: string) => void = (p, c) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, c);
  },
): void {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}
