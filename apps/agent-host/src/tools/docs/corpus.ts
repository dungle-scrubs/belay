/**
 * The docs corpus domain: the persisted shape of a cached external-documentation corpus and its
 * pages, plus the deterministic key derivation that gives every corpus and page a stable identity.
 * Same inputs always produce the same id, so a re-resolve of the same subject/version targets the
 * same on-disk corpus and a re-read of the same page URL targets the same page file. This module is
 * pure (types + hashing only); persistence lives in `corpus-store.ts` and the result envelope in
 * `envelope.ts`, so neither imports the other.
 */

import { createHash } from "node:crypto";

/**
 * Schema/format version stamped on every persisted corpus and page. A future shape change bumps
 * this so a reader detects an older layout as a migration rather than silently misreading it.
 */
export const DOCS_CORPUS_VERSION = 1;

/** Where a corpus's documentation came from, independent of the model-facing display subject. */
export interface CorpusSource {
  /** The documentation root the corpus was anchored to (e.g. a product docs home). */
  readonly rootUrl: string;
  /** The root URL's host, denormalized for quick provenance display. */
  readonly host: string;
  /** A documented product/library version the corpus pins, when the subject is versioned. */
  readonly version?: string;
  /** A release channel (stable, beta, canary, ...), when the docs distinguish one. */
  readonly channel?: string;
}

/** The fetch/discovery policy a corpus was built under; later phases act on it (freshness, re-fetch). */
export interface CorpusPolicy {
  /** The cap on pages discovery may gather into the corpus. */
  readonly maxPages: number;
  /** The web_fetch mode pages are read with (mirrors web_fetch's strategy). */
  readonly fetchMode: "auto" | "static" | "rendered";
  /** How many hours after a fetch the corpus is considered stale (drives `staleAfter`). */
  readonly freshnessHours: number;
}

/** One page that was skipped or failed during discovery/fetch, recorded for visibility. */
export interface PageDiagnostic {
  readonly url: string;
  readonly reason: string;
}

/** A cached corpus's metadata manifest. The normalized page content lives in sibling page files. */
export interface Corpus {
  readonly version: number;
  readonly corpusId: string;
  /** The model-facing name the corpus was resolved for (e.g. "Effect Schema"). */
  readonly subject: string;
  /** A normalized display name derived from the subject. */
  readonly name: string;
  readonly source: CorpusSource;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The freshness horizon: after this instant the corpus should be refreshed (Phase 5). */
  readonly staleAfter: string;
  readonly policy: CorpusPolicy;
  readonly pageCount: number;
  readonly byteCount: number;
  /** True when any page's content was truncated to its cap. */
  readonly truncated: boolean;
  /**
   * Manifest completeness flag: true while a write is in flight or a load found the corpus
   * incomplete, so an interrupted corpus is visibly PARTIAL rather than silently healthy.
   */
  readonly partial: boolean;
  /** A short, sanitized summary of how the corpus was built (backends, discovery). */
  readonly provenance: string;
  /** Pages discovery chose not to fetch (out of scope, over the cap, ...). */
  readonly skipped: readonly PageDiagnostic[];
  /** Pages a fetch attempted but could not store. */
  readonly failed: readonly PageDiagnostic[];
}

/** One cached page: its identity, source/final URL, normalized content, and a content hash. */
export interface Page {
  readonly version: number;
  readonly pageId: string;
  readonly corpusId: string;
  /** The URL the page was discovered/requested at. */
  readonly url: string;
  /** The post-redirect URL the content actually came from. */
  readonly finalUrl: string;
  readonly title?: string;
  readonly contentType?: string;
  /** The normalized markdown/text body. */
  readonly content: string;
  /** A sha256 of `content`, so a load detects a corrupt or truncated page file. */
  readonly contentHash: string;
  readonly fetchedAt: string;
  readonly staleAfter: string;
  /** The web_fetch backend that produced the content (static, jina, firecrawl). */
  readonly backend: string;
  /** A short, sanitized attribution summary for the page. */
  readonly provenance: string;
  readonly truncated: boolean;
  /** Page-level notes (e.g. "thin content", "rendered fallback used"). */
  readonly diagnostics: readonly string[];
  /** Outgoing in-corpus documentation links, for later cross-page navigation. */
  readonly links: readonly string[];
}

