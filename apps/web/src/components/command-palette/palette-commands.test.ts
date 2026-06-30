import assert from "node:assert/strict";
import { test } from "vitest";
import { PALETTE_CHOOSER, type PaletteCommand, runPaletteCommand } from "./palette-commands";

/**
 * M3: the palette's command -> row projection + run dispatch. Hints take priority over the keybinding
 * for the right-aligned status; a disabled command carries its reason; running dispatches by id.
 */

const cmds: PaletteCommand[] = [
  { id: "vim", label: "Toggle Vim mode", hint: "off", run: () => {} },
  { id: "sidebar", label: "Toggle sidebar", keys: "⌘\\", run: () => {} },
  { id: "stop", label: "Stop run", keys: "⌘.", run: () => {}, disabledReason: "no active run" },
];

test("buildRows projects label + status (hint over keys) + disabledReason", () => {
  const rows = PALETTE_CHOOSER.buildRows(cmds, undefined);
  assert.deepEqual(
    rows.map((r) => ({ id: r.id, label: r.label, status: r.status, disabled: r.disabledReason })),
    [
      { id: "vim", label: "Toggle Vim mode", status: "off", disabled: undefined },
      { id: "sidebar", label: "Toggle sidebar", status: "⌘\\", disabled: undefined },
      { id: "stop", label: "Stop run", status: "⌘.", disabled: "no active run" },
    ],
  );
  // A command with a hint is toned "active"; a keys-only command is "muted".
  assert.equal(rows[0]?.statusTone, "active");
  assert.equal(rows[1]?.statusTone, "muted");
});

test("runPaletteCommand runs the command with the chosen id, and ignores an unknown id", () => {
  const ran: string[] = [];
  const list: PaletteCommand[] = [
    { id: "a", label: "A", run: () => ran.push("a") },
    { id: "b", label: "B", run: () => ran.push("b") },
  ];
  runPaletteCommand(list, "b");
  runPaletteCommand(list, "missing");
  assert.deepEqual(ran, ["b"]);
});
