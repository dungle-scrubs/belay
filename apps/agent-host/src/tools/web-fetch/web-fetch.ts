/**
 * The web_fetch tool entry: a read-only, host-owned reader for ONE explicit public URL. It guards
 * the URL (SSRF), fetches it statically (following+guarding redirects), extracts bounded
 * markdown/text, classifies the result, and serializes the envelope the model reads and the web
 * renders. In "auto" mode an unusable static result (thin/blocked/failed) falls through the ladder -
 * Jina, then Firecrawl - each only when the prior backend is unusable; "static" mode never falls
 * back and "rendered" mode goes straight to Firecrawl. The backend dispatch (`fetchVia`) is the seam
 * those backends slot into, and every attempt (including skips/failures) lands in `attempts[]`.
 *
 * Responsible for: the web_fetch tool entry - URL guarding, the static/Jina/Firecrawl
 * backend ladder, and envelope serialization.
 */

import { lookup } from "node:dns/promises";
import { Schema } from "effect";
import { clamp, simpleTool, toolInput } from "../shared";
import type { FetchAttempt, FetchBackend, WebFetchResult } from "./envelope";
import { serializeResult } from "./envelope";
import { boundContent, classifyStatic, extractHtml } from "./extract";
import { firecrawlFetch } from "./firecrawl-fetch";
import { jinaFetch } from "./jina-fetch";
import { type FetchLike, StaticFetchError, staticFetch } from "./static-fetch";
import { assertSafeUrlAsync, UnsafeUrlError } from "./url-guard";
import { errorCategoryFor, hostOf, logWebFetchAttempt } from "./web-fetch-log";

const MODES = ["auto", "static", "rendered"] as const;

const MAX_BYTES_FLOOR = 1024;
const MAX_BYTES_CEILING = 5_000_000;
const DEFAULT_MAX_BYTES = 2_000_000;

const MAX_CHARS_FLOOR = 500;
const MAX_CHARS_CEILING = 50_000;
const DEFAULT_MAX_CHARS = 12_000;

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 12_000;
const JINA_TIMEOUT_MS = 20_000;
const FIRECRAWL_TIMEOUT_MS = 30_000;
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
  /** A monotonic clock (ms) for per-backend durations in the redacted log; absent in tests that do
   *  not assert timing, where each attempt then logs a 0ms duration. */
  readonly monotonicMs?: () => number;
  /** Optional `JINA_API_KEY` - Jina Reader also works keyless, so an absent key only drops the
   *  Authorization header, never the backend. Injected so tests stay deterministic. */
  readonly jinaApiKey?: string;
  /** `FIRECRAWL_API_KEY` - Firecrawl is gated entirely behind this; absent means the backend is
   *  unavailable and yields a typed `failed` attempt rather than a request. */
  readonly firecrawlApiKey?: string;
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

/** One backend's contribution to the ladder: its classification, the bounded content it produced
 *  (absent on a failure), a sanitized failure detail, and the envelope fields a winning backend
 *  carries. */
interface BackendOutcome {
  readonly backend: FetchBackend;
  readonly status: FetchAttempt["status"];
  readonly detail?: string;
  readonly finalUrl?: string;
  readonly title?: string;
  readonly contentType?: string;
  readonly httpStatus?: number;
  readonly byteCount?: number;
  readonly content?: { readonly content: string; readonly truncated: boolean };
}

/**
 * Runs the backend ladder and produces an envelope. The order is static -> Jina -> Firecrawl, each
 * attempted only when the prior backend is unusable: Jina runs only in "auto" mode after an unusable
 * static result, and Firecrawl runs only when its key is set and either (auto, after BOTH static and
 * Jina are unusable) or mode is "rendered". "static" mode stops after static and never falls back.
 * Every attempt - including a backend that failed - lands in `attempts[]` with a sanitized detail.
 */
