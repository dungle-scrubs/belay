import assert from "node:assert/strict";
import { test } from "node:test";
import { applyUniqueReplacement, replaceMissMessage } from "./replace";

/**
 * Characterization tests for the shared unique-substring replacement core (M9 / D-009).
 *
 * `edit` and `multi_edit` each reimplemented "count occurrences of `old` (0 -> not found,
 * >1 -> ambiguous), then replace", plus the same not-found / ambiguous error wording -
 * `edit` plain, `multi_edit` with an ` in <path>` suffix. These pin the match semantics
 * and the exact messages before they are centralized, so neither tool's output changes.
 */

test("a unique match is replaced and returned", () => {
  assert.deepEqual(applyUniqueReplacement("a b c", "b", "X"), { ok: true, content: "a X c" });
});

test("no occurrence is a not_found miss", () => {
  assert.deepEqual(applyUniqueReplacement("a b c", "z", "X"), { ok: false, reason: "not_found" });
});

test("more than one occurrence is an ambiguous miss carrying the count", () => {
  assert.deepEqual(applyUniqueReplacement("a a a", "a", "X"), {
    ok: false,
    reason: "ambiguous",
    count: 3,
  });
});

test("replacement targets the single occurrence only", () => {
  assert.deepEqual(applyUniqueReplacement("start MIDDLE end", "MIDDLE", "x"), {
    ok: true,
    content: "start x end",
  });
});

test("edit-style miss messages (no path suffix) match the current wording", () => {
  assert.equal(replaceMissMessage({ reason: "not_found" }), "error: 'old' text not found");
  assert.equal(
    replaceMissMessage({ reason: "ambiguous", count: 3 }),
    "error: 'old' text appears 3 times (must be unique)",
  );
});

test("multi_edit-style miss messages (with ' in <path>') match the current wording", () => {
  assert.equal(
    replaceMissMessage({ reason: "not_found" }, " in src/x.ts"),
    "error: 'old' text not found in src/x.ts",
  );
  assert.equal(
    replaceMissMessage({ reason: "ambiguous", count: 2 }, " in src/x.ts"),
    "error: 'old' text appears 2 times in src/x.ts (must be unique)",
  );
});
