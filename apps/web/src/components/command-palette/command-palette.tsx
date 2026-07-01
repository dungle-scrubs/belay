import { RowChooserModal } from "@/components/command-modal";
import { PALETTE_CHOOSER, type PaletteCommand, runPaletteCommand } from "./palette-commands";

/**
 * The `Mod+K` command palette (plan 07): a searchable list of app commands, built on the shared
 * `RowChooserModal` (a centered `Dialog` overlay = a frontmost surface, so while open it owns its keys
 * and the router suppresses everything below). Selecting a row runs the command and closes. Data-driven
 * - App supplies the command list, so new actions never need bespoke key handlers.
 */
export function CommandPalette({
  open,
  onOpenChange,
  commands,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly commands: readonly PaletteCommand[];
}) {
  return (
    <RowChooserModal
      adapter={PALETTE_CHOOSER}
      open={open}
      onOpenChange={onOpenChange}
      data={commands}
      context={undefined}
      onSelect={(id) => runPaletteCommand(commands, id)}
    />
  );
}
