import assert from "node:assert/strict";
import { fireEvent, render } from "@testing-library/react";
import type { PastePayload } from "@trevor/session";
import { test, vi } from "vitest";
import { PasteTokenOverlay } from "./paste-token-overlay";

/**
 * 10-large-paste-placeholders M4: the paste-token overlay renders `[Pasted text #N +M lines]` chips
 * over a real, editable textarea, each with an inspection popover (line + char counts, a capped
 * payload preview, copy + remove actions). Pins token rendering, the popover content, the actions,
 * and that edits pass through (the textarea owns the caret/typing). <!-- D-007 -->
 */

const PAYLOAD: PastePayload = { text: "alpha\nbeta\ngamma" };
const noop = () => {};

test("renders a highlighted chip per [Pasted text #N] over the textarea text", () => {
  const { container } = render(
    <PasteTokenOverlay
      value="see [Pasted text #1 +3 lines] now"
      pastes={[PAYLOAD]}
      onChange={noop}
    />,
  );
  assert.ok(container.querySelector('[data-paste-token="1"]'), "the paste chip renders");
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  assert.equal(
    textarea.value,
    "see [Pasted text #1 +3 lines] now",
    "the textarea holds the tokens",
  );
});

test("the inspection popover shows line + character counts derived from the payload", () => {
  const { container } = render(
    <PasteTokenOverlay value="[Pasted text #1 +3 lines]" pastes={[PAYLOAD]} onChange={noop} />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("3 lines"), "the line count shows");
  assert.ok(text.includes(`${PAYLOAD.text.length} chars`), "the character count shows");
});

test("the popover preview shows the exact payload text in a capped pre", () => {
  const { container } = render(
    <PasteTokenOverlay value="[Pasted text #1 +3 lines]" pastes={[PAYLOAD]} onChange={noop} />,
  );
  const pre = container.querySelector("pre") as HTMLPreElement;
  assert.ok(pre, "a preview pre renders");
  assert.equal(pre.textContent, PAYLOAD.text, "the full payload is shown for inspection");
  assert.ok(pre.className.includes("max-h-"), "the preview height is capped");
  assert.ok(pre.className.includes("overflow-auto"), "overflow scrolls rather than blowing out");
});

test("the copy action writes the exact payload to the clipboard", () => {
  const writeText = vi.fn();
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const { getByLabelText } = render(
    <PasteTokenOverlay value="[Pasted text #1 +3 lines]" pastes={[PAYLOAD]} onChange={noop} />,
  );
  fireEvent.click(getByLabelText("Copy pasted text"));
  assert.equal(writeText.mock.calls[0]?.[0], PAYLOAD.text);
  vi.unstubAllGlobals();
});

test("the remove action calls onRemove with the token's reading-order index", () => {
  let removed: number | null = null;
  const { getAllByLabelText } = render(
    <PasteTokenOverlay
      value="[Pasted text #1 +3 lines] and [Pasted text #2 +2 lines]"
      pastes={[PAYLOAD, { text: "one\ntwo" }]}
      onChange={noop}
      onRemove={(index) => {
        removed = index;
      }}
    />,
  );
  fireEvent.click(getAllByLabelText("Remove pasted text")[1] as HTMLElement);
  assert.equal(removed, 1, "the second chip removes index 1");
});

test("no remove button when onRemove is omitted (read-only inspection)", () => {
  const { queryByLabelText } = render(
    <PasteTokenOverlay value="[Pasted text #1 +3 lines]" pastes={[PAYLOAD]} onChange={noop} />,
  );
  assert.equal(queryByLabelText("Remove pasted text"), null, "remove is opt-in via onRemove");
});

test("typing in the textarea passes the new value through onChange", () => {
  let latest = "";
  const { container } = render(
    <PasteTokenOverlay value="hi" pastes={[]} onChange={(v) => (latest = v)} />,
  );
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: "hi there" } });
  assert.equal(latest, "hi there");
});

test("mixed image/paste tokens render distinct chips (frost image, purple paste)", () => {
  const { container } = render(
    <PasteTokenOverlay
      value="look [Image #1] then [Pasted text #1 +3 lines]"
      pastes={[PAYLOAD]}
      onChange={noop}
    />,
  );
  assert.ok(container.querySelector('[data-image-token="1"]'), "the image token is marked");
  assert.ok(container.querySelector('[data-paste-token="1"]'), "the paste token is marked");
});
