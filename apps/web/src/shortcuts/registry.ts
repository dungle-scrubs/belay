import { type Chord, parseChord } from "./keys";

/**
 * The declarative shortcut registry (plan 07): the single source of truth for every Trevor-owned
 * keyboard binding. Each entry is classified by policy (see `apps/web/HOTKEYS.md`), and a test
 * cross-checks that every registered binding is documented in that ledger - so a shortcut can't be
 * added in code without updating the policy doc. The router (`./router`) dispatches against this list;
 * the shortcuts-help surface renders from it. Adding a binding = one row here + one row in HOTKEYS.md.
 */

/** Browser/OS conflict classification (mirrors the HOTKEYS.md policy classes). */
export type ShortcutPolicy = "safe" | "contextual" | "rude" | "reserved";

export interface ShortcutSpec {
  readonly id: string;
  /** Canonical chord, `Mod` = Cmd (macOS) / Ctrl (Windows/Linux); e.g. `Mod+Shift+\`. */
  readonly keys: string;
  /** Human label for the shortcuts-help surface. */
  readonly label: string;
  readonly policy: ShortcutPolicy;
}

export const SHORTCUTS = [
  {
    id: "command-palette",
    keys: "Mod+K",
    label: "Open the command palette",
    policy: "contextual",
  },
  { id: "shortcuts-help", keys: "Mod+/", label: "Show keyboard shortcuts", policy: "safe" },
  { id: "submit", keys: "Mod+Enter", label: "Send the message", policy: "contextual" },
  {
    id: "toggle-sidebar",
    keys: "Mod+\\",
    label: "Toggle the sessions sidebar",
    policy: "contextual",
  },
  {
    id: "toggle-panel",
    keys: "Mod+Shift+\\",
    label: "Toggle the side panel",
    policy: "contextual",
  },
  { id: "stop", keys: "Mod+.", label: "Stop the active run", policy: "contextual" },
] as const satisfies readonly ShortcutSpec[];

/** The id union, derived from the registry so callers reference a real binding. */
export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

/**
 * Each registered binding with its chord parsed ONCE at module load. The router's matcher runs on every
 * window keydown (including every keystroke typed into the composer), so it reads these precomputed
 * {@link Chord}s instead of re-splitting the constant `keys` strings on each keypress.
 */
export const PARSED_SHORTCUTS: readonly { readonly id: ShortcutId; readonly chord: Chord }[] =
  SHORTCUTS.map((s) => ({ id: s.id, chord: parseChord(s.keys) }));

/** Looks up a shortcut spec by id. */
export function shortcut(id: ShortcutId): ShortcutSpec {
  const spec = SHORTCUTS.find((s) => s.id === id);
  if (!spec) {
    throw new Error(`unknown shortcut id: ${id}`);
  }
  return spec;
}

/** The parsed chord for a shortcut id (for the router's matcher). */
export function shortcutChord(id: ShortcutId): Chord {
  return parseChord(shortcut(id).keys);
}
