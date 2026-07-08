import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import { test } from "vitest";
import { ReasoningTrace, reasoningTraceSummary } from "@/components/chat/reasoning-trace";

/**
 * The ghosted reasoning trace (plan 35): a muted, collapsible, streaming-aware disclosure over the
 * `assistant.thinking` string. These lock M1 (shape/states), M2 (streaming + manual precedence +
 * reduced-motion), and M5 (compact affordance + accessibility). The streaming auto-open/collapse
 * state machine itself is `ReasoningGroup`'s (reasoning.tsx); here we assert the transcript-facing
 * surface built on it.
 */

const THINKING = "First I list the constraints, then I sketch a plan.";

/** The single reasoning disclosure trigger (its accessible name always contains the stable label). */
function trigger(): HTMLElement {
  return screen.getByRole("button", { name: /thinking/i });
}

/** Radix mirrors the disclosure open/closed state onto the trigger's `data-state`; robust across
 *  mount/hide semantics. */
function isOpen(): boolean {
  return trigger().getAttribute("data-state") === "open";
}

// --- M1: component shape and states ---

test("M1: an empty, non-streaming trace renders nothing (no stray trigger)", () => {
  const { container } = render(<ReasoningTrace content="   " />);
  assert.equal(container.firstChild, null);
});

test("M1: a settled trace is collapsed by default and reads the stable `thinking` label", () => {
  render(<ReasoningTrace content={THINKING} />);
  assert.ok(trigger(), "the trigger renders");
  assert.equal(isOpen(), false, "settled reasoning is secondary - collapsed by default");
});

test("M1: toggling the trigger expands the reasoning content, then collapses it again", () => {
  render(<ReasoningTrace content={THINKING} />);
  assert.equal(screen.queryByText(THINKING), null, "collapsed content is not shown");

  fireEvent.click(trigger());
  assert.equal(isOpen(), true);
  assert.ok(screen.getByText(THINKING), "expanded content shows the reasoning text");

  fireEvent.click(trigger());
  assert.equal(isOpen(), false);
});

test("M1: manual toggle persists within a mounted message (open stays open across re-render)", () => {
  const { rerender } = render(<ReasoningTrace content={THINKING} />);
  fireEvent.click(trigger());
  assert.equal(isOpen(), true);
  // A benign re-render (e.g. meta arriving) must not reset the user's manual open choice.
  rerender(<ReasoningTrace content={`${THINKING} More.`} />);
  assert.equal(isOpen(), true);
});

test("M1: markdown-rich reasoning renders real markdown when expanded", () => {
  const { container } = render(
    <ReasoningTrace content={"# Heading\n\n- one\n- two\n\n`code`"} defaultOpen />,
  );
  assert.ok(container.querySelector("h1"), "a heading element is produced");
  assert.ok(container.querySelector("li"), "list items render");
  assert.ok(container.querySelector("code"), "inline code renders");
});

test("M1: long reasoning is capped with an internal scroll box (never floods the transcript)", () => {
  const long = Array.from({ length: 80 }, (_, i) => `reasoning line ${i}`).join("\n");
  const { container } = render(<ReasoningTrace content={long} defaultOpen />);
  const scroller = container.querySelector('[data-slot="reasoning-text"]');
  assert.ok(scroller, "the reasoning text sits in its own scroll container");
  assert.match(scroller?.className ?? "", /overflow-y-auto/);
  assert.match(scroller?.className ?? "", /max-h-/);
});

test("M1: fade overlays use the surrounding transcript background token", () => {
  const { container } = render(<ReasoningTrace content={THINKING} streaming />);
  const fades = container.querySelectorAll('[data-slot="reasoning-fade"]');
  assert.equal(fades.length, 2, "streaming preview has top and bottom fade overlays");
  for (const fade of fades) {
    assert.match(fade.className, /--trevor-reasoning-fade-bg/);
  }
});

test("M1: expanded reasoning text is selectable/copyable (not aria-hidden scaffolding)", () => {
  render(<ReasoningTrace content={THINKING} defaultOpen />);
  const text = screen.getByText(THINKING);
  assert.equal(
    text.closest("[aria-hidden]"),
    null,
    "the reasoning prose is real selectable text, not an aria-hidden decoration",
  );
});

// --- M2: streaming behavior ---

test("M2: an actively streaming trace auto-opens with a shimmering trigger", () => {
  const { container } = render(<ReasoningTrace content={THINKING} streaming />);
  assert.equal(isOpen(), true, "streaming reasoning auto-opens");
  const shimmer = container.querySelector('[data-slot="reasoning-trigger-shimmer"]');
  assert.ok(shimmer, "the trigger shimmers while streaming");
});

