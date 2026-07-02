import { loadJsonConfig, writeJsonConfig } from "@host/boot/config";
import { USER_STYLE_JSON } from "@host/boot/paths";
import { DEFAULT_STYLE_ID, findStyle, resolveStyle } from "./styles";

/**
 * The active output-style preference store (plan 03, M5). The selected style id persists as a small
 * `{ activeStyle }` JSON under the config home (`<TREVOR_HOME>/style.json`), the approved Trevor settings
 * root - portable, separate from provider/model/reasoning preferences. Read at turn start for run
 * attribution; written when `/style` selects a style. An unknown / retired / missing id falls back to the
 * built-in default (and is reported as `source: "default"`). Read/write are injectable so the store is
 * unit-tested without touching disk.
 *
 * Responsible for: persisting + caching the active output-style preference (style.json).
 * Not for: style metadata and /style argument handling - styles.ts.
 */

export interface StylePreference {
  /** The resolved active style id (always a real built-in style). */
  readonly activeStyle: string;
  /** Where it came from: a valid user file, or the default fallback (missing/unknown/malformed). */
  readonly source: "user" | "default";
}

const DEFAULT_PREF: StylePreference = { activeStyle: DEFAULT_STYLE_ID, source: "default" };

/** Parses a raw `style.json` value to a preference, falling back to default for a missing/unknown id. */
export function parseStylePref(raw: unknown): StylePreference {
  if (raw && typeof raw === "object") {
    const id = (raw as { activeStyle?: unknown }).activeStyle;
    if (typeof id === "string" && findStyle(id)) {
      return { activeStyle: id, source: "user" };
    }
  }
  return DEFAULT_PREF;
}

/** Reads the active style preference (missing/malformed -> the default), through the shared config-file
 *  scaffold. `read` is injectable for tests. */
export function loadStylePref(
  path: string = USER_STYLE_JSON,
  read?: (p: string) => string,
): StylePreference {
  return loadJsonConfig(path, parseStylePref, DEFAULT_PREF, read);
}

/** Persists the active style id, creating the config dir as needed. Clears the per-turn cache so the
 *  next turn (and `/doctor`) sees the new style without a host restart. */
export function saveStylePref(
  styleId: string,
  path: string = USER_STYLE_JSON,
  write?: (p: string, content: string) => void,
): void {
  writeJsonConfig(path, { activeStyle: styleId }, write);
  cache = undefined;
}

/**
 * The active style preference, read once and cached for the host's lifetime so the per-step system-prompt
 * build never re-reads disk. {@link saveStylePref} clears the cache on a `/style` change, so a selection
 * takes effect on the next turn without a restart.
 */
let cache: StylePreference | undefined;

export function activeStylePref(): StylePreference {
  if (cache === undefined) {
    cache = loadStylePref();
  }
  return cache;
}

/** The active style's presentation-only response-shape guidance (empty for the default style), threaded
 *  into the system prompt. Reads through the cache. */
export function activeStyleGuidance(): string {
  return resolveStyle(activeStylePref().activeStyle).guidance;
}
