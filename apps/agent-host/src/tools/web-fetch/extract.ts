/**
 * Deterministic HTML -> bounded markdown/text, plus the static-result classifier the fallback
 * ladder reads. No DOM library and no rendered backend: the plan's escape hatch accepts a
 * hand-rolled extractor (title from <title>, drop script/style/nav boilerplate, collapse
 * whitespace, keep links and code) over a heavy dependency. Tolerant of malformed HTML, since the
 * input is arbitrary public pages. The classifier decides usable | thin | blocked | failed so auto
 * mode knows when to hand off to Jina/Firecrawl later.
 *
 * Responsible for: deterministic HTML-to-markdown extraction, content bounding, and the
 * usable/thin/blocked/failed static-result classifier.
 */

import type { FetchAttemptStatus } from "./envelope";

export interface Extraction {
  readonly title?: string;
  readonly content: string;
}

/** Bounds the extracted text and reports whether it was cut. The cap protects the result envelope
 *  (web_fetch is NOT `capped: true` - the blunt 8000-char cap would corrupt the JSON), so the
 *  content field is bounded here, before serialization. */
export interface BoundedContent {
  readonly content: string;
  readonly truncated: boolean;
}

const BLOCK_TAGS = /<\/(p|div|section|article|h[1-6]|li|tr|br|pre|blockquote|header|footer)>/gi;
const DROP_BLOCKS =
  /<(script|style|noscript|template|svg|head|nav|footer|form|aside|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Extracts a title and readable body from an HTML document. Falls back to whole-text collapse
 *  when no structure survives, so a malformed page still yields something. */
export function extractHtml(html: string): Extraction {
  const title = extractTitle(html);
  const main = isolateMain(html);

  const withCode = preserveCode(main);
  const withLinks = preserveLinks(withCode);
  const blocked = withLinks.replace(BLOCK_TAGS, "\n");
  const stripped = stripTags(blocked);
  const content = collapseWhitespace(decodeEntities(stripped));

  return title !== undefined ? { title, content } : { content };
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

  if (!match?.[1]) {
    return undefined;
  }

  const title = collapseWhitespace(decodeEntities(stripTags(match[1])));

  return title.length > 0 ? title : undefined;
}

/** Narrows to <main>/<article> when present, else the <body>, else the whole document, then drops
 *  the always-boilerplate blocks (script/style/nav/...). */
function isolateMain(html: string): string {
  const main =
    firstBlock(html, "main") ?? firstBlock(html, "article") ?? firstBlock(html, "body") ?? html;

  return main.replace(DROP_BLOCKS, " ");
}

function firstBlock(html: string, tag: string): string | undefined {
  const match = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));

  return match?.[1];
}

/** Wraps <pre>/<code> contents in markdown fences/backticks BEFORE tag stripping, so code survives
 *  as code rather than collapsing into prose. */
function preserveCode(html: string): string {
  const fenced = html.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, inner: string) => {
    const code = decodeEntities(stripTags(inner)).replace(/^\n+|\n+$/g, "");
    return `\n\`\`\`\n${code}\n\`\`\`\n`;
  });

  return fenced.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_match, inner: string) => {
    return `\`${decodeEntities(stripTags(inner))}\``;
  });
}

/** Rewrites <a href> as markdown `[text](href)` before stripping, so links are kept and attributable. */
function preserveLinks(html: string): string {
  return html.replace(
    /<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href: string, inner: string) => {
      const text = collapseWhitespace(decodeEntities(stripTags(inner)));

      if (text.length === 0) {
        return "";
      }

      return href.length > 0 ? `[${text}](${href})` : text;
    },
  );
}

function stripTags(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ");
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A blocker/challenge page (Cloudflare, captcha, "enable JavaScript", access-denied interstitials)
 *  the static path can't get past - distinct from a thin page, which simply has little content. */
const BLOCKER_SIGNALS = [
  "captcha",
  "are you a robot",
  "verify you are human",
  "checking your browser",
  "cf-browser-verification",
  "enable javascript",
  "please enable js",
  "access denied",
  "request blocked",
  "ddos protection",
];

const THIN_TEXT_THRESHOLD = 200;

/**
 * Classifies a static extraction so auto mode knows whether to fall back. `failed` when the fetch
 * itself errored (no body); `blocked` when the page looks like a challenge/blocker; `thin` when the
 * body is a JS shell or has too little text to be the real content; otherwise `usable`.
 */
export function classifyStatic(input: {
  readonly httpStatus?: number;
  readonly rawHtml: string;
  readonly extractedText: string;
  readonly fetchFailed?: boolean;
}): FetchAttemptStatus {
  if (input.fetchFailed) {
    return "failed";
  }

  if (input.httpStatus !== undefined && input.httpStatus >= 400) {
    return "failed";
  }

  const haystack = `${input.rawHtml} ${input.extractedText}`.toLowerCase();

  if (BLOCKER_SIGNALS.some((signal) => haystack.includes(signal))) {
    return "blocked";
  }

  const text = input.extractedText.trim();

  if (text.length === 0) {
    return "thin";
  }

  // A JS shell renders almost no text but ships lots of <script>: a low text-to-markup ratio with
  // little visible text is the signature of a page whose content only appears after JS runs.
  if (text.length < THIN_TEXT_THRESHOLD && hasHeavyScript(input.rawHtml)) {
    return "thin";
  }

  return "usable";
}

function hasHeavyScript(html: string): boolean {
  const scripts = html.match(/<script\b/gi)?.length ?? 0;

  return scripts >= 1 && html.length > visibleTextLength(html) * 3;
}

function visibleTextLength(html: string): number {
  return stripTags(html.replace(DROP_BLOCKS, " ")).replace(/\s+/g, "").length || 1;
}

/** Applies the text-length cap to extracted content with a visible truncation marker. */
export function boundContent(content: string, maxChars: number): BoundedContent {
  if (content.length <= maxChars) {
    return { content, truncated: false };
  }

  return { content: `${content.slice(0, maxChars)}\n…[truncated]`, truncated: true };
}
