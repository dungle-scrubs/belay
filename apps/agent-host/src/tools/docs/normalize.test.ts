import assert from "node:assert/strict";
import { test } from "vitest";
import { normalizeMarkdown } from "./normalize";

/**
 * Normalization keeps the documentation (headings, code, prose, short link lists) while stripping the
 * navigation chrome a docs page carries, and it never edits the inside of a fenced code block. It also
 * reports the heading outline and outgoing links so the fetch step can flag thin pages and record
 * in-corpus navigation.
 */

test("headings and fenced code blocks survive normalization", () => {
  const raw = "# Title\n\nSome prose.\n\n```ts\nconst x = 1;\n```\n\n## Usage\n\nMore prose.";
  const result = normalizeMarkdown(raw);

  assert.match(result.content, /# Title/);
  assert.match(result.content, /```ts\nconst x = 1;\n```/);
  assert.deepEqual(result.headings, ["Title", "Usage"]);
});

test("navigation clutter lines are stripped", () => {
  const raw = [
    "Skip to content",
    "# Real Heading",
    "On this page",
    "Body text that is the actual content.",
    "Edit this page on GitHub",
    "Was this page helpful?",
  ].join("\n");
  const result = normalizeMarkdown(raw);

  assert.ok(!result.content.includes("Skip to content"));
  assert.ok(!result.content.includes("On this page"));
  assert.ok(!result.content.includes("Edit this page"));
  assert.ok(!result.content.includes("Was this page helpful"));
  assert.match(result.content, /# Real Heading/);
  assert.match(result.content, /Body text that is the actual content\./);
});

test("a dense link menu is dropped but a short link list and inline links survive", () => {
  const menu = [
    "[Home](/home)",
    "[Guide](/guide)",
    "[API](/api)",
    "[Reference](/reference)",
    "[Blog](/blog)",
    "[Community](/community)",
  ].join("\n");
  const body = "# Docs\n\nSee [the guide](/guide) for details.\n\n- [One](/one)\n- [Two](/two)";
  const result = normalizeMarkdown(`${menu}\n\n${body}`);

  assert.ok(!result.content.includes("[Community](/community)"), "the nav menu run is dropped");
  assert.match(result.content, /See \[the guide\]\(\/guide\) for details\./);
  assert.match(result.content, /- \[One\]\(\/one\)/);
});

test("clutter phrases inside a code fence are preserved verbatim", () => {
  const raw = "# Title\n\n```\nSkip to content\nOn this page\n```";
  const result = normalizeMarkdown(raw);

  assert.match(result.content, /```\nSkip to content\nOn this page\n```/);
});

test("runs of blank lines collapse and outgoing links are reported", () => {
  const raw = "# Title\n\n\n\nBody with a [link](https://x.dev/a) and [another](https://x.dev/b).";
  const result = normalizeMarkdown(raw);

  assert.ok(!result.content.includes("\n\n\n"), "3+ blank lines collapse to one");
  assert.deepEqual(result.links, ["https://x.dev/a", "https://x.dev/b"]);
});

test("an empty body normalizes to empty content", () => {
  assert.equal(normalizeMarkdown("   \n\n   ").content, "");
});
