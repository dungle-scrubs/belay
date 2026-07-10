import assert from "node:assert/strict";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { test, vi } from "vitest";
import { createScrollFollowUi } from "@/hooks/use-scroll-follow";
import { createScrollFollowController } from "@/scroll-follow";
import { JumpToBottom } from "./jump-to-bottom";

/**
 * The jump-to-bottom leaf (Tier 2.4). These pin its store-driven contract: it renders purely from the
 * controller's pin bit + the adapter ui store via its own subscriptions - every state change below is
 * a store mutation with NO parent re-render (the component is rendered exactly once), which is the
 * isolation the leaf exists for.
 */

test("renders from the follow stores without any parent re-render", () => {
  const controller = createScrollFollowController();
  const handle = createScrollFollowUi();
  const onJump = vi.fn();
  render(<JumpToBottom controller={controller} ui={handle.ui} onJump={onJump} />);

  // Pinned at the live edge: no button.
  assert.equal(screen.queryByRole("button"), null);

  // An upward gesture unpins -> the chevron appears, plain (nothing unseen yet).
  act(() => controller.gesture("up"));
  const button = screen.getByRole("button", { name: "Scroll to bottom" });
  assert.equal(button.dataset.unseen, undefined);

  // Content appended below the fold -> the unseen state glows through the same subscription.
  act(() => handle.setHasUnseen(true));
  const unseen = screen.getByRole("button", { name: "Scroll to new content" });
  assert.equal(unseen.dataset.unseen, "true");

  // Clicking routes to the adapter's jump handler (which re-pins + requests the live-edge scroll).
  fireEvent.click(unseen);
  assert.equal(onJump.mock.calls.length, 1);

  // A re-pin (the jump, or a genuine return to the bottom) hides the button again.
  act(() => controller.repin("jump"));
  assert.equal(screen.queryByRole("button"), null);
});
