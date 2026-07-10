import assert from "node:assert/strict";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { useNow } from "./use-now";

/**
 * The leaf wall clock (Tier 2.3). These pin the gating contract App's clock split relies on:
 * enabled ticks re-sample the clock on the interval, DISABLED schedules nothing at all (the whole
 * point - an idle session must not carry a live timer), and re-enabling re-samples immediately
 * instead of holding the stale sample until the first interval elapses.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("ticks a fresh sample every interval while enabled", () => {
  vi.setSystemTime(10_000);
  const { result } = renderHook(() => useNow(4000));
  assert.equal(result.current, 10_000);

  act(() => vi.advanceTimersByTime(4000));
  assert.equal(result.current, 14_000);

  act(() => vi.advanceTimersByTime(8000));
  assert.equal(result.current, 22_000);
});

test("enabled=false ticks nothing: no timer is scheduled and the sample never moves", () => {
  vi.setSystemTime(10_000);
  const { result } = renderHook(() => useNow(4000, { enabled: false }));
  assert.equal(result.current, 10_000);
  // Nothing scheduled - the gate's purpose is zero timer work while idle, not a suppressed callback.
  assert.equal(vi.getTimerCount(), 0);

  act(() => vi.advanceTimersByTime(60_000));

  assert.equal(result.current, 10_000);
  assert.equal(vi.getTimerCount(), 0);
});

test("re-enabling re-samples immediately instead of waiting out the first interval", () => {
  vi.setSystemTime(10_000);
  const { result, rerender } = renderHook(({ enabled }) => useNow(4000, { enabled }), {
    initialProps: { enabled: false },
  });
  act(() => vi.advanceTimersByTime(120_000));
  assert.equal(result.current, 10_000);

  rerender({ enabled: true });

  // The enable effect re-reads the clock in the same commit - no 4s of stale "now" after re-arming.
  assert.equal(result.current, 130_000);
  act(() => vi.advanceTimersByTime(4000));
  assert.equal(result.current, 134_000);
});
