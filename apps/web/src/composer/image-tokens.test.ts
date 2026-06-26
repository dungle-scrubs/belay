import assert from "node:assert/strict";
import type { ArtifactRef } from "@trevor/session";
import { test } from "vitest";
import {
  EMPTY_DRAFT,
  type ImageDraft,
  insertImage,
  insertImages,
  parseImageTokens,
  removeAdjacentToken,
  renumber,
  syncDraft,
} from "./image-tokens";

/**
 * D-092 M2: the pure image-token draft model. Insertion (auto-spacing, ordered multi), one-step
 * deletion, and reading-order renumbering are pinned here without any DOM, so the composer hook is
 * a thin wiring layer over a tested core.
 */

function ref(name: string): ArtifactRef {
  return {
    kind: "image",
    mimeType: "image/png",
    size: 10,
    hash: name.repeat(8).slice(0, 64),
    name,
  };
}

const A = ref("a");
const B = ref("b");
const C = ref("c");

function draftOf(text: string, refs: readonly ArtifactRef[]): ImageDraft {
  return { text, refs };
}

test("parseImageTokens finds tokens in reading order with their ranges", () => {
  const spans = parseImageTokens("see [Image #1] then [Image #2] end");
  assert.equal(spans.length, 2);
  assert.deepEqual(
    spans.map((s) => s.num),
    [1, 2],
  );
  assert.equal("see [Image #1]".length, spans[0]?.end);
});

test("insertImage into empty draft adds the token and its ref", () => {
  const { draft, cursor } = insertImage(EMPTY_DRAFT, 0, 0, A);
  assert.equal(draft.text, "[Image #1]");
  assert.deepEqual(draft.refs, [A]);
  assert.equal(cursor, draft.text.length);
});

test("insertImage between words auto-spaces both sides", () => {
  const base = draftOf("ab", []);
  const { draft } = insertImage(base, 1, 1, A);
  assert.equal(
    draft.text,
    "a [Image #1] b",
    "a leading and trailing space keep the token off the words",
  );
});

test("insertImage at start only adds a trailing space; at end only a leading space", () => {
  const start = insertImage(draftOf("hi", []), 0, 0, A);
  assert.equal(start.draft.text, "[Image #1] hi");

  const end = insertImage(draftOf("hi", []), 2, 2, A);
  assert.equal(end.draft.text, "hi [Image #1]");
});

test("insertImage does not add a space when the neighbor is already whitespace", () => {
  const { draft } = insertImage(draftOf("a  b", []), 2, 2, A);
  assert.equal(draft.text, "a [Image #1] b");
});

test("insertImage replaces the selection", () => {
  const base = draftOf("hello world", []);
  const { draft } = insertImage(base, 0, 5, A); // replace "hello"
  assert.equal(draft.text, "[Image #1] world");
  assert.deepEqual(draft.refs, [A]);
});

test("inserting into the middle splices the ref into reading order", () => {
  // "[Image #1] [Image #2]" with refs [A, B]; insert C between them.
  const base = draftOf("[Image #1] [Image #2]", [A, B]);
  const at = "[Image #1] ".length;
  const { draft } = insertImage(base, at, at, C);
  assert.deepEqual(draft.refs, [A, C, B], "the new ref lands between the existing two");
  assert.deepEqual(
    parseImageTokens(draft.text).map((s) => s.num),
    [1, 2, 3],
    "tokens renumber to reading order",
  );
});

test("insertImages inserts ordered tokens for multiple images deterministically", () => {
  const { draft } = insertImages(EMPTY_DRAFT, 0, 0, [A, B, C]);
  assert.deepEqual(draft.refs, [A, B, C]);
  assert.equal(draft.text, "[Image #1] [Image #2] [Image #3]");
});

test("backspace next to a token removes the whole token and its ref in one step", () => {
  const base = draftOf("x [Image #1] y", [A]);
  const cursor = "x [Image #1]".length; // right after the token
  const result = removeAdjacentToken(base, cursor, -1);
  assert.ok(result);
  assert.equal(result.draft.text, "x y", "the token and a redundant space are gone");
  assert.deepEqual(result.draft.refs, []);
  assert.equal(result.cursor, "x ".length);
});

test("delete next to a token removes the whole token and its ref in one step", () => {
  const base = draftOf("x [Image #1] y", [A]);
  const cursor = "x ".length; // right before the token
  const result = removeAdjacentToken(base, cursor, 1);
  assert.ok(result);
  assert.equal(result.draft.text, "x y");
  assert.deepEqual(result.draft.refs, []);
});

test("removeAdjacentToken returns null when no token is adjacent (normal editing)", () => {
  const base = draftOf("plain text", []);
  assert.equal(removeAdjacentToken(base, 3, -1), null);
  assert.equal(removeAdjacentToken(base, 3, 1), null);
});

test("removing a middle token keeps text, refs, and numbers synced in reading order", () => {
  const base = draftOf("[Image #1] [Image #2] [Image #3]", [A, B, C]);
  const cursor = "[Image #1] [Image #2]".length; // after token 2
  const result = removeAdjacentToken(base, cursor, -1);
  assert.ok(result);
  assert.deepEqual(result.draft.refs, [A, C], "the middle ref is dropped");
  assert.deepEqual(
    parseImageTokens(result.draft.text).map((s) => s.num),
    [1, 2],
    "remaining tokens renumber to 1, 2",
  );
});

test("renumber rewrites out-of-order numbers to reading order", () => {
  assert.equal(renumber("[Image #5] mid [Image #9]"), "[Image #1] mid [Image #2]");
});

test("syncDraft drops the right ref when a token is deleted by a raw selection edit", () => {
  // Refs [A,B,C]; the user selects + deletes the FIRST token, leaving #2 and #3 in the raw text.
  const prev = draftOf("[Image #1] [Image #2] [Image #3]", [A, B, C]);
  const rawAfterDeletingFirst = " [Image #2] [Image #3]";
  const synced = syncDraft(prev, rawAfterDeletingFirst);
  assert.deepEqual(
    synced.refs,
    [B, C],
    "the surviving tokens' numbers identify the surviving refs",
  );
  assert.deepEqual(
    parseImageTokens(synced.text).map((s) => s.num),
    [1, 2],
    "and the survivors renumber to reading order",
  );
});

test("syncDraft drops a token whose number no longer maps to a ref", () => {
  const prev = draftOf("[Image #1]", [A]);
  const synced = syncDraft(prev, "[Image #1] [Image #7]"); // #7 was never a real token
  assert.deepEqual(synced.refs, [A]);
  assert.equal(parseImageTokens(synced.text).length, 1, "only the mapped token survives");
  assert.ok(!synced.text.includes("#7"), "the stray token text is dropped, keeping refs aligned");
});
