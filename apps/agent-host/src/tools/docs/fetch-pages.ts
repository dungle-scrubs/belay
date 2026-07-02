/**
 * Page fetch + normalization (Phase 4): read each discovered candidate ONLY through the web_fetch
 * seam - docs never reaches a fetch backend directly, since web_fetch owns the static/rendered ladder
 * - then normalize the result into a citeable corpus page. web_fetch's provenance (final URL, winning
 * backend, per-attempt outcomes) is carried into the page so a reader can see where the content came
 * from. Empty/failed reads become page/corpus diagnostics rather than thrown turns; thin pages are
 * kept but flagged; and pages are de-duplicated by canonical final URL and by content hash so a redirect
 * collision or a mirror page does not bloat the corpus.
 *
 * Responsible for: fetching discovered candidates via the web_fetch seam and normalizing +
 * de-duplicating them into citeable corpus pages.
 * Not for: choosing the candidates - discovery.ts.
 */

import type { WebFetchResult } from "../web-fetch/envelope";
import {
  canonicalUrl,
  contentHash,
  DOCS_CORPUS_VERSION,
  hostOf,
  type Page,
  type PageDiagnostic,
  pageIdFor,
  staleAfterFrom,
} from "./corpus";
import type { DiscoveryCandidate } from "./discovery";
import { normalizeMarkdown, THIN_CONTENT_THRESHOLD } from "./normalize";
import type { WebFetchReader } from "./readers";

/** The most in-corpus navigation links a single page records. */
const MAX_PAGE_LINKS = 50;

export interface FetchPagesInput {
  readonly corpusId: string;
  /** The corpus root host, used to keep recorded links in-corpus. */
  readonly host: string;
  readonly candidates: readonly DiscoveryCandidate[];
  readonly fetchMode: "auto" | "static" | "rendered";
  readonly maxChars: number;
  readonly freshnessHours: number;
  readonly now: () => string;
}

export interface FetchPagesResult {
  readonly pages: readonly Page[];
  /** Candidates whose read produced no usable content. */
  readonly failed: readonly PageDiagnostic[];
  /** Candidates dropped as duplicates of an already-stored page. */
  readonly skipped: readonly PageDiagnostic[];
  readonly byteCount: number;
  /** True when any stored page's content was truncated to the fetch cap. */
  readonly truncated: boolean;
}

/** A web_fetch envelope reduced to the fields the page builder reads (defensive against partial JSON). */
interface FetchEnvelope {
  readonly finalUrl: string;
  readonly title?: string;
  readonly contentType?: string;
  readonly status?: number;
  readonly content: string;
  readonly byteCount: number;
  readonly truncated: boolean;
  readonly backend: string;
  readonly needsFallback: boolean;
  readonly attempts: readonly { backend: string; status: string }[];
}

function parseEnvelope(raw: string, url: string): FetchEnvelope {
  const parsed = JSON.parse(raw) as Partial<WebFetchResult>;

  return {
    finalUrl: typeof parsed.finalUrl === "string" ? parsed.finalUrl : url,
    ...(typeof parsed.title === "string" ? { title: parsed.title } : {}),
    ...(typeof parsed.contentType === "string" ? { contentType: parsed.contentType } : {}),
    ...(typeof parsed.status === "number" ? { status: parsed.status } : {}),
    content: typeof parsed.content === "string" ? parsed.content : "",
    byteCount: typeof parsed.byteCount === "number" ? parsed.byteCount : 0,
    truncated: parsed.truncated === true,
    backend: typeof parsed.backend === "string" ? parsed.backend : "unknown",
    needsFallback: parsed.needsFallback === true,
    attempts: Array.isArray(parsed.attempts)
      ? parsed.attempts.map((attempt) => ({ backend: attempt.backend, status: attempt.status }))
      : [],
  };
}

/** A short, sanitized attribution carrying the backend that won and what each attempt did. */
function provenanceOf(env: FetchEnvelope): string {
  const attempts = env.attempts.map((attempt) => `${attempt.backend}:${attempt.status}`).join(",");

  return `web_fetch ${env.backend}; finalUrl=${env.finalUrl}${
    attempts ? `; attempts=${attempts}` : ""
  }`.slice(0, 300);
}

