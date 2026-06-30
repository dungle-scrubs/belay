import { formatChord } from "@/shortcuts/keys";
import { SHORTCUTS, type ShortcutPolicy } from "@/shortcuts/registry";

/**
 * The shortcuts-help projection (plan 07 M6): the registry rendered for the help surface, one row per
 * binding in registry order with the chord formatted for THIS platform (`⌘K` macOS / `Ctrl+K` else).
 * Pure, so the help list and the router can never diverge - both read the same {@link SHORTCUTS}.
 */
export interface ShortcutHelpRow {
  readonly id: string;
  readonly label: string;
  /** The chord, formatted for the platform passed in. */
  readonly chord: string;
  readonly policy: ShortcutPolicy;
}

export function buildShortcutHelpRows(mac: boolean): readonly ShortcutHelpRow[] {
  return SHORTCUTS.map((s) => ({
    id: s.id,
    label: s.label,
    chord: formatChord(s.keys, mac),
    policy: s.policy,
  }));
}

/** Human blurb for each policy class (mirrors `apps/web/HOTKEYS.md`), shown beside a binding. */
export const POLICY_NOTE: Record<ShortcutPolicy, string> = {
  safe: "no browser conflict",
  contextual: "only when its surface owns focus",
  rude: "overrides a browser default",
  reserved: "planned, not yet bound",
};