async function fetchVia(args: WebFetchArgs, deps: WebFetchDeps): Promise<WebFetchResult> {
  const mode = args.mode ?? "auto";
  const maxBytes = clamp(args.maxBytes, MAX_BYTES_FLOOR, MAX_BYTES_CEILING, DEFAULT_MAX_BYTES);
  const maxChars = clamp(args.maxChars, MAX_CHARS_FLOOR, MAX_CHARS_CEILING, DEFAULT_MAX_CHARS);

  const attempts: FetchAttempt[] = [];
  const fetchedAt = deps.now();
  // The request host + caps are the same for every backend; only the host (never the path/query) and
  // the sizes are ever logged, so the secret-bearing parts of the URL never reach a log field.
  const host = hostOf(args.url);
  const caps = { maxBytes, maxChars };

  // Times one backend run, records its sanitized attempt, and emits the single redacted host-log line
  // for it (host + caps + status + duration + bytes + error category - never the URL query, a key, or
  // the fetched content). Returns the outcome so the ladder decides whether to continue.
  const runBackend = async (run: () => Promise<BackendOutcome>): Promise<BackendOutcome> => {
    const startedAt = deps.monotonicMs?.() ?? 0;
    const outcome = await run();
    const attempt = toAttempt(outcome);

    attempts.push(attempt);
    logWebFetchAttempt({
      backend: outcome.backend,
      host,
      status: outcome.status,
      durationMs: (deps.monotonicMs?.() ?? 0) - startedAt,
      bytes: outcome.byteCount ?? 0,
      caps,
      errorCategory: errorCategoryFor(attempt),
    });

    return outcome;
  };

  const staticOutcome = await runBackend(() => runStatic(args.url, maxBytes, maxChars, deps));

  // The reported backend defaults to static (its content is the best available even when thin), but
  // "rendered" mode owes the caller the rendered backend's result, so a usable Firecrawl below
  // overrides static and an unavailable Firecrawl still surfaces as the reported backend.
  let winner = staticOutcome;

  if (mode === "auto" && staticOutcome.status !== "usable") {
    const jinaOutcome = await runBackend(() => runJina(args.url, maxChars, deps));

    if (jinaOutcome.status === "usable") {
      winner = jinaOutcome;
    }
  }

  if (shouldRunFirecrawl(mode, winner)) {
    const firecrawlOutcome = await runBackend(() => runFirecrawlBackend(args.url, maxChars, deps));

    if (firecrawlOutcome.status === "usable" || mode === "rendered") {
      winner = firecrawlOutcome;
    }
  }

  const needsFallback = mode !== "static" && winner.status !== "usable";
  // A blocked/failed winner has no trustworthy body: its "content" is a challenge page or nav chrome,
  // not the page's text. Emit empty content so the model reads needsFallback + attempts as the signal
  // and never mistakes the noise for the source. Only usable/thin winners carry real (if partial) text.
  const hasReadableBody = winner.status === "usable" || winner.status === "thin";
  const bounded =
    hasReadableBody && winner.content ? winner.content : { content: "", truncated: false };

  return {
    url: args.url,
    finalUrl: winner.finalUrl ?? args.url,
    ...(winner.title !== undefined ? { title: winner.title } : {}),
    ...(winner.contentType !== undefined ? { contentType: winner.contentType } : {}),
    ...(winner.httpStatus !== undefined ? { status: winner.httpStatus } : {}),
    fetchedAt,
    byteCount: winner.byteCount ?? 0,
    textLength: bounded.content.length,
    truncated: bounded.truncated,
    backend: winner.backend,
    attempts,
    needsFallback,
    content: bounded.content,
  };
}

/** Decides whether the gated Firecrawl backend runs: explicit "rendered" mode always, or "auto" once
 *  every earlier backend (static, Jina) is still unusable. "static" mode never reaches Firecrawl. */
function shouldRunFirecrawl(mode: WebFetchArgs["mode"], winner: BackendOutcome): boolean {
  if (mode === "rendered") {
    return true;
  }

  return mode === "auto" && winner.status !== "usable";
}

/** Runs the static backend, capturing its body+classification (or a failure) as a `BackendOutcome`. */
async function runStatic(
  url: string,
  maxBytes: number,
  maxChars: number,
  deps: WebFetchDeps,
): Promise<BackendOutcome> {
  let result: Awaited<ReturnType<typeof staticFetch>>;

  try {
    result = await staticFetch(url, {
      fetch: deps.fetch as FetchLike,
      resolveHost: deps.resolveHost,
      maxBytes,
      maxRedirects: MAX_REDIRECTS,
      timeoutMs: TIMEOUT_MS,
    });
  } catch (error) {
    const detail = error instanceof StaticFetchError ? error.reason : "static fetch failed";

    return { backend: "static", status: "failed", finalUrl: url, detail };
  }

  const isHtml = (result.contentType ?? "").toLowerCase().includes("html");
  const extracted = isHtml ? extractHtml(result.body) : { content: result.body };
  const status = classifyStatic({
    httpStatus: result.status,
    rawHtml: isHtml ? result.body : "",
    extractedText: extracted.content,
  });

  const bounded = boundContent(extracted.content, maxChars);

  return {
    backend: "static",
    status,
    finalUrl: result.finalUrl,
    title: extracted.title,
    contentType: result.contentType,
    httpStatus: result.status,
    byteCount: result.byteCount,
    content: { content: bounded.content, truncated: bounded.truncated || result.bodyTruncated },
  };
}

