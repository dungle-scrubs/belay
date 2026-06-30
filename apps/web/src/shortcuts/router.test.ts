import assert from "node:assert/strict";
import { test } from "vitest";
import type { KeyChordEvent } from "./keys";
import { type RouterContext, routeKey } from "./router";

/**
 * M2: the pure router decision. Only the FRONTMOST eligible surface owns a key: a global app shortcut
 * is suppressed while a frontmost overlay is open, and `submit` is composer-owned (requires editable
 * focus). This is the bug-class guard - a key never reaches a surface behind the modal/menu/panel.
 */

const ev = (key: string, over: Partial<KeyChordEvent> = {}): KeyChordEvent => ({
  key,
  metaKey: true, // default: Cmd held (mac)
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});
const ctx = (over: Partial<RouterContext> = {}): RouterContext => ({
  mac: true,
  overlayOpen: false,
  editableFocused: false,
  ...over,
});

test("global Mod shortcuts route to their ids when no overlay is open", () => {
  assert.equal(routeKey(ev("k"), ctx()), "command-palette");
  assert.equal(routeKey(ev("/"), ctx()), "shortcuts-help");
  assert.equal(routeKey(ev("\\"), ctx()), "toggle-sidebar");
  assert.equal(routeKey(ev("\\", { shiftKey: true }), ctx()), "toggle-panel");
  assert.equal(routeKey(ev("."), ctx()), "stop");
});

test("a frontmost overlay suppresses every global shortcut (no behind-surface interaction)", () => {
  for (const key of ["k", "/", "\\", "."]) {
    assert.equal(
      routeKey(ev(key), ctx({ overlayOpen: true })),
      null,
      `${key} suppressed behind overlay`,
    );
  }
  assert.equal(routeKey(ev("\\", { shiftKey: true }), ctx({ overlayOpen: true })), null);
});

test("submit is composer-owned: only with an editable field focused, never behind an overlay", () => {
  assert.equal(routeKey(ev("Enter"), ctx({ editableFocused: true })), "submit");
  assert.equal(
    routeKey(ev("Enter"), ctx({ editableFocused: false })),
    null,
    "no submit without composer focus",
  );
  assert.equal(
    routeKey(ev("Enter"), ctx({ editableFocused: true, overlayOpen: true })),
    null,
    "no submit behind an overlay",
  );
});

test("a non-Mod key and an unbound Mod chord route to nothing", () => {
  assert.equal(routeKey(ev("k", { metaKey: false }), ctx()), null, "bare k is not a shortcut");
  assert.equal(routeKey(ev("p"), ctx()), null, "Mod+P is unbound (a rude combo)");
});

test("Mod maps per platform: Ctrl+K routes on Windows/Linux, Cmd+K on macOS", () => {
  assert.equal(
    routeKey(ev("k", { metaKey: false, ctrlKey: true }), ctx({ mac: false })),
    "command-palette",
  );
  assert.equal(routeKey(ev("k", { metaKey: true, ctrlKey: false }), ctx({ mac: false })), null);
});
