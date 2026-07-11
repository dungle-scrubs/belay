import assert from "node:assert/strict";
import { fireEvent, render } from "@testing-library/react";
import { test } from "vitest";
import { TakeoverSurface } from "./takeover-surface";

/**
 * The shared conversation-takeover shell: it owns Escape locally (the global Escape is suppressed while
 * a takeover is frontmost) and auto-focuses on mount so Escape works immediately. Pins that Escape
 * returns to the conversation and that the region carries its accessible name.
 */

test("Escape calls onBack (returns to the conversation)", () => {
  let backs = 0;
  const { getByLabelText } = render(
    <TakeoverSurface label="Model chooser" onBack={() => (backs += 1)}>
      <span>body</span>
    </TakeoverSurface>,
  );
  fireEvent.keyDown(getByLabelText("Model chooser"), { key: "Escape" });
  assert.equal(backs, 1);
});

test("auto-focuses the region on mount so Escape works before any click", () => {
  const { getByLabelText } = render(
    <TakeoverSurface label="Archived sessions" onBack={() => {}}>
      <span>body</span>
    </TakeoverSurface>,
  );
  assert.equal(document.activeElement, getByLabelText("Archived sessions"));
});

test("Escape is inert when no onBack is provided", () => {
  const { getByLabelText } = render(
    <TakeoverSurface label="Tangents">
      <span>body</span>
    </TakeoverSurface>,
  );
  // Must not throw when Escape fires without a back handler.
  fireEvent.keyDown(getByLabelText("Tangents"), { key: "Escape" });
  assert.ok(getByLabelText("Tangents"));
});
