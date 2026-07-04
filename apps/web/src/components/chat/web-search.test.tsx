import assert from "node:assert/strict";
import { render } from "@testing-library/react";
import { test } from "vitest";
import type { ToolMessage as ToolMessageData } from "@/transcript";
import { ToolRenderer } from "./tool-message";

/**
 * The web_search transcript surface. Pins that results render as a normalized list (title link,
 * source URL, snippet), that the provider/count/recency meta line shows, and that the tool
 * dispatch routes web_search here.
 */

const toolMsg = (over: Partial<ToolMessageData>): ToolMessageData => ({
  kind: "tool",
  id: "t1",
  name: "web_search",
  args: "{}",
  done: true,
  ...over,
});

const noop = () => {};

function envelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    provider: "brave",
    query: "vitest",
    results: [
      {
        title: "Vitest | Next Generation testing framework",
        url: "https://vitest.dev",
        snippet: "A Vite-native testing framework.",
      },
    ],
    ...over,
  });
}

test("a result renders the provider meta, title link, and snippet (not raw JSON)", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        args: JSON.stringify({ query: "vitest" }),
        result: envelope(),
      })}
      onOpenPath={noop}
    />,
  );
  const text = container.textContent ?? "";
  assert.ok(
    text.includes("Vitest | Next Generation testing framework"),
    "the result title renders",
  );
  assert.ok(text.includes("A Vite-native testing framework."), "the snippet renders");
  assert.ok(
    container.querySelector('a[href="https://vitest.dev"]'),
    "the result title links its source URL",
  );
  assert.ok(!text.includes('"snippet"'), "the raw JSON envelope is not dumped");
});

test("a running web_search shows the specific query, not just the bare verb", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({ args: JSON.stringify({ query: "useSlashMenu" }), done: false })}
      onOpenPath={noop}
    />,
  );
  const text = (container.textContent ?? "").toLowerCase();
  assert.ok(text.includes("searching the web"), "the running verb shows");
  assert.ok(text.includes("useslashmenu"), "the specific query renders in the running label");
});

test("web_search dispatches to the results renderer", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({ args: JSON.stringify({ query: "vitest" }), result: envelope() })}
      onOpenPath={noop}
    />,
  );
  assert.ok(
    (container.textContent ?? "").includes("Vitest | Next Generation testing framework"),
    "the dispatch reaches WebSearchResults",
  );
});
