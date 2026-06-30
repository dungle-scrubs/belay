import assert from "node:assert/strict";
import { fireEvent, render } from "@testing-library/react";
import type { ArtifactRef } from "@trevor/session";
import { test } from "vitest";
import { MessageImages } from "./message-images";

/**
 * D-092 M4: the transcript image set. Pins the 200px contained tile cap, the container-query layout
 * (mobile grid -> tablet flex-wrap), image grouping, click-to-open with the set index, and the
 * broken/non-image file-row fallback.
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
  const { container } = render(<MessageImages images={[A, B]} others={[]} srcOf={src} />);
  const imgs = container.querySelectorAll("img");
  assert.equal(imgs.length, 2, "an image per image artifact");
  for (const img of imgs) {
    assert.ok(img.className.includes("object-contain"), "images are contained, not cropped");
  }
  assert.ok(container.querySelector('[aria-label="message images"]'), "the images form one set");
});

test("each tile is capped at 200px on either side, regardless of count", () => {
  for (const images of [[A], [A, B]]) {
    const { container } = render(<MessageImages images={images} others={[]} srcOf={src} />);
    const img = container.querySelector("img");
    assert.ok(img?.className.includes("max-h-[200px]"), "200px height cap");
    assert.ok(img?.className.includes("max-w-[200px]"), "200px width cap");
  }
});

test("the set lays out as a container-query grid that becomes a flex-wrap row at tablet width", () => {
  const { container } = render(<MessageImages images={[A, B]} others={[]} srcOf={src} />);
  const section = container.querySelector('[aria-label="message images"]');
  assert.ok(section?.className.includes("grid-cols-2"), "mobile two-column grid");
  assert.ok(section?.className.includes("@md:flex"), "tablet+ flex-wrap row");
  assert.ok(section?.className.includes("gap-2"), "row + column gap in all cases");
});

test("clicking an image opens the carousel at its set index", () => {
  const opened: number[] = [];
  const { container } = render(
    <MessageImages images={[A, B]} others={[]} srcOf={src} onOpen={(i) => opened.push(i)} />,
  );
  const buttons = container.querySelectorAll('button[aria-label^="open image"]');
  (buttons[1] as HTMLButtonElement).click();
  assert.deepEqual(opened, [1], "the second image opens at index 1");
});

test("a broken image degrades to a file row, not a broken-image icon", () => {
  const { container } = render(<MessageImages images={[A]} others={[]} srcOf={src} />);
  const img = container.querySelector("img") as HTMLImageElement;
  fireEvent.error(img);
  assert.equal(container.querySelector("img"), null, "the broken <img> is gone");
  const link = container.querySelector(
    'a[href="mem://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]',
  );
  assert.ok(link, "it falls back to a file/link row");
});

test("a non-image artifact renders as a file row, never an image", () => {
  const { container } = render(<MessageImages images={[]} others={[DOC]} srcOf={src} />);
  assert.equal(container.querySelector("img"), null, "no <img> for a document");
  assert.ok(
    (container.textContent ?? "").includes("spec.pdf"),
    "the document name shows in a file row",
  );
});
