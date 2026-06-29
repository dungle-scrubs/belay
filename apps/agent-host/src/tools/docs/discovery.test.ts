import assert from "node:assert/strict";
import { test } from "vitest";
import { parseLlms, parseRobots, parseSitemap, pickDocsRoot, resolveCandidates } from "./discovery";
import type { WebFetchReader, WebSearchReader } from "./readers";

/**
 * Discovery resolves a bounded, explainable candidate list from a direct URL or a subject, sourced
 * from a curated llms.txt / llms-full.txt, a sitemap, or the index page's own links, and fenced by
 * caps (pages, bytes, depth), same-origin/path scope, and robots.txt - surfacing every drop and every
 * clipped cap as a visible diagnostic. All network IO is injected, so nothing touches the wire.
 */

interface ProbeFields {
  readonly content?: string;
  readonly status?: number;
  readonly byteCount?: number;
}

function probe(fields: ProbeFields): string {
  return JSON.stringify({
    content: fields.content ?? "",
    status: fields.status ?? 200,
    byteCount: fields.byteCount ?? 0,
    finalUrl: "",
  });
}

/** A web_fetch reader over a fixed url->envelope map; an unmapped url reads as an absent (404) page. */
function fetcher(map: Record<string, string>): WebFetchReader {
  return async ({ url }) =>
    map[url] ?? JSON.stringify({ content: "", status: 404, byteCount: 0, finalUrl: url });
}

function searcher(results: readonly { title?: string; url: string }[]): WebSearchReader {
  return async ({ query }) => JSON.stringify({ provider: "brave", query, results });
}

function urls(result: { candidates: readonly { url: string }[] }): string[] {
  return result.candidates.map((candidate) => candidate.url);
}

test("a direct docs URL anchors discovery and llms.txt enumerates in-scope candidates", async () => {
  const fetch = fetcher({
    "https://docs.x.dev/llms.txt": probe({
      content:
        "- [A](https://docs.x.dev/guide/a)\n- [B](https://docs.x.dev/guide/b)\n- [Blog](https://docs.x.dev/blog/c)",
    }),
  });
  const result = await resolveCandidates(
    { url: "https://docs.x.dev/guide", maxPages: 40 },
    { webFetch: fetch },
  );

  assert.equal(result.rootUrl, "https://docs.x.dev/guide");
  assert.equal(result.candidates[0]?.via, "explicit");
  assert.deepEqual(urls(result).sort(), [
    "https://docs.x.dev/guide",
    "https://docs.x.dev/guide/a",
    "https://docs.x.dev/guide/b",
  ]);
  assert.equal(result.candidates.find((c) => c.url.endsWith("/guide/a"))?.via, "llms");
  assert.ok(result.skipped.some((s) => s.url.includes("/blog/c") && /scope/.test(s.reason)));
  assert.equal(result.truncated, false);
});

test("a subject query resolves a docs root through web_search", async () => {
  const fetch = fetcher({
    "https://docs.acme.dev/llms.txt": probe({
      content: "[Intro](https://docs.acme.dev/intro)\n[API](https://docs.acme.dev/api)",
    }),
  });
  const search = searcher([{ title: "Acme Docs", url: "https://docs.acme.dev/" }]);
  const result = await resolveCandidates(
    { subject: "Acme SDK", maxPages: 40 },
    { webFetch: fetch, webSearch: search },
  );

  assert.equal(result.rootUrl, "https://docs.acme.dev/");
  assert.equal(result.candidates[0]?.via, "search");
  assert.ok(urls(result).includes("https://docs.acme.dev/intro"));
  assert.ok(urls(result).includes("https://docs.acme.dev/api"));
});

test("an official docs result is preferred over a blog or repo", async () => {
  const search = searcher([
    { title: "Acme on Medium", url: "https://medium.com/@acme/getting-started" },
    { title: "acme/acme on GitHub", url: "https://github.com/acme/acme" },
    { title: "Acme Documentation", url: "https://docs.acme.dev/" },
  ]);
  const result = await resolveCandidates(
    { subject: "Acme", maxPages: 40 },
    { webFetch: fetcher({}), webSearch: search },
  );

  assert.equal(result.rootUrl, "https://docs.acme.dev/");
});

test("a subject query with no web_search seam yields no candidates and a clear diagnostic", async () => {
  const result = await resolveCandidates(
    { subject: "Acme", maxPages: 40 },
    { webFetch: fetcher({}) },
  );

  assert.equal(result.candidates.length, 0);
  assert.equal(result.partial, true);
  assert.ok(result.diagnostics.some((line) => /web_search unavailable/.test(line)));
});

test("llms-full.txt is enumerated when llms.txt is absent", async () => {
  const fetch = fetcher({
    "https://x.dev/llms-full.txt": probe({
      content: "# Full docs\n\nSee [A](https://x.dev/a) and [B](https://x.dev/b).",
    }),
  });
  const result = await resolveCandidates(
    { url: "https://x.dev/", maxPages: 40 },
    { webFetch: fetch },
  );

  assert.equal(result.candidates.find((c) => c.url.endsWith("/a"))?.via, "llms-full");
  assert.ok(urls(result).includes("https://x.dev/a"));
});

