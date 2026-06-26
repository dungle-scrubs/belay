import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ArtifactRef } from "@trevor/session";
import { test } from "vitest";
import { ImageCarousel } from "./image-carousel";

/**
 * D-092 M5: the same-message image carousel. Pins open render, previous/next cycling, keyboard
 * navigation, close, the index/count, and that the set is scoped to exactly the images given.
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
const C = imageRef("c", "c.png");
const src = (h: string) => `mem://${h}`;

/** The alt text of the currently shown carousel image (its name). */
function shownAlt(): string | null {
  return screen.getByRole("dialog").querySelector("img")?.getAttribute("alt") ?? null;
}

function open(images: readonly ArtifactRef[], onOpenChange = () => {}) {
  return render(
    <ImageCarousel images={images} open initialIndex={0} onOpenChange={onOpenChange} srcOf={src} />,
  );
}

test("opens showing the first image and the index/count", () => {
  open([A, B, C]);
  assert.equal(shownAlt(), "a.png", "the initial image shows");
  assert.ok(screen.getByText(/Image 1 of 3/), "the index/count is shown");
});

test("next and previous cycle through the images in order (wrapping)", () => {
  open([A, B, C]);
  fireEvent.click(screen.getByRole("button", { name: "next image" }));
  assert.equal(shownAlt(), "b.png", "next advances");
  fireEvent.click(screen.getByRole("button", { name: "next image" }));
  assert.equal(shownAlt(), "c.png");
  fireEvent.click(screen.getByRole("button", { name: "next image" }));
  assert.equal(shownAlt(), "a.png", "next wraps to the first");
  fireEvent.click(screen.getByRole("button", { name: "previous image" }));
  assert.equal(shownAlt(), "c.png", "previous wraps to the last");
});

test("ArrowRight / ArrowLeft navigate the carousel", () => {
  open([A, B, C]);
  const dialog = screen.getByRole("dialog");
  fireEvent.keyDown(dialog, { key: "ArrowRight" });
  assert.equal(shownAlt(), "b.png");
  fireEvent.keyDown(dialog, { key: "ArrowLeft" });
  assert.equal(shownAlt(), "a.png");
});

test("Escape closes the carousel", () => {
  let isOpen = true;
  render(
    <ImageCarousel
      images={[A, B]}
      open
      initialIndex={0}
      onOpenChange={(o) => {
        isOpen = o;
      }}
      srcOf={src}
    />,
  );
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  assert.equal(isOpen, false, "Escape requests close");
});

test("a single image shows no prev/next controls", () => {
  open([A]);
  assert.equal(screen.queryByRole("button", { name: "next image" }), null);
  assert.equal(screen.queryByRole("button", { name: "previous image" }), null);
  assert.ok(screen.getByText(/Image 1 of 1/));
});

test("the carousel is scoped to exactly the images given (same-message set)", () => {
  open([A, B]);
  assert.ok(screen.getByText(/of 2/), "only this message's two images are in the set");
});
