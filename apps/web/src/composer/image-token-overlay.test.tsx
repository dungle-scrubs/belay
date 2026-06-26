import assert from "node:assert/strict";
import { fireEvent, render } from "@testing-library/react";
import type { ArtifactRef } from "@trevor/session";
import { test } from "vitest";
import { ImageTokenOverlay } from "./image-token-overlay";

/**
 * D-092 M1: the composer overlay renders `[Image #N]` token chips with accessible labels + hover
 * previews over a real, editable textarea. These pin token rendering, the a11y labels, the upload
 * indicator, and that edits pass through (the textarea owns the caret/typing).
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

const REF_A = imageRef("a", "diagram.png");
const REF_B = imageRef("b", "shot.png");
const noop = () => {};

test("renders a highlighted token chip per [Image #N] over the textarea text", () => {
  const { container } = render(
    <ImageTokenOverlay
      value="see [Image #1] and [Image #2]"
      refs={[REF_A, REF_B]}
      onChange={noop}
    />,
  );
  assert.ok(container.querySelector('[data-image-token="1"]'), "token 1 chip renders");
  assert.ok(container.querySelector('[data-image-token="2"]'), "token 2 chip renders");
  // The accessible text lives in the textarea (the mirror is aria-hidden decoration).
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  assert.equal(textarea.value, "see [Image #1] and [Image #2]");
});

test("the textarea holds the full draft text including tokens (caret/editing live there)", () => {
  const { container } = render(
    <ImageTokenOverlay value="hi [Image #1]" refs={[REF_A]} onChange={noop} />,
  );
  const textarea = container.querySelector("textarea");
  assert.ok(textarea);
  assert.equal((textarea as HTMLTextAreaElement).value, "hi [Image #1]");
});

test("typing in the textarea passes the new value through onChange", () => {
  let latest = "";
  const { container } = render(
    <ImageTokenOverlay value="hi" refs={[]} onChange={(v) => (latest = v)} />,
  );
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: "hi there" } });
  assert.equal(latest, "hi there");
});

test("shows the uploading indicator while uploads are in flight", () => {
  const { container } = render(
    <ImageTokenOverlay value="x" refs={[]} onChange={noop} uploading={2} />,
  );
  assert.ok(
    (container.textContent ?? "").includes("uploading 2"),
    "the pending-upload count shows",
  );
});

test("a token preview uses the injected srcOf (so no blob store is needed)", () => {
  const { container } = render(
    <ImageTokenOverlay
      value="[Image #1]"
      refs={[REF_A]}
      onChange={noop}
      srcOf={() => "data:image/png;base64,AAA"}
    />,
  );
  const img = container.querySelector("img");
  assert.ok(img, "the preview image renders");
  assert.equal(img?.getAttribute("src"), "data:image/png;base64,AAA");
});
