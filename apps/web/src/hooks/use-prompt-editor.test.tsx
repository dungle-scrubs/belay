import assert from "node:assert/strict";
import { act, renderHook } from "@testing-library/react";
import { test, vi } from "vitest";
import { usePromptEditor } from "./use-prompt-editor";

/**
 * The full-surface prompt editor's state machine (02.12), driven in a DOM. Guards the open/edit/confirm
 * contract both callers depend on: composer-expand (edits sync back to the draft) and programmatic edit
 * (02.10 generated-handoff returns the edited text through onConfirm).
 */

test("opens seeded with text and reports isOpen", () => {
  const { result } = renderHook(() => usePromptEditor());
  assert.equal(result.current.isOpen, false);
  assert.equal(result.current.text, "");

  act(() => result.current.open({ text: "hello", onConfirm: vi.fn(), title: "Edit prompt" }));
  assert.equal(result.current.isOpen, true);
  assert.equal(result.current.text, "hello");
  assert.equal(result.current.title, "Edit prompt");
});

test("confirm hands the edited text to onConfirm and closes", () => {
  const onConfirm = vi.fn<(t: string) => void>();
  const { result } = renderHook(() => usePromptEditor());

  act(() => result.current.open({ text: "draft", onConfirm }));
  act(() => result.current.setText("draft, edited"));
  assert.equal(result.current.text, "draft, edited");

  act(() => result.current.confirm());
  assert.deepEqual(onConfirm.mock.calls, [["draft, edited"]], "the latest text is returned");
  assert.equal(result.current.isOpen, false);
  assert.equal(result.current.text, "");
});

test("a fresh open replaces the previous text and onConfirm target", () => {
  const first = vi.fn<(t: string) => void>();
  const second = vi.fn<(t: string) => void>();
  const { result } = renderHook(() => usePromptEditor());

  act(() => result.current.open({ text: "one", onConfirm: first }));
  act(() => result.current.confirm());
  act(() => result.current.open({ text: "two", onConfirm: second }));
  act(() => result.current.confirm());

  assert.deepEqual(first.mock.calls, [["one"]]);
  assert.deepEqual(second.mock.calls, [["two"]]);
});

test("setText is ignored while closed (no stale text leaks into the next open)", () => {
  const { result } = renderHook(() => usePromptEditor());
  act(() => result.current.setText("ghost"));
  assert.equal(result.current.text, "");
  assert.equal(result.current.isOpen, false);
});
