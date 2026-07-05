import assert from "node:assert/strict";
import { render } from "@testing-library/react";
import { test } from "vitest";
import { formatOutputTokenCell, TurnStatusHeader } from "./turn-status-header";

/**
 * The pinned live turn-status line (plan 50). Pins the LINE CONTRACT it owns: the `↓ <count> tokens`
 * output cell format, the hidden-token-cell rule (no cell until an output count is handed in), the
 * redundancy rule (the trailing engine state is dropped when it already equals the headline), and the
 * inherited `ShimmerText` a11y (announced base label + aria-hidden `motion-reduce` overlay).
 */

/** The parenthetical metrics text (the muted `(…)` span), or "" when there is no parenthetical. */
function parenthetical(container: HTMLElement): string {
  const text = container.textContent ?? "";
  const match = text.match(/\(([^)]*)\)/);
  return match?.[1] ?? "";
}

test("formatOutputTokenCell prefixes the ↓ glyph and abbreviates via fmtTokens", () => {
  assert.equal(formatOutputTokenCell(2600), "↓ 2.6k tokens");
  assert.equal(formatOutputTokenCell(340), "↓ 340 tokens");
  assert.equal(formatOutputTokenCell(0), "↓ 0 tokens");
});

test("a task headline shows the distinct engine state cell", () => {
  const { container } = render(
    <TurnStatusHeader
      headline="Adding schemas and tests…"
      startedAt={Date.now()}
      outputTokens={2600}
      state="thinking"
    />,
  );
  const cells = parenthetical(container);
  assert.match(cells, /↓ 2\.6k tokens/);
  assert.match(cells, /thinking/);
  // The headline is announced beside the parenthetical.
  assert.match(container.textContent ?? "", /Adding schemas and tests…/);
});

test("redundancy rule: the state cell is dropped when it equals the headline", () => {
  const { container } = render(
    <TurnStatusHeader
      headline="thinking"
      startedAt={Date.now()}
      outputTokens={2600}
      state="thinking"
    />,
  );
  const cells = parenthetical(container);
  assert.match(cells, /↓ 2\.6k tokens/);
  // "thinking" appears once (as the headline), never again as a trailing state cell.
  assert.equal(cells.includes("thinking"), false, "no redundant trailing state cell");
});

test("the ↓ token cell is hidden until an output count is supplied", () => {
  const { container } = render(
    <TurnStatusHeader headline="Working" startedAt={Date.now()} state="Working" />,
  );
  const cells = parenthetical(container);
  assert.equal(cells.includes("↓"), false, "no token cell before the first progress snapshot");
  assert.equal(cells.includes("tokens"), false);
});

test("no parenthetical is rendered when there are no metrics cells", () => {
  const { container } = render(<TurnStatusHeader headline="Working" />);
  assert.equal(parenthetical(container), "", "no elapsed, no tokens, no distinct state -> no (…)");
});

test("reduced motion: the headline shimmer overlay carries motion-reduce:animate-none", () => {
  // Under prefers-reduced-motion the shimmer band stops animating while the solid base label stays
  // readable (the ShimmerText structural guarantee the header inherits).
  const { container } = render(
    <TurnStatusHeader headline="thinking" startedAt={Date.now()} outputTokens={2600} />,
  );
  const overlay = container.querySelector("[aria-hidden].shimmer");
  assert.ok(overlay?.classList.contains("motion-reduce:animate-none"));
});

test("the headline inherits ShimmerText a11y: announced base + aria-hidden motion-reduce overlay", () => {
  const { container } = render(<TurnStatusHeader headline="reading src/foo.ts" />);
  const overlay = container.querySelector("[aria-hidden].shimmer");
  assert.ok(overlay, "the headline must render a shimmer overlay");
  assert.ok(overlay?.classList.contains("motion-reduce:animate-none"));
  // Exactly one announced (non-aria-hidden) copy of the headline.
  const announced = [...container.querySelectorAll("span")].filter(
    (el) => el.textContent === "reading src/foo.ts" && el.getAttribute("aria-hidden") === null,
  );
  assert.equal(announced.length, 1);
});