/** Runs the Jina backend and maps its outcome onto a `BackendOutcome`. */
async function runJina(url: string, maxChars: number, deps: WebFetchDeps): Promise<BackendOutcome> {
  const maxBytes = clamp(undefined, MAX_BYTES_FLOOR, MAX_BYTES_CEILING, DEFAULT_MAX_BYTES);
  const outcome = await jinaFetch(url, {
    fetch: deps.fetch,
    resolveHost: deps.resolveHost,
    apiKey: deps.jinaApiKey,
    maxBytes,
    maxChars,
    timeoutMs: JINA_TIMEOUT_MS,
  });

  if ("detail" in outcome) {
    return { backend: "jina", status: outcome.status, detail: outcome.detail };
  }

  return {
    backend: "jina",
    status: outcome.status,
    finalUrl: outcome.finalUrl,
    httpStatus: outcome.httpStatus,
    byteCount: outcome.byteCount,
    content: outcome.content,
  };
}

/** Runs the Firecrawl backend and maps its outcome onto a `BackendOutcome`. */
async function runFirecrawlBackend(
  url: string,
  maxChars: number,
  deps: WebFetchDeps,
): Promise<BackendOutcome> {
  const outcome = await firecrawlFetch(url, {
    fetch: deps.fetch,
    resolveHost: deps.resolveHost,
    apiKey: deps.firecrawlApiKey,
    maxChars,
    timeoutMs: FIRECRAWL_TIMEOUT_MS,
  });

  if ("detail" in outcome) {
    return { backend: "firecrawl", status: outcome.status, detail: outcome.detail };
  }

  return {
    backend: "firecrawl",
    status: outcome.status,
    finalUrl: outcome.finalUrl,
    byteCount: outcome.byteCount,
    content: outcome.content,
  };
}

/** Maps a backend outcome to the sanitized attempt log entry. A usable result omits the detail; an
 *  unusable one carries either the backend's own sanitized detail or a generic "result is X". */
function toAttempt(outcome: BackendOutcome): FetchAttempt {
  if (outcome.status === "usable") {
    return { backend: outcome.backend, status: outcome.status };
  }

  return {
    backend: outcome.backend,
    status: outcome.status,
    detail: outcome.detail ?? `${outcome.backend} result is ${outcome.status}`,
  };
}

/** Live dependencies: the global fetch, a timeout-bounded node DNS resolver, the wall clock, and the
 *  fallback backend keys read from the environment (like web_search reads its provider keys). Jina's
 *  key is optional; Firecrawl is gated entirely behind its key. */
const liveDeps: WebFetchDeps = {
  fetch: globalThis.fetch,
  resolveHost: resolveHostLiterals,
  now: () => new Date().toISOString(),
  monotonicMs: () => performance.now(),
  jinaApiKey: process.env.JINA_API_KEY?.trim() || undefined,
  firecrawlApiKey: process.env.FIRECRAWL_API_KEY?.trim() || undefined,
};

/** Runs the full web_fetch path against injected deps; the exported tool binds the live deps. */
export async function runWebFetch(args: WebFetchArgs, deps: WebFetchDeps): Promise<string> {
  // Entry guard: a malformed/unsafe URL must never reach a backend. A bad input is a typed input
  // error (the model reads it), not a crashed turn.
  try {
    await assertSafeUrlAsync(args.url, deps.resolveHost);
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      return toolInput(error.reason);
    }

    throw error;
  }

  const result = await fetchVia(args, deps);

  return serializeResult(result);
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
// `liveDeps` is exported as the bound, env-reading dependency bundle so a sibling tool (docs) can reuse
// the real web_fetch reader through `runWebFetch(args, webFetchLiveDeps)` without re-deriving the keys/DNS.
export { liveDeps as webFetchLiveDeps, Params as WebFetchParams, resolveHostLiterals };
