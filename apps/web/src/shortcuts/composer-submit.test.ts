import assert from "node:assert/strict";
import { test } from "vitest";
import { isComposerSubmitKey } from "./composer-submit";

/**
 * M6: the composer submit predicate. Plain Enter and the registry `Mod+Enter` chord send; Shift+Enter
 * (newline) and stray modifier+Enter combos do not, so the send key never collides with a surface chord.
 */

const enter = (over: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({
    key: "Enter",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  }) as KeyboardEvent;

test("plain Enter sends; Shift+Enter does not (newline)", () => {
  assert.equal(isComposerSubmitKey(enter(), true), true);
  assert.equal(isComposerSubmitKey(enter({ shiftKey: true }), true), false);
});

test("the Mod+Enter chord sends per platform (Cmd on mac, Ctrl elsewhere)", () => {
  assert.equal(isComposerSubmitKey(enter({ metaKey: true }), true), true, "Cmd+Enter on mac");
  assert.equal(isComposerSubmitKey(enter({ ctrlKey: true }), false), true, "Ctrl+Enter off mac");
  // The other platform's primary modifier must NOT match (Ctrl+Enter on mac stays inert).
  assert.equal(isComposerSubmitKey(enter({ ctrlKey: true }), true), false, "Ctrl+Enter on mac");
});

test("a stray modifier+Enter (Alt) and a non-Enter key never submit", () => {
  assert.equal(isComposerSubmitKey(enter({ altKey: true }), true), false);
  assert.equal(isComposerSubmitKey(enter({ metaKey: true, shiftKey: true }), true), false);
  assert.equal(isComposerSubmitKey({ ...enter(), key: "k" } as KeyboardEvent, true), false);
});
