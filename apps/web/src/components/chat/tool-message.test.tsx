import assert from "node:assert/strict";
import { render } from "@testing-library/react";
import { test } from "vitest";
import type { ToolMessage as ToolMessageData } from "@/transcript";
import { ToolRenderer } from "./tool-message";

/**
 * The single tool-message dispatch: ToolRenderer maps each host tool NAME to its renderer
 * and derives the `done -> status` once, so callers render one component instead of a name
 * ladder (M29). These tests pin (a) that each tool kind reaches its renderer (a distinct DOM
 * marker per renderer), (b) that an unknown/dynamic tool name still falls back to the generic
 * row, and (c) that status is derived from `done` once for the whole component.
 */

const toolMsg = (over: Partial<ToolMessageData>): ToolMessageData => ({
  kind: "tool",
  id: "t1",
  name: "read",
  args: "{}",
  done: true,
  ...over,
});

const noop = () => {};

test("multi_edit with edits dispatches to the grouped diff renderer", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        name: "multi_edit",
        args: JSON.stringify({ edits: [{ path: "a.ts", old: "x", new: "y" }] }),
      })}
      onOpenPath={noop}
    />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("a.ts"), "the edited file path renders");
});

test("write dispatches to the code-diff renderer with its path", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({ name: "write", args: JSON.stringify({ path: "new.ts", content: "hi" }) })}
      onOpenPath={noop}
    />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("write"), "the tool name renders");
  assert.ok(text.includes("new.ts"), "the written file path renders");
});

test("edit dispatches to the code-diff renderer with its path", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        name: "edit",
        args: JSON.stringify({ path: "edit.ts", old: "a", new: "b" }),
      })}
      onOpenPath={noop}
    />,
  );
  assert.ok((container.textContent ?? "").includes("edit.ts"), "the edited file path renders");
});

test("web_search dispatches to the result-list renderer", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        name: "web_search",
        args: JSON.stringify({ query: "node lts" }),
        result: JSON.stringify({
          provider: "brave",
          results: [{ title: "Node", url: "https://node.dev", snippet: "x" }],
        }),
      })}
      onOpenPath={noop}
    />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("node lts"), "the query renders");
  assert.ok(container.querySelector('a[href="https://node.dev"]'), "a result link renders");
});

test("bash dispatches to the text-output renderer", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        name: "bash",
        args: JSON.stringify({ command: "ls" }),
        result: "file-one\nfile-two",
      })}
      onOpenPath={noop}
    />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("bash"), "the tool name renders");
  assert.ok(text.includes("file-one"), "the command output renders");
});

test("grep dispatches to the text-output renderer", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        name: "grep",
        args: JSON.stringify({ pattern: "needle" }),
        result: "match-line",
      })}
      onOpenPath={noop}
    />,
  );
  assert.ok((container.textContent ?? "").includes("match-line"), "the matches render");
});

test("clipboard_write renders a bounded preview and the copied char count (06 M4)", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        name: "clipboard_write",
        args: JSON.stringify({ text: "Ship the release after smoke is green." }),
        result: JSON.stringify({ copied: true, charCount: 38 }),
      })}
      onOpenPath={noop}
    />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("clipboard_write"), "the tool name renders");
  assert.ok(text.includes("Ship the release"), "a bounded preview of the copied text renders");
  assert.ok(text.includes("Copied 38 chars"), "the copied char count renders");
});

test("clipboard_write surfaces a write failure as its error result (06 M4)", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        name: "clipboard_write",
        args: JSON.stringify({ text: "x" }),
        result: "error: clipboard_write failed - no clipboard command available",
      })}
      onOpenPath={noop}
    />,
  );
  assert.ok(
    (container.textContent ?? "").includes("no clipboard command available"),
    "the failure detail renders",
  );
});

test("a path-arg read tool renders the generic row with a clickable path", () => {
  let opened: string | null = null;
  const { container } = render(
    <ToolRenderer
      message={toolMsg({ name: "read", args: JSON.stringify({ path: "src/app.ts" }) })}
      onOpenPath={(p) => {
        opened = p;
      }}
    />,
  );
  const link = container.querySelector('[role="button"]');
  assert.ok(link, "the path renders as a click target");
  (link as HTMLElement).click();
  assert.equal(opened, "src/app.ts", "clicking the path opens it in the editor");
});

test("an unknown / dynamic tool name falls back to the generic row", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({ name: "custom_skill_tool", args: JSON.stringify({ foo: "bar" }) })}
      onOpenPath={noop}
    />,
  );
  assert.ok(
    (container.textContent ?? "").includes("custom_skill_tool"),
    "the unknown tool name renders via the generic row",
  );
});

test("ast_grep (read-only search) renders the generic row, not broken", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({ name: "ast_grep", args: JSON.stringify({ pattern: "console.log($A)" }) })}
      onOpenPath={noop}
    />,
  );
  assert.ok((container.textContent ?? "").includes("ast_grep"), "the tool name renders");
});

test("status is derived once from `done`: a running call tints the wrench yellow", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({ name: "read", args: JSON.stringify({ path: "x.ts" }), done: false })}
      onOpenPath={noop}
    />,
  );
  assert.ok(
    container.querySelector(".text-smui-yellow"),
    "a not-done call derives the running status",
  );
});
