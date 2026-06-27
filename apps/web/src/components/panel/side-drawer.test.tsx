import assert from "node:assert/strict";
import { fireEvent, render } from "@testing-library/react";
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

test("the same glyph backs the collapse affordance with its own label", () => {
  let toggled = 0;
  const { getByLabelText } = render(
    <DrawerToggle side="left" label="Collapse sessions sidebar" onClick={() => (toggled += 1)} />,
  );
  const btn = getByLabelText("Collapse sessions sidebar");
  fireEvent.click(btn);
  assert.equal(toggled, 1, "the collapse affordance fires its toggle");
});
