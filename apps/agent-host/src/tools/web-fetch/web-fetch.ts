/**
 * The web_fetch tool entry: a read-only, host-owned reader for ONE explicit public URL. It guards
 * the URL (SSRF), fetches it statically (following+guarding redirects), extracts bounded
 * markdown/text, classifies the result, and serializes the envelope the model reads and the web
 * renders. In "auto" mode an unusable static result (thin/blocked/failed) sets `needsFallback` so a
 * later external backend (Jina, then Firecrawl - a separate phase) can recover it; "static" mode
 * never falls back. The backend dispatch (`fetchVia`) is the seam those backends slot into.
 */

import { lookup } from "node:dns/promises";
import { Schema } from "effect";
import { simpleTool, toolInput } from "../shared";
import type { FetchAttempt, WebFetchResult } from "./envelope";
import { serializeResult } from "./envelope";
import { boundContent, classifyStatic, extractHtml } from "./extract";
import { type FetchLike, StaticFetchError, staticFetch } from "./static-fetch";
import { assertSafeUrl, UnsafeUrlError } from "./url-guard";

const MODES = ["auto", "static", "rendered"] as const;

const MAX_BYTES_FLOOR = 1024;
const MAX_BYTES_CEILING = 5_000_000;
const DEFAULT_MAX_BYTES = 2_000_000;

const MAX_CHARS_FLOOR = 500;
const MAX_CHARS_CEILING = 50_000;
const DEFAULT_MAX_CHARS = 12_000;

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 12_000;
const DNS_TIMEOUT_MS = 4_000;

const Params = Schema.Struct({
  url: Schema.String.annotations({
    description: "The single public http(s) URL to fetch and read",
  }),
  mode: Schema.optional(Schema.Literal(...MODES)).annotations({
    description:
      "Fetch strategy: 'auto' (static first, then later rendered fallback), 'static' (never " +
      "falls back), or 'rendered'. Default 'auto'.",
  }),
  // maxBytes/maxChars decode leniently (any number) and are clamped in code to sane ranges; the
  // advertised schema still presents them as bounded integers (the model-facing hint).
  maxBytes: Schema.optional(
    Schema.Number.annotations({
      jsonSchema: { type: "integer", minimum: MAX_BYTES_FLOOR, maximum: MAX_BYTES_CEILING },
    }),
  ).annotations({
    description: `Cap on bytes downloaded, clamped to [${MAX_BYTES_FLOOR}, ${MAX_BYTES_CEILING}] (default ${DEFAULT_MAX_BYTES})`,
  }),
  maxChars: Schema.optional(
    Schema.Number.annotations({
      jsonSchema: { type: "integer", minimum: MAX_CHARS_FLOOR, maximum: MAX_CHARS_CEILING },
    }),
  ).annotations({
    description: `Cap on characters of extracted content, clamped to [${MAX_CHARS_FLOOR}, ${MAX_CHARS_CEILING}] (default ${DEFAULT_MAX_CHARS})`,
  }),
});

type WebFetchArgs = typeof Params.Type;

/** Injectable dependencies, so the whole tool path is deterministic under test. The DNS resolver is
 *  ASYNC here (live DNS is async); `runWebFetch` pre-resolves the entry host and the static
 *  backend's redirect hops, then hands the SYNC guard the resolved literals. */
export interface WebFetchDeps {
  readonly fetch: typeof globalThis.fetch;
  readonly resolveHost: (host: string) => Promise<readonly string[]>;
  readonly now: () => string;
}

function clamp(
  value: number | undefined,
  floor: number,
  ceiling: number,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(value), floor), ceiling);
}

/**
 * Resolves a hostname to its IP literals for the guard, bounded by a short timeout. `dns.lookup`
 * ignores an abort signal, so the wait is bounded by racing it against a rejecting timer. Returns []
 * on any failure (including the timeout) so the guard's "unknown safety" path rejects rather than
 * fetching blind.
 */
