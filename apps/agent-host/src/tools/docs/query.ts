/**
 * Corpus query + citation: the pure ranking and excerpting the docs query actions return. Given the
 * cached pages of a corpus it ranks heading-delimited segments for a query (term frequency plus a
 * heading-proximity bonus), builds compact cited excerpts, selects a lead preview without a query,
 * slices a single page into a bounded view, and formats the one citation shape every action shares.
 * Pure and deterministic - no IO, no clock - and deliberately separate from the freshness policy, so
 * ranking and refresh never entangle. Every result is capped, with a `nextOffset` continuation cursor,
 * so a large corpus never dumps wholesale into the prompt.
 */

import type { Page, PageView, QueryExcerpt } from "./corpus";

/** Max characters of body text a single excerpt carries. */
export const EXCERPT_MAX_CHARS = 400;

/** Max characters a single bounded page read returns per call. */
export const READ_MAX_CHARS = 4_000;

/** A heading-term match counts for this many body-term occurrences (heading proximity). */
const HEADING_BONUS = 5;

/** Common words dropped from a query so ranking keys on the meaningful terms. */
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "do",
  "does",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "what",
  "when",
  "why",
  "with",
]);

/** A heading-delimited region of a page: the heading text, its char offset, and the body beneath it. */
interface Segment {
  readonly heading: string;
  readonly start: number;
  readonly text: string;
}

/** A capped, ordered set of excerpts plus its continuation cursor when more remain. */
export interface Ranked {
  readonly excerpts: readonly QueryExcerpt[];
  /** Total candidate excerpts available before the cap. */
  readonly total: number;
  /** The offset to pass back to continue past this window, when the cap clipped the set. */
  readonly nextOffset?: number;
}

/** A bounded page read: the capped view plus the full length and the continuation cursor. */
export interface PageReadResult {
  readonly view: PageView;
  /** The page's full normalized content length, so the caller can see how much was held back. */
  readonly total: number;
  readonly nextOffset?: number;
}

/** A non-negative integer offset, defaulting to 0 for an absent or invalid cursor. */
export function clampOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Math.trunc(value);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function tokenize(text: string): readonly string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function queryTerms(query: string): readonly string[] {
  return [...new Set(tokenize(query).filter((term) => term.length > 1 && !STOP_WORDS.has(term)))];
}

/** A filesystem/anchor-safe slug for a heading, used as the stable in-page citation locator. */
function slug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60);
}

function isFence(line: string): boolean {
  return /^\s*```/.test(line);
}

function headingText(line: string): string | undefined {
  return line.match(/^#{1,6}\s+(.+?)\s*#*$/)?.[1]?.trim();
}

/** Splits a page into heading-delimited segments, tracking each segment's char offset, without ever
 *  treating a `#` inside a fenced code block as a heading. */
function segmentize(content: string): readonly Segment[] {
  const segments: Segment[] = [];
  let inFence = false;
  let heading = "";
  let bodyLines: string[] = [];
  let segmentStart = 0;
  let offset = 0;

  const flush = (start: number): void => {
    const text = bodyLines.join("\n").trim();

    if (heading !== "" || text !== "") {
      segments.push({ heading, start, text });
    }
  };

  for (const line of content.split("\n")) {
    if (isFence(line)) {
      inFence = !inFence;
      bodyLines.push(line);
      offset += line.length + 1;
      continue;
    }

    const found = inFence ? undefined : headingText(line);

    if (found !== undefined) {
      flush(segmentStart);
      heading = found;
      bodyLines = [];
      segmentStart = offset;
    } else {
      bodyLines.push(line);
    }

    offset += line.length + 1;
  }

  flush(segmentStart);

  return segments;
}

function scoreSegment(segment: Segment, terms: readonly string[]): number {
  let termFrequency = 0;

  for (const token of tokenize(segment.text)) {
    if (terms.includes(token)) {
      termFrequency += 1;
    }
  }

  const headingTokens = new Set(tokenize(segment.heading));
  let headingHits = 0;

  for (const term of terms) {
    if (headingTokens.has(term)) {
      headingHits += 1;
    }
  }

  return termFrequency + headingHits * HEADING_BONUS;
}

/** Builds a compact snippet around the earliest query-term match, capped to `maxChars` and marked
 *  with ellipses where it was clipped. With no terms it snips from the start (a lead preview). */
function snippet(text: string, terms: readonly string[], maxChars: number): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();

  if (collapsed.length <= maxChars) {
    return collapsed;
  }

  let start = 0;

  if (terms.length > 0) {
    const lower = collapsed.toLowerCase();
    let earliest = -1;

    for (const term of terms) {
      const at = lower.indexOf(term);

      if (at >= 0 && (earliest === -1 || at < earliest)) {
        earliest = at;
      }
    }

    if (earliest > 0) {
      const boundary = collapsed.lastIndexOf(" ", Math.max(0, earliest - 60));
      start = boundary > 0 ? boundary + 1 : Math.max(0, earliest - 60);
    }
  }

  let slice = collapsed.slice(start, start + maxChars);

  if (start + maxChars < collapsed.length) {
    const lastSpace = slice.lastIndexOf(" ");

    if (lastSpace > maxChars * 0.6) {
      slice = slice.slice(0, lastSpace);
    }

    slice = `${slice}...`;
  }

  if (start > 0) {
    slice = `...${slice}`;
  }

  return slice;
}

