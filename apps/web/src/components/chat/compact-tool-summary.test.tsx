import assert from "node:assert/strict";
import { LoaderIcon } from "lucide-react";
import { test } from "vitest";
import type { Message } from "../../transcript";
import { compactDisplayFor } from "./compact-display";

/**
 * M4: per-tool compact summaries. The compact tool row's secondary should name what the tool acted on -
 * the command, pattern, path, search query, fetch url, or multi-edit file + edit count - across bash,
 * read, write, edit, multi_edit, grep, glob, web_search, session_recall, docs, web_fetch, MCP, and
 * unknown tools, plus the running state.
 */

function toolRow(name: string, args: object, over?: Partial<Message>): Message {
  return {
    kind: "tool",
    id: "t",
    name,
    args: JSON.stringify(args),
    done: true,
    ...over,
  } as Message;
}

const summary = (name: string, args: object, over?: Partial<Message>): string | null =>
  compactDisplayFor(toolRow(name, args, over))?.secondary ?? null;

test("file/command/pattern tools summarize on their primary arg", () => {
  assert.equal(summary("bash", { command: "pnpm test" }), "pnpm test");
  assert.equal(summary("read", { path: "src/app.ts" }), "src/app.ts");
  assert.equal(summary("write", { path: "src/new.ts" }), "src/new.ts");
  assert.equal(summary("edit", { path: "src/app.ts" }), "src/app.ts");
  assert.equal(summary("grep", { pattern: "useState" }), "useState");
  assert.equal(summary("glob", { pattern: "**/*.tsx" }), "**/*.tsx");
});

test("search and fetch tools summarize on query / url (not raw JSON)", () => {
  assert.equal(
    summary("web_search", { query: "tanstack virtual overscan" }),
    "tanstack virtual overscan",
  );
  assert.equal(
    summary("session_recall", { query: "where did we set the budget" }),
    "where did we set the budget",
  );
  assert.equal(summary("docs", { query: "effect Layer" }), "effect Layer");
  assert.equal(
    summary("web_fetch", { url: "https://example.com/post" }),
    "https://example.com/post",
  );
});

test("multi_edit summarizes the file and the edit count", () => {
  const s = summary("multi_edit", {
    path: "src/app.ts",
    edits: [
      { old: "a", new: "b" },
      { old: "c", new: "d" },
      { old: "e", new: "f" },
    ],
  });
  assert.ok(s);
  assert.match(s, /src\/app\.ts/);
  assert.match(s, /3 edits/);
});

test("MCP and unknown tools fall back to a generic summary, never crash", () => {
  // An MCP-style dynamic name with a path arg uses the generic path fallback.
  assert.equal(summary("mcp__github__get_issue", { path: "owner/repo#1" }), "owner/repo#1");
  // A truly unknown tool with no recognized arg degrades to null (no noisy "{}"), not a throw.
  assert.equal(summary("totally_unknown", {}), null);
  // Malformed args never throw.
  assert.doesNotThrow(() => compactDisplayFor(toolRow("bash", {}, { args: "{not json" })));
});

test("a running tool keeps its summary and shows the running spinner", () => {
  const d = compactDisplayFor(toolRow("web_search", { query: "live results" }, { done: false }));
  assert.ok(d);
  assert.equal(d.status, "running");
  assert.equal(d.icon, LoaderIcon);
  assert.equal(d.secondary, "live results");
});
