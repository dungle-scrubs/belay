/**
 * Bounded documentation discovery: resolve a small, explainable set of candidate page URLs for a
 * subject or an explicit docs URL WITHOUT crawling the open web. Resolution is deliberately kept
 * separate from page fetching (Phase 4) - this module returns a bounded URL list plus discovery
 * diagnostics; it never stores page content. When no explicit URL is given it uses the web_search
 * seam to pick an official-looking docs root, then enumerates candidates from a curated `llms.txt` /
 * `llms-full.txt`, a `sitemap.xml`, or the index page's own links - preferring the curated sources.
 * Enumeration is fenced by caps (max pages, max bytes, max depth), same-origin/path scope, and
 * robots.txt disallow rules, and every drop or clipped cap is surfaced as a visible diagnostic so a
 * partial result is never mistaken for an exhaustive one.
 *
 * Responsible for: resolving a bounded, diagnosed candidate-URL list for a docs subject or root.
 * Not for: fetching or storing page content - fetch-pages.ts.
 */

import { canonicalUrl, type PageDiagnostic } from "./corpus";
import type { WebFetchReader, WebSearchReader } from "./readers";

/** Total bytes of discovery probe fetches (manifests/index/robots) before enumeration stops. */
const DISCOVERY_MAX_BYTES = 2_000_000;

/** How many link hops from the root discovery will enumerate. The root is depth 0; curated manifest
 *  entries and index links are depth 1. docs is not a crawler, so the default never recurses past 1. */
const DISCOVERY_MAX_DEPTH = 1;

/** How many web_search results to consider when resolving a docs root from a subject. */
const DISCOVERY_SEARCH_COUNT = 8;

/** Character cap for a discovery probe fetch - larger than a page read so a big sitemap survives. */
const DISCOVERY_FETCH_MAX_CHARS = 50_000;

/** Hosts that are almost never the official docs root for a subject; penalized during root scoring. */
const NON_OFFICIAL_HOSTS = [
  "github.com",
  "gitlab.com",
  "medium.com",
  "stackoverflow.com",
  "reddit.com",
  "youtube.com",
  "dev.to",
  "twitter.com",
  "x.com",
];

/** How a candidate URL entered the result, for provenance and later ranking. */
export type CandidateSource = "explicit" | "search" | "llms" | "llms-full" | "sitemap" | "index";

/** One resolved candidate page URL (canonicalized), with its discovery depth and origin. */
export interface DiscoveryCandidate {
  readonly url: string;
  readonly depth: number;
  readonly via: CandidateSource;
}

/** What discovery resolves a subject/URL into: a bounded candidate list plus explainable metadata. */
export interface DiscoveryResult {
  readonly rootUrl: string;
  readonly host: string;
  readonly candidates: readonly DiscoveryCandidate[];
  /** URLs deliberately dropped (out of scope, robots-disallowed, over the page cap), for visibility. */
  readonly skipped: readonly PageDiagnostic[];
  readonly diagnostics: readonly string[];
  /** True when a cap clipped the candidate set (page cap or byte budget). */
  readonly truncated: boolean;
  /** True when discovery could not complete: no root resolved, or a cap cut enumeration short. */
  readonly partial: boolean;
  readonly provenance: string;
}

/** The inputs that drive a discovery pass. Caps default to the module constants; tests override them. */
export interface DiscoveryInput {
  readonly subject?: string;
  readonly url?: string;
  readonly version?: string;
  readonly maxPages: number;
  readonly maxBytes?: number;
  readonly maxDepth?: number;
  readonly searchCount?: number;
}

/** The seams discovery reads through; web_search is optional (only the subject path needs it). */
export interface DiscoveryDeps {
  readonly webFetch: WebFetchReader;
  readonly webSearch?: WebSearchReader;
}

/** A same-host, same-path-prefix scope a candidate must fall within to be in the corpus. */
interface Scope {
  readonly host: string;
  readonly prefix: string;
}

/** A single web_fetch probe reduced to what discovery reads: usable content + the bytes it cost. */
interface Probe {
  readonly present: boolean;
  readonly content: string;
  readonly byteCount: number;
}

