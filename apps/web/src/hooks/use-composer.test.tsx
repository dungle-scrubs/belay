import assert from "node:assert/strict";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ArtifactRef } from "@trevor/session";
import type { ClipboardEvent } from "react";
import { test, vi } from "vitest";
import { useComposer } from "./use-composer";

/**
 * D-092 M3: composer image intake. An image becomes an inline `[Image #N]` token paired to its ref
 * (in deterministic reading order); a non-image file keeps the document-chip behavior; and a raw
 * text edit reconciles the refs against the surviving tokens. The token model itself is unit-tested
 * (image-tokens.test.ts); this pins the live-composer wiring over a mocked upload.
 */

vi.mock("../blob", () => ({
  uploadArtifact: (file: File): Promise<ArtifactRef> =>
    Promise.resolve({
      kind: file.type.startsWith("image/") ? "image" : "document",
      mimeType: file.type,
      size: 1,
      hash: file.name.padEnd(64, "0").slice(0, 64),
      name: file.name,
    }),
}));

function imageFile(name: string): File {
  return new File(["x"], name, { type: "image/png" });
}
function docFile(name: string): File {
  return new File(["x"], name, { type: "application/pdf" });
}
function pasteEvent(files: File[]): ClipboardEvent<HTMLTextAreaElement> {
  return {
    clipboardData: { files },
    preventDefault: () => {},
  } as unknown as ClipboardEvent<HTMLTextAreaElement>;
}

test("pasting an image inserts an [Image #N] token paired to its ref", async () => {
  const { result } = renderHook(() => useComposer());
  act(() => result.current.onPaste(pasteEvent([imageFile("a.png")])));

  await waitFor(() => assert.equal(result.current.imageRefs.length, 1));
  assert.equal(result.current.draft, "[Image #1]", "an image token lands in the draft text");
  assert.equal(result.current.imageRefs[0]?.name, "a.png");
  assert.equal(result.current.attachments.length, 0, "an image is a token, not a document chip");
});

test("pasting a document keeps the chip behavior, with no token", async () => {
  const { result } = renderHook(() => useComposer());
  act(() => result.current.onPaste(pasteEvent([docFile("spec.pdf")])));

  await waitFor(() => assert.equal(result.current.attachments.length, 1));
  assert.equal(result.current.draft, "", "a document inserts no image token");
  assert.equal(result.current.imageRefs.length, 0);
});

test("pasting multiple images inserts ordered tokens and refs deterministically", async () => {
  const { result } = renderHook(() => useComposer());
  act(() => result.current.onPaste(pasteEvent([imageFile("a.png"), imageFile("b.png")])));

  await waitFor(() => assert.equal(result.current.imageRefs.length, 2));
  assert.equal(result.current.draft, "[Image #1] [Image #2]");
  assert.deepEqual(
    result.current.imageRefs.map((r) => r.name),
    ["a.png", "b.png"],
    "refs stay in paste order despite parallel uploads",
  );
});

test("a raw edit that deletes a token drops the right ref and renumbers", async () => {
  const { result } = renderHook(() => useComposer());
  act(() => result.current.onPaste(pasteEvent([imageFile("a.png"), imageFile("b.png")])));
  await waitFor(() => assert.equal(result.current.imageRefs.length, 2));

  // Simulate the user selecting + deleting the FIRST token (raw text now holds only token #2).
  act(() => result.current.setDraft("[Image #2]"));

  assert.equal(result.current.imageRefs.length, 1, "the deleted token's ref is dropped");
  assert.equal(result.current.imageRefs[0]?.name, "b.png", "the surviving ref is the right one");
  assert.equal(result.current.draft, "[Image #1]", "the survivor renumbers to reading order");
});

test("clearing the draft clears the image refs too", async () => {
  const { result } = renderHook(() => useComposer());
  act(() => result.current.onPaste(pasteEvent([imageFile("a.png")])));
  await waitFor(() => assert.equal(result.current.imageRefs.length, 1));

  act(() => result.current.setDraft(""));
  assert.equal(result.current.imageRefs.length, 0, "submit/steer clears the draft and its refs");
});
