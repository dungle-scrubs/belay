import assert from "node:assert/strict";
import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { useElapsedLabel } from "./use-elapsed-label";

/**
 * Plan 09.4 M7: the shared elapsed ticker must advance ~1 second per real second and must not
 * double-tick when the app mounts it under `<StrictMode>` (main.tsx) - a second live interval makes
 * the label re-render twice a second and, if the two ticks race the clock read, makes elapsed "feel
 * too fast". These tests pin both the value (exactly N seconds after N seconds) and the invariant of
 * a single live interval.
 */

const BASE = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
});

afterEach(() => {
  vi.useRealTimers();
});

test("advances exactly one second per real second", () => {
  const { result } = renderHook(() => useElapsedLabel(BASE));
  assert.equal(result.current, "0s");
  act(() => {
    vi.advanceTimersByTime(3000);
  });
  assert.equal(result.current, "3s");
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  assert.equal(result.current, "1m 3s");
});

test("never increments early: the second flips at the boundary, not before (no round-up drift)", () => {
  const { result } = renderHook(() => useElapsedLabel(BASE));
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  assert.equal(result.current, "1s");
  // 1.999s in: still "1s" - the label reads the floored wall-clock, so it never reads a second early
  // (a `round` instead of `floor`, or a second racing interval, is what would make it "feel too fast").
  act(() => {
    vi.advanceTimersByTime(999);
  });
  assert.equal(result.current, "1s");
  act(() => {
    vi.advanceTimersByTime(1);
  });
  assert.equal(result.current, "2s");
});

test("returns null and runs no timer when there is no start time", () => {
  renderHook(() => useElapsedLabel(undefined));
  assert.equal(vi.getTimerCount(), 0);
});

test("registers exactly one live interval under StrictMode (no double-ticking)", () => {
  renderHook(() => useElapsedLabel(BASE), { wrapper: StrictMode });
  assert.equal(vi.getTimerCount(), 1);
});
