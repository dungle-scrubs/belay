import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  type FolderPicker,
  getFolderPicker,
  pickProjectFolder,
  resetFolderPicker,
  setFolderPicker,
} from "./folder-picker";

/**
 * The native folder-pick seam (plan 44.1): a test picker is injected so no real OS dialog ever fires,
 * and `pickProjectFolder` resolves whatever the active picker returns - a chosen path or a cancel.
 * This pins the injection boundary the daemon and its integration test rely on.
 */

afterEach(() => resetFolderPicker());

test("an injected picker's chosen path flows through pickProjectFolder", async () => {
  const fake: FolderPicker = {
    pick: () => Promise.resolve({ cancelled: false, path: "/Users/me/proj" }),
  };
  setFolderPicker(fake);
  assert.equal(getFolderPicker(), fake);
  assert.deepEqual(await pickProjectFolder(), { cancelled: false, path: "/Users/me/proj" });
});

test("an injected cancel flows through as cancelled with no path", async () => {
  setFolderPicker({ pick: () => Promise.resolve({ cancelled: true }) });
  assert.deepEqual(await pickProjectFolder(), { cancelled: true });
});

test("resetFolderPicker restores the real (non-fake) picker", () => {
  const fake: FolderPicker = { pick: () => Promise.resolve({ cancelled: true }) };
  setFolderPicker(fake);
  resetFolderPicker();
  assert.notEqual(getFolderPicker(), fake);
});
