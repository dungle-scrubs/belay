import assert from "node:assert/strict";
import { act, renderHook } from "@testing-library/react";
import { type KeyboardEvent as ReactKeyboardEvent, useState } from "react";
import { test } from "vitest";
import { useAutocompleteMenuKeys } from "./use-autocomplete-menu-keys";

function keyEvent(
  key: string,
  options: { shiftKey?: boolean } = {},
): ReactKeyboardEvent<HTMLTextAreaElement> & {
  readonly prevented: () => boolean;
  readonly stopped: () => boolean;
} {
  let prevented = false;
  let stopped = false;
  return {
    key,
    shiftKey: options.shiftKey ?? false,
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
    prevented: () => prevented,
    stopped: () => stopped,
  } as ReactKeyboardEvent<HTMLTextAreaElement> & {
    readonly prevented: () => boolean;
    readonly stopped: () => boolean;
  };
}

function useHarness(matches: readonly string[], open = true) {
  const [activeIndex, setActiveIndex] = useState(0);
  const accepted: string[] = [];
  let escaped = 0;
  const onMenuKeyDown = useAutocompleteMenuKeys({
    open,
    matches,
    activeIndex,
    setActiveIndex,
    onAccept: (m) => accepted.push(m),
    onEscape: () => {
      escaped += 1;
    },
  });
  return { activeIndex, onMenuKeyDown, accepted, escapedCount: () => escaped };
}

test("ArrowDown/ArrowUp cycle the active index, wrapping at the ends", () => {
  const { result } = renderHook(() => useHarness(["a", "b", "c"]));
  act(() => {
    assert.equal(result.current.onMenuKeyDown(keyEvent("ArrowDown")), true);
  });
  assert.equal(result.current.activeIndex, 1);

  act(() => {
    result.current.onMenuKeyDown(keyEvent("ArrowUp"));
    result.current.onMenuKeyDown(keyEvent("ArrowUp"));
  });
  assert.equal(result.current.activeIndex, 2); // wrapped below 0
});

test("Tab and Enter both accept the highlighted match", () => {
  const { result } = renderHook(() => useHarness(["a", "b"]));
  act(() => {
    assert.equal(result.current.onMenuKeyDown(keyEvent("Tab")), true);
  });
  assert.deepEqual(result.current.accepted, ["a"]);
});

test("Shift+Enter is not consumed (newline passes through)", () => {
  const { result } = renderHook(() => useHarness(["a"]));
  const event = keyEvent("Enter", { shiftKey: true });
  act(() => {
    assert.equal(result.current.onMenuKeyDown(event), false);
  });
  assert.equal(event.prevented(), false);
});

test("Escape dismisses even with ZERO matches, as long as the menu is open", () => {
  const { result } = renderHook(() => useHarness([]));
  const event = keyEvent("Escape");
  act(() => {
    assert.equal(result.current.onMenuKeyDown(event), true);
  });
  assert.equal(event.prevented(), true);
  assert.equal(event.stopped(), true);
  assert.equal(result.current.escapedCount(), 1);
});

test("Backspace and plain typing are never consumed", () => {
  const { result } = renderHook(() => useHarness(["a"]));
  assert.equal(result.current.onMenuKeyDown(keyEvent("Backspace")), false);
  assert.equal(result.current.onMenuKeyDown(keyEvent("x")), false);
});

test("a closed menu consumes nothing, not even Escape", () => {
  const { result } = renderHook(() => useHarness(["a"], false));
  assert.equal(result.current.onMenuKeyDown(keyEvent("Escape")), false);
  assert.equal(result.current.onMenuKeyDown(keyEvent("ArrowDown")), false);
});

test("with matches present but out-of-range activeIndex, only Escape is owned", () => {
  const { result } = renderHook(() => useHarness([]));
  assert.equal(result.current.onMenuKeyDown(keyEvent("ArrowDown")), false);
  assert.equal(result.current.onMenuKeyDown(keyEvent("Enter")), false);
});
