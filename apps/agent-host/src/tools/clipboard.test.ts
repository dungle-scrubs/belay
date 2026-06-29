import assert from "node:assert/strict";
import { Effect } from "effect";
import { afterEach, test } from "vitest";
import {
  CaptureClipboard,
  clipboardArgv,
  clipboardWriteTool,
  getClipboardWriter,
  resetClipboardWriter,
  setClipboardWriter,
} from "./clipboard";
import { executeTool } from "./index";

/**
 * M1 - the host clipboard write boundary. Every test swaps in the in-memory CaptureClipboard so
 * the real system clipboard is never touched (D-009); the spawn-backed real writer is never
 * exercised here. Platform selection is proven through `clipboardArgv` (pure, no spawn).
 */

afterEach(() => {
  resetClipboardWriter();
});

function run(text: string): Promise<string> {
  return Effect.runPromise(clipboardWriteTool.execute({ text }));
}

test("clipboard_write writes the exact text to the active writer and reports bounded metadata", async () => {
  const capture = new CaptureClipboard();
  setClipboardWriter(capture);

  const text = "ship it: copy this verbatim\nwith a newline";
  const result = await run(text);

  assert.deepEqual(capture.writes, [text]);
  assert.deepEqual(JSON.parse(result), { copied: true, charCount: text.length });
});

test("the capture adapter records without touching the real clipboard", async () => {
  const capture = new CaptureClipboard();
  setClipboardWriter(capture);
  assert.equal(
    getClipboardWriter(),
    capture,
    "the active writer is the in-memory capture, not spawn",
  );

  await run("first");
  await run("second");

  assert.deepEqual(capture.writes, ["first", "second"]);
  assert.equal(capture.last, "second");
});

test("clipboard_write returns a structured tool error when the host write fails", async () => {
  setClipboardWriter(new CaptureClipboard("no clipboard command available"));

  const result = await Effect.runPromise(
    executeTool("clipboard_write", JSON.stringify({ text: "x" })),
  );

  assert.match(result, /^error: clipboard_write failed/);
  assert.match(result, /no clipboard command available/);
});

test("clipboard_write is registered and decodes its text argument through the executor", async () => {
  const capture = new CaptureClipboard();
  setClipboardWriter(capture);

  const result = await Effect.runPromise(
    executeTool("clipboard_write", JSON.stringify({ text: "via the registry" })),
  );

  assert.deepEqual(JSON.parse(result), { copied: true, charCount: 16 });
  assert.deepEqual(capture.writes, ["via the registry"]);
});

test("clipboardArgv keeps platform selection behind the abstraction", () => {
  assert.deepEqual(clipboardArgv("darwin"), ["pbcopy", []]);
  assert.deepEqual(clipboardArgv("win32"), ["clip", []]);
  assert.deepEqual(clipboardArgv("linux"), ["wl-copy", []]);
  assert.throws(() => clipboardArgv("aix"), /no clipboard command/i);
});
