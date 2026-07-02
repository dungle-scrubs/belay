import assert from "node:assert/strict";
import { test } from "vitest";
import { plural, statusHistogram } from "./format";

/**
 * The shared doctor display helpers (plan 24 simplify pass): plural nouns and the compact
 * status histogram both peripheral debug summaries render.
 */

test("plural appends s except for exactly one", () => {
  assert.equal(plural(0, "server"), "0 servers");
  assert.equal(plural(1, "server"), "1 server");
  assert.equal(plural(2, "workspace"), "2 workspaces");
});

test("statusHistogram counts statuses in first-seen order", () => {
  assert.equal(statusHistogram(["ready", "failed", "ready"]), "2 ready · 1 failed");
  assert.equal(statusHistogram(["disabled"]), "1 disabled");
  assert.equal(statusHistogram([]), "");
});
