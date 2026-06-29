import assert from "node:assert/strict";
import { test } from "vitest";
import { contentHash, DOCS_CORPUS_VERSION, type Page } from "./corpus";
import {
  citationFor,
  EXCERPT_MAX_CHARS,
  formatCitation,
  previewExcerpts,
  READ_MAX_CHARS,
  readPage,
  searchCorpus,
} from "./query";

/**
 * The query layer is pure ranking + citation: it ranks heading-delimited segments by term frequency
 * and heading proximity, returns compact cited excerpts (source URL + title + a stable locator),
 * reads a single page within a bounded char cap, and caps every result with a continuation cursor so a
 * large corpus never dumps wholesale. Deterministic - no IO, no clock.
 */

function page(id: string, url: string, title: string, content: string): Page {
  return {
    version: DOCS_CORPUS_VERSION,
    pageId: id,
    corpusId: "acme-000000000000",
    url,
    finalUrl: url,
    title,
    content,
    contentHash: contentHash(content),
    fetchedAt: "2026-06-29T00:00:00.000Z",
    staleAfter: "2026-06-30T00:00:00.000Z",
    backend: "static",
    provenance: "static",
    truncated: false,
    diagnostics: [],
    links: [],
  };
}

const PAGES: readonly Page[] = [
  page(
    "0000000000000001",
    "https://docs.acme.dev/guide/auth",
    "Authentication",
    "# Overview\n\nThe guide introduces the product and how to get set up quickly.\n\n# Authentication\n\nAuthentication uses an API token. Pass the token in the Authorization header to authenticate every request.",
  ),
  page(
    "0000000000000002",
    "https://docs.acme.dev/guide/errors",
    "Errors",
    "# Errors\n\nErrors are returned as JSON with a code and a message. A 401 means the request was not authenticated.",
  ),
];

test("searchCorpus ranks the segment whose heading matches the query first", () => {
  const ranked = searchCorpus(PAGES, "authentication token", { limit: 5 });

  assert.ok(ranked.excerpts.length >= 1);
  const top = ranked.excerpts[0];
  assert.ok(top);
  assert.equal(top.pageId, "0000000000000001");
  assert.equal(top.locator, "#authentication");
  assert.ok(top.score >= 5, "a heading-term match outscores body-only matches");
});

test("each excerpt carries a citation: source URL, title, and a stable locator", () => {
  const ranked = searchCorpus(PAGES, "authenticated", { limit: 5 });
  const hit = ranked.excerpts.find((excerpt) => excerpt.pageId === "0000000000000002");

  assert.ok(hit);
  assert.equal(hit.url, "https://docs.acme.dev/guide/errors");
  assert.equal(hit.title, "Errors");
  assert.equal(hit.locator, "#errors");
  assert.equal(formatCitation(hit), "Errors - https://docs.acme.dev/guide/errors#errors");
});

test("searchCorpus is deterministic for the same corpus and query", () => {
  const a = searchCorpus(PAGES, "authentication token", { limit: 5 });
  const b = searchCorpus(PAGES, "authentication token", { limit: 5 });

  assert.deepEqual(a, b);
});

test("searchCorpus caps the excerpts and returns a continuation cursor when more remain", () => {
  const first = searchCorpus(PAGES, "token errors", { limit: 1 });

  assert.equal(first.excerpts.length, 1);
  assert.ok(first.total > 1);
  assert.equal(first.nextOffset, 1);

  const second = searchCorpus(PAGES, "token errors", { limit: 1, offset: first.nextOffset });
  assert.equal(second.excerpts.length, 1);
  assert.notEqual(second.excerpts[0]?.pageId, first.excerpts[0]?.pageId);
});

test("previewExcerpts returns one lead excerpt per page, capped and continuable", () => {
  const preview = previewExcerpts(PAGES, { limit: 1 });

  assert.equal(preview.excerpts.length, 1);
  assert.equal(preview.total, 2);
  assert.equal(preview.nextOffset, 1);
  assert.equal(preview.excerpts[0]?.pageId, "0000000000000001");
});

test("readPage bounds the returned content and reports a continuation offset", () => {
  const big = page(
    "0000000000000009",
    "https://docs.acme.dev/guide/big",
    "Big",
    `# Big\n\n${"word ".repeat(5_000)}`,
  );

  const head = readPage(big, {});

  assert.ok(head.view.content.length <= READ_MAX_CHARS);
  assert.ok(head.total > READ_MAX_CHARS);
  assert.equal(head.nextOffset, head.view.content.length);
  assert.equal(head.view.url, "https://docs.acme.dev/guide/big");
  assert.equal(head.view.locator, "#big");

  const tail = readPage(big, { offset: head.nextOffset });
  assert.ok(tail.view.content.length > 0);
  assert.equal(tail.view.locator, `@${head.nextOffset}`);
});

test("readPage returns the whole page with no continuation when it fits the cap", () => {
  const result = readPage(PAGES[1] as Page, {});

  assert.equal(result.nextOffset, undefined);
  assert.equal(result.view.content, (PAGES[1] as Page).content);
});

test("an excerpt is capped to the excerpt char budget", () => {
  const wordy = page(
    "0000000000000010",
    "https://docs.acme.dev/guide/wordy",
    "Wordy",
    `# Wordy\n\n${"token ".repeat(2_000)}`,
  );

  const ranked = searchCorpus([wordy], "token", { limit: 5 });
  const excerpt = ranked.excerpts[0];

  assert.ok(excerpt);
  assert.ok(
    excerpt.excerpt.length <= EXCERPT_MAX_CHARS + 6,
    "excerpt stays within the char budget",
  );
});

test("citationFor uses the page's final URL as the source URL", () => {
  const redirected: Page = { ...(PAGES[0] as Page), finalUrl: "https://docs.acme.dev/v2/auth" };
  const citation = citationFor(redirected, "#authentication");

  assert.equal(citation.url, "https://docs.acme.dev/v2/auth");
  assert.equal(citation.title, "Authentication");
  assert.equal(citation.locator, "#authentication");
});
