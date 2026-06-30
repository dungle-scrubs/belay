import assert from "node:assert/strict";
import { test } from "vitest";
import { vimToggleCommand } from "./vim-command";

/**
 * M4: the palette "Toggle Vim mode" command. Its hint reads the current host preference, and selecting
 * it dispatches the bare host `/vim` command (which persists the flip + re-announces).
 */

test("reflects the current state in the hint", () => {
  assert.equal(vimToggleCommand(true, () => {}).hint, "on");
  assert.equal(vimToggleCommand(false, () => {}).hint, "off");
});

test("running dispatches the bare host /vim command", () => {
  const sent: Array<[string, string]> = [];
  vimToggleCommand(false, (name, args) => sent.push([name, args])).run();
  assert.deepEqual(sent, [["/vim", ""]]);
});
