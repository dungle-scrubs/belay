/**
 * Page normalization: turn the markdown/text web_fetch already extracted into a leaner, citeable
 * documentation body. web_fetch owns HTML -> markdown (titles, code fences, links); this pass strips
 * the residual navigation clutter a docs page carries (skip-to-content, on-this-page, edit-this-page,
 * dense link menus) without ever touching the inside of a fenced code block, collapses runs of blank
 * lines, and reports the heading outline and outgoing links so the fetch step can detect thin pages
 * and record in-corpus navigation. Pure and deterministic - no IO, no DOM.
 */

/** A run of this many consecutive lone-link lines is treated as a nav menu and dropped. */
const MENU_RUN = 5;

/** Below this many characters of normalized body, a page is flagged thin (kept, but diagnosed). */
export const THIN_CONTENT_THRESHOLD = 200;

/** Lines that are navigation chrome rather than documentation, dropped outside code fences. */
const NAV_CLUTTER: readonly RegExp[] = [
  /^skip to (main )?content$/i,
  /^on this page$/i,
  /^in this article$/i,
  /^table of contents$/i,
  /^edit (this )?page/i,
  /^edit on github/i,
  /^view source/i,
  /^was this (page|article|helpful)/i,
  /^back to top$/i,
  /^previous$/i,
  /^next$/i,
  /^copy(\s+code)?$/i,
];

export interface Normalized {
  readonly content: string;
  readonly headings: readonly string[];
  /** Raw outgoing link targets (markdown hrefs); scope/dedup is the caller's concern. */
  readonly links: readonly string[];
}

function isFence(line: string): boolean {
  return /^\s*```/.test(line);
}

/** A line that is nothing but a single markdown link (optionally a list bullet) - menu material. */
function isLoneLink(line: string): boolean {
  return /^[-*]?\s*\[[^\]]+\]\([^)\s]+\)\s*$/.test(line);
}

function extractHeadings(content: string): readonly string[] {
  const headings: string[] = [];
  let inFence = false;

  for (const line of content.split("\n")) {
    if (isFence(line)) {
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/)?.[2]?.trim();

    if (heading) {
      headings.push(heading);
    }
  }

  return headings;
}

function extractLinks(content: string): readonly string[] {
  const links: string[] = [];
  const seen = new Set<string>();

  for (const match of content.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = match[1];

    if (href && !seen.has(href)) {
      seen.add(href);
      links.push(href);
    }
  }

  return links;
}

/**
 * Strips navigation clutter and collapses blank runs without ever editing fenced code, then reports
 * the heading outline and outgoing links of the cleaned body.
 */
export function normalizeMarkdown(raw: string): Normalized {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;
  let linkRun: string[] = [];

  const flushRun = (): void => {
    if (linkRun.length < MENU_RUN) {
      out.push(...linkRun);
    }

    linkRun = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (isFence(line)) {
      flushRun();
      inFence = !inFence;
      out.push(line);
      continue;
    }

    if (inFence) {
      out.push(line);
      continue;
    }

    if (NAV_CLUTTER.some((pattern) => pattern.test(trimmed))) {
      flushRun();
      continue;
    }

    if (isLoneLink(trimmed)) {
      linkRun.push(line);
      continue;
    }

    flushRun();
    out.push(line);
  }

  flushRun();

  const content = out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { content, headings: extractHeadings(content), links: extractLinks(content) };
}