function sanitize(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

function isHttpUrl(raw: string): boolean {
  try {
    const protocol = new URL(raw).protocol;

    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** The scheme+host(+port) origin of a URL, or "" when it does not parse. */
function originOf(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return "";
  }
}

/** The path with a trailing slash trimmed (the site root "/" is preserved). */
function trimPath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * Derives the same-host, same-path-prefix scope a root URL implies. A root that points at a file
 * (or a manifest) scopes to that file's directory; a section root scopes to itself, so
 * `https://x.dev/docs` keeps `/docs/...` in and `/blog/...` out, while `https://docs.x.dev/` keeps
 * the whole host in.
 */
function scopeOf(rootUrl: string): Scope {
  let url: URL;

  try {
    url = new URL(rootUrl);
  } catch {
    return { host: "", prefix: "/" };
  }

  const host = url.hostname.toLowerCase();
  let path = trimPath(url.pathname);
  const last = path.split("/").pop() ?? "";

  if (last.includes(".")) {
    const idx = path.lastIndexOf("/");
    path = idx <= 0 ? "/" : path.slice(0, idx);
  }

  return { host, prefix: path === "" ? "/" : path };
}

/** Whether a candidate URL falls within a root's same-host, same-path-prefix scope. */
function inScope(rawUrl: string, scope: Scope): boolean {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.hostname.toLowerCase() !== scope.host) {
    return false;
  }

  if (scope.prefix === "/") {
    return true;
  }

  const path = trimPath(url.pathname);

  return path === scope.prefix || path.startsWith(`${scope.prefix}/`);
}

/** Whether a URL's path is blocked by any robots.txt disallow prefix. */
function isDisallowed(rawUrl: string, disallow: readonly string[]): boolean {
  let path: string;

  try {
    path = new URL(rawUrl).pathname;
  } catch {
    return false;
  }

  return disallow.some((prefix) => prefix.length > 0 && path.startsWith(prefix));
}

/** Resolves a possibly-relative href against a base into an absolute URL, or undefined if it can't. */
function absolute(href: string, base: string): string | undefined {
  try {
    return new URL(href.trim(), base).toString();
  } catch {
    return undefined;
  }
}

/** Classifies an explicit URL whose path is itself a manifest, so it is parsed rather than read. */
function manifestKindOf(rawUrl: string): "llms" | "llms-full" | "sitemap" | undefined {
  let path: string;

  try {
    path = new URL(rawUrl).pathname.toLowerCase();
  } catch {
    return undefined;
  }

  if (path.endsWith("/llms-full.txt")) {
    return "llms-full";
  }

  if (path.endsWith("/llms.txt")) {
    return "llms";
  }

  if (path.endsWith("sitemap.xml") || path.endsWith("sitemap_index.xml")) {
    return "sitemap";
  }

  return undefined;
}

/** Extracts URLs from an `llms.txt` / `llms-full.txt` body: markdown link targets plus bare URLs. */
export function parseLlms(text: string, base: string): readonly string[] {
  const urls: string[] = [];

  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const resolved = absolute(match[1] ?? "", base);

    if (resolved) {
      urls.push(resolved);
    }
  }

  for (const match of text.matchAll(/(?<![([])\bhttps?:\/\/[^\s)\]]+/g)) {
    const resolved = absolute(match[0], base);

    if (resolved) {
      urls.push(resolved);
    }
  }

  return urls;
}

/** Extracts `<loc>` entries from a sitemap (or sitemap index) document. */
export function parseSitemap(xml: string, base: string): readonly string[] {
  const urls: string[] = [];

  for (const match of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    const resolved = absolute(match[1] ?? "", base);

    if (resolved) {
      urls.push(resolved);
    }
  }

  return urls;
}

/** Extracts markdown link targets from an index page web_fetch already rendered to markdown. */
export function parseIndexLinks(markdown: string, base: string): readonly string[] {
  const urls: string[] = [];

  for (const match of markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
    const resolved = absolute(match[1] ?? "", base);

    if (resolved) {
      urls.push(resolved);
    }
  }

  return urls;
}

/** Parses the `Disallow` path prefixes that apply to all agents (`User-agent: *`) in a robots.txt. */
export function parseRobots(text: string): readonly string[] {
  const disallow: string[] = [];
  let appliesToAll = false;

  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();

    if (line === "") {
      continue;
    }

    const agent = line.match(/^user-agent:\s*(.+)$/i);

    if (agent) {
      appliesToAll = (agent[1] ?? "").trim() === "*";
      continue;
    }

    const rule = line.match(/^disallow:\s*(.*)$/i);

    if (rule && appliesToAll) {
      const path = (rule[1] ?? "").trim();

      if (path !== "") {
        disallow.push(path);
      }
    }
  }

  return disallow;
}

