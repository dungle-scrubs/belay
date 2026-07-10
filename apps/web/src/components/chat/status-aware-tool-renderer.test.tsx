import assert from "node:assert/strict";
import { render } from "@testing-library/react";
import { test } from "vitest";
import { StatusAwareToolRenderer } from "./status-aware-tool-renderer";

/**
 * Plan 58.6.1 M2: the running-tool elapsed clock. A running tool row that carries `startedAt` (the
 * `tool.started` envelope timestamp, threaded from `ToolMessage.startedAt`) renders a live elapsed
 * meta on its shimmer, so a slow tool ("reading… (1m 5s)") is distinguishable from a stuck one.
 * Without a start time the running shimmer stays the plain form (no elapsed parens); completed rows
 * never render the shimmer at all.
 */

test("58.6.1 M2: a running tool row renders the live elapsed meta when startedAt is present", () => {
  const { container } = render(
    <StatusAwareToolRenderer
      name="web_search"
      args="q"
      status="running"
      running
      runningLabel="searching q"
      startedAt={Date.now() - 65_000}
    />,
  );
  const text = container.textContent ?? "";
  // The elapsed cell renders inside the parenthetical meta - here ~1m 5s after a 65s start.
  assert.match(text, /\(1m/, "the running row shows the live elapsed clock");
});

test("58.6.1 M2: a running tool row without startedAt renders no elapsed parenthetical", () => {
  const { container } = render(
    <StatusAwareToolRenderer
      name="web_search"
      args="q"
      status="running"
      running
      runningLabel="searching q"
    />,
  );
  const text = container.textContent ?? "";
  assert.match(text, /searching q/, "the running label still renders");
  // The row header always renders `name(args)`; the elapsed meta is the distinct `(1m 5s)` form,
  // i.e. a paren immediately followed by a digit. Its absence proves no elapsed clock was rendered.
  assert.doesNotMatch(text, /\(\d/, "no elapsed parenthetical without a start time");
});

test("58.6.1 M2: a completed tool row renders its body, never the elapsed shimmer", () => {
  const { container } = render(
    <StatusAwareToolRenderer
      name="web_search"
      args="q"
      status="done"
      startedAt={Date.now() - 65_000}
      renderBody={() => <span>done body</span>}
    />,
  );
  const text = container.textContent ?? "";
  assert.match(text, /done body/, "the settled row shows its result body");
  assert.doesNotMatch(text, /1m/, "a settled row never renders the running elapsed clock");
});
