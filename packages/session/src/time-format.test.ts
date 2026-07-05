import assert from "node:assert/strict";
import { test } from "vitest";
import { timeUntil } from "./time-format";

/**
 * `timeUntil` is the FUTURE-relative sibling of `relativeTime` (which is past-only). Plan 44.4 uses it
 * to humanize a usage-limit `resetsAt` (unix epoch SECONDS or an ISO string) into "in 2m" / "in 3h".
 * `nowMs` is injected so the label is deterministic (no live clock).
 */

const now = Date.parse("2026-07-04T12:00:00.000Z");

test("timeUntil humanizes an epoch-SECONDS reset into a compact future label", () => {
  assert.equal(timeUntil(now / 1000 + 90, now), "in 1m");
  assert.equal(timeUntil(now / 1000 + 2 * 60, now), "in 2m");
  assert.equal(timeUntil(now / 1000 + 3 * 3600, now), "in 3h");
  assert.equal(timeUntil(now / 1000 + 2 * 86_400, now), "in 2d");
});

test("timeUntil accepts an ISO string too", () => {
  assert.equal(timeUntil("2026-07-04T12:05:00.000Z", now), "in 5m");
  assert.equal(timeUntil("2026-07-05T12:00:00.000Z", now), "in 1d");
});

test("timeUntil reads sub-minute futures as 'in <1m' and a past/now as 'now'", () => {
  assert.equal(timeUntil(now / 1000 + 30, now), "in <1m");
  assert.equal(timeUntil(now / 1000, now), "now");
  assert.equal(timeUntil(now / 1000 - 60, now), "now");
});

test("timeUntil returns '' for an unparseable input", () => {
  assert.equal(timeUntil("not-a-date", now), "");
});
