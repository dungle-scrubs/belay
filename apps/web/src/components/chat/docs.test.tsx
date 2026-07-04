import assert from "node:assert/strict";
import { render } from "@testing-library/react";
import { test } from "vitest";
import type { ToolMessage as ToolMessageData } from "@/transcript";
import { ToolRenderer } from "./tool-message";

/**
 * Plan 05 M7: the docs transcript surface. These pin that the docs result envelope renders as
 * STRUCTURED, source-backed documentation - a corpus summary, ranked excerpts with citations (source
 * URL + title), a bounded page read, and an inventory listing - rather than opaque JSON, and that the
 * stale, partial, unavailable, and error states are all visibly surfaced. The dispatch routing docs to
 * this renderer is covered too.
 */

const toolMsg = (over: Partial<ToolMessageData>): ToolMessageData => ({
  kind: "tool",
  id: "t1",
  name: "docs",
  args: "{}",
  done: true,
  ...over,
});

const noop = () => {};

function corpus(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    corpusId: "effect-schema-abc123",
    subject: "Effect Schema",
    rootUrl: "https://effect.website/docs/schema",
    pageCount: 4,
    byteCount: 8200,
    updatedAt: "2026-06-29T00:00:00.000Z",
    staleAfter: "2026-06-30T00:00:00.000Z",
    partial: false,
    ...over,
  };
}

function excerpt(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pageId: "p1",
    url: "https://effect.website/docs/schema/intro",
    title: "Schema Introduction",
    locator: "#introduction",
    excerpt: "Schema parses and validates unknown data into typed values.",
    score: 1,
    ...over,
  };
}

function resolveResult(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "resolve",
    outcome: "ok",
    detail: "docs resolve built corpus effect-schema-abc123 for Effect Schema: 4 page(s)",
    corpus: corpus(),
    excerpts: [
      excerpt(),
      excerpt({
        pageId: "p2",
        url: "https://effect.website/docs/schema/api",
        title: "Schema API",
        locator: "#api",
        excerpt: "Use Schema.decode to parse unknown input into a typed value.",
      }),
    ],
    window: { unit: "excerpts", returned: 2, total: 2, truncated: false },
    stale: false,
    ...over,
  });
}

test("a resolve result renders the corpus summary and cited excerpts (not raw JSON)", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        args: JSON.stringify({ action: "resolve", subject: "Effect Schema" }),
        result: resolveResult(),
      })}
      onOpenPath={noop}
    />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("Effect Schema"), "the corpus subject renders");
  assert.ok(text.includes("4 pages"), "the corpus page count renders");
  assert.ok(text.includes("Schema Introduction"), "an excerpt title renders");
  assert.ok(
    text.includes("Schema parses and validates unknown data into typed values."),
    "the excerpt body renders",
  );
  assert.ok(
    container.querySelector('a[href="https://effect.website/docs/schema/intro"]'),
    "the excerpt cites its source URL as a link",
  );
  assert.ok(
    container.querySelector('a[href="https://effect.website/docs/schema"]'),
    "the corpus summary links the documentation root",
  );
  assert.ok(!text.includes('"corpusId"'), "the raw JSON envelope is not dumped");
});

test("a search result renders the query and its cited excerpts", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        args: JSON.stringify({
          action: "search",
          corpusId: "effect-schema-abc123",
          query: "decode",
        }),
        result: JSON.stringify({
          action: "search",
          outcome: "ok",
          detail: 'docs search: 1 excerpt(s) for "decode" in effect-schema-abc123',
          corpus: corpus(),
          query: {
            corpusId: "effect-schema-abc123",
            query: "decode",
            excerpts: [excerpt({ excerpt: "Schema.decode parses unknown input." })],
          },
          window: { unit: "excerpts", returned: 1, total: 1, truncated: false },
          stale: false,
        }),
      })}
      onOpenPath={noop}
    />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("decode"), "the query text renders");
  assert.ok(text.includes("Schema.decode parses unknown input."), "the matched excerpt renders");
  assert.ok(
    container.querySelector('a[href="https://effect.website/docs/schema/intro"]'),
    "the search excerpt cites its source URL",
  );
});

test("a read result renders the page title link and bounded content", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        args: JSON.stringify({ action: "read", corpusId: "effect-schema-abc123", pageId: "p1" }),
        result: JSON.stringify({
          action: "read",
          outcome: "ok",
          detail: "docs read: p1 (120 of 120 chars)",
          corpus: corpus(),
          page: {
            pageId: "p1",
            corpusId: "effect-schema-abc123",
            url: "https://effect.website/docs/schema/intro",
            title: "Schema Introduction",
            content: "# Schema Introduction\n\nSchema parses and validates unknown data.",
            fetchedAt: "2026-06-29T00:00:00.000Z",
            staleAfter: "2026-06-30T00:00:00.000Z",
            backend: "static",
            provenance: "web_fetch static",
            locator: "#introduction",
          },
          window: { unit: "chars", returned: 120, total: 120, truncated: false },
          stale: false,
        }),
      })}
      onOpenPath={noop}
    />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("Schema parses and validates unknown data."), "the page content renders");
  assert.ok(
    container.querySelector('a[href="https://effect.website/docs/schema/intro"]'),
    "the page title links its source URL",
  );
});