async function resolveHostLiterals(host: string): Promise<readonly string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("dns lookup timed out")), DNS_TIMEOUT_MS);
  });

  try {
    const records = await Promise.race([lookup(host, { all: true }), timeout]);
    return records.map((record) => record.address);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs the static backend and produces an envelope. In "auto" mode an unusable result sets
 * `needsFallback`; "static" mode leaves it false (it is the final word). The dispatch shape leaves a
 * clear place for M5/M6 to add Jina/Firecrawl backends behind the same `fetchVia` switch.
 */
async function fetchVia(args: WebFetchArgs, deps: WebFetchDeps): Promise<WebFetchResult> {
  const mode = args.mode ?? "auto";
  const maxBytes = clamp(args.maxBytes, MAX_BYTES_FLOOR, MAX_BYTES_CEILING, DEFAULT_MAX_BYTES);
  const maxChars = clamp(args.maxChars, MAX_CHARS_FLOOR, MAX_CHARS_CEILING, DEFAULT_MAX_CHARS);

  const attempts: FetchAttempt[] = [];
  const fetchedAt = deps.now();

  let result: Awaited<ReturnType<typeof staticFetch>>;

  try {
    result = await staticFetch(args.url, {
      fetch: deps.fetch as FetchLike,
      resolveHost: deps.resolveHost,
      maxBytes,
      maxRedirects: MAX_REDIRECTS,
      timeoutMs: TIMEOUT_MS,
    });
  } catch (error) {
    const detail = error instanceof StaticFetchError ? error.reason : "static fetch failed";

    attempts.push({ backend: "static", status: "failed", detail });

    return {
      url: args.url,
      finalUrl: args.url,
      fetchedAt,
      byteCount: 0,
      textLength: 0,
      truncated: false,
      backend: "static",
      attempts,
      // A failed static fetch is recoverable by a later rendered backend in auto mode.
      needsFallback: mode !== "static",
      content: "",
    };
  }

  const isHtml = (result.contentType ?? "").toLowerCase().includes("html");
  const extracted = isHtml ? extractHtml(result.body) : { content: result.body };
  const status = classifyStatic({
    httpStatus: result.status,
    rawHtml: isHtml ? result.body : "",
    extractedText: extracted.content,
  });

  const bounded = boundContent(extracted.content, maxChars);

  attempts.push({
    backend: "static",
    status,
    ...(status === "usable" ? {} : { detail: `static result is ${status}` }),
  });

  const needsFallback = mode !== "static" && status !== "usable";

  return {
    url: args.url,
    finalUrl: result.finalUrl,
    ...(extracted.title !== undefined ? { title: extracted.title } : {}),
    ...(result.contentType !== undefined ? { contentType: result.contentType } : {}),
    status: result.status,
    fetchedAt,
    byteCount: result.byteCount,
    textLength: bounded.content.length,
    truncated: bounded.truncated || result.bodyTruncated,
    backend: "static",
    attempts,
    needsFallback,
    content: bounded.content,
  };
}

/** Live dependencies: the global fetch, a timeout-bounded node DNS resolver, and the wall clock. */
const liveDeps: WebFetchDeps = {
  fetch: globalThis.fetch,
  resolveHost: resolveHostLiterals,
  now: () => new Date().toISOString(),
};

/** Runs the full web_fetch path against injected deps; the exported tool binds the live deps. */
export async function runWebFetch(args: WebFetchArgs, deps: WebFetchDeps): Promise<string> {
  // Entry guard: a malformed/unsafe URL must never reach a backend. Pre-resolve the host (async DNS)
  // into the literals the SYNC guard checks; the static backend re-guards each redirect hop the same
  // way. A bad input is a typed input error (the model reads it), not a crashed turn.
  try {
    const sync = await entryResolver(args.url, deps.resolveHost);

    assertSafeUrl(args.url, sync);
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      return toolInput(error.reason);
    }

    throw error;
  }

  const result = await fetchVia(args, deps);

  return serializeResult(result);
}

/** Pre-resolves the entry URL's host (async) into the sync resolver the guard consumes. */
async function entryResolver(
  raw: string,
  resolveHost: WebFetchDeps["resolveHost"],
): Promise<((host: string) => readonly string[]) | undefined> {
  let host: string;

  try {
    host = new URL(raw).hostname;
  } catch {
    // The guard rejects the malformed URL; give it a resolver that finds nothing.
    return () => [];
  }

  const literals = await resolveHost(host);

  return (queried) => (queried === host ? literals : []);
}

/** Fetches one explicit public URL into bounded, attributable markdown/text. */
export const webFetchTool = simpleTool({
  name: "web_fetch",
  description:
    "Fetch ONE explicit public http(s) URL into bounded, attributable markdown/text - the " +
    "source-reading companion to web_search. Use it to READ a page you already have a URL for " +
    "(docs, an article, an API/JSON endpoint), NOT to search, crawl, click, or browse with " +
    "cookies/auth. Returns JSON: {url, finalUrl, title?, contentType?, status?, fetchedAt, " +
    "byteCount, textLength, truncated, backend, attempts, needsFallback, content}.",
  params: Params,
  readOnly: true,
  execute: (args) => runWebFetch(args, liveDeps),
});

export type { WebFetchArgs };
export { Params as WebFetchParams, resolveHostLiterals };
