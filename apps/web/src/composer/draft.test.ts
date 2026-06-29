import assert from "node:assert/strict";
import type { ArtifactRef, PastePayload } from "@trevor/session";
import { parseImageTokens, parsePasteTokens } from "@trevor/session";
import { test } from "vitest";
import {
  type ComposerDraft,
  EMPTY_COMPOSER_DRAFT,
  insertImages,
  insertPaste,
  removeAdjacentToken,
  syncComposerDraft,
} from "./draft";

/**
 * 10-large-paste-placeholders M2: the combined composer draft - image tokens and pasted-text tokens
 * sharing one text, each in its own reading-order namespace. The pinned invariant: editing one kind
 * never disturbs the other's pairing or numbering. <!-- D-004 -->
 */

function imageRef(name: string): ArtifactRef {
  return {
    kind: "image",
    mimeType: "image/png",
    size: 10,
    hash: name.repeat(64).slice(0, 64),
    name,
  };
}

function payload(text: string): PastePayload {
  return { text };
}

const IMG = imageRef("a");
const P = payload("alpha\nbeta\ngamma");
const Q = payload("one\ntwo");

function draftOf(over: Partial<ComposerDraft>): ComposerDraft {
  return { ...EMPTY_COMPOSER_DRAFT, ...over };
}

test("insertPaste into an empty draft pairs the token with its payload", () => {
  const { draft } = insertPaste(EMPTY_COMPOSER_DRAFT, 0, 0, P);
  assert.equal(draft.text, "[Pasted text #1 +3 lines]");
  assert.deepEqual(draft.pastes, [P]);
  assert.deepEqual(draft.imageRefs, []);
});

test("a paste token and an image token coexist with independent numbering", () => {
  // Start with one image token + its ref, then paste a large payload after it.
  const withImage = draftOf({ text: "look [Image #1]", imageRefs: [IMG] });
  const { draft } = insertPaste(withImage, withImage.text.length, withImage.text.length, P);

  assert.equal(draft.text, "look [Image #1] [Pasted text #1 +3 lines]");
  assert.deepEqual(draft.imageRefs, [IMG]);
  assert.deepEqual(draft.pastes, [P]);
  assert.deepEqual(
    parseImageTokens(draft.text).map((s) => s.num),
    [1],
    "the image token keeps #1",
  );
  assert.deepEqual(
    parsePasteTokens(draft.text).map((s) => s.num),
    [1],
    "the paste token is its own #1, not #2",
  );
});

test("renumbering pasted-text tokens does not disturb image-token numbering", () => {
  // Two paste tokens around one image token; remove the first paste token.
  const base = draftOf({
    text: "[Pasted text #1 +3 lines] [Image #1] [Pasted text #2 +2 lines]",
    imageRefs: [IMG],
    pastes: [P, Q],
  });
  // Raw edit deletes the FIRST paste token (selection delete).
  const synced = syncComposerDraft(base, " [Image #1] [Pasted text #2 +2 lines]");

  assert.deepEqual(synced.pastes, [Q], "the deleted paste token drops the right payload");
  assert.deepEqual(synced.imageRefs, [IMG], "the image ref is untouched");
  assert.deepEqual(
    parsePasteTokens(synced.text).map((s) => s.num),
    [1],
    "the surviving paste token renumbers to #1",
  );
  assert.deepEqual(
    parseImageTokens(synced.text).map((s) => s.num),
    [1],
    "the image token stays #1",
  );
});

test("multiple paste tokens renumber in reading order on a middle insert", () => {
  const base = draftOf({
    text: "[Pasted text #1 +3 lines] [Pasted text #2 +2 lines]",
    pastes: [P, Q],
  });
  const at = "[Pasted text #1 +3 lines] ".length;
  const mid = payload("inserted\npayload");
  const { draft } = insertPaste(base, at, at, mid);
  assert.deepEqual(draft.pastes, [P, mid, Q]);
  assert.deepEqual(
    parsePasteTokens(draft.text).map((s) => s.num),
    [1, 2, 3],
  );
});

test("backspace removes an adjacent paste token + payload, leaving image tokens intact", () => {
  const base = draftOf({
    text: "[Image #1] [Pasted text #1 +3 lines]",
    imageRefs: [IMG],
    pastes: [P],
  });
  const cursor = base.text.length;
  const result = removeAdjacentToken(base, cursor, -1);
  assert.ok(result);
  // A token at the very end leaves its leading space (no following space to collapse into).
  assert.equal(result.draft.text, "[Image #1] ");
  assert.deepEqual(result.draft.pastes, []);
  assert.deepEqual(result.draft.imageRefs, [IMG], "the image token + ref survive");
});

test("backspace removes an adjacent image token + ref, leaving paste tokens intact", () => {
  const base = draftOf({
    text: "[Pasted text #1 +3 lines] [Image #1]",
    imageRefs: [IMG],
    pastes: [P],
  });
  const cursor = base.text.length;
  const result = removeAdjacentToken(base, cursor, -1);
  assert.ok(result);
  // A token at the very end leaves its leading space (no following space to collapse into).
  assert.equal(result.draft.text, "[Pasted text #1 +3 lines] ");
  assert.deepEqual(result.draft.imageRefs, []);
  assert.deepEqual(result.draft.pastes, [P], "the paste token + payload survive");
});

test("a selection delete that removes both kinds drops both paired sets", () => {
  const base = draftOf({
    text: "keep [Image #1] [Pasted text #1 +3 lines] tail",
    imageRefs: [IMG],
    pastes: [P],
  });
  const synced = syncComposerDraft(base, "keep tail");
  assert.deepEqual(synced.imageRefs, []);
  assert.deepEqual(synced.pastes, []);
  assert.equal(synced.text, "keep tail");
});

test("clearing the draft drops both image refs and paste payloads", () => {
  const base = draftOf({
    text: "[Image #1] [Pasted text #1 +3 lines]",
    imageRefs: [IMG],
    pastes: [P],
  });
  const synced = syncComposerDraft(base, "");
  assert.deepEqual(synced, EMPTY_COMPOSER_DRAFT);
});

test("inserting an image after a paste token keeps the paste payload aligned", () => {
  const base = draftOf({ text: "[Pasted text #1 +3 lines]", pastes: [P] });
  const { draft } = insertImages(base, base.text.length, base.text.length, [IMG]);
  assert.equal(draft.text, "[Pasted text #1 +3 lines] [Image #1]");
  assert.deepEqual(draft.pastes, [P]);
  assert.deepEqual(draft.imageRefs, [IMG]);
});
