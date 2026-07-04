import assert from "node:assert/strict";
import { render } from "@testing-library/react";
import { test } from "vitest";
import { ActionShimmer, ShimmerText } from "./action-shimmer";

/**
 * Plan 31 M1: the shimmer status primitive. Pins the label text, the elapsed/interruptible meta
 * forms, the reduced-motion fallback (the shimmer overlay carries `motion-reduce:animate-none` and
 * is hidden from screen readers), and the stable-width overlay idiom - so the shimmer never
 * duplicates its label to assistive tech and never shifts layout.
 */

test("renders the label as readable text", () => {
  const { getByText } = render(<ActionShimmer label="thinking" />);
  // The base (announced) label span is present exactly once.
  assert.equal(
    getByText("thinking", { selector: "span:not([aria-hidden])" }).textContent,
    "thinking",
  );
});

test("defaults to the generic Working fallback label", () => {
  const { getByText } = render(<ActionShimmer />);
  assert.ok(getByText("Working", { selector: "span:not([aria-hidden])" }));
});

test("shows elapsed + interruptible meta for the turn form", () => {
  const { container } = render(
    <ActionShimmer label="Working" startedAt={Date.now()} interruptible />,
  );
  const text = container.textContent ?? "";
  assert.match(text, /esc to interrupt/);
  assert.match(text, /0s/); // just started
  assert.match(text, /\(.*esc to interrupt\)/);
});

test("interruptible without a start time still renders the esc hint", () => {
  const { container } = render(<ActionShimmer label="Working" interruptible />);
  assert.match(container.textContent ?? "", /esc to interrupt/);
});

test("plain form (no meta) shows no parenthetical", () => {
  const { container } = render(<ActionShimmer label="reading foo.ts" />);
  assert.doesNotMatch(container.textContent ?? "", /esc to interrupt/);
  assert.doesNotMatch(container.textContent ?? "", /\(/);
});

test("the shimmer overlay is aria-hidden and disables animation under reduced motion", () => {
  const { container } = render(<ShimmerText>reading app.tsx</ShimmerText>);
  const overlay = container.querySelector("[aria-hidden]");
  assert.ok(overlay, "expected a shimmer overlay span");
  assert.ok(overlay?.classList.contains("shimmer"));
  assert.ok(
    overlay?.classList.contains("motion-reduce:animate-none"),
    "overlay must stop animating for prefers-reduced-motion users",
  );
});

test("label text is announced once (base only), overlay is a hidden duplicate", () => {
  const { getAllByText, getByText } = render(<ShimmerText>searching foo</ShimmerText>);
  // Two DOM nodes carry the text (base + overlay) but only the base is announced.
  assert.equal(getAllByText("searching foo").length, 2);
  const announced = getByText("searching foo", { selector: "span:not([aria-hidden])" });
  assert.equal(announced.getAttribute("aria-hidden"), null);
});