/** Page-level notes derived from the fetch + normalization (rendered fallback, thin, truncated). */
function diagnosticsFor(env: FetchEnvelope, contentLength: number): readonly string[] {
  const notes: string[] = [];

  if (env.backend !== "static" && env.backend !== "unknown") {
    notes.push(`rendered/fallback backend used: ${env.backend}`);
  }

  if (env.needsFallback) {
    notes.push("web_fetch flagged needsFallback: content may be incomplete");
  }

  if (env.truncated) {
    notes.push("content truncated to the fetch cap");
  }

  if (contentLength < THIN_CONTENT_THRESHOLD) {
    notes.push(`thin content (${contentLength} chars)`);
  }

  return notes;
}

/** Keeps only same-host links, resolved against the final URL, de-duplicated and bounded. */
function inCorpusLinks(
  rawLinks: readonly string[],
  finalUrl: string,
  host: string,
): readonly string[] {
  const links: string[] = [];
  const seen = new Set<string>();

  for (const raw of rawLinks) {
    let resolved: string;

    try {
      resolved = new URL(raw, finalUrl).toString();
    } catch {
      continue;
    }

    if (hostOf(resolved) !== host || seen.has(resolved)) {
      continue;
    }

    seen.add(resolved);
    links.push(resolved);

    if (links.length >= MAX_PAGE_LINKS) {
      break;
    }
  }

  return links;
}

/**
 * Fetches each candidate through web_fetch and normalizes it into a corpus page. The result separates
 * stored pages from failed reads and de-duplicated skips, so the caller can mark a corpus partial when
 * a read failed without losing the pages that succeeded.
 */
export async function fetchPages(
  input: FetchPagesInput,
  webFetch: WebFetchReader,
): Promise<FetchPagesResult> {
  const pages: Page[] = [];
  const failed: PageDiagnostic[] = [];
  const skipped: PageDiagnostic[] = [];
  const seenHashes = new Set<string>();
  const seenFinalUrls = new Set<string>();
  const fetchedAt = input.now();
  const staleAfter = staleAfterFrom(fetchedAt, input.freshnessHours);
  let byteCount = 0;
  let truncated = false;

  for (const candidate of input.candidates) {
    let env: FetchEnvelope;

    try {
      env = parseEnvelope(
        await webFetch({ url: candidate.url, mode: input.fetchMode, maxChars: input.maxChars }),
        candidate.url,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 200) : "fetch failed";
      failed.push({ url: candidate.url, reason: `web_fetch threw: ${detail}` });
      continue;
    }

    if (env.content.trim() === "") {
      failed.push({
        url: candidate.url,
        reason: `no content (backend ${env.backend}${env.status ? `, status ${env.status}` : ""})`,
      });
      continue;
    }

    const normalized = normalizeMarkdown(env.content);

    if (normalized.content.trim() === "") {
      failed.push({ url: candidate.url, reason: "no content after normalization" });
      continue;
    }

    const hash = contentHash(normalized.content);
    const finalCanonical = canonicalUrl(env.finalUrl);

    if (seenHashes.has(hash)) {
      skipped.push({ url: candidate.url, reason: "duplicate content (same hash as a kept page)" });
      continue;
    }

    if (seenFinalUrls.has(finalCanonical)) {
      skipped.push({ url: candidate.url, reason: "duplicate final URL of a kept page" });
      continue;
    }

    seenHashes.add(hash);
    seenFinalUrls.add(finalCanonical);
    byteCount += env.byteCount;
    truncated = truncated || env.truncated;

    pages.push({
      version: DOCS_CORPUS_VERSION,
      pageId: pageIdFor(input.corpusId, candidate.url),
      corpusId: input.corpusId,
      url: candidate.url,
      finalUrl: env.finalUrl,
      ...(env.title !== undefined ? { title: env.title } : {}),
      ...(env.contentType !== undefined ? { contentType: env.contentType } : {}),
      content: normalized.content,
      contentHash: hash,
      fetchedAt,
      staleAfter,
      backend: env.backend,
      provenance: provenanceOf(env),
      truncated: env.truncated,
      diagnostics: diagnosticsFor(env, normalized.content.length),
      links: inCorpusLinks(normalized.links, env.finalUrl, input.host),
    });
  }

  return { pages, failed, skipped, byteCount, truncated };
}
