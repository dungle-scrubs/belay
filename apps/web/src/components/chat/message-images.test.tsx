import assert from "node:assert/strict";
import type { ArtifactRef } from "@belay/session";
import { fireEvent, render } from "@testing-library/react";
import { test } from "vitest";
import { MessageImages } from "./message-images";

/**
 * D-092 M4 + plan 34: the transcript image set. Pins the single-image taller cap vs the multi-image
 * shorter cap, the container-query layout (mobile grid -> tablet flex-wrap), image grouping,
 * click-to-open with the set index, the loading shimmer + reserved footprint, accessible labels/alt,
 * the single-image filename caption, and the broken/non-image file-row fallback.
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

test("a set of images uses the shorter 200px tile cap so the grid stays scannable", () => {
  const { container } = render(<MessageImages images={[A, B]} others={[]} srcOf={src} />);
  const img = container.querySelector("img");
  assert.ok(img?.className.includes("max-h-[200px]"), "200px height cap for a set");
  assert.ok(img?.className.includes("max-w-[200px]"), "200px width cap for a set");
});

test("a single image uses the taller cap so a screenshot stays legible", () => {
  const { container } = render(<MessageImages images={[A]} others={[]} srcOf={src} />);
  const img = container.querySelector("img");
  assert.ok(img?.className.includes("max-h-[360px]"), "single image gets the taller 360px cap");
  assert.ok(img?.className.includes("object-contain"), "still contained, never cropped");
  assert.ok(!img?.className.includes("max-w-[200px]"), "not clamped to the 200px set width");
});

test("a tile reserves a footprint and shimmers until the image decodes, then swaps in without a jump", () => {
  const { container } = render(<MessageImages images={[A]} others={[]} srcOf={src} />);
  const img = container.querySelector("img") as HTMLImageElement;
  // Before the image loads: a shimmer placeholder fills the reserved frame and the image is hidden.
  assert.ok(container.querySelector(".skeleton"), "a loading shimmer is shown while decoding");
  assert.ok(img.className.includes("opacity-0"), "the undecoded image is not yet visible");
  assert.ok(
    container.querySelector("button")?.className.includes("min-h-[200px]"),
    "the frame reserves a minimum height so the row never collapses then jumps",
  );
  fireEvent.load(img);
  assert.equal(container.querySelector(".skeleton"), null, "the shimmer clears once decoded");
  assert.ok(
    (container.querySelector("img") as HTMLImageElement).className.includes("opacity-100"),
    "the decoded image fades in",
  );
});

test("each inline image tile is an accessible button with a stable label and alt", () => {
  const { container } = render(<MessageImages images={[A, B]} others={[]} srcOf={src} />);
  const buttons = container.querySelectorAll('button[aria-label^="open image"]');
  assert.equal(
    buttons.length,
    2,
    "every image is a keyboard-focusable button (Enter/Space open it)",
  );
  assert.equal(
    buttons[0]?.getAttribute("aria-label"),
    "open image 1: a.png",
    "the label is stable and names the image",
  );
  const img = container.querySelector("img");
  assert.equal(img?.getAttribute("alt"), "a.png", "alt text falls back to the artifact name");
});

test("an image with no name still carries a stable positional label and alt", () => {
  const nameless: ArtifactRef = { ...A, name: undefined };
  const { container } = render(<MessageImages images={[nameless]} others={[]} srcOf={src} />);
  assert.equal(
    container.querySelector("button")?.getAttribute("aria-label"),
    "open image 1",
    "the label falls back to the set position",
  );
  assert.equal(container.querySelector("img")?.getAttribute("alt"), "image 1");
});

test("a single image surfaces its filename as a subtle caption; a set keeps names off the tiles", () => {
  const single = render(<MessageImages images={[A]} others={[]} srcOf={src} />);
  assert.ok(
    single.getByText("a.png", { selector: "span" }),
    "a single image shows a visible filename caption",
  );
  single.unmount();

  const set = render(<MessageImages images={[A, B]} others={[]} srcOf={src} />);
  assert.equal(
    set.container.querySelector("span.truncate"),
    null,
    "a set does not caption each tile (names stay in the tooltip/aria-label)",
  );
});

test("a long single-image filename truncates and keeps the full name in its tooltip", () => {
  const longName = "a-really-long-generated-screenshot-filename-that-should-not-overflow.png";
  const long: ArtifactRef = { ...A, name: longName };
  const { getByText } = render(<MessageImages images={[long]} others={[]} srcOf={src} />);
  const caption = getByText(longName, { selector: "span" });
  assert.ok(
    caption.className.includes("truncate"),
    "the caption truncates rather than overflowing",
  );
  assert.ok(caption.className.includes("max-w-"), "and is width-capped so it can't resize the row");
  assert.equal(caption.getAttribute("title"), longName, "the full name stays available on hover");
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