test("a stale result surfaces a visible stale marker", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        args: JSON.stringify({ action: "resolve", subject: "Effect Schema" }),
        result: resolveResult({ stale: true, detail: "docs resolve: reused cached corpus, STALE" }),
      })}
      onOpenPath={noop}
    />,
  );
  assert.ok(
    (container.textContent ?? "").toLowerCase().includes("stale"),
    "the stale state is visible",
  );
});

test("a partial corpus surfaces a visible partial marker, its provenance, and diagnostics", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        args: JSON.stringify({ action: "status", corpusId: "effect-schema-abc123" }),
        result: JSON.stringify({
          action: "status",
          outcome: "ok",
          detail: "docs status: effect-schema-abc123 - 3 page(s), fresh, partial",
          corpus: corpus({ partial: true, pageCount: 3 }),
          provenance: "web_search official docs; web_fetch auto; 3 page(s), 1 failed",
          stale: false,
          diagnostics: [
            "corpus is partial: some pages were skipped or failed",
            "failed: https://effect.website/docs/schema/x: 404",
          ],
        }),
      })}
      onOpenPath={noop}
    />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.toLowerCase().includes("partial"), "the partial state is visible");
  assert.ok(text.includes("web_fetch auto"), "the provenance line renders");
  assert.ok(text.includes("some pages were skipped or failed"), "a diagnostic renders");
});

test("a list result renders each corpus with its freshness", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        args: JSON.stringify({ action: "list" }),
        result: JSON.stringify({
          action: "list",
          outcome: "ok",
          detail: "docs list: 2 of 2 corpus/corpora",
          corpora: [
            { ...corpus(), stale: false },
            {
              ...corpus({
                corpusId: "react-xyz",
                subject: "React",
                rootUrl: "https://react.dev",
              }),
              stale: true,
            },
          ],
          window: { unit: "corpora", returned: 2, total: 2, truncated: false },
        }),
      })}
      onOpenPath={noop}
    />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("Effect Schema"), "the first corpus is listed");
  assert.ok(text.includes("React"), "the second corpus is listed");
  assert.ok(text.toLowerCase().includes("stale"), "the stale corpus is marked stale");
});

test("an unavailable result surfaces the missing dependency", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        args: JSON.stringify({ action: "resolve", subject: "Effect" }),
        result: JSON.stringify({
          action: "resolve",
          outcome: "unavailable",
          detail: "docs resolve is unavailable: missing web_fetch",
          missing: ["web_fetch"],
        }),
      })}
      onOpenPath={noop}
    />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.toLowerCase().includes("unavailable"), "the unavailable state is visible");
  assert.ok(text.includes("web_fetch"), "the missing dependency is named");
});

test("an error result shows its message instead of content", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        args: JSON.stringify({ action: "resolve", subject: "Nonexistent" }),
        result: "error: docs resolve could not resolve any documentation pages",
      })}
      onOpenPath={noop}
    />,
  );
  assert.ok(
    (container.textContent ?? "").includes("could not resolve any documentation pages"),
    "the typed error surfaces",
  );
});

test("a running docs call shows the working indicator", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        args: JSON.stringify({ action: "resolve", subject: "Effect Schema" }),
        done: false,
      })}
      onOpenPath={noop}
    />,
  );
  assert.ok(
    (container.textContent ?? "").toLowerCase().includes("looking up docs"),
    "the looking-up indicator shows while running",
  );
});

test("plan 31 fix: a running docs call shows the specific subject, not just the bare verb", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        args: JSON.stringify({ action: "resolve", subject: "Effect Schema" }),
        done: false,
      })}
      onOpenPath={noop}
    />,
  );
  assert.ok(
    (container.textContent ?? "").includes("Effect Schema"),
    "the running label names the specific subject being looked up",
  );
});

test("docs dispatches to the structured documentation renderer", () => {
  const { container } = render(
    <ToolRenderer
      message={toolMsg({
        args: JSON.stringify({ action: "resolve", subject: "Effect Schema" }),
        result: resolveResult(),
      })}
      onOpenPath={noop}
    />,
  );
  assert.ok(
    (container.textContent ?? "").includes("Schema Introduction"),
    "the dispatch reaches the docs renderer",
  );
});
