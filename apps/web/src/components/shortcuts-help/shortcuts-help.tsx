import { useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { isMac } from "@/shortcuts/keys";
import { buildShortcutHelpRows, POLICY_NOTE } from "./shortcut-help-rows";

/**
 * The `Mod+/` keyboard-shortcuts reference (plan 07 M6): a read-only overlay listing every registered
 * binding with its platform chord + policy note, generated from the shortcut registry so it can never
 * drift from what the router actually dispatches. A `Dialog` = a frontmost surface: while open it joins
 * `modalOpen`, so the global shortcuts are suppressed and Escape closes it (it owns its own keys).
 */
export function ShortcutsHelp({
  open,
  onOpenChange,
  mac = isMac(),
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly mac?: boolean;
}) {
  const rows = useMemo(() => buildShortcutHelpRows(mac), [mac]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            {mac ? "⌘" : "Ctrl"} is the primary modifier on this platform.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-1">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-4 py-1 text-sm">
              <span className="flex flex-col">
                <span>{row.label}</span>
                <span className="text-xs text-muted-foreground">{POLICY_NOTE[row.policy]}</span>
              </span>
              <Kbd className="border font-mono">{row.chord}</Kbd>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
