import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import { test, vi } from "vitest";
import { CommandPalette } from "./command-palette";
import type { PaletteCommand } from "./palette-commands";

/**
 * M3: the Mod+K command palette shell. It lists the app commands, runs the chosen one and closes, leaves
 * a disabled command inert, and shows an empty state. (Opening on Mod+K + frontmost-routing suppression
 * are the shortcut router's job, covered in src/shortcuts.)
 */

function renderPalette(commands: PaletteCommand[]) {
  const onOpenChange = vi.fn();
  render(<CommandPalette open onOpenChange={onOpenChange} commands={commands} />);
  return { onOpenChange };
}

test("lists the commands and runs the chosen one, then closes", () => {
  const ran: string[] = [];
  const { onOpenChange } = renderPalette([
    { id: "vim", label: "Toggle Vim mode", hint: "off", run: () => ran.push("vim") },
    { id: "sidebar", label: "Toggle the sidebar", keys: "⌘\\", run: () => ran.push("sidebar") },
  ]);
  assert.ok(screen.getByText("Toggle Vim mode"));
  assert.ok(screen.getByText("Toggle the sidebar"));

  fireEvent.click(screen.getByText("Toggle the sidebar"));
  assert.deepEqual(ran, ["sidebar"]);
  assert.deepEqual(onOpenChange.mock.calls.at(-1), [false], "selecting closes the palette");
});

test("a disabled command does not run", () => {
  const ran: string[] = [];
  renderPalette([
    {
      id: "stop",
      label: "Stop the run",
      run: () => ran.push("stop"),
      disabledReason: "no active run",
    },
  ]);
  fireEvent.click(screen.getByText("Stop the run"));
  assert.deepEqual(ran, []);
});

test("an empty command list shows the empty state", () => {
  renderPalette([]);
  assert.ok(screen.getByText("No matching commands"));
});
