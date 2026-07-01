import assert from "node:assert/strict";
import { test } from "vitest";
import {
  appendHistory,
  clearDraft,
  HISTORY_CAP,
  readDraft,
  readHistory,
  writeDraft,
} from "./composer-storage";
import { createMemoryStorage } from "./test-support/storage";

/**
 * The pure tab-local composer persistence policy (D-083/D-084): draft round-trip + clear, the
 * history cap + adjacent de-dupe, tab/session key isolation, version-skew rejection, and graceful
 * degradation when storage throws. Driven by an in-memory fake Storage - no DOM.
 */

/** A Storage whose every method throws (private mode / disabled storage). */
const throwingStorage = (): Storage =>
  ({
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
    clear: () => {},
    key: () => null,
    length: 0,
  }) as Storage;

test("draft round-trips, then clears (and empty writes clear the slot)", () => {
  const s = createMemoryStorage();
  assert.equal(readDraft(s, "tab", "sess"), "");
  writeDraft(s, "tab", "sess", "hello world");
  assert.equal(readDraft(s, "tab", "sess"), "hello world");
  // An empty write clears the slot (used when the composer goes empty on submit/clear).
  writeDraft(s, "tab", "sess", "");
  assert.equal(readDraft(s, "tab", "sess"), "");
  writeDraft(s, "tab", "sess", "again");
  clearDraft(s, "tab", "sess");
  assert.equal(readDraft(s, "tab", "sess"), "");
});

test("draft + history are isolated by tab id and by session id", () => {
  const s = createMemoryStorage();
  writeDraft(s, "tabA", "sess", "from A");
  writeDraft(s, "tabB", "sess", "from B");
  writeDraft(s, "tabA", "other", "A other");
  assert.equal(readDraft(s, "tabA", "sess"), "from A");
  assert.equal(readDraft(s, "tabB", "sess"), "from B");
  assert.equal(readDraft(s, "tabA", "other"), "A other");

  appendHistory(s, "tabA", "sess", "a1");
  appendHistory(s, "tabB", "sess", "b1");
  assert.deepEqual(readHistory(s, "tabA", "sess"), ["a1"]);
  assert.deepEqual(readHistory(s, "tabB", "sess"), ["b1"]);
});

test("appendHistory de-dupes an adjacent duplicate, trims, and skips empties", () => {
  const s = createMemoryStorage();
  appendHistory(s, "t", "x", "ls");
  appendHistory(s, "t", "x", "ls"); // adjacent dup: ignored
  appendHistory(s, "t", "x", "  pwd  "); // trimmed
  appendHistory(s, "t", "x", "   "); // whitespace-only: skipped
  appendHistory(s, "t", "x", ""); // empty: skipped
  appendHistory(s, "t", "x", "ls"); // not adjacent to the newest (pwd): kept
  assert.deepEqual(readHistory(s, "t", "x"), ["ls", "pwd", "ls"]);
});

test("history is capped to the newest HISTORY_CAP entries", () => {
  const s = createMemoryStorage();
  for (let i = 0; i < HISTORY_CAP + 10; i += 1) {
    appendHistory(s, "t", "x", `cmd-${i}`);
  }
  const items = readHistory(s, "t", "x");
  assert.equal(items.length, HISTORY_CAP);
  assert.equal(items[0], "cmd-10"); // the oldest 10 were dropped
  assert.equal(items[items.length - 1], `cmd-${HISTORY_CAP + 9}`);
});

test("a version-skewed or malformed payload reads as empty (never throws)", () => {
  const s = createMemoryStorage();
  s.setItem("trevor.draft.t.x", JSON.stringify({ v: 999, text: "stale" }));
  s.setItem("trevor.history.t.x", "not json{");
  assert.equal(readDraft(s, "t", "x"), "");
  assert.deepEqual(readHistory(s, "t", "x"), []);
});

test("storage failures degrade silently - reads default, writes don't throw", () => {
  const s = throwingStorage();
  assert.equal(readDraft(s, "t", "x"), "");
  assert.deepEqual(readHistory(s, "t", "x"), []);
  // None of these throw despite the backing storage rejecting every call.
  writeDraft(s, "t", "x", "hi");
  clearDraft(s, "t", "x");
  // appendHistory still returns the new in-memory ring (so the hook keeps working in-session); the
  // write just silently no-ops, so a re-read stays empty.
  assert.deepEqual(appendHistory(s, "t", "x", "ls"), ["ls"]);
  assert.deepEqual(readHistory(s, "t", "x"), []);
});
