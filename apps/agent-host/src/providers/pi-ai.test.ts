import assert from "node:assert/strict";
import type { ArtifactRef } from "@belay/session";
import { test } from "vitest";
import { toPiAiMessages } from "./pi-ai";
import type { ChatImage, ChatMessage } from "./types";

/**
 * D-092 M6: provider projection over `[Image #N]` tokens. The host strips the literal tokens and
 * interleaves the inlined images at the token positions in reading order; a non-vision turn gets
 * clean stripped text plus an attachments note (never token clutter); a legacy no-token message
 * keeps the old text + appended-images shape. Driven through the exported `toPiAiMessages`.
 */

type Block = { type: string; text?: string; data?: string; mimeType?: string };

function imageRef(seed: string, name?: string): ArtifactRef {
  return {
    kind: "image",
    mimeType: "image/png",
    size: 10,
    hash: seed.repeat(64).slice(0, 64),
    name,
  };
}

function image(ref: ArtifactRef): ChatImage {
  return {
    hash: ref.hash,
    mimeType: ref.mimeType,
    data: `b64-${ref.name ?? ref.hash.slice(0, 4)}`,
  };
}

/** The projected content of the first (user) message: a string or a content-block array. */
function userContentOf(message: ChatMessage): string | Block[] {
  const [projected] = toPiAiMessages([message]) as unknown as { content: string | Block[] }[];
  assert.ok(projected);
  return projected.content;
}

const A = imageRef("a", "a.png");
const B = imageRef("b", "b.png");

test("strips [Image #N] tokens and interleaves images in reading order for a vision turn", () => {
  const content = userContentOf({
    role: "user",
    content: "look at [Image #1] and [Image #2] please",
    artifacts: [A, B],
    images: [image(A), image(B)],
  });

  assert.ok(Array.isArray(content), "a vision turn projects to content blocks");
  const blocks = content as Block[];
  const kinds = blocks.map((b) => b.type);
  assert.deepEqual(
    kinds,
    ["text", "image", "text", "image", "text"],
    "text/image interleave at token spots",
  );
  assert.equal(blocks[1]?.data, "b64-a.png", "first token -> first image");
  assert.equal(blocks[3]?.data, "b64-b.png", "second token -> second image");
  const allText = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  assert.ok(!allText.includes("[Image"), "no literal token clutter reaches the model");
});

test("an attachments-only prompt projects to just the image block(s)", () => {
  const content = userContentOf({
    role: "user",
    content: "[Image #1]",
    artifacts: [A],
    images: [image(A)],
  });
  const blocks = content as Block[];
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["image"],
    "no empty text block, just the image",
  );
});

test("a non-vision turn strips tokens and notes the attachment instead of token clutter", () => {
  // No `images` resolved (non-vision model): the content collapses to clean text + a note.
  const content = userContentOf({
    role: "user",
    content: "what is in [Image #1]?",
    artifacts: [A],
  });
  assert.equal(typeof content, "string", "no images -> a plain string");
  const text = content as string;
  assert.ok(!text.includes("[Image #1]"), "the literal token is stripped");
  assert.ok(text.includes("what is in"), "the prompt text survives");
  assert.ok(
    text.includes("[attachments: a.png]"),
    "the attachment is noted so the model knows it exists",
  );
});

test("documents are noted, never tokened, alongside an inlined image", () => {
  const doc: ArtifactRef = {
    kind: "document",
    mimeType: "application/pdf",
    size: 20,
    hash: "d".repeat(64),
    name: "spec.pdf",
  };
  const content = userContentOf({
    role: "user",
    content: "[Image #1] see attached",
    artifacts: [A, doc],
    images: [image(A)],
  });
  const blocks = content as Block[];
  assert.ok(
    blocks.some((b) => b.type === "image"),
    "the image inlines",
  );
  const note = blocks.map((b) => b.text ?? "").join("");
  assert.ok(note.includes("[attachments: spec.pdf]"), "the document rides as a note, not a token");
});

test("a legacy message with no tokens keeps text + appended images (old decode compatibility)", () => {
  const content = userContentOf({
    role: "user",
    content: "old style attachment",
    artifacts: [A],
    images: [image(A)],
  });
  const blocks = content as Block[];
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["text", "image"],
    "text first, image appended",
  );
  assert.equal(blocks[0]?.text, "old style attachment");
});

test("a plain text message with no artifacts projects to a plain string", () => {
  const content = userContentOf({ role: "user", content: "just text" });
  assert.equal(content, "just text");
});

test("expands a [Pasted text #N] token into its exact payload at the token position", () => {
  const payload = "line one\nline two\nline three";
  const content = userContentOf({
    role: "user",
    content: "here is the log [Pasted text #1 +3 lines] - what failed?",
    pastes: [{ text: payload }],
  });
  assert.equal(
    content,
    `here is the log ${payload} - what failed?`,
    "the payload lands where the token was, and no placeholder leaks",
  );
  assert.ok(typeof content === "string" && !content.includes("[Pasted text"), "no token clutter");
});

test("multiple paste tokens expand to their payloads in reading order", () => {
  const content = userContentOf({
    role: "user",
    content: "first [Pasted text #1 +1 lines] then [Pasted text #2 +1 lines]",
    pastes: [{ text: "ALPHA" }, { text: "BETA" }],
  });
  assert.equal(content, "first ALPHA then BETA");
});

test("a paste token with no paired payload drops to empty (legacy / restored message)", () => {
  const content = userContentOf({
    role: "user",
    content: "see [Pasted text #1 +2 lines] here",
    // No `pastes`: the placeholder must not leak to the model.
  });
  assert.equal(content, "see  here");
  assert.ok(typeof content === "string" && !content.includes("[Pasted text"), "no leak");
});

test("paste tokens expand BEFORE image interleaving when a turn carries both", () => {
  const content = userContentOf({
    role: "user",
    content: "log [Pasted text #1 +1 lines] and image [Image #1]",
    pastes: [{ text: "PAYLOAD" }],
    artifacts: [A],
    images: [image(A)],
  });
  assert.ok(Array.isArray(content), "the image turn still projects to blocks");
  const blocks = content as Block[];
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["text", "image"],
    "the expanded paste text precedes the inlined image",
  );
  assert.equal(blocks[0]?.text, "log PAYLOAD and image ", "the paste payload is inlined as text");
  assert.ok(!(blocks[0]?.text ?? "").includes("[Pasted text"), "no paste placeholder leaks");
});
