import assert from "node:assert/strict";
import { render } from "@testing-library/react";
import { test } from "vitest";
import type { ToolMessage as ToolMessageData } from "@/transcript";
import { parseArchiveResult } from "./archive";
import { ToolRenderer } from "./tool-message";

const noop = () => {};

function toolMsg(over: Partial<ToolMessageData>): ToolMessageData {
  return {
    kind: "tool",
    id: "t1",
    name: "archive_read",
    args: "{}",
    done: true,
    ...over,
  };
}

function readEnvelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    tool: "archive_read",
    source: "/tmp/evidence.zip",
    path: "/tmp/evidence.zip",
    archiveBytes: 1024,
    expandedBytes: 40,
    warnings: ["Archive text preview budget exhausted"],
    entries: [
      {
        path: "logs/app.txt",
        originalPath: "logs/app.txt",
        compressedBytes: 20,
        expandedBytes: 20,
        processor: "text",
        preview: "hello archive",
      },
      {
        path: "image.png",
        compressedBytes: 20,
        expandedBytes: 20,
        processor: "image",
        mime: "image/png",
        width: 320,
        height: 240,
      },
    ],
    ...over,
  });
}

test("parseArchiveResult parses archive envelopes and error lines", () => {
  assert.equal(parseArchiveResult(undefined), null);
  assert.equal(
    parseArchiveResult("error: archive_read failed - bad")?.error,
    "archive_read failed - bad",
  );
  assert.equal(parseArchiveResult(readEnvelope({}))?.entries?.[0]?.path, "logs/app.txt");
});

test("archive_read renders source, byte counts, warnings, previews, and image metadata", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        args: JSON.stringify({ path: "/tmp/evidence.zip" }),
        result: readEnvelope({}),
      })}
      onOpenPath={noop}
    />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("/tmp/evidence.zip"));
  assert.ok(text.includes("1.0 KiB zip"));
  assert.ok(text.includes("Archive text preview budget exhausted"));
  assert.ok(text.includes("hello archive"));
  assert.ok(text.includes("image/png 320x240"));
  assert.ok(!text.includes('"entries"'), "raw JSON should not render");
});

test("archive_unpack renders destination and extracted entries", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        name: "archive_unpack",
        args: JSON.stringify({ path: "/tmp/evidence.zip", destination: "/tmp/out" }),
        result: JSON.stringify({
          tool: "archive_unpack",
          source: "/tmp/evidence.zip",
          path: "/tmp/evidence.zip",
          destination: "/tmp/out",
          archiveBytes: 100,
          expandedBytes: 11,
          extractedEntries: [{ path: "logs/app.txt", bytes: 11 }],
          warnings: [],
        }),
      })}
      onOpenPath={noop}
    />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("to /tmp/out"));
  assert.ok(text.includes("logs/app.txt"));
  assert.ok(text.includes("11 B"));
});

test("running and error archive rows use status-aware rendering", () => {
  const running = render(
    <ToolRenderer
      message={toolMsg({
        args: JSON.stringify({ path: "/tmp/evidence.zip" }),
        done: false,
      })}
      onOpenPath={noop}
    />,
  );
  assert.ok((running.container.textContent ?? "").toLowerCase().includes("reading archive"));

  const failed = render(
    <ToolRenderer
      message={toolMsg({
        args: JSON.stringify({ path: "/tmp/evidence.zip" }),
        result: "error: archive_read failed - ARCHIVE_ENTRY_UNSAFE: no",
      })}
      onOpenPath={noop}
    />,
  );
  assert.ok((failed.container.textContent ?? "").includes("ARCHIVE_ENTRY_UNSAFE"));
});

test("plan 31 fix: a running archive row shows the specific source, not just the bare verb", () => {
  const readRunning = render(
    <ToolRenderer
      message={toolMsg({
        name: "archive_read",
        args: JSON.stringify({ path: "/tmp/evidence.zip" }),
        done: false,
      })}
      onOpenPath={noop}
    />,
  );
  assert.ok(
    (readRunning.container.textContent ?? "").includes("/tmp/evidence.zip"),
    "the running label names the specific archive source, not just 'reading archive'",
  );

  const unpackRunning = render(
    <ToolRenderer
      message={toolMsg({
        name: "archive_unpack",
        args: JSON.stringify({ path: "/tmp/evidence.zip", destination: "/tmp/out" }),
        done: false,
      })}
      onOpenPath={noop}
    />,
  );
  const text = unpackRunning.container.textContent ?? "";
  assert.ok(text.toLowerCase().includes("extracting archive"));
  assert.ok(text.includes("/tmp/evidence.zip"), "the running label names the archive source");
});

test("plan 31 fix: no path/url yet renders the bare verb, never a duplicated 'archive archive'", () => {
  const { container } = render(
    <ToolRenderer message={toolMsg({ args: "{}", done: false })} onOpenPath={noop} />,
  );
  const text = (container.textContent ?? "").toLowerCase();
  assert.ok(text.includes("reading archive"));
  assert.doesNotMatch(text, /archive archive/);
});
