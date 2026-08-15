import assert from "node:assert/strict";
import type { CommandSpec } from "@belay/session";
import { act, renderHook } from "@testing-library/react";
import { type KeyboardEvent as ReactKeyboardEvent, useRef, useState } from "react";
import { test } from "vitest";
import { useSlashMenu } from "./use-slash-menu";

const commands: CommandSpec[] = [
  { name: "/clear", summary: "Start fresh" },
  { name: "/compact", summary: "Compact context" },
  { name: "/doctor", summary: "Doctor" },
  { name: "/fix", summary: "Fix an issue", argumentHint: "<issue>", body: "Fix issue #$0" },
];

function useHarness(initialDraft: string) {
  const [draft, setDraft] = useState(initialDraft);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  return {
    draft,
    setDraft,
    ...useSlashMenu({ draft, commandSpecs: commands, inputRef, setDraft }),
  };
}

function keyEvent(
  key: string,
  options: { shiftKey?: boolean; requestSubmit?: () => void } = {},
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
    currentTarget: {
      form: options.requestSubmit ? { requestSubmit: options.requestSubmit } : null,
    },
    prevented: () => prevented,
    stopped: () => stopped,
  } as ReactKeyboardEvent<HTMLTextAreaElement> & {
    readonly prevented: () => boolean;
    readonly stopped: () => boolean;
  };
}

test("filters command matches for a bare slash query", () => {
  const { result } = renderHook(() => useHarness("/c"));

  assert.equal(result.current.menuOpen, true);
  assert.deepEqual(
    result.current.menuMatches.map((c) => c.name),
    ["/clear", "/compact"],
  );
  assert.equal(result.current.menuIndex, 0);
});

test("arrow keys move the highlighted command", () => {
  const { result } = renderHook(() => useHarness("/c"));
  const down = keyEvent("ArrowDown");

  act(() => {
    assert.equal(result.current.onMenuKeyDown(down), true);
  });

  assert.equal(down.prevented(), true);
  assert.equal(result.current.menuIndex, 1);
});

test("tab accepts the highlighted command", () => {
  const { result } = renderHook(() => useHarness("/do"));
  const tab = keyEvent("Tab");

  act(() => {
    assert.equal(result.current.onMenuKeyDown(tab), true);
  });

  assert.equal(tab.prevented(), true);
  assert.equal(result.current.draft, "/doctor ");
});

test("enter submits when the command is already exact", () => {
  let submitted = 0;
  const { result } = renderHook(() => useHarness("/doctor"));
  const enter = keyEvent("Enter", { requestSubmit: () => submitted++ });

  act(() => {
    assert.equal(result.current.onMenuKeyDown(enter), true);
  });

  assert.equal(enter.prevented(), true);
  assert.equal(submitted, 1);
});

test("escape dismisses the menu for the current draft", () => {
  const { result } = renderHook(() => useHarness("/c"));
  const escapeKey = keyEvent("Escape");

  act(() => {
    assert.equal(result.current.onMenuKeyDown(escapeKey), true);
  });

  assert.equal(escapeKey.prevented(), true);
  assert.equal(escapeKey.stopped(), true);
  assert.equal(result.current.menuOpen, false);
});

test("the substitution preview stays visible PAST the first space, where the menu closes (44.5 M6)", () => {
  const { result } = renderHook(() => useHarness("/fix 123"));
  // The menu itself is closed once a space is typed...
  assert.equal(result.current.menuOpen, false);
  // ...but the live preview takes over, resolving the placeholder for the typed args.
  assert.equal(result.current.preview?.command, "/fix");
  assert.equal(result.current.preview?.text, "Fix issue #123");
});

test("no preview while still choosing the command (before the first space)", () => {
  const { result } = renderHook(() => useHarness("/fi"));
  assert.equal(result.current.menuOpen, true);
  assert.equal(result.current.preview, null);
});
