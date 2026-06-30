import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, test, vi } from "vitest";
import { useVim } from "./use-vim";

/**
 * M5: the Vim <-> global-Escape contract. The global Escape (cancel a run / clear the draft) is a
 * `window` listener; the composer's Vim layer runs FIRST and, when it consumes a key, `stopPropagation`s
 * so the native event never reaches that window listener. So the FIRST Escape in insert/visual mode
 * enters normal mode and does NOT cancel the run behind it; only a SECOND Escape (now normal mode, a
 * passthrough) reaches the global handler. With Vim off, Escape always passes through.
 */

function Harness({ enabled }: { readonly enabled: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const vim = useVim(ref, enabled);
  return (
    <div>
      <span data-testid="mode">{vim.mode}</span>
      <textarea
        ref={ref}
        aria-label="composer"
        defaultValue="hello"
        onKeyDown={(e) => vim.onKeyDown(e)}
      />
    </div>
  );
}

let globalEscapes = 0;
const onWindowEscape = (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    globalEscapes += 1;
  }
};

afterEach(() => {
  window.removeEventListener("keydown", onWindowEscape);
  globalEscapes = 0;
  vi.restoreAllMocks();
});

test("insert-mode Escape enters normal mode and is NOT seen by the global Escape listener", () => {
  window.addEventListener("keydown", onWindowEscape);
  render(<Harness enabled />);
  const composer = screen.getByLabelText("composer");
  assert.equal(screen.getByTestId("mode").textContent, "insert");

  fireEvent.keyDown(composer, { key: "Escape" });
  assert.equal(screen.getByTestId("mode").textContent, "normal", "first Escape -> normal");
  assert.equal(globalEscapes, 0, "Vim consumed it (stopPropagation), so no global cancel");

  // A second Escape in normal mode is a passthrough -> it reaches the global listener (would cancel).
  fireEvent.keyDown(composer, { key: "Escape" });
  assert.equal(screen.getByTestId("mode").textContent, "normal");
  assert.equal(globalEscapes, 1, "normal-mode Escape passes through to the global handler");
});

test("with Vim disabled, Escape passes straight through to the global listener", () => {
  window.addEventListener("keydown", onWindowEscape);
  render(<Harness enabled={false} />);
  fireEvent.keyDown(screen.getByLabelText("composer"), { key: "Escape" });
  assert.equal(globalEscapes, 1);
  assert.equal(screen.getByTestId("mode").textContent, "insert", "disabled stays in insert");
});
