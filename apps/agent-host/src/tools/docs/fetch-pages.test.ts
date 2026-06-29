import assert from "node:assert/strict";
import { test } from "vitest";
import type { DiscoveryCandidate } from "./discovery";
import { type FetchPagesInput, fetchPages } from "./fetch-pages";
import type { WebFetchReader } from "./readers";

/**
 * Page fetch + normalization reads each candidate ONLY through the web_fetch seam, normalizes the
 * body, carries web_fetch provenance (final URL + winning backend) into the page, turns a failed read
 * into a diagnostic rather than a thrown turn, and de-duplicates by content hash and final URL.
 */

interface EnvFields {
  readonly url: string;
  readonly finalUrl?: string;
  readonly title?: string;
  readonly content?: string;
  readonly byteCount?: number;
  readonly truncated?: boolean;
  readonly backend?: string;
  readonly needsFallback?: boolean;
  readonly attempts?: readonly { backend: string; status: string }[];
}

function env(fields: EnvFields): string {
  return JSON.stringify({
    url: fields.url,
    finalUrl: fields.finalUrl ?? fields.url,
    title: fields.title,
    contentType: "text/markdown",
    status: 200,
    content: fields.content ?? "",
    byteCount: fields.byteCount ?? fields.content?.length ?? 0,
    truncated: fields.truncated ?? false,
    backend: fields.backend ?? "static",
    needsFallback: fields.needsFallback ?? false,
    attempts: fields.attempts ?? [{ backend: fields.backend ?? "static", status: "usable" }],
  });
}

function candidate(url: string): DiscoveryCandidate {
  return { url, depth: 1, via: "llms" };
}

function inputFor(candidates: readonly DiscoveryCandidate[]): FetchPagesInput {
  return {
    corpusId: "corpus-1",
    host: "x.dev",
    candidates,
    fetchMode: "auto",
    maxChars: 12_000,
    freshnessHours: 24,
    now: () => "2026-06-29T00:00:00.000Z",
  };
}

const BODY =
  "# Heading\n\nReal documentation body text long enough to not be considered thin content.";

test("each candidate is read through web_fetch and provenance is carried into the page", async () => {
  const calls: { url: string; mode?: string }[] = [];
  const fetch: WebFetchReader = async ({ url, mode }) => {
    calls.push({ url, ...(mode ? { mode } : {}) });
    return env({
      url,
      finalUrl: "https://x.dev/final",
      title: "Guide",
      content: BODY,
      backend: "jina",
      attempts: [
        { backend: "static", status: "thin" },
        { backend: "jina", status: "usable" },
      ],
    });
  };
  const result = await fetchPages(inputFor([candidate("https://x.dev/guide")]), fetch);

  assert.deepEqual(calls, [{ url: "https://x.dev/guide", mode: "auto" }]);
  assert.equal(result.pages.length, 1);
  const page = result.pages[0];
  assert.ok(page);
  assert.equal(page.url, "https://x.dev/guide");
  assert.equal(page.finalUrl, "https://x.dev/final");
  assert.equal(page.backend, "jina");
  assert.match(page.provenance, /jina/);
  assert.match(page.provenance, /finalUrl=https:\/\/x\.dev\/final/);
  assert.ok(page.diagnostics.some((note) => /jina/.test(note)));
});

test("page content is normalized (clutter stripped, heading and code kept)", async () => {
  const raw = "Skip to content\n\n# API\n\n```ts\nconst x = 1;\n```\n\nThe real body of the page.";
  const fetch: WebFetchReader = async ({ url }) => env({ url, content: raw });
  const result = await fetchPages(inputFor([candidate("https://x.dev/api")]), fetch);

  const page = result.pages[0];
  assert.ok(page);
  assert.ok(!page.content.includes("Skip to content"));
  assert.match(page.content, /# API/);
  assert.match(page.content, /```ts\nconst x = 1;\n```/);
});

test("a thin page is kept but flagged", async () => {
  const fetch: WebFetchReader = async ({ url }) => env({ url, content: "# Tiny\n\ntoo short" });
  const result = await fetchPages(inputFor([candidate("https://x.dev/tiny")]), fetch);

  assert.equal(result.pages.length, 1);
  assert.ok(result.pages[0]?.diagnostics.some((note) => /thin/.test(note)));
});

test("an empty/failed read becomes a diagnostic, not a stored page", async () => {
  const fetch: WebFetchReader = async ({ url }) => env({ url, content: "" });
  const result = await fetchPages(inputFor([candidate("https://x.dev/gone")]), fetch);

  assert.equal(result.pages.length, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]?.url, "https://x.dev/gone");
});

test("a thrown web_fetch is captured as a failed read", async () => {
  const fetch: WebFetchReader = async () => {
    throw new Error("network down");
  };
  const result = await fetchPages(inputFor([candidate("https://x.dev/a")]), fetch);

  assert.equal(result.pages.length, 0);
  assert.ok(result.failed[0]?.reason.includes("network down"));
});

test("duplicate content is de-duplicated by hash", async () => {
  const fetch: WebFetchReader = async ({ url }) => env({ url, finalUrl: url, content: BODY });
  const result = await fetchPages(
    inputFor([candidate("https://x.dev/a"), candidate("https://x.dev/b")]),
    fetch,
  );

  assert.equal(result.pages.length, 1);
  assert.ok(result.skipped.some((s) => /duplicate content/.test(s.reason)));
});

test("a redirect collision is de-duplicated by final URL", async () => {
  const bodies: Record<string, string> = {
    "https://x.dev/a": `${BODY} variant A`,
    "https://x.dev/b": `${BODY} variant B`,
  };
  const fetch: WebFetchReader = async ({ url }) =>
    env({ url, finalUrl: "https://x.dev/canonical", content: bodies[url] ?? "" });
  const result = await fetchPages(
    inputFor([candidate("https://x.dev/a"), candidate("https://x.dev/b")]),
    fetch,
  );

  assert.equal(result.pages.length, 1);
  assert.ok(result.skipped.some((s) => /duplicate final URL/.test(s.reason)));
});

test("byte counts and content truncation aggregate across pages", async () => {
  const fetch: WebFetchReader = async ({ url }) =>
    url.endsWith("/a")
      ? env({ url, content: `${BODY} A`, byteCount: 100, truncated: true })
      : env({ url, content: `${BODY} B`, byteCount: 200 });
  const result = await fetchPages(
    inputFor([candidate("https://x.dev/a"), candidate("https://x.dev/b")]),
    fetch,
  );

  assert.equal(result.byteCount, 300);
  assert.equal(result.truncated, true);
});

test("recorded links are restricted to in-corpus (same-host) targets", async () => {
  const content = "See [a](https://x.dev/a), [b](https://other.dev/b), and [c](/c) here.";
  const fetch: WebFetchReader = async ({ url }) =>
    env({ url, finalUrl: "https://x.dev/page", content });
  const result = await fetchPages(inputFor([candidate("https://x.dev/page")]), fetch);

  const links = result.pages[0]?.links ?? [];
  assert.ok(links.includes("https://x.dev/a"));
  assert.ok(links.includes("https://x.dev/c"));
  assert.ok(!links.some((link) => link.includes("other.dev")));
});
