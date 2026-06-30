import type { RowChooserAdapter } from "@/components/command-modal/RowChooserModal";
import type { CommandRow } from "@/components/command-modal/types";

/**
 * The command palette's command model + adapter (plan 07). A `PaletteCommand` is a data-driven app
 * action (run on select), optionally showing its keyboard shortcut and a status (e.g. a toggle's
 * on/off). The palette is the `Mod+K` discovery surface; new actions are added to the command list, not
 * to bespoke key handlers (M3 REFACTOR), and they reuse the shared `RowChooserModal` chrome that the
 * resume + worktree choosers already use.
 */
export interface PaletteCommand {
  /** Stable id returned on select. */
  readonly id: string;
  readonly label: string;
  /** A display keybinding for this command (e.g. `⌘K`), shown right-aligned when there's no `hint`. */
  readonly keys?: string;
  /** A status hint (e.g. `on` / `off` for a toggle), shown right-aligned (takes priority over `keys`). */
  readonly hint?: string;
  readonly run: () => void;
  /** When set, the row is disabled with this reason. */
  readonly disabledReason?: string;
}

export const PALETTE_CHOOSER: RowChooserAdapter<readonly PaletteCommand[], undefined> = {
  title: "Command palette",
  placeholder: "Search commands…",
  emptyLabel: "No matching commands",
  footerHints: [
    { keys: "↑↓", label: "navigate" },
    { keys: "↵", label: "run" },
    { keys: "esc", label: "close" },
  ],
  buildRows: (commands): readonly CommandRow[] =>
    commands.map((c) => ({
      id: c.id,
      label: c.label,
      status: c.hint ?? c.keys,
      statusTone: c.hint ? "active" : "muted",
      ...(c.disabledReason ? { disabledReason: c.disabledReason } : {}),
    })),
};

/** Runs the command with the given id from a list (the palette's onSelect). */
export function runPaletteCommand(commands: readonly PaletteCommand[], id: string): void {
  commands.find((c) => c.id === id)?.run();
}
