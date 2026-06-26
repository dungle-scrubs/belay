import assert from "node:assert/strict";
import { fireEvent, render } from "@testing-library/react";
import type { ArtifactRef } from "@trevor/session";
import { test } from "vitest";
import { MessageImages } from "./message-images";

/**
 * D-092 M4: the transcript image set. Pins responsive contained sizing (single vs set caps), image
 * grouping, click-to-open with the set index, and the broken/non-image file-row fallback.
 */

function imageRef(seed: string, name: string): ArtifactRef {
  return {
    kind: "image",
    mimeType: "image/png",
    size: 10,
    hash: seed.repeat(64).slice(0, 64),
    name,
  };
}

const A = imageRef("a", "a.png");
const B = imageRef("b", "b.png");
const DOC: ArtifactRef = {
  kind: "document",
  mimeType: "application/pdf",
  size: 10,
  hash: "d".repeat(64),
  name: "spec.pdf",
};
const src = (h: string) => `mem://${h}`;

test("renders one contained image per image artifact, grouped in one set", () => {
  const { container } = render(<MessageImages artifacts={[A, B]} srcOf={src} />);
  const imgs = container.querySelectorAll("img");
  assert.equal(imgs.length, 2, "an image per image artifact");
  for (const img of imgs) {
    assert.ok(img.className.includes("object-contain"), "images are contained, not cropped");
  }
  assert.ok(container.querySelector('[aria-label="message images"]'), "the images form one set");
});

test("a single image gets the taller cap; a set gets the shorter cap", () => {
  const single = render(<MessageImages artifacts={[A]} srcOf={src} />);
  assert.ok(
    single.container.querySelector("img")?.className.includes("max-h-96"),
    "single image cap",
  );

  const set = render(<MessageImages artifacts={[A, B]} srcOf={src} />);
  assert.ok(set.container.querySelector("img")?.className.includes("max-h-48"), "image-set cap");
});

test("clicking an image opens the carousel at its set index", () => {
  const opened: number[] = [];
  const { container } = render(
    <MessageImages artifacts={[A, B]} srcOf={src} onOpen={(i) => opened.push(i)} />,
  );
  const buttons = container.querySelectorAll('button[aria-label^="open image"]');
  (buttons[1] as HTMLButtonElement).click();
  assert.deepEqual(opened, [1], "the second image opens at index 1");
});

test("a broken image degrades to a file row, not a broken-image icon", () => {
  const { container } = render(<MessageImages artifacts={[A]} srcOf={src} />);
  const img = container.querySelector("img") as HTMLImageElement;
  fireEvent.error(img);
  assert.equal(container.querySelector("img"), null, "the broken <img> is gone");
  const link = container.querySelector(
    'a[href="mem://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]',
  );
  assert.ok(link, "it falls back to a file/link row");
});

test("a non-image artifact renders as a file row, never an image", () => {
  const { container } = render(<MessageImages artifacts={[DOC]} srcOf={src} />);
  assert.equal(container.querySelector("img"), null, "no <img> for a document");
  assert.ok(
    (container.textContent ?? "").includes("spec.pdf"),
    "the document name shows in a file row",
  );
});
