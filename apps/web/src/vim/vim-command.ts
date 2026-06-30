import type { PaletteCommand } from "@/components/command-palette/palette-commands";

/**
 * The command-palette "Toggle Vim mode" action (plan 07 M4). Its hint reflects the live host preference
 * (`vimEnabledFrom` over host.online), and selecting it dispatches the host `/vim` command, which
 * persists the flip under the config home and re-announces - so the next host.online updates the hint.
 * Pure + injectable (the session `command` dispatcher is passed in) so it unit-tests without a session.
 */
export function vimToggleCommand(
  enabled: boolean,
  command: (name: string, args: string) => void,
): PaletteCommand {
  return {
    id: "toggle-vim",
    label: "Toggle Vim mode",
    hint: enabled ? "on" : "off",
    run: () => command("/vim", ""),
  };
}
