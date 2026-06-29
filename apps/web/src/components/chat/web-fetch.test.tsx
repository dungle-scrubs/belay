import assert from "node:assert/strict";
import { render } from "@testing-library/react";
import { test } from "vitest";
import type { ToolMessage as ToolMessageData } from "@/transcript";
import { ToolRenderer } from "./tool-message";

/**
 * Plan 04 M7: the web_fetch transcript surface. These pin that the envelope renders as FLAT source
 * content (title, the final URL as a link, the markdown/text body) rather than opaque JSON, that a
 * truncated result and the backend/attempts footer surface, and that an all-failed/error envelope
 * shows its message - plus that the tool dispatch routes web_fetch here.
 */

const toolMsg = (over: Partial<ToolMessageData>): ToolMessageData => ({
  kind: "tool",
  id: "t1",
  name: "web_fetch",
  args: "{}",
  done: true,
  ...over,
});

const noop = () => {};

function envelope(over: Record<string, unknown>): string {
  return JSON.stringify({
    url: "https://docs.example.com/guide",
    finalUrl: "https://docs.example.com/guide",
    title: "The Guide",
    backend: "static",
    attempts: [{ backend: "static", status: "usable" }],
    truncated: false,
    textLength: 42,
    content: "# The Guide\n\nReal source content here.",
    ...over,
  });
}

test("a usable result renders the title, final URL link, and source content (not raw JSON)", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        args: JSON.stringify({ url: "https://docs.example.com/guide" }),
        result: envelope({}),
      })}
      onOpenPath={noop}
    />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("The Guide"), "the source title renders");
  assert.ok(text.includes("Real source content here."), "the extracted content renders");
  assert.ok(
    container.querySelector('a[href="https://docs.example.com/guide"]'),
    "the final URL renders as a link",
  );
  assert.ok(!text.includes('"backend"'), "the raw JSON envelope is not dumped");
});

test("the final URL (after redirects) is what the link points at", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        args: JSON.stringify({ url: "https://exmpl.co/r" }),
        result: envelope({ url: "https://exmpl.co/r", finalUrl: "https://docs.example.com/final" }),
      })}
      onOpenPath={noop}
    />,
  );
  assert.ok(
    container.querySelector('a[href="https://docs.example.com/final"]'),
    "the link follows the resolved finalUrl",
  );
});

test("a truncated result surfaces the truncation note in the footer", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        args: JSON.stringify({ url: "https://docs.example.com/guide" }),
        result: envelope({ truncated: true }),
      })}
      onOpenPath={noop}
    />,
  );
  assert.ok((container.textContent ?? "").includes("truncated"), "truncation is noted");
});

test("the footer summarizes the backend and the attempts ladder", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        args: JSON.stringify({ url: "https://docs.example.com/guide" }),
        result: envelope({
          backend: "jina",
          attempts: [
            { backend: "static", status: "thin" },
            { backend: "jina", status: "usable" },
          ],
        }),
      })}
      onOpenPath={noop}
    />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("via jina"), "the winning backend is shown");
  assert.ok(text.includes("static thin"), "the static attempt is shown in the ladder");
  assert.ok(text.includes("jina usable"), "the jina attempt is shown in the ladder");
});

test("an all-failed/error result shows its message instead of content", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        args: JSON.stringify({ url: "ftp://nope.example.com" }),
        result: "error: url scheme not allowed (only http and https)",
      })}
      onOpenPath={noop}
    />,
  );
  assert.ok(
    (container.textContent ?? "").includes("url scheme not allowed"),
    "the typed input error surfaces",
  );
});

test("a running web_fetch shows the working indicator", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        args: JSON.stringify({ url: "https://docs.example.com/guide" }),
        done: false,
      })}
      onOpenPath={noop}
    />,
  );
  assert.ok(
    (container.textContent ?? "").toLowerCase().includes("fetching"),
    "the fetching indicator shows while running",
  );
});

test("web_fetch dispatches to the source-content renderer", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        args: JSON.stringify({ url: "https://docs.example.com/guide" }),
        result: envelope({}),
      })}
      onOpenPath={noop}
    />,
  );
  assert.ok(
    (container.textContent ?? "").includes("The Guide"),
    "the dispatch reaches WebFetchResult",
  );
});
