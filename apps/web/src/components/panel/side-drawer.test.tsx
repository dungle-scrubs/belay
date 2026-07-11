import assert from "node:assert/strict";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { test } from "vitest";
import { DrawerToggle } from "./side-drawer";

/**
 * D-093 M5: the dashboard-icon entry point that opens/focuses the session navigator. The app renders
 * the left `DrawerToggle` in the header strip when the sidebar is collapsed ("Open sessions sidebar")
 * and inside the sidebar header to collapse it ("Collapse sessions sidebar") - the SAME glyph for
 * both. These pin its accessible label, click action, keyboard focusability, and the cursor-pointer
 * affordance, so the entry point stays reachable by pointer and keyboard.
 */

test("the left entry-point toggle is an accessible, labeled button that fires onClick", () => {
  let opened = 0;
  const { getByLabelText } = render(
    <DrawerToggle side="left" label="Open sessions sidebar" onClick={() => (opened += 1)} />,
  );
  const btn = getByLabelText("Open sessions sidebar");
  assert.equal(
    btn.tagName,
    "BUTTON",
    "the entry point is a real button (native keyboard operation)",
  );
  fireEvent.click(btn);
  assert.equal(opened, 1, "clicking the entry point opens the navigator");
});

test("the entry-point toggle is keyboard-focusable and uses cursor-pointer", () => {
  const { getByLabelText } = render(
    <DrawerToggle side="left" label="Open sessions sidebar" onClick={() => {}} />,
  );
  const btn = getByLabelText("Open sessions sidebar") as HTMLButtonElement;
  btn.focus();
  assert.equal(document.activeElement, btn, "the entry point can take keyboard focus");
  // The global cursor-pointer rule is enforced in index.css, but the toggle also declares it directly;
  // a non-pointer cursor here would read as non-interactive.
  assert.ok(btn.className.includes("cursor-pointer"), "the entry point shows a pointer cursor");
});

/** Dispatches a window pointermove at (x, y). jsdom lacks a PointerEvent constructor, so a MouseEvent
 *  (which carries clientX/clientY and can take any type name) stands in for the listener's read. */
function movePointer(x: number, y: number): void {
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y, bubbles: true }));
}

test("a proximity-gated toggle stays hidden until the pointer comes within the radius", async () => {
  const { getByLabelText } = render(
    <DrawerToggle
      side="left"
      label="Open sessions sidebar"
      onClick={() => {}}
      proximityRadius={200}
    />,
  );
  const btn = getByLabelText("Open sessions sidebar");
  // Hidden at rest (no pointer near). It is still in the DOM (queryable, focusable), just faded out.
  assert.ok(btn.className.includes("opacity-0"), "hidden before the pointer approaches");

  // A pointer far from the button (jsdom's rect is at the origin) leaves it hidden.
  movePointer(600, 600);
  await waitFor(() => assert.ok(btn.className.includes("opacity-0")));

  // A pointer within 200px of the button reveals it.
  movePointer(10, 10);
  await waitFor(() =>
    assert.ok(!btn.className.includes("opacity-0"), "revealed within the radius"),
  );

  // Moving back out hides it again.
  movePointer(600, 600);
  await waitFor(() =>
    assert.ok(btn.className.includes("opacity-0"), "hidden again once out of range"),
  );
});

test("a proximity-gated toggle reveals on keyboard focus even when the pointer is far", async () => {
  const { getByLabelText } = render(
    <DrawerToggle side="right" label="Open panel" onClick={() => {}} proximityRadius={200} />,
  );
  const btn = getByLabelText("Open panel") as HTMLButtonElement;
  movePointer(800, 800); // pointer nowhere near
  await waitFor(() => assert.ok(btn.className.includes("opacity-0")));
  btn.focus();
  await waitFor(() => assert.ok(!btn.className.includes("opacity-0"), "focus keeps it reachable"));
});

test("without proximityRadius the toggle is always visible (the in-drawer collapse affordance)", () => {
  const { getByLabelText } = render(
    <DrawerToggle side="left" label="Collapse sessions sidebar" onClick={() => {}} />,
  );
  const btn = getByLabelText("Collapse sessions sidebar");
  assert.ok(!btn.className.includes("opacity-0"), "no proximity gating without a radius");
});

test("the same glyph backs the collapse affordance with its own label", () => {
  let toggled = 0;
  const { getByLabelText } = render(
    <DrawerToggle side="left" label="Collapse sessions sidebar" onClick={() => (toggled += 1)} />,
  );
  const btn = getByLabelText("Collapse sessions sidebar");
  fireEvent.click(btn);
  assert.equal(toggled, 1, "the collapse affordance fires its toggle");
});
