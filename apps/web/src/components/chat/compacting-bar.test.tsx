import assert from "node:assert/strict";
import { render } from "@testing-library/react";
import { test } from "vitest";
import { compactionActionLabel } from "@/action-label";
import { CompactingBar } from "./compacting-bar";

/**
 * The live cross-turn compaction progress bar (D-040). Pins that its label renders via the SHARED
 * `compactionActionLabel` (plan 31 coordinator fix) rather than a hand-rolled duplicate string, so
 * a future format change to the shared label can't silently drift from what this bar shows.
 */

test("fix: the label renders via the shared compactionActionLabel, not a parallel string", () => {
  const { container } = render(<CompactingBar tokens={200} budget={1000} />);
  assert.ok(
    (container.textContent ?? "").includes(compactionActionLabel()),
    "the bar's label text must equal whatever the shared helper currently produces",
  );
});

test("shows the percent complete once tokens are streaming", () => {
  const { container } = render(<CompactingBar tokens={500} budget={1000} />);
  assert.ok((container.textContent ?? "").includes("50%"));
});

test("shows a preparing state before any tokens have streamed", () => {
  const { container } = render(<CompactingBar tokens={0} budget={1000} />);
  assert.ok((container.textContent ?? "").includes("preparing"));
});
