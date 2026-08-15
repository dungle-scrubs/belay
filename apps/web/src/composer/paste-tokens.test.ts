import assert from "node:assert/strict";
import type { PastePayload } from "@belay/session";
import { test } from "vitest";
import {
  EMPTY_PASTE_DRAFT,
  insertPaste,
  type PasteDraft,
  parsePasteTokens,
  removeAdjacentPasteToken,
  renumberPastes,
  syncPasteDraft,
} from "./paste-tokens";

/**
 * 10-large-paste-placeholders M2: the pure pasted-text-token draft model. Insertion (auto-spacing,
 * payload pairing), one-step deletion, and reading-order renumbering are pinned here without any DOM,
 * so the composer is a thin wiring layer over a tested core. Mirrors image-tokens.test.ts.
 */

function payload(text: string): PastePayload {
  return { text };
}

const P = payload("alpha\nbeta\ngamma");
const Q = payload("one\ntwo");
const R = payload("x".repeat(2000));

function draftOf(text: string, pastes: readonly PastePayload[]): PasteDraft {
  return { text, pastes };
}

test("insertPaste into empty draft adds the token (with its line count) and its payload", () => {
  const { draft, cursor } = insertPaste(EMPTY_PASTE_DRAFT, 0, 0, P);
  assert.equal(draft.text, "[Pasted text #1 +3 lines]", "the +M line count comes from the payload");
  assert.deepEqual(draft.pastes, [P]);
  assert.equal(cursor, draft.text.length);
});

test("insertPaste between words auto-spaces both sides", () => {
  const { draft } = insertPaste(draftOf("ab", []), 1, 1, P);
  assert.equal(draft.text, "a [Pasted text #1 +3 lines] b");
});

test("insertPaste at start only adds a trailing space; at end only a leading space", () => {
  const start = insertPaste(draftOf("hi", []), 0, 0, P);
  assert.equal(start.draft.text, "[Pasted text #1 +3 lines] hi");

  const end = insertPaste(draftOf("hi", []), 2, 2, P);
  assert.equal(end.draft.text, "hi [Pasted text #1 +3 lines]");
});

test("insertPaste replaces the selection", () => {
  const { draft } = insertPaste(draftOf("hello world", []), 0, 5, P); // replace "hello"
  assert.equal(draft.text, "[Pasted text #1 +3 lines] world");
  assert.deepEqual(draft.pastes, [P]);
});

test("inserting into the middle splices the payload into reading order", () => {
  const base = draftOf("[Pasted text #1 +3 lines] [Pasted text #2 +2 lines]", [P, Q]);
  const at = "[Pasted text #1 +3 lines] ".length;
  const { draft } = insertPaste(base, at, at, R);
  assert.deepEqual(draft.pastes, [P, R, Q], "the new payload lands between the existing two");
  assert.deepEqual(
    parsePasteTokens(draft.text).map((s) => s.num),
    [1, 2, 3],
    "tokens renumber to reading order",
  );
});

test("backspace next to a token removes the whole token and its payload in one step", () => {
  const base = draftOf("x [Pasted text #1 +3 lines] y", [P]);
  const cursor = "x [Pasted text #1 +3 lines]".length;
  const result = removeAdjacentPasteToken(base, cursor, -1);
  assert.ok(result);
  assert.equal(result.draft.text, "x y", "the token and a redundant space are gone");
  assert.deepEqual(result.draft.pastes, []);
  assert.equal(result.cursor, "x ".length);
});

test("delete next to a token removes the whole token and its payload in one step", () => {
  const base = draftOf("x [Pasted text #1 +3 lines] y", [P]);
  const cursor = "x ".length;
  const result = removeAdjacentPasteToken(base, cursor, 1);
  assert.ok(result);
  assert.equal(result.draft.text, "x y");
  assert.deepEqual(result.draft.pastes, []);
});

test("removeAdjacentPasteToken returns null when no token is adjacent (normal editing)", () => {
  const base = draftOf("plain text", []);
  assert.equal(removeAdjacentPasteToken(base, 3, -1), null);
  assert.equal(removeAdjacentPasteToken(base, 3, 1), null);
});

test("removing a middle token keeps text, payloads, and numbers synced in reading order", () => {
  const base = draftOf(
    "[Pasted text #1 +3 lines] [Pasted text #2 +2 lines] [Pasted text #3 +1 lines]",
    [P, Q, R],
  );
  const cursor = "[Pasted text #1 +3 lines] [Pasted text #2 +2 lines]".length;
  const result = removeAdjacentPasteToken(base, cursor, -1);
  assert.ok(result);
  assert.deepEqual(result.draft.pastes, [P, R], "the middle payload is dropped");
  assert.deepEqual(
    parsePasteTokens(result.draft.text).map((s) => s.num),
    [1, 2],
    "remaining tokens renumber to 1, 2",
  );
});

test("renumberPastes rewrites out-of-order numbers but keeps each token's line count", () => {
  assert.equal(
    renumberPastes("[Pasted text #5 +3 lines] mid [Pasted text #9 +7 lines]"),
    "[Pasted text #1 +3 lines] mid [Pasted text #2 +7 lines]",
  );
});

test("syncPasteDraft drops the right payload when a token is deleted by a raw selection edit", () => {
  const prev = draftOf(
    "[Pasted text #1 +3 lines] [Pasted text #2 +2 lines] [Pasted text #3 +1 lines]",
    [P, Q, R],
  );
  const rawAfterDeletingFirst = " [Pasted text #2 +2 lines] [Pasted text #3 +1 lines]";
  const synced = syncPasteDraft(prev, rawAfterDeletingFirst);
  assert.deepEqual(synced.pastes, [Q, R], "the surviving tokens' numbers identify the survivors");
  assert.deepEqual(
    parsePasteTokens(synced.text).map((s) => s.num),
    [1, 2],
    "and the survivors renumber to reading order",
  );
});

test("syncPasteDraft drops a token whose number no longer maps to a payload", () => {
  const prev = draftOf("[Pasted text #1 +3 lines]", [P]);
  const synced = syncPasteDraft(prev, "[Pasted text #1 +3 lines] [Pasted text #7 +9 lines]");
  assert.deepEqual(synced.pastes, [P]);
  assert.equal(parsePasteTokens(synced.text).length, 1, "only the mapped token survives");
  assert.ok(
    !synced.text.includes("#7"),
    "the stray token text is dropped, keeping payloads aligned",
  );
});
