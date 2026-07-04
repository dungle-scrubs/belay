import assert from "node:assert/strict";
import { test } from "vitest";
import { contextPressureState } from "./context-pressure";

// The band thresholds are the plan's contract (D-001). Encoding the exact boundary
// percents in the test names makes any later threshold change a deliberate, visible edit.

test("band is normal below 70% (0%)", () => {
  const p = contextPressureState(0, 1000);
  assert.equal(p?.band, "normal");
  assert.equal(p?.percent, 0);
});

test("band is normal just under the warning threshold (69.9%)", () => {
  const p = contextPressureState(699, 1000);
  assert.equal(p?.band, "normal");
});

test("band is warning at exactly 70%", () => {
  const p = contextPressureState(700, 1000);
  assert.equal(p?.band, "warning");
});

test("band is warning just under the danger threshold (84.9%)", () => {
  const p = contextPressureState(849, 1000);
  assert.equal(p?.band, "warning");
});

test("band is danger at exactly 85%", () => {
  const p = contextPressureState(850, 1000);
  assert.equal(p?.band, "danger");
});

test("band is danger just under the critical threshold (94.9%)", () => {
  const p = contextPressureState(949, 1000);
  assert.equal(p?.band, "danger");
});

test("band is critical at exactly 95%", () => {
  const p = contextPressureState(950, 1000);
  assert.equal(p?.band, "critical");
});

test("band is critical at exactly 100%", () => {
  const p = contextPressureState(1000, 1000);
  assert.equal(p?.band, "critical");
  assert.equal(p?.percent, 100);
});

test("band stays critical over the window (120%)", () => {
  const p = contextPressureState(1200, 1000);
  assert.equal(p?.band, "critical");
  assert.equal(p?.percent, 120);
});

test("ratio is the raw ctxUsed/ctxMax and can exceed 1 over the window", () => {
  assert.equal(contextPressureState(512, 1024)?.ratio, 0.5);
  assert.equal(contextPressureState(1200, 1000)?.ratio, 1.2);
});

test("clampedPercent caps the bar width at 100 even when over the window", () => {
  assert.equal(contextPressureState(1200, 1000)?.clampedPercent, 100);
  assert.equal(contextPressureState(420, 1000)?.clampedPercent, 42);
});

test("labels carry the token count, percent, and compact window", () => {
  const p = contextPressureState(53_800, 128_000);
  assert.equal(p?.usageLabel, "53.8k (42%)");
  assert.equal(p?.windowLabel, "128k");
});

test("ariaLabel carries tokens, window, percent, and band for assistive tech", () => {
  const p = contextPressureState(180_000, 200_000);
  assert.equal(p?.band, "danger");
  assert.match(p?.ariaLabel ?? "", /180\.0k/);
  assert.match(p?.ariaLabel ?? "", /200k/);
  assert.match(p?.ariaLabel ?? "", /90%/);
  assert.match(p?.ariaLabel ?? "", /danger/);
});

// Absent state: the meter must not render at all when usage cannot be derived.

test("returns null for missing ctxUsed or ctxMax", () => {
  assert.equal(contextPressureState(undefined, 1000), null);
  assert.equal(contextPressureState(500, undefined), null);
  assert.equal(contextPressureState(undefined, undefined), null);
});

test("returns null for a zero or negative max", () => {
  assert.equal(contextPressureState(500, 0), null);
  assert.equal(contextPressureState(500, -1000), null);
});

test("returns null for a negative or non-finite used", () => {
  assert.equal(contextPressureState(-1, 1000), null);
  assert.equal(contextPressureState(Number.NaN, 1000), null);
  assert.equal(contextPressureState(Number.POSITIVE_INFINITY, 1000), null);
});
