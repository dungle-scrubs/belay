/**
 * The static HTTP backend: fetch one safe URL over an injected fetch-like function and return its
 * raw body plus response metadata. It follows redirects MANUALLY (so every hop runs back through the
 * SSRF guard before it is requested), caps the redirect count, enforces a short timeout, and stops
 * reading once a byte cap is hit. It sends NO cookies and NO authorization - web_fetch reads only
 * public URLs, never an authenticated session. IO is injected so the whole path is deterministic.
 */

import { assertSafeRedirect, assertSafeUrl, type ResolveHost, UnsafeUrlError } from "./url-guard";

/** Resolves a hostname to its IP literals; async because live DNS is async. Each hop's host is
 *  resolved with this before the SYNC guard runs, so the guard stays pure. */
export type AsyncResolveHost = (host: string) => Promise<readonly string[]>;

/** The subset of the `fetch` API this backend depends on; injected for deterministic tests. */
export type FetchLike = (url: string, init: StaticFetchInit) => Promise<FetchLikeResponse>;

export interface StaticFetchInit {
  readonly method: "GET";
  readonly redirect: "manual";
  readonly headers: Record<string, string>;
  readonly signal?: AbortSignal;
}

export interface FetchLikeResponse {
  readonly status: number;
  readonly url: string;
  readonly headers: { get(name: string): string | null };
  /** Reads the body as raw bytes; the caller applies the byte cap to the result. */
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface StaticFetchOptions {
  readonly fetch: FetchLike;
  readonly resolveHost?: AsyncResolveHost;
  readonly maxBytes: number;
  readonly maxRedirects: number;
  readonly timeoutMs: number;
}

export interface StaticFetchResult {
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType?: string;
  readonly body: string;
  readonly byteCount: number;
  /** True when the body was cut at `maxBytes` before the response ended. */
  readonly bodyTruncated: boolean;
}

/** A static fetch could not complete (timeout, network error, redirect cap, unsafe hop). The reason
 *  is sanitized for the model and the attempt log - never the body, never a header value. */
export class StaticFetchError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "StaticFetchError";
  }
}

const REQUEST_HEADERS: Record<string, string> = {
  accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
  "user-agent": "TrevorWebFetch/1.0 (+read-only public source fetch)",
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Fetches `rawUrl` statically, following safe redirects up to the cap. The URL is guarded once here
 *  (callers may pass an already-guarded URL; guarding again is cheap and keeps the backend safe on
 *  its own). Throws `StaticFetchError` for any failure that prevents producing a response. */
export async function staticFetch(
  rawUrl: string,
  options: StaticFetchOptions,
): Promise<StaticFetchResult> {
  let current = await guardUrl(rawUrl, undefined, options.resolveHost);
  const seen = new Set<string>([current.toString()]);

  for (let hop = 0; hop <= options.maxRedirects; hop++) {
    const response = await requestOnce(current, options);

    if (!REDIRECT_STATUSES.has(response.status)) {
      return await readResponse(current, response, options.maxBytes);
    }

    const location = response.headers.get("location");

    if (!location) {
      // A redirect status with no Location is a dead end, not a hop; treat the response as final.
      return await readResponse(current, response, options.maxBytes);
    }

    current = await guardRedirect(current, location, seen, options.resolveHost);
    seen.add(current.toString());
  }

  throw new StaticFetchError(`too many redirects (cap ${options.maxRedirects})`);
}

/** Pre-resolves a host (async) into the literals the SYNC guard needs, then guards the URL. A `base`
 *  is supplied for a relative redirect target so its host is known before resolution. */
async function guardUrl(
  raw: string,
  base: URL | undefined,
  resolveHost: AsyncResolveHost | undefined,
): Promise<URL> {
  const sync = await syncResolverFor(raw, base, resolveHost);

  try {
    return assertSafeUrl(base ? new URL(raw, base).toString() : raw, sync);
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      throw new StaticFetchError(error.reason);
    }

    throw error;
  }
}

async function guardRedirect(
  from: URL,
  to: string,
  seen: ReadonlySet<string>,
  resolveHost: AsyncResolveHost | undefined,
): Promise<URL> {
  const sync = await syncResolverFor(to, from, resolveHost);

  try {
    return assertSafeRedirect({ from, to }, seen, sync);
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      throw new StaticFetchError(error.reason);
    }

    throw error;
  }
}

/** Resolves the target's host once (async), returning a sync `ResolveHost` the guard can call. When
 *  no async resolver is injected, returns undefined so the guard runs literal-only. */
async function syncResolverFor(
  raw: string,
  base: URL | undefined,
  resolveHost: AsyncResolveHost | undefined,
): Promise<ResolveHost | undefined> {
  if (!resolveHost) {
    return undefined;
  }

  let host: string;

  try {
    host = new URL(raw, base).hostname;
  } catch {
    // The guard will reject the malformed URL; hand it a resolver that finds nothing.
    return () => [];
  }

  const literals = await resolveHost(host);

  return (queried) => (queried === host ? literals : []);
}

async function requestOnce(url: URL, options: StaticFetchOptions): Promise<FetchLikeResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    return await options.fetch(url.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { ...REQUEST_HEADERS },
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new StaticFetchError(`request timed out after ${options.timeoutMs}ms`);
    }

    throw new StaticFetchError(error instanceof Error ? error.message : "network error");
  } finally {
    clearTimeout(timer);
  }
}

async function readResponse(
  url: URL,
  response: FetchLikeResponse,
  maxBytes: number,
): Promise<StaticFetchResult> {
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const bodyTruncated = bytes.byteLength > maxBytes;
  const kept = bodyTruncated ? bytes.subarray(0, maxBytes) : bytes;
  const body = new TextDecoder("utf-8", { fatal: false }).decode(kept);
  const contentType = response.headers.get("content-type") ?? undefined;

  return {
    finalUrl: response.url || url.toString(),
    status: response.status,
    contentType,
    body,
    byteCount: bytes.byteLength,
    bodyTruncated,
  };
}
