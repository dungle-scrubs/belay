import { loadJsonConfig, writeJsonConfig } from "@host/boot/config";
import { USER_MODEL_PREFS_JSON } from "@host/boot/paths";
import {
  decodeModelPreferences,
  EMPTY_PREFERENCES,
  type ModelPreferences,
  type ModelRef,
} from "@trevor/session";

/**
 * The host-owned model-selection preference store (plan 51). The durable DEFAULT model (the one a fresh
 * session starts on) and the FAVORITES (pinned models) persist as a small `{ default, pinned }` JSON
 * under the config home (`<TREVOR_HOME>/model-prefs.json`), the approved Trevor settings root - portable
 * and shared across every session and browser tab talking to this host. Making them host-owned (not a
 * per-browser localStorage blob) is what closes the "reset to qwen" bug: the default survives a machine
 * switch, a cleared browser store, and a fresh session. Read once at startup, announced on `host.online`,
 * and mutated by the set-default / toggle-favorite command; a missing or malformed file loads to the
 * empty preference (reported by the shared config scaffold, never thrown). Read/write are injectable so
 * the store is unit-tested without touching disk.
 *
 * Responsible for: persisting + caching the `{ default, pinned }` subset (model-prefs.json load/save/cache).
 * Not for: the pure default/pin transitions (setDefaultModel / pinModel / unpinModel live in
 * @trevor/session/model-preferences), the command that drives a mutation (model-prefs-command.ts), or
 * any UI.
 */

/** The persisted subset of {@link ModelPreferences}: the durable default + the favorites (pinned). The
 *  session-scoped `active` / `recent` / `reasoningByModel` stay browser-side (conversation/usage state). */
export interface ModelPrefsFile {
  readonly default: ModelRef | null;
  readonly pinned: readonly ModelRef[];
}

/** The empty preference: no default, no favorites (missing / malformed file). */
export const EMPTY_MODEL_PREFS: ModelPrefsFile = { default: null, pinned: [] };

/** Projects the full pure preferences to the persisted subset. */
function toFile(prefs: ModelPreferences): ModelPrefsFile {
  return { default: prefs.default, pinned: prefs.pinned };
}

/** Lifts the persisted subset into full pure preferences so the @trevor/session transitions apply. */
export function toModelPreferences(file: ModelPrefsFile): ModelPreferences {
  return { ...EMPTY_PREFERENCES, default: file.default, pinned: file.pinned };
}

/** Parses a raw `model-prefs.json` value to the persisted subset, reusing the tolerant pure decoder so a
 *  partial/garbled default or favorite drops to a safe value instead of throwing. */
export function parseModelPrefs(raw: unknown): ModelPrefsFile {
  return toFile(decodeModelPreferences(raw));
}

/** Reads the model preference (missing/malformed -> the empty preference) through the shared config-file
 *  scaffold. `read` is injectable for tests. */
export function loadModelPrefs(
  path: string = USER_MODEL_PREFS_JSON,
  read?: (p: string) => string,
): ModelPrefsFile {
  return loadJsonConfig(path, parseModelPrefs, EMPTY_MODEL_PREFS, read);
}

/** Persists the `{ default, pinned }` subset, creating the config dir as needed, and clears the read-once
 *  cache so a restart-free re-read (the next announce) reflects the change. The write counterpart to
 *  {@link loadModelPrefs}, driven by the set-default / toggle-favorite command. */
export function saveModelPrefs(
  prefs: ModelPrefsFile,
  path: string = USER_MODEL_PREFS_JSON,
  write?: (p: string, content: string) => void,
): void {
  writeJsonConfig(path, { default: prefs.default, pinned: prefs.pinned }, write);
  cache = undefined;
}

/**
 * The model preference, read once and cached for the host's lifetime - the `host.online` announce reads
 * through this, so it never re-touches disk per turn. {@link saveModelPrefs} clears the cache, so a
 * set-default / toggle-favorite takes effect on the next announce without a restart. `read` is used only
 * on the first (uncached) read, so a test can inject it and still observe the cache clearing.
 */
let cache: ModelPrefsFile | undefined;

export function modelPrefs(read?: (p: string) => string): ModelPrefsFile {
  if (cache === undefined) {
    cache = loadModelPrefs(USER_MODEL_PREFS_JSON, read);
  }
  return cache;
}
