import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import { test, vi } from "vitest";
import { DetailBody } from "./detail-body";
import type { ToolDetailModel } from "./detail-model";

/**
 * M3: the filesystem + shell detail adapters. Each tool's body shows its key fields - bash command + cwd,
 * read path/range + open-in-editor, write/edit/multi_edit file paths + diffs - and an unknown tool falls
 * back to the generic Arguments/Output body.
 */

function model(
  over: Partial<ToolDetailModel> & { toolName: string; args: string },
): ToolDetailModel {
  return { id: "c1", source: "tool", status: "done", aborted: false, ...over };
}

test("bash shows the command, the working directory, and the output", () => {
  render(
    <DetailBody
      model={model({
        toolName: "bash",
        args: '{"command":"ls -la","cwd":"~/dev"}',
        output: "a.ts",
      })}
    />,
  );
  assert.ok(screen.getByText("Command"));
  assert.ok(screen.getByText("ls -la"));
  assert.ok(screen.getByText("~/dev"));
  assert.ok(screen.getByText("a.ts"));
});

test("read shows the path + range and opens the file in the editor", () => {
  const onOpenPath = vi.fn();
  render(
    <DetailBody
      model={model({
        toolName: "read",
        args: '{"path":"apps/web/src/app.tsx","offset":10,"limit":5}',
      })}
      onOpenPath={onOpenPath}
    />,
  );
  assert.ok(screen.getByText("L10-14"), "the read range is labelled");
  fireEvent.click(screen.getByText("apps/web/src/app.tsx"));
  assert.deepEqual(onOpenPath.mock.calls, [["apps/web/src/app.tsx"]]);
});

test("write shows the file and its contents as a diff", () => {
  render(
    <DetailBody
      model={model({
        toolName: "write",
        args: '{"path":"new.ts","content":"export const x = 1;"}',
      })}
    />,
  );
  assert.ok(screen.getAllByText("new.ts").length >= 1);
  assert.ok(screen.getByText(/export const x = 1;/));
});

test("edit shows the file and the change", () => {
  render(
    <DetailBody
      model={model({ toolName: "edit", args: '{"path":"a.ts","old":"const x","new":"const y"}' })}
    />,
  );
  assert.ok(screen.getByText("Change"));
  assert.ok(screen.getAllByText("a.ts").length >= 1);
});

test("multi_edit shows the file (from edits[].path) and a per-edit change count", () => {
  render(
    <DetailBody
      model={model({
        // Real host shape (plan 08.1): no top-level path; each edit carries its own.
        toolName: "multi_edit",
        args: '{"edits":[{"path":"a.ts","old":"x","new":"y"},{"path":"a.ts","old":"a","new":"b"}]}',
      })}
    />,
  );
  assert.ok(screen.getByText("Changes (2)"));
  // The FILE section names the file (a.ts) rather than rendering "(none)".
  assert.ok(screen.getAllByText("a.ts").length >= 1, "the FILE section shows the file");
  assert.equal(screen.queryByText("(none)"), null, "the FILE section is not empty");
});

test("a multi-file multi_edit shows every file and a per-file diff summary", () => {
  render(
    <DetailBody
      model={model({
        toolName: "multi_edit",
        args: '{"edits":[{"path":"a.ts","old":"x","new":"y"},{"path":"b.ts","old":"a","new":"b"}]}',
      })}
    />,
  );
  // Two distinct files -> the section title pluralizes to "Files" and both get a chip.
  assert.ok(screen.getByText("Files"));
  assert.ok(screen.getAllByText("a.ts").length >= 1);
  assert.ok(screen.getAllByText("b.ts").length >= 1);
  // The diff summary counts 2 files, not the collapsed "1 file" the old top-level path produced.
  assert.ok(screen.getByText(/2 files/), "the CHANGES summary reports 2 files");
});

test("grep shows the pattern, scope, and match count", () => {
  render(
    <DetailBody
      model={model({
        toolName: "grep",
        args: '{"pattern":"export","path":"apps/web/src"}',
        output: "a.ts:1: export x\nb.ts:2: export y",
      })}
    />,
  );
  assert.ok(screen.getByText("Pattern"));
  assert.ok(screen.getByText("export"));
  assert.ok(screen.getByText("apps/web/src"));
  assert.ok(screen.getByText("Matches"));
  assert.ok(screen.getByText("2"));
});

test("web_search shows the query as the request and its results", () => {
  render(
    <DetailBody
      model={model({
        toolName: "web_search",
        args: '{"query":"effect schema"}',
        output: "1 result",
      })}
    />,
  );
  assert.ok(screen.getByText("Request"));
  assert.ok(screen.getByText("effect schema"));
  assert.ok(screen.getByText("1 result"));
});

test("docs shows the action + subject request", () => {
  render(
    <DetailBody
      model={model({
        toolName: "docs",
        args: '{"action":"read","subject":"react"}',
        output: "...",
      })}
    />,
  );
  assert.ok(screen.getByText("read react"));
});

test("an unknown / MCP tool falls back to the generic Arguments + Output body", () => {
  render(
    <DetailBody model={model({ toolName: "mcp__server__do", args: '{"x":1}', output: "ok" })} />,
  );
  assert.ok(screen.getByText("Arguments"));
  assert.ok(screen.getByText('{"x":1}'));
  assert.ok(screen.getByText("ok"));
});

test("tool_script shows the script source, permitted toolsets, and the result", () => {
  render(
    <DetailBody
      model={model({
        toolName: "tool_script",
        args: '{"script":"return await tools.read({path:\'a\'});","toolsets":["safe_read"]}',
        output: '{"files":3}',
      })}
    />,
  );
  assert.ok(screen.getByText("Script"));
  assert.ok(screen.getByText("return await tools.read({path:'a'});"));
  assert.ok(screen.getByText("Permitted toolsets"));
  assert.ok(screen.getByText("safe_read"));
  assert.ok(screen.getByText('{"files":3}'));
});

test("tool_script defaults the toolsets label to safe_read when none were sent", () => {
  render(<DetailBody model={model({ toolName: "tool_script", args: '{"script":"return 1;"}' })} />);
  assert.ok(screen.getByText("safe_read"));
});

test("video_inspect shows the video path, the frame timeline, and dimensions (plan 39 M9)", () => {
  const onOpenPath = vi.fn();
  render(
    <DetailBody
      model={model({
        toolName: "video_inspect",
        args: '{"path":"/tmp/clip.mp4","maxFrames":2}',
        output: JSON.stringify({
          processor: "video",
          path: "/tmp/clip.mp4",
          unavailable: false,
          durationMs: 3000,
          width: 16,
          height: 12,
          sampledFrameCount: 2,
          truncated: true,
          warnings: [],
          frames: [
            {
              frameIndex: 0,
              timestampMs: 0,
              width: 16,
              height: 12,
              artifact: { kind: "image", mimeType: "image/png", size: 100, hash: "f0" },
            },
            {
              frameIndex: 1,
              timestampMs: 1000,
              width: 16,
              height: 12,
              artifact: { kind: "image", mimeType: "image/png", size: 100, hash: "f1" },
            },
          ],
        }),
      })}
      onOpenPath={onOpenPath}
    />,
  );
  assert.ok(screen.getByText("Timeline"), "the per-frame timeline section renders");
  assert.ok(screen.getByText("#0"), "the first frame index renders");
  assert.ok(screen.getByText("1.0s"), "the second frame timestamp renders");
  fireEvent.click(screen.getByText("/tmp/clip.mp4"));
  assert.deepEqual(onOpenPath.mock.calls, [["/tmp/clip.mp4"]], "clicking the path opens the video");
});
