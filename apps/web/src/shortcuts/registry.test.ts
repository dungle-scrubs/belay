import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { parseChord } from "./keys";
import { SHORTCUTS, shortcut, shortcutChord } from "./registry";

/**
 * M1: the shortcut registry is the source of truth, and it must stay in sync with the policy ledger.
 * Every registered binding has to appear in `apps/web/HOTKEYS.md`, so a shortcut can never be added in
 * code without documenting its browser/OS policy - an undocumented registration fails this test.
 */

const HOTKEYS = readFileSync(new URL("../../HOTKEYS.md", import.meta.url), "utf8");

test("every registered shortcut's keys are documented in HOTKEYS.md", () => {
  for (const s of SHORTCUTS) {
    assert.ok(
      HOTKEYS.includes(s.keys),
      `shortcut "${s.id}" (${s.keys}) is not documented in apps/web/HOTKEYS.md`,
    );
  }
});

test("shortcut ids are unique and every entry has a label + valid policy", () => {
  const ids = SHORTCUTS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate shortcut id");
  const policies = new Set(["safe", "contextual", "rude", "reserved"]);
  for (const s of SHORTCUTS) {
    assert.ok(s.label.length > 0, `${s.id} needs a label`);
    assert.ok(policies.has(s.policy), `${s.id} has an invalid policy: ${s.policy}`);
  }
});

test("every shortcut's keys parse to a Mod chord (Trevor's primary modifier)", () => {
  for (const s of SHORTCUTS) {
    const chord = parseChord(s.keys);
    assert.equal(chord.mod, true, `${s.id} (${s.keys}) must be a Mod binding`);
    assert.ok(chord.key.length > 0, `${s.id} needs a key`);
  }
});

test("shortcut() resolves a known id and shortcutChord() parses it", () => {
  assert.equal(shortcut("command-palette").keys, "Mod+K");
  assert.deepEqual(shortcutChord("command-palette"), {
    mod: true,
    shift: false,
    alt: false,
    key: "k",
  });
  assert.throws(() => shortcut("nope" as never), /unknown shortcut id/);
});
