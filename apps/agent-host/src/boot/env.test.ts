import assert from "node:assert/strict";
import { test } from "vitest";
import { envPositiveMs } from "./env";

/**
 * The injectable positive-milliseconds env read (plan 24 simplify pass): duration knobs must
 * never honor zero, negative, or malformed values (a zero timeout is not a real override), and
 * the helper is pure over the given env record so option mappings stay unit-testable.
 */

test("a positive whole-millisecond value is honored", () => {
  assert.equal(envPositiveMs({ KNOB: "800" }, "KNOB"), 800);
  assert.equal(envPositiveMs({ KNOB: "1" }, "KNOB"), 1);
});

test("fractional values truncate to whole milliseconds", () => {
  assert.equal(envPositiveMs({ KNOB: "800.9" }, "KNOB"), 800);
});

test("unset, blank, malformed, zero, and negative values contribute nothing", () => {
  assert.equal(envPositiveMs({}, "KNOB"), undefined);
  for (const bad of ["", "  ", "abc", "0", "-5", "NaN", "1.5e999"]) {
    assert.equal(envPositiveMs({ KNOB: bad }, "KNOB"), undefined, `"${bad}" must be ignored`);
  }
});