/**
 * The one citation shape every action shares: a source URL (the page's final URL), the page title,
 * and a stable in-page locator. `formatCitation` renders the same fields to a single display line.
 */
export function citationFor(
  page: Page,
  locator: string,
): { readonly url: string; readonly title?: string; readonly locator: string } {
  return {
    url: page.finalUrl,
    ...(page.title !== undefined ? { title: page.title } : {}),
    locator,
  };
}

/** Renders a citation to a single line (title plus the located source URL), with no title omitted. */
export function formatCitation(citation: {
  readonly url: string;
  readonly title?: string;
  readonly locator: string;
}): string {
  const target = `${citation.url}${citation.locator}`;

  return citation.title ? `${citation.title} - ${target}` : target;
}

function excerptFor(
  page: Page,
  segment: Segment,
  terms: readonly string[],
  score: number,
  maxChars: number,
): QueryExcerpt {
  const locator = segment.heading !== "" ? `#${slug(segment.heading)}` : `@${segment.start}`;
  const citation = citationFor(page, locator);
  const body = segment.text.trim() !== "" ? segment.text : segment.heading;

  return {
    pageId: page.pageId,
    url: citation.url,
    ...(citation.title !== undefined ? { title: citation.title } : {}),
    locator: citation.locator,
    excerpt: snippet(body, terms, maxChars),
    score,
  };
}

/**
 * Ranks heading-delimited segments across a corpus's pages for a query and returns a capped, ordered
 * set of cited excerpts. Order is score-descending with deterministic (pageId, offset) tie-breaks, so
 * the same corpus and query always produce the same window.
 */
export function searchCorpus(
  pages: readonly Page[],
  query: string,
  options: { readonly offset?: number; readonly limit: number; readonly excerptChars?: number },
): Ranked {
  const terms = queryTerms(query);
  const scored: { readonly page: Page; readonly segment: Segment; readonly score: number }[] = [];

  for (const page of pages) {
    for (const segment of segmentize(page.content)) {
      const score = terms.length > 0 ? scoreSegment(segment, terms) : 0;

      if (score > 0) {
        scored.push({ page, segment, score });
      }
    }
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      compare(a.page.pageId, b.page.pageId) ||
      a.segment.start - b.segment.start,
  );

  const offset = clampOffset(options.offset);
  const limit = Math.max(1, Math.trunc(options.limit));
  const windowed = scored.slice(offset, offset + limit);
  const excerpts = windowed.map((hit) =>
    excerptFor(hit.page, hit.segment, terms, hit.score, options.excerptChars ?? EXCERPT_MAX_CHARS),
  );
  const next = offset + windowed.length < scored.length ? offset + windowed.length : undefined;

  return { excerpts, total: scored.length, ...(next !== undefined ? { nextOffset: next } : {}) };
}

/**
 * Selects a lead excerpt per page - the corpus preview a resolve/refresh returns when there is no
 * query - capped and continuable, so even a large corpus returns only a bounded sample.
 */
export function previewExcerpts(
  pages: readonly Page[],
  options: { readonly offset?: number; readonly limit: number; readonly excerptChars?: number },
): Ranked {
  const offset = clampOffset(options.offset);
  const limit = Math.max(1, Math.trunc(options.limit));
  const windowed = pages.slice(offset, offset + limit);
  const excerpts = windowed.map((page) => {
    const segments = segmentize(page.content);
    const lead = segments.find((segment) => segment.text.trim() !== "") ??
      segments[0] ?? { heading: "", start: 0, text: page.content };

    return excerptFor(page, lead, [], 0, options.excerptChars ?? EXCERPT_MAX_CHARS);
  });
  const next = offset + windowed.length < pages.length ? offset + windowed.length : undefined;

  return { excerpts, total: pages.length, ...(next !== undefined ? { nextOffset: next } : {}) };
}

function firstHeadingLocator(content: string): string {
  const heading = segmentize(content).find((segment) => segment.heading !== "");

  return heading ? `#${slug(heading.heading)}` : "@0";
}

/**
 * Reads one page into a bounded view: a capped content slice from `offset`, the full length, and a
 * `nextOffset` cursor when content remains. The citation locator names the slice (a heading anchor for
 * the start, a `@charOffset` once paging in), through the same citation helper the excerpts use.
 */
export function readPage(
  page: Page,
  options: { readonly offset?: number; readonly maxChars?: number },
): PageReadResult {
  const total = page.content.length;
  const offset = clampOffset(options.offset);
  const maxChars = Math.max(1, Math.trunc(options.maxChars ?? READ_MAX_CHARS));
  const content = page.content.slice(offset, offset + maxChars);
  const end = offset + content.length;
  const locator = offset > 0 ? `@${offset}` : firstHeadingLocator(page.content);
  const citation = citationFor(page, locator);

  const view: PageView = {
    pageId: page.pageId,
    corpusId: page.corpusId,
    url: citation.url,
    ...(citation.title !== undefined ? { title: citation.title } : {}),
    ...(page.contentType !== undefined ? { contentType: page.contentType } : {}),
    content,
    fetchedAt: page.fetchedAt,
    staleAfter: page.staleAfter,
    backend: page.backend,
    provenance: page.provenance,
    locator: citation.locator,
  };
  const next = end < total ? end : undefined;

  return { view, total, ...(next !== undefined ? { nextOffset: next } : {}) };
}
