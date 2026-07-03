/**
 * The Firecrawl backend: the ladder's final, gated fallback, reached only when static AND Jina both
 * fail (auto mode) or the caller asked for `rendered` mode. It calls Firecrawl's HTTP scrape API
 * directly over the injected fetch (no SDK dependency) and is deliberately scoped to scrape +
 * markdown + main content only - no crawl/map/search/extract, no screenshots/actions, no
 * profiles/cookies/custom headers/proxy. The target is re-guarded (SSRF) before any request, the key
 * is injected (so it is never echoed into a detail), and every failure - including a missing key -
 * returns a typed `failed` outcome rather than throwing the turn.
 *
 * Responsible for: the Firecrawl scrape backend - the ladder's gated final fallback.
 * Not for: choosing when to fall back - web-fetch.ts owns the ladder.
 */

import type { FetchAttemptStatus } from "./envelope";
import type { BoundedContent } from "./extract";
import { boundContent } from "./extract";
import { type AsyncResolveHost, assertSafeUrlAsync, UnsafeUrlError } from "./url-guard";

/** The Firecrawl backend's injected dependencies. `apiKey` is `FIRECRAWL_API_KEY`; undefined means
 *  the backend is unavailable and returns a typed `failed` outcome without any request. */
export interface FirecrawlFetchDeps {
  readonly fetch: typeof globalThis.fetch;
  readonly resolveHost?: AsyncResolveHost;
  readonly apiKey?: string;
  readonly maxChars: number;
  readonly timeoutMs: number;
}

/** Firecrawl's outcome: bounded markdown plus its classification, or a sanitized failure detail. */
export type FirecrawlFetchOutcome =
  | {
      readonly status: Extract<FetchAttemptStatus, "usable" | "thin">;
      readonly content: BoundedContent;
      readonly finalUrl: string;
      readonly byteCount: number;
    }
  | {
      readonly status: Extract<FetchAttemptStatus, "blocked" | "failed">;
      readonly detail: string;
    };

const SCRAPE_ENDPOINT = "https://api.firecrawl.dev/v1/scrape";

const THIN_MARKDOWN_THRESHOLD = 200;

/** The ONLY request shape Firecrawl is allowed: a single-page scrape returning main-content markdown.
 *  No crawl/map/search/extract/screenshots/actions/profiles/cookies/headers/proxy fields appear. */
interface ScrapeRequestBody {
  readonly url: string;
  readonly formats: readonly ["markdown"];
  readonly onlyMainContent: true;
}

/**
 * Scrapes `target` through Firecrawl. A missing key short-circuits to a typed `unavailable` failure
 * (no request). Otherwise the target is guarded, POSTed to the scrape endpoint, and the returned
 * markdown is bounded. Never throws: a rate limit, provider error, or timeout becomes a sanitized
 * `failed`/`blocked` outcome the ladder records.
 */
export async function firecrawlFetch(
  target: string,
  deps: FirecrawlFetchDeps,
): Promise<FirecrawlFetchOutcome> {
  if (!deps.apiKey) {
    return { status: "failed", detail: "firecrawl unavailable: FIRECRAWL_API_KEY not configured" };
  }

  let safe: URL;

  try {
    safe = await assertSafeUrlAsync(target, deps.resolveHost);
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      return { status: "failed", detail: `firecrawl target rejected: ${error.reason}` };
    }

    throw error;
  }

  const body: ScrapeRequestBody = {
    url: safe.toString(),
    formats: ["markdown"],
    onlyMainContent: true,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);

  let response: Response;

  try {
    response = await deps.fetch(SCRAPE_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${deps.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      return { status: "failed", detail: `firecrawl request timed out after ${deps.timeoutMs}ms` };
    }

    return { status: "failed", detail: sanitizedError(error) };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) {
    return { status: "blocked", detail: "firecrawl rate limited (429)" };
  }

  if (response.status >= 400) {
    return { status: "failed", detail: `firecrawl returned status ${response.status}` };
  }

  return await readBody(safe, response, deps);
}

async function readBody(
  target: URL,
  response: Response,
  deps: FirecrawlFetchDeps,
): Promise<FirecrawlFetchOutcome> {
  let payload: unknown;

  try {
    payload = await response.json();
  } catch (error) {
    return { status: "failed", detail: sanitizedError(error) };
  }

  const markdown = extractMarkdown(payload);

  if (markdown === undefined) {
    return { status: "failed", detail: "firecrawl response had no markdown" };
  }

  const trimmed = markdown.trim();
  const status: Extract<FetchAttemptStatus, "usable" | "thin"> =
    trimmed.length < THIN_MARKDOWN_THRESHOLD ? "thin" : "usable";

  return {
    status,
    content: boundContent(trimmed, deps.maxChars),
    finalUrl: target.toString(),
    byteCount: new TextEncoder().encode(markdown).byteLength,
  };
}

/** Pulls the markdown out of Firecrawl's `{ success, data: { markdown } }` envelope, tolerating a
 *  flat `{ markdown }` shape too. Returns undefined when no markdown string is present. */
function extractMarkdown(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  const data = record.data;

  if (typeof data === "object" && data !== null) {
    const nested = (data as Record<string, unknown>).markdown;

    if (typeof nested === "string") {
      return nested;
    }
  }

  return typeof record.markdown === "string" ? record.markdown : undefined;
}

/** Reduces an unknown thrown value to a short, key-free detail. */
function sanitizedError(error: unknown): string {
  return error instanceof Error && error.message
    ? `firecrawl error: ${error.message}`
    : "firecrawl error";
}
