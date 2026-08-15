import assert from "node:assert/strict";
import type { FileMatch } from "@belay/session";
import { act, renderHook } from "@testing-library/react";
import { type KeyboardEvent as ReactKeyboardEvent, useRef, useState } from "react";
import { test } from "vitest";
import { useFileMentionMenu } from "./use-file-mention-menu";

const RESULTS: FileMatch[] = [
  { path: "apps/web/src/app.tsx" },
  { path: "apps/web/src/hooks/use-composer.ts" },
  { path: "packages/session/src/app-config.ts" },
];

function useHarness(
  initialDraft: string,
  initialCaret: number,
  options: { results?: readonly FileMatch[]; suppressed?: boolean } = {},
) {
  const [draft, setDraft] = useState(initialDraft);
  const [caret, setCaret] = useState(initialCaret);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  return {
    draft,
    caret,
    ...useFileMentionMenu({
      draft,
      caret,
      results: options.results ?? RESULTS,
      suppressed: options.suppressed ?? false,
      inputRef,
      setDraft,
      setCaret,
    }),
  };
}

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

test("opens on an active @ token; matches are reversed (fuzzy top, best bottom) and the highlight starts at the last (best) row", () => {
  const { result } = renderHook(() => useHarness("@app", 4));
  assert.equal(result.current.menuOpen, true);
  assert.equal(result.current.query, "app");
  assert.equal(result.current.matches.length, 3);
  // The list is presented worst-first, so RESULTS is reversed for display.
  assert.deepEqual(
    result.current.matches.map((m) => m.path),
    [
      "packages/session/src/app-config.ts",
      "apps/web/src/hooks/use-composer.ts",
      "apps/web/src/app.tsx",
    ],
  );
  // The default highlight is the LAST row (the best match, nearest the composer).
  assert.equal(result.current.menuIndex, 2);
});

test("stays closed when no @ token is active", () => {
  const { result } = renderHook(() => useHarness("hello world", 11));
  assert.equal(result.current.menuOpen, false);
  assert.equal(result.current.query, null);
});

test("stays closed when suppressed (e.g. the caret is on a /loop line)", () => {
  const { result } = renderHook(() => useHarness("@app", 4, { suppressed: true }));
  assert.equal(result.current.menuOpen, false);
});

test("ArrowDown / ArrowUp move and wrap the highlight from the bottom-start default, consuming the key", () => {
  const { result } = renderHook(() => useHarness("@app", 4));
  // Default highlight is the last row (index 2). ArrowUp moves toward the top (worse matches).
  const up = keyEvent("ArrowUp");
  act(() => assert.equal(result.current.onMenuKeyDown(up), true));
  assert.equal(up.prevented(), true);
  assert.equal(result.current.menuIndex, 1);

  const upAgain = keyEvent("ArrowUp");
  act(() => assert.equal(result.current.onMenuKeyDown(upAgain), true));
  assert.equal(result.current.menuIndex, 0);

  // ArrowUp at the top wraps to the bottom (the best match).
  const wrap = keyEvent("ArrowUp");
  act(() => assert.equal(result.current.onMenuKeyDown(wrap), true));
  assert.equal(result.current.menuIndex, 2);
});

test("Tab accepts the highlighted (best, bottom) file, replacing the token with a mention + trailing space", () => {
  const { result } = renderHook(() => useHarness("@app", 4));
  const tab = keyEvent("Tab");
  act(() => assert.equal(result.current.onMenuKeyDown(tab), true));
  assert.equal(tab.prevented(), true);
  // The default highlight is the best match (app.tsx), which is the last row after the reversal.
  assert.equal(result.current.draft, "@apps/web/src/app.tsx ");
  assert.equal(result.current.caret, "@apps/web/src/app.tsx ".length);
  // The trailing space closes the token, so the menu no longer opens at the parked caret.
  assert.equal(result.current.menuOpen, false);
});

test("Enter accepts the highlighted file; Shift+Enter is not owned", () => {
  const { result } = renderHook(() => useHarness("@use", 4));
  // Reversed list: [app-config.ts, use-composer.ts, app.tsx]; default highlight is app.tsx (index 2).
  // Arrow up once to land on use-composer.ts (index 1), then accept.
  const up = keyEvent("ArrowUp");
  act(() => result.current.onMenuKeyDown(up));
  const enter = keyEvent("Enter");
  act(() => assert.equal(result.current.onMenuKeyDown(enter), true));
  assert.equal(result.current.draft, "@apps/web/src/hooks/use-composer.ts ");

  const { result: r2 } = renderHook(() => useHarness("@app", 4));
  const shiftEnter = keyEvent("Enter", { shiftKey: true });
  act(() => assert.equal(r2.current.onMenuKeyDown(shiftEnter), false));
});

test("Escape dismisses the menu for the current token and swallows the key", () => {
  const { result } = renderHook(() => useHarness("@app", 4));
  const escapeKey = keyEvent("Escape");
  act(() => assert.equal(result.current.onMenuKeyDown(escapeKey), true));
  assert.equal(escapeKey.prevented(), true);
  assert.equal(escapeKey.stopped(), true);
  assert.equal(result.current.menuOpen, false);
});

test("Backspace and normal typing are not owned by the menu", () => {
  const { result } = renderHook(() => useHarness("@app", 4));
  assert.equal(result.current.onMenuKeyDown(keyEvent("Backspace")), false);
  assert.equal(result.current.onMenuKeyDown(keyEvent("a")), false);
});

test("with an active token but no results, only Escape is owned", () => {
  const { result } = renderHook(() => useHarness("@zzz", 4, { results: [] }));
  assert.equal(result.current.menuOpen, true);
  assert.equal(result.current.onMenuKeyDown(keyEvent("ArrowDown")), false);
  assert.equal(result.current.onMenuKeyDown(keyEvent("Enter")), false);
  assert.equal(result.current.onMenuKeyDown(keyEvent("Escape")), true);
});
