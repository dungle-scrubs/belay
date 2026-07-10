import assert from "node:assert/strict";
import { act, fireEvent, render } from "@testing-library/react";
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

test("bash dispatches to the collapsible fallback: name on the trigger, output collapsed by default", () => {
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
  const trigger = container.querySelector('[data-slot="tool-fallback-trigger"]');
  assert.ok(trigger, "the bash row renders as a ToolFallback trigger");
  assert.ok((trigger?.textContent ?? "").includes("bash"), "the tool name is on the trigger");
  assert.ok(
    !(container.textContent ?? "").includes("file-one"),
    "the command output stays collapsed (out of the DOM) until the row is opened",
  );
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

test("tool_script (completed) dispatches to the text-output renderer and shows its result (16 M9)", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        name: "tool_script",
        args: JSON.stringify({ script: "return { files: 3 };", toolsets: ["safe_read"] }),
        result: '{"files":3}',
      })}
      onOpenPath={noop}
    />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("tool_script"), "the tool name renders");
  assert.ok(text.includes('{"files":3}'), "the compact result renders in the row");
});

test("tool_script (failed) surfaces its typed failure line in the row (16 M9)", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        name: "tool_script",
        args: JSON.stringify({ script: "throw 1;", toolsets: ["safe_read"] }),
        result: "error: tool_script runtime_error: boom",
      })}
      onOpenPath={noop}
    />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("runtime_error"), "the failure class is visible in the transcript row");
});

/**
 * 58.6.2 M1 - null-until-complete audit (F5). Every arm that needs a specific arg to render its
 * specialized view must DEFER to the generic row (return null) until that arg has streamed in, so a
 * running row never mounts a half-built specialized view that then remounts. `renderDiff` (write/edit)
 * and `renderMultiEdit` defer on `path`; the flat-text arms (`renderOutput`/`renderFallback`) hold a
 * stable running row and never leak a partial result body mid-stream. These pin that discipline so a
 * future arm can't quietly regress it.
 */

test("M1: write defers to the generic row until a path streams in (no premature diff body)", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        name: "write",
        // A still-streaming write: content has arrived but the path has not yet.
        args: JSON.stringify({ content: "UNIQUE_STREAMING_WRITE_BODY" }),
        done: false,
      })}
      onOpenPath={noop}
    />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("write"), "the generic row still names the tool while streaming");
  assert.ok(
    !text.includes("UNIQUE_STREAMING_WRITE_BODY"),
    "the diff renderer must not mount its body before a path has streamed in",
  );
});

test("M1: edit defers to the generic row until a path streams in (no premature diff body)", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        name: "edit",
        args: JSON.stringify({ old: "UNIQUE_OLD_HUNK", new: "UNIQUE_NEW_HUNK" }),
        done: false,
      })}
      onOpenPath={noop}
    />,
  );
  const text = container.textContent ?? "";
  assert.ok(!text.includes("UNIQUE_OLD_HUNK"), "no old hunk before a path streams in");
  assert.ok(!text.includes("UNIQUE_NEW_HUNK"), "no new hunk before a path streams in");
});

test("M1: multi_edit defers to the generic row until an edit path streams in", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        name: "multi_edit",
        // An edit whose `path` has not yet arrived: filtered out, so the arm defers.
        args: JSON.stringify({ edits: [{ old: "a", new: "UNIQUE_ME_STREAMING_BODY" }] }),
        done: false,
      })}
      onOpenPath={noop}
    />,
  );
  const text = container.textContent ?? "";
  assert.ok(
    !text.includes("UNIQUE_ME_STREAMING_BODY"),
    "the grouped-diff renderer must not mount a path-less edit mid-stream",
  );
});

test("M1: a still-streaming text-output tool renders a running row without a partial result", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({ name: "grep", args: JSON.stringify({ pattern: "needle" }), done: false })}
      onOpenPath={noop}
    />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("grep"), "the running text-output row still names the tool");
  assert.ok(
    container.querySelector(".text-smui-yellow"),
    "a not-done text-output call derives the running status",
  );
});

/**
 * 58.6.2 M2 - ToolFallback for the flat-text arms (F7). `mcp`, every `lsp_*`, and `bash` now render
 * through the collapsible ToolFallback shell: collapsed by default (long output out of the DOM),
 * expandable to the Result body, a running shimmer while in flight, and the `error:` convention routed
 * to the Error block. These pin the collapse/expand, running, and completed-result behavior.
 */

const fallbackTrigger = (container: HTMLElement): HTMLElement => {
  const trigger = container.querySelector<HTMLElement>('[data-slot="tool-fallback-trigger"]');
  assert.ok(trigger, "the row renders through the ToolFallback shell");
  return trigger as HTMLElement;
};

test("M2: an lsp_diagnostics row starts collapsed and reveals its result on expand", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        name: "lsp_diagnostics",
        args: JSON.stringify({ path: "src/app.ts" }),
        result: "src/app.ts:12:5 error TS2304: Cannot find name 'foo'.",
      })}
      onOpenPath={noop}
    />,
  );
  assert.ok(
    !(container.textContent ?? "").includes("TS2304"),
    "the diagnostics body is collapsed out of the DOM by default",
  );
  act(() => {
    fireEvent.click(fallbackTrigger(container));
  });
  assert.ok(
    (container.textContent ?? "").includes("TS2304"),
    "expanding the row reveals the diagnostics body",
  );
});

test("M2: a running mcp row shows the shimmering trigger and no result body", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        name: "mcp",
        args: JSON.stringify({ action: "call", server: "github", tool: "list_prs" }),
        done: false,
      })}
      onOpenPath={noop}
    />,
  );
  const trigger = fallbackTrigger(container);
  assert.ok(
    trigger.querySelector('[data-slot="tool-fallback-trigger-shimmer"]'),
    "a running fallback row renders the shimmer overlay",
  );
  assert.ok(trigger.querySelector(".animate-spin"), "the running icon spins");
});

test("M2: a completed mcp row shows its result once expanded", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        name: "mcp",
        args: JSON.stringify({ action: "call", server: "github", tool: "list_prs" }),
        result: "UNIQUE_MCP_RESULT_BODY",
      })}
      onOpenPath={noop}
    />,
  );
  act(() => {
    fireEvent.click(fallbackTrigger(container));
  });
  assert.ok(
    (container.textContent ?? "").includes("UNIQUE_MCP_RESULT_BODY"),
    "the completed result renders in the expanded row",
  );
});

test("M2: a failed bash row routes its error: result to the Error block", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        name: "bash",
        args: JSON.stringify({ command: "false" }),
        result: "error: command exited with code 1",
      })}
      onOpenPath={noop}
    />,
  );
  act(() => {
    fireEvent.click(fallbackTrigger(container));
  });
  const errorBlock = container.querySelector('[data-slot="tool-fallback-error"]');
  assert.ok(errorBlock, "an error result renders the Error block");
  assert.ok(
    (errorBlock?.textContent ?? "").includes("command exited with code 1"),
    "the error reason renders (error: prefix stripped)",
  );
});