test("a sitemap is enumerated when no llms files exist, honoring scope", async () => {
  const fetch = fetcher({
    "https://x.dev/sitemap.xml": probe({
      content:
        "<urlset><url><loc>https://x.dev/docs/a</loc></url><url><loc>https://x.dev/docs/b</loc></url><url><loc>https://other.dev/docs/c</loc></url></urlset>",
    }),
  });
  const result = await resolveCandidates(
    { url: "https://x.dev/docs", maxPages: 40 },
    { webFetch: fetch },
  );

  assert.equal(result.candidates.find((c) => c.url.endsWith("/docs/a"))?.via, "sitemap");
  assert.ok(urls(result).includes("https://x.dev/docs/a"));
  assert.ok(!urls(result).includes("https://other.dev/docs/c"), "off-host loc is out of scope");
  assert.ok(result.skipped.some((s) => s.url.includes("other.dev")));
});

test("an index page's own links are enumerated as a last resort", async () => {
  const fetch = fetcher({
    "https://x.dev/docs": probe({
      content: "# Index\n\n[Guide](https://x.dev/docs/guide) and [Ref](https://x.dev/docs/ref).",
    }),
  });
  const result = await resolveCandidates(
    { url: "https://x.dev/docs", maxPages: 40 },
    { webFetch: fetch },
  );

  assert.equal(result.candidates.find((c) => c.url.endsWith("/docs/guide"))?.via, "index");
  assert.ok(urls(result).includes("https://x.dev/docs/ref"));
});

test("the page cap clips the candidate set and surfaces partial/truncated metadata", async () => {
  const fetch = fetcher({
    "https://x.dev/sitemap.xml": probe({
      content:
        "<urlset><url><loc>https://x.dev/a</loc></url><url><loc>https://x.dev/b</loc></url><url><loc>https://x.dev/c</loc></url></urlset>",
    }),
  });
  const result = await resolveCandidates(
    { url: "https://x.dev/", maxPages: 2 },
    { webFetch: fetch },
  );

  assert.equal(result.candidates.length, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.partial, true);
  assert.ok(result.skipped.some((s) => /page cap/.test(s.reason)));
  assert.ok(result.diagnostics.some((line) => /page cap/.test(line)));
});

test("a depth cap of 0 keeps only the root candidate", async () => {
  const fetch = fetcher({
    "https://x.dev/llms.txt": probe({ content: "[A](https://x.dev/a)" }),
  });
  const result = await resolveCandidates(
    { url: "https://x.dev/", maxPages: 40, maxDepth: 0 },
    { webFetch: fetch },
  );

  assert.deepEqual(urls(result), ["https://x.dev/"]);
  assert.ok(result.diagnostics.some((line) => /depth cap/.test(line)));
});

test("the byte budget halts enumeration and marks the result partial", async () => {
  const fetch = fetcher({
    "https://x.dev/llms.txt": probe({
      // present but out of scope, so enumeration would continue - except the budget is now spent.
      content: "[Blog](https://x.dev/blog/c)",
      byteCount: 5000,
    }),
  });
  const result = await resolveCandidates(
    { url: "https://x.dev/guide", maxPages: 40, maxBytes: 100 },
    { webFetch: fetch },
  );

  assert.deepEqual(urls(result), ["https://x.dev/guide"]);
  assert.equal(result.partial, true);
  assert.ok(result.diagnostics.some((line) => /byte budget/.test(line)));
});

test("robots.txt disallow rules drop disallowed candidates", async () => {
  const fetch = fetcher({
    "https://x.dev/robots.txt": probe({ content: "User-agent: *\nDisallow: /private" }),
    "https://x.dev/sitemap.xml": probe({
      content:
        "<urlset><url><loc>https://x.dev/public/a</loc></url><url><loc>https://x.dev/private/b</loc></url></urlset>",
    }),
  });
  const result = await resolveCandidates(
    { url: "https://x.dev/", maxPages: 40 },
    { webFetch: fetch },
  );

  assert.ok(urls(result).includes("https://x.dev/public/a"));
  assert.ok(!urls(result).includes("https://x.dev/private/b"));
  assert.ok(result.skipped.some((s) => /robots/.test(s.reason)));
});

test("parsers extract URLs and disallow rules deterministically", () => {
  assert.deepEqual(parseLlms("- [A](https://x.dev/a)\nhttps://x.dev/b", "https://x.dev/"), [
    "https://x.dev/a",
    "https://x.dev/b",
  ]);
  assert.deepEqual(parseSitemap("<url><loc>https://x.dev/a</loc></url>", "https://x.dev/"), [
    "https://x.dev/a",
  ]);
  assert.deepEqual(parseRobots("User-agent: *\nDisallow: /x\nDisallow: /y"), ["/x", "/y"]);
  assert.equal(
    pickDocsRoot("acme", [
      { url: "https://github.com/acme/acme" },
      { url: "https://docs.acme.dev/" },
    ]),
    "https://docs.acme.dev/",
  );
});
