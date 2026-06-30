import assert from "node:assert/strict";
import { test } from "vitest";
import { type KeyChordEvent, matchesChord, parseChord } from "./keys";

/**
 * M1/M2: the `Mod` chord parser + matcher. `Mod` is Cmd on macOS, Ctrl elsewhere; the OTHER primary
 * modifier must be absent, and Shift/Alt must match exactly so `Mod+K` never also fires on `Mod+Shift+K`.
 */

const ev = (over: Partial<KeyChordEvent>): KeyChordEvent => ({
  key: "k",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

test("parseChord splits modifiers from the key and lowercases a single char", () => {
  assert.deepEqual(parseChord("Mod+K"), { mod: true, shift: false, alt: false, key: "k" });
  assert.deepEqual(parseChord("Mod+Shift+\\"), { mod: true, shift: true, alt: false, key: "\\" });
  assert.deepEqual(parseChord("Mod+Enter"), { mod: true, shift: false, alt: false, key: "Enter" });
});

test("Mod maps to Cmd on macOS and Ctrl elsewhere", () => {
  const k = parseChord("Mod+K");
  assert.equal(matchesChord(ev({ metaKey: true }), k, true), true, "mac: Cmd+K matches");
  assert.equal(
    matchesChord(ev({ ctrlKey: true }), k, true),
    false,
    "mac: Ctrl+K does NOT match Mod",
  );
  assert.equal(matchesChord(ev({ ctrlKey: true }), k, false), true, "win: Ctrl+K matches");
  assert.equal(
    matchesChord(ev({ metaKey: true }), k, false),
    false,
    "win: Cmd+K does NOT match Mod",
  );
});

test("Shift/Alt must match exactly - Mod+K does not fire on Mod+Shift+K and vice versa", () => {
  const modK = parseChord("Mod+K");
  const modShiftK = parseChord("Mod+Shift+\\");
  assert.equal(matchesChord(ev({ metaKey: true, shiftKey: true }), modK, true), false);
  assert.equal(
    matchesChord(ev({ key: "\\", metaKey: true, shiftKey: true }), modShiftK, true),
    true,
  );
  assert.equal(
    matchesChord(ev({ key: "\\", metaKey: true }), modShiftK, true),
    false,
    "needs Shift",
  );
});

test("a bare key (no Mod) never matches a Mod chord", () => {
  assert.equal(matchesChord(ev({ key: "k" }), parseChord("Mod+K"), true), false);
});
