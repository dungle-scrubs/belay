import { loadJsonConfig, writeJsonConfig } from "@host/boot/config";
import { USER_VIM_JSON } from "@host/boot/paths";

/**
 * The Vim-mode prompt preference store (plan 06). Whether the opt-in Vim motions are enabled persists as
 * a small `{ enabled }` JSON under the config home (`<TREVOR_HOME>/vim.json`), the approved Trevor
 * settings root - portable, separate from the browser. Read once at host startup and announced to the
 * web on `host.online`, so the preference follows Trevor sessions on this machine instead of living in
 * per-tab browser state. Disabled by default: a missing, malformed, or `{ enabled: false }` file all
 * resolve to off, and a malformed file is reported (by the shared config scaffold) without blocking
 * startup. Read/write are injectable so the store is unit-tested without touching disk.
 *
 * Responsible for: the persisted Vim prompt-motions preference (vim.json load/save/toggle/cache).
 * Not for: the /vim command spec - commands/commands.ts.
 */

export interface VimPreference {
  /** Whether Vim prompt motions are enabled. */
  readonly enabled: boolean;
  /** Where it came from: an explicit user file, or the default (missing/malformed) fallback. */
  readonly source: "user" | "default";
}

const DEFAULT_PREF: VimPreference = { enabled: false, source: "default" };

/** Parses a raw `vim.json` value to a preference; anything but an explicit boolean `enabled` is the
 *  disabled default (a missing key, a non-boolean, or a malformed file). */
export function parseVimPref(raw: unknown): VimPreference {
  if (raw && typeof raw === "object") {
    const enabled = (raw as { enabled?: unknown }).enabled;
    if (typeof enabled === "boolean") {
      return { enabled, source: "user" };
    }
  }
  return DEFAULT_PREF;
}

/** Reads the Vim preference (missing/malformed -> disabled default) through the shared config scaffold.
 *  `read` is injectable for tests. */
export function loadVimPref(
  path: string = USER_VIM_JSON,
  read?: (p: string) => string,
): VimPreference {
  return loadJsonConfig(path, parseVimPref, DEFAULT_PREF, read);
}

/**
 * Resolves a `/vim [on|off]` argument against the current state to the next enabled value (plan 07).
 * Bare `/vim` toggles; an explicit `on`/`enable`/`true` or `off`/`disable`/`false` sets regardless of
 * the current value (case-insensitive); anything else is rejected so the command can report usage. Pure
 * - the command wrapper persists the result via {@link saveVimPref}.
 */
export function resolveVimToggle(
  args: string,
  current: boolean,
): { readonly ok: true; readonly enabled: boolean } | { readonly ok: false } {
  switch (args.trim().toLowerCase()) {
    case "":
      return { ok: true, enabled: !current };
    case "on":
    case "enable":
    case "true":
      return { ok: true, enabled: true };
    case "off":
    case "disable":
    case "false":
      return { ok: true, enabled: false };
    default:
      return { ok: false };
  }
}

/** Persists the Vim-enabled preference, creating the config dir as needed, and clears the read-once
 *  cache so a restart-free re-read reflects the change. The write counterpart to {@link loadVimPref},
 *  driven by the host `/vim` toggle command (plan 07). */
export function saveVimPref(
  enabled: boolean,
  path: string = USER_VIM_JSON,
  write?: (p: string, content: string) => void,
): void {
  writeJsonConfig(path, { enabled }, write);
  cache = undefined;
}

/**
 * The Vim preference, read once and cached for the host's lifetime - the startup `host.online` announce
 * reads through this, so it never re-touches disk per turn. {@link saveVimPref} clears the cache.
 */
let cache: VimPreference | undefined;

export function vimPref(): VimPreference {
  if (cache === undefined) {
    cache = loadVimPref();
  }
  return cache;
}

/** Whether Vim prompt motions are enabled (the boolean the host announces to the web). */
export function vimEnabled(): boolean {
  return vimPref().enabled;
}
