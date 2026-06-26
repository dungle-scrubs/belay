import assert from "node:assert/strict";
import { act, renderHook } from "@testing-library/react";
import { test } from "vitest";
import { useCollapsibleDisclosure } from "./use-collapsible-disclosure";

/**
 * The three-state controlled/uncontrolled open contract every assistant-ui disclosure
 * (tool fallback, tool group, reasoning) shares (D-034). Reasoning's streaming auto-open
 * is layered on top in reasoning.tsx and is NOT exercised here - this locks only the base
 * wiring: uncontrolled toggling, parent-owned controlled state, and the toggle callback.
 */

test("uncontrolled: defaultOpen seeds open and onOpenChange flips internal state", () => {
  const { result } = renderHook(() =>
    useCollapsibleDisclosure({ defaultOpen: true }),
  );

  assert.equal(result.current.isControlled, false);
  assert.equal(result.current.open, true);

  act(() => result.current.onOpenChange(false));
  assert.equal(result.current.open, false);

  act(() => result.current.onOpenChange(true));
  assert.equal(result.current.open, true);
});

test("uncontrolled: defaultOpen defaults to false (closed) when omitted", () => {
  const { result } = renderHook(() => useCollapsibleDisclosure({}));

  assert.equal(result.current.isControlled, false);
  assert.equal(result.current.open, false);
});

test("controlled: parent owns open; onOpenChange forwards but does not mutate internal state", () => {
  const calls: boolean[] = [];
  const { result, rerender } = renderHook(
    ({ open }: { open: boolean }) =>
      useCollapsibleDisclosure({
        open,
        onOpenChange: (next) => calls.push(next),
      }),
    { initialProps: { open: false } },
  );

  assert.equal(result.current.isControlled, true);
  assert.equal(result.current.open, false);

  // The toggle reports the requested value to the parent but the resolved `open`
  // stays put until the parent re-renders with a new `open` prop.
  act(() => result.current.onOpenChange(true));
  assert.deepEqual(calls, [true]);
  assert.equal(result.current.open, false);

  rerender({ open: true });
  assert.equal(result.current.open, true);
});

test("toggle callback fires the parent in both modes", () => {
  // Uncontrolled still forwards to a supplied onOpenChange.
  const uncontrolledCalls: boolean[] = [];
  const uncontrolled = renderHook(() =>
    useCollapsibleDisclosure({
      defaultOpen: false,
      onOpenChange: (next) => uncontrolledCalls.push(next),
    }),
  );
  act(() => uncontrolled.result.current.onOpenChange(true));
  assert.deepEqual(uncontrolledCalls, [true]);
  assert.equal(uncontrolled.result.current.open, true);

  // Controlled forwards without a supplied callback being required to crash.
  const controlled = renderHook(() => useCollapsibleDisclosure({ open: true }));
  act(() => controlled.result.current.onOpenChange(false));
  assert.equal(controlled.result.current.open, true);
});