test("M2: an empty trace still shows the trigger while streaming (reasoning is arriving)", () => {
  render(<ReasoningTrace content="" streaming />);
  assert.ok(trigger(), "a streaming trace renders its trigger even before text arrives");
});

test("M2: the trace auto-collapses once streaming completes", () => {
  const { rerender } = render(<ReasoningTrace content={THINKING} streaming />);
  assert.equal(isOpen(), true);
  rerender(<ReasoningTrace content={THINKING} streaming={false} />);
  assert.equal(isOpen(), false, "settling collapses the auto-opened trace");
});

test("M2: a manual toggle wins over streaming auto-state permanently", () => {
  const { rerender } = render(<ReasoningTrace content={THINKING} streaming />);
  // The user closes it mid-stream...
  fireEvent.click(trigger());
  assert.equal(isOpen(), false);
  // ...and it stays closed even though it is still streaming.
  rerender(<ReasoningTrace content={`${THINKING} more`} streaming />);
  assert.equal(isOpen(), false, "manual choice takes over the streaming auto-open");
});

test("M2: the shimmer is disabled under reduced motion", () => {
  const { container } = render(<ReasoningTrace content={THINKING} streaming />);
  const shimmer = container.querySelector('[data-slot="reasoning-trigger-shimmer"]');
  assert.match(shimmer?.className ?? "", /motion-reduce:animate-none/);
  assert.equal(shimmer?.getAttribute("aria-hidden"), "true", "the shimmer is hidden from AT");
});

// --- M5: accessibility + compact affordance ---

test("M5 a11y: the trigger is a native button labelled `thinking` and controls the region", () => {
  render(<ReasoningTrace content={THINKING} defaultOpen />);
  const el = trigger();
  assert.equal(el.tagName, "BUTTON", "a native button - keyboard toggle works for free");
  assert.match(el.textContent ?? "", /thinking/);
  // The disclosure exposes its open/closed state to AT via aria-expanded (Radix).
  assert.equal(el.getAttribute("aria-expanded"), "true", "expanded state is announced");
});

test("M5 a11y: the content region is marked busy while streaming", () => {
  const { container } = render(<ReasoningTrace content={THINKING} streaming />);
  const content = container.querySelector('[data-slot="reasoning-content"]');
  assert.equal(content?.getAttribute("aria-busy"), "true");
});

test("M5 compact: the compact affordance is a one-line trigger with a count, still expandable", () => {
  const content = "line a\nline b\nline c";
  render(<ReasoningTrace content={content} compact />);
  const el = trigger();
  assert.match(el.textContent ?? "", /thinking · 3 lines/);
  assert.equal(isOpen(), false, "the compact row is collapsed by default");
  fireEvent.click(el);
  assert.equal(isOpen(), true, "the compact affordance still expands to the full trace");
});

test("M5 compact: while streaming the compact label stays the live word (count is still growing)", () => {
  render(<ReasoningTrace content={"a\nb"} compact streaming />);
  assert.match(trigger().textContent ?? "", /thinking/);
  assert.doesNotMatch(trigger().textContent ?? "", /lines/);
});

// --- plan 12.2: the no-yank-mid-stream scroll contract ---

test("plan 12.2: expanding/collapsing the trace never writes the ancestor scroll position", () => {
  // The follow controller owns the transcript viewport; the reasoning disclosure must not write it.
  // ReasoningGroup animates height under the shared useScrollLock anchor and pins only its own inner
  // scroll box, so a scrolled-up reader is never yanked when reasoning opens or collapses below them.
  const { container } = render(
    <div data-testid="viewport" style={{ overflowY: "auto", height: "100px" }}>
      <div style={{ height: "1000px" }}>
        <ReasoningTrace content={"a\nb\nc\nd\ne"} />
      </div>
    </div>,
  );
  const viewport = container.querySelector('[data-testid="viewport"]') as HTMLElement;
  viewport.scrollTop = 240;

  fireEvent.click(trigger()); // expand
  assert.equal(viewport.scrollTop, 240, "expanding reasoning does not move the viewport");

  fireEvent.click(trigger()); // collapse
  assert.equal(viewport.scrollTop, 240, "collapsing reasoning does not move the viewport");
});

test("M5: reasoningTraceSummary is a pure one-line projection for plan 27's compact row", () => {
  assert.deepEqual(reasoningTraceSummary("one\ntwo\nthree", false), {
    label: "thinking",
    lines: 3,
    active: false,
  });
  assert.deepEqual(reasoningTraceSummary("   ", true), {
    label: "thinking",
    lines: 0,
    active: true,
  });
});
