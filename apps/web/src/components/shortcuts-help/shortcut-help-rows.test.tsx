import assert from "node:assert/strict";
import { test } from "vitest";
import { SHORTCUTS } from "@/shortcuts/registry";
import { buildShortcutHelpRows } from "./shortcut-help-rows";

/**
 * M6: the help projection covers every registered binding (so help can't drift from the router) and
 * formats each chord for the platform.
 */

test("one row per registered shortcut, in registry order", () => {
  const rows = buildShortcutHelpRows(true);
  assert.equal(rows.length, SHORTCUTS.length);
  assert.deepEqual(
    rows.map((r) => r.id),
    SHORTCUTS.map((s) => s.id),
  );
});

test("chords are formatted per platform (⌘ on mac, Ctrl elsewhere)", () => {
  const mac = buildShortcutHelpRows(true);
  const other = buildShortcutHelpRows(false);
  const paletteMac = mac.find((r) => r.id === "command-palette");
  const paletteOther = other.find((r) => r.id === "command-palette");
  assert.equal(paletteMac?.chord, "⌘K");
  assert.equal(paletteOther?.chord, "Ctrl+K");
});