/** A compact projection of a corpus for listings and the resolve/status outcomes. */
export interface CorpusSummary {
  readonly corpusId: string;
  readonly subject: string;
  readonly rootUrl: string;
  readonly version?: string;
  readonly pageCount: number;
  readonly updatedAt: string;
  readonly staleAfter: string;
  readonly partial: boolean;
}

/** One ranked excerpt with its citation, the unit a corpus query returns (Phase 6). */
export interface QueryExcerpt {
  readonly pageId: string;
  readonly url: string;
  readonly title?: string;
  readonly excerpt: string;
  readonly score: number;
}

/** The compact, ranked, cited answer a corpus query produces (Phase 6). */
export interface QueryResult {
  readonly corpusId: string;
  readonly query: string;
  readonly excerpts: readonly QueryExcerpt[];
}

/** The inputs a corpus identity is derived from: the subject plus its source identity. */
export interface CorpusKeyInput {
  readonly subject: string;
  readonly rootUrl: string;
  readonly version?: string;
  readonly channel?: string;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** The host of a URL, or "" when it does not parse (the id derivation stays deterministic either way). */
export function hostOf(raw: string): string {
  try {
    return new URL(raw.trim()).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Canonicalizes a URL for identity: lowercased scheme+host, default ports and the fragment dropped,
 * a trailing slash trimmed from the path. The query is kept (a `?version=` distinguishes pages). A
 * URL that does not parse falls back to its trimmed, lowercased raw form so the derivation never throws.
 */
export function canonicalUrl(raw: string): string {
  let url: URL;

  try {
    url = new URL(raw.trim());
  } catch {
    return raw.trim().toLowerCase();
  }

  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";

  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ) {
    url.port = "";
  }

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}

/** A filesystem-safe, human-readable slug for an id prefix (lowercase alphanumeric, dash-separated). */
function slug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
}

/**
 * Derives a stable corpus id from (subject, root URL, version, channel). The id is a readable slug
 * plus a hash of the canonicalized inputs, so the same subject+source always resolves to the same
 * corpus, while case/trailing-slash/fragment differences in the root URL do not split it.
 */
export function corpusIdFor(input: CorpusKeyInput): string {
  const canonical = [
    input.subject.trim().toLowerCase(),
    canonicalUrl(input.rootUrl),
    (input.version ?? "").trim().toLowerCase(),
    (input.channel ?? "").trim().toLowerCase(),
  ].join("\n");
  const base = slug(input.subject) || slug(hostOf(input.rootUrl)) || "corpus";

  return `${base}-${sha256Hex(canonical).slice(0, 12)}`;
}

/**
 * Derives a stable page id from (corpusId, canonical page URL), so the same page URL within a
 * corpus always maps to the same page file across re-fetches.
 */
export function pageIdFor(corpusId: string, pageUrl: string): string {
  return sha256Hex(`${corpusId}\n${canonicalUrl(pageUrl)}`).slice(0, 16);
}

/** The content hash stored on a page, recomputed on load to detect a corrupt/truncated page file. */
export function contentHash(content: string): string {
  return sha256Hex(content);
}

/** The freshness horizon `freshnessHours` after a fetch instant; falls back to wall-clock on a bad input. */
export function staleAfterFrom(now: string, freshnessHours: number): string {
  const parsed = Date.parse(now);
  const base = Number.isNaN(parsed) ? Date.now() : parsed;

  return new Date(base + freshnessHours * 3_600_000).toISOString();
}