/** Scores how much a search result looks like an official documentation root (higher is better). */
function scoreDocsResult(subject: string, result: { url: string; title?: string }): number {
  let url: URL;

  try {
    url = new URL(result.url);
  } catch {
    return Number.NEGATIVE_INFINITY;
  }

  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  let score = 0;

  if (host.startsWith("docs.") || host.startsWith("developer.") || host.startsWith("developers.")) {
    score += 3;
  }

  if (/\/(docs|documentation|reference|api|guide|guides)(\/|$)/.test(path)) {
    score += 2;
  }

  const token = subject.trim().toLowerCase().split(/\s+/)[0] ?? "";

  if (token.length >= 3 && host.includes(token)) {
    score += 2;
  }

  if (NON_OFFICIAL_HOSTS.some((bad) => host === bad || host.endsWith(`.${bad}`))) {
    score -= 3;
  }

  if (url.protocol === "https:") {
    score += 1;
  }

  return score;
}

/** Picks the best official-looking docs root from a list of search results, or undefined if empty. */
export function pickDocsRoot(
  subject: string,
  results: readonly { url: string; title?: string }[],
): string | undefined {
  let best: { url: string; score: number } | undefined;

  for (const result of results) {
    if (!isHttpUrl(result.url)) {
      continue;
    }

    const score = scoreDocsResult(subject, result);

    if (best === undefined || score > best.score) {
      best = { url: result.url, score };
    }
  }

  return best?.url;
}

/** Reads a web_search envelope into the minimal result rows discovery ranks. */
function parseSearch(raw: string): readonly { url: string; title?: string }[] {
  const parsed = JSON.parse(raw) as { results?: readonly { url?: string; title?: string }[] };

  return (parsed.results ?? [])
    .filter((row): row is { url: string; title?: string } => typeof row.url === "string")
    .map((row) => ({ url: row.url, ...(row.title !== undefined ? { title: row.title } : {}) }));
}

/** Reads a web_fetch envelope into the probe shape discovery needs (usable content + byte cost). */
function parseProbe(raw: string): Probe {
  const parsed = JSON.parse(raw) as {
    content?: string;
    status?: number;
    byteCount?: number;
  };
  const content = typeof parsed.content === "string" ? parsed.content : "";
  const blocked = typeof parsed.status === "number" && parsed.status >= 400;

  return {
    present: !blocked && content.trim() !== "",
    content,
    byteCount: typeof parsed.byteCount === "number" ? parsed.byteCount : 0,
  };
}

/** One web_fetch probe in static mode (discovery never triggers the rendered ladder). */
async function probeFetch(url: string, deps: DiscoveryDeps): Promise<Probe> {
  try {
    return parseProbe(
      await deps.webFetch({ url, mode: "static", maxChars: DISCOVERY_FETCH_MAX_CHARS }),
    );
  } catch {
    return { present: false, content: "", byteCount: 0 };
  }
}

/** Parses a probe body into candidate URLs given the manifest/index kind it came from. */
function parseManifest(kind: CandidateSource, content: string, base: string): readonly string[] {
  if (kind === "llms" || kind === "llms-full") {
    return parseLlms(content, base);
  }

  if (kind === "sitemap") {
    return parseSitemap(content, base);
  }

  return parseIndexLinks(content, base);
}

/** Resolves the documentation root: the explicit URL, or the best web_search docs result. */
async function resolveRoot(
  input: DiscoveryInput,
  deps: DiscoveryDeps,
  diagnostics: string[],
): Promise<{ rootUrl: string; via: CandidateSource } | undefined> {
  const url = input.url?.trim();

  if (url) {
    if (isHttpUrl(url)) {
      return { rootUrl: url, via: "explicit" };
    }

    diagnostics.push(`ignored non-http url: ${url}`);
  }

  const subject = input.subject?.trim();

  if (!subject) {
    diagnostics.push("no docs url or subject to resolve");
    return undefined;
  }

  if (!deps.webSearch) {
    diagnostics.push("web_search unavailable: cannot resolve a docs root from a subject");
    return undefined;
  }

  const query = `${subject} documentation${input.version ? ` ${input.version}` : ""}`;
  let results: readonly { url: string; title?: string }[];

  try {
    results = parseSearch(
      await deps.webSearch({ query, count: input.searchCount ?? DISCOVERY_SEARCH_COUNT }),
    );
  } catch (error) {
    diagnostics.push(`web_search failed: ${sanitize(error)}`);
    return undefined;
  }

  const picked = pickDocsRoot(subject, results);

  if (!picked) {
    diagnostics.push("web_search returned no usable docs root");
    return undefined;
  }

  diagnostics.push(`web_search docs root: ${picked}`);

  return { rootUrl: picked, via: "search" };
}

