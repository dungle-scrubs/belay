import assert from "node:assert/strict";
import { render } from "@testing-library/react";
import { test } from "vitest";
import { VIM_MODES } from "@/vim/mode";
import { VimModeIndicator } from "./vim-mode-indicator";

/**
 * M2: the Vim mode indicator. Each mode shows its label with an accessible name, and the pill keeps a
 * stable shape (fixed height + min-width) so a mode change never reflows the composer.
 */

test("renders the mode label uppercased for each mode", () => {
  for (const mode of VIM_MODES) {
    const { getByText, unmount } = render(<VimModeIndicator mode={mode} />);
    // The label text is the raw mode; CSS uppercases it. Match case-insensitively.
    getByText(mode);
    unmount();
  }
});

test("carries an accessible name describing the Vim mode (no visible instructional copy)", () => {
  const { getByLabelText } = render(<VimModeIndicator mode="normal" />);
  const el = getByLabelText("Vim mode: normal");
  // The only visible text is the compact label itself - no sentence-length hint.
  assert.equal(el.textContent, "normal");
});

test("the indicator is a status live region, so a mode change is announced to screen readers (M7)", () => {
  const { getByRole } = render(<VimModeIndicator mode="normal" />);
  const el = getByRole("status");
  assert.equal(el.getAttribute("aria-label"), "Vim mode: normal");
});

test("every mode pill carries the fixed-height + min-width classes (no reflow on mode change)", () => {
  for (const mode of VIM_MODES) {
    const { getByLabelText, unmount } = render(<VimModeIndicator mode={mode} />);
    const el = getByLabelText(`Vim mode: ${mode}`);
    assert.ok(el.className.includes("h-6"), `${mode}: fixed height`);
    assert.ok(el.className.includes("min-w-"), `${mode}: stable min width`);
    unmount();
  }
});
