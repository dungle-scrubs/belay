import assert from "node:assert/strict";
import type { ArtifactRef } from "@belay/session";
import { act, renderHook, waitFor } from "@testing-library/react";
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
    clipboardData: { files, getData: () => "" },
    preventDefault: () => {},
  } as unknown as ClipboardEvent<HTMLTextAreaElement>;
}

/** A text-only paste event (no files), carrying `text` as the `text/plain` clipboard payload. */
function textPasteEvent(
  text: string,
  prevented = { value: false },
): ClipboardEvent<HTMLTextAreaElement> {
  return {
    clipboardData: {
      files: [] as File[],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
    preventDefault: () => {
      prevented.value = true;
    },
  } as unknown as ClipboardEvent<HTMLTextAreaElement>;
}

const BIG_PASTE = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");

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

test("pasting large plain text inserts a [Pasted text #N] token paired to the exact payload", () => {
  const { result } = renderHook(() => useComposer());
  const prevented = { value: false };
  act(() => result.current.onPaste(textPasteEvent(BIG_PASTE, prevented)));

  assert.equal(prevented.value, true, "the browser paste is intercepted");
  assert.equal(result.current.draft, "[Pasted text #1 +40 lines]");
  assert.equal(result.current.pastes.length, 1);
  assert.equal(result.current.pastes[0]?.text, BIG_PASTE, "the exact payload is preserved");
});

test("pasting small plain text falls through as literal browser text", () => {
  const { result } = renderHook(() => useComposer());
  const prevented = { value: false };
  act(() => result.current.onPaste(textPasteEvent("just a short note", prevented)));

  assert.equal(prevented.value, false, "a small paste is NOT intercepted (browser inserts it)");
  assert.equal(result.current.draft, "", "no token is inserted for small text");
  assert.equal(result.current.pastes.length, 0);
});

test("large text paste on the shell lane stays literal (no token)", () => {
  const { result } = renderHook(() => useComposer());
  act(() => result.current.setDraft("!"));
  const prevented = { value: false };
  act(() => result.current.onPaste(textPasteEvent(BIG_PASTE, prevented)));

  assert.equal(prevented.value, false, "shell mode keeps pasted command text literal (D-006)");
  assert.equal(result.current.pastes.length, 0);
});

test("a mixed clipboard with image files still routes to image intake, not a paste token", async () => {
  const { result } = renderHook(() => useComposer());
  act(() =>
    result.current.onPaste({
      clipboardData: {
        files: [imageFile("a.png")],
        getData: (type: string) => (type === "text/plain" ? BIG_PASTE : ""),
      },
      preventDefault: () => {},
    } as unknown as ClipboardEvent<HTMLTextAreaElement>),
  );

  await waitFor(() => assert.equal(result.current.imageRefs.length, 1));
  assert.equal(
    result.current.draft,
    "[Image #1]",
    "files win: the image token lands, no paste token",
  );
  assert.equal(result.current.pastes.length, 0);
});

test("a large paste then a raw delete of its token drops the paired payload", () => {
  const { result } = renderHook(() => useComposer());
  act(() => result.current.onPaste(textPasteEvent(BIG_PASTE)));
  assert.equal(result.current.pastes.length, 1);

  act(() => result.current.setDraft(""));
  assert.equal(result.current.pastes.length, 0, "deleting the token drops its hidden payload");
});

test("a secret-looking paste never floods the visible draft, stays inspectable, and is removable", () => {
  const secret = ["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG", "token: ghp_0123456789abcdef"]
    .concat(Array.from({ length: 30 }, (_, i) => `export VAR_${i}=value-${i}`))
    .join("\n");
  const { result } = renderHook(() => useComposer());
  act(() => result.current.onPaste(textPasteEvent(secret)));

  // The secret bytes are NOT in the visible draft text - only the compact token is.
  assert.equal(result.current.draft, `[Pasted text #1 +${secret.split("\n").length} lines]`);
  assert.ok(!result.current.draft.includes("AWS_SECRET"), "no secret bytes leak into the textarea");
  // It stays inspectable via the paired payload (exact bytes preserved for the inspection UI).
  assert.equal(result.current.pastes[0]?.text, secret, "the exact payload is held for inspection");
  // And it is removable BEFORE submit: deleting the token drops the payload entirely (no orphan).
  act(() => result.current.setDraft(""));
  assert.equal(
    result.current.pastes.length,
    0,
    "removing the token leaves no hidden secret behind",
  );
});