/**
 * Resolves a bounded, explainable set of candidate documentation page URLs. The result is the input
 * to Phase 4 fetching; this function performs only discovery probes (manifests, index, robots) and
 * never stores page content. Every cap hit and every dropped URL is recorded so a caller can mark a
 * partial corpus partial.
 */
export async function resolveCandidates(
  input: DiscoveryInput,
  deps: DiscoveryDeps,
): Promise<DiscoveryResult> {
  const maxBytes = input.maxBytes ?? DISCOVERY_MAX_BYTES;
  const maxDepth = input.maxDepth ?? DISCOVERY_MAX_DEPTH;
  const diagnostics: string[] = [];
  const skipped: PageDiagnostic[] = [];

  const rooted = await resolveRoot(input, deps, diagnostics);

  if (!rooted) {
    return {
      rootUrl: "",
      host: "",
      candidates: [],
      skipped,
      diagnostics,
      truncated: false,
      partial: true,
      provenance: "discovery: no root resolved",
    };
  }

  const { rootUrl, via } = rooted;
  const scope = scopeOf(rootUrl);
  const origin = originOf(rootUrl);
  const candidates: DiscoveryCandidate[] = [];
  const seen = new Set<string>();
  let bytesUsed = 0;
  let budgetHit = false;
  let disallow: readonly string[] = [];

  const addCandidate = (rawUrl: string, depth: number, source: CandidateSource): boolean => {
    if (depth > maxDepth) {
      return false;
    }

    const abs = absolute(rawUrl, origin);

    if (!abs) {
      return false;
    }

    const canon = canonicalUrl(abs);

    if (seen.has(canon)) {
      return false;
    }

    seen.add(canon);

    if (!inScope(canon, scope)) {
      skipped.push({ url: canon, reason: "out of scope (host/path)" });
      return false;
    }

    if (isDisallowed(canon, disallow)) {
      skipped.push({ url: canon, reason: "robots.txt disallow" });
      return false;
    }

    candidates.push({ url: canon, depth, via: source });
    return true;
  };

  const rootKind = manifestKindOf(rootUrl);

  if (rootKind) {
    const probe = await probeFetch(rootUrl, deps);
    bytesUsed += probe.byteCount;

    if (probe.present) {
      for (const url of parseManifest(rootKind, probe.content, rootUrl)) {
        addCandidate(url, 1, rootKind);
      }
    } else {
      diagnostics.push(`manifest ${rootUrl} was empty or unavailable`);
    }
  } else {
    addCandidate(rootUrl, 0, via);

    if (maxDepth < 1) {
      diagnostics.push("depth cap 0: enumeration skipped, only the root is a candidate");
    } else {
      const robots = await probeFetch(`${origin}/robots.txt`, deps);
      bytesUsed += robots.byteCount;
      disallow = robots.present ? parseRobots(robots.content) : [];

      const sources: readonly { url: string; kind: CandidateSource }[] = [
        { url: `${origin}/llms.txt`, kind: "llms" },
        { url: `${origin}/llms-full.txt`, kind: "llms-full" },
        { url: `${origin}/sitemap.xml`, kind: "sitemap" },
        { url: rootUrl, kind: "index" },
      ];

      for (const source of sources) {
        if (bytesUsed >= maxBytes) {
          budgetHit = true;
          diagnostics.push(`byte budget reached before probing ${source.kind}`);
          break;
        }

        const probe = await probeFetch(source.url, deps);
        bytesUsed += probe.byteCount;

        if (!probe.present) {
          continue;
        }

        let added = 0;

        for (const url of parseManifest(source.kind, probe.content, source.url)) {
          if (addCandidate(url, 1, source.kind)) {
            added += 1;
          }
        }

        if (added > 0) {
          diagnostics.push(`enumerated ${added} candidate(s) from ${source.kind}`);
          break;
        }
      }
    }
  }

  let truncated = false;
  let resolved = candidates;

  if (candidates.length > input.maxPages) {
    resolved = candidates.slice(0, input.maxPages);

    for (const dropped of candidates.slice(input.maxPages)) {
      skipped.push({ url: dropped.url, reason: "page cap reached" });
    }

    diagnostics.push(
      `page cap reached: kept ${resolved.length} of ${candidates.length} candidates`,
    );
    truncated = true;
  }

  const provenance = `discovery: root via ${via}; ${resolved.length} candidate(s)${
    truncated ? ", page-capped" : ""
  }${budgetHit ? ", byte-capped" : ""}`;

  return {
    rootUrl,
    host: scope.host,
    candidates: resolved,
    skipped,
    diagnostics,
    truncated,
    partial: truncated || budgetHit,
    provenance,
  };
}
