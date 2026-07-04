/**
 * Responsible for: the injectable HTTP transport every source-recall adapter shares - a bounded,
 * timeout-guarded JSON GET/POST over a `fetch`-like capability. The `fetch` is injected (defaults to
 * the global) so every adapter test is hermetic against a fake HTTP layer with no live daemon. This
 * layer classifies transport failure into the typed provider errors (unreachable / timeout /
 * malformed) and NEVER lets a raw response body or endpoint URL escape into a thrown message.
 *
 * Not for: mapping a decoded body into normalized results (that is each adapter's *-mapping module).
 */
import { Effect } from "effect";
import {
  SourceRecallProtocolError,
  type SourceRecallProviderError,
  SourceRecallTimeoutError,
  SourceRecallUnreachableError,
} from "./errors";

/** The minimal fetch surface an adapter needs; the global `fetch` satisfies it, and tests inject a fake. */
export type SourceRecallFetch = (
  input: string,
  init?: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}>;

/** The transport bundle an adapter binds: the base URL, the fetch, and the per-request timeout. */
export interface SourceRecallHttp {
  readonly baseUrl: string;
  readonly fetch: SourceRecallFetch;
  readonly timeoutMs: number;
}

/** An HTTP response the adapter still owns classification of (a non-2xx is a domain signal, not a throw). */
export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly body: string;
}

/** Joins a base URL and a path without doubling or dropping the slash between them. */
function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const rel = path.startsWith("/") ? path : `/${path}`;
  return `${base}${rel}`;
}

/**
 * Runs one request, bounding it with an abort timeout, and returns the raw {@link HttpResponse}. A
 * connection/DNS/socket failure becomes {@link SourceRecallUnreachableError}; a timeout becomes
 * {@link SourceRecallTimeoutError}. A non-2xx is NOT an error here - the caller inspects
 * `status`/`body` because some non-2xx codes (404 repo-not-found, 429 rate-limited, 400 bad graph)
 * are documented domain outcomes.
 */
export function request(
  http: SourceRecallHttp,
  path: string,
  init?: { readonly method?: string; readonly body?: unknown },
): Effect.Effect<HttpResponse, SourceRecallProviderError> {
  return Effect.tryPromise({
    try: async (signal) => {
      const timer = new AbortController();
      const onAbort = () => timer.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => timer.abort(), http.timeoutMs);
      try {
        const response = await http.fetch(joinUrl(http.baseUrl, path), {
          method: init?.method ?? "GET",
          headers: { "content-type": "application/json", accept: "application/json" },
          ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
          signal: timer.signal,
        });
        const body = await response.text();
        return { status: response.status, ok: response.ok, body };
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
      }
    },
    catch: (cause) => classifyTransport(cause, http.timeoutMs),
  });
}

/** Parses a response body as JSON, mapping a non-JSON body to a bounded protocol error. */
export function parseJson<T>(response: HttpResponse): Effect.Effect<T, SourceRecallProviderError> {
  return Effect.try({
    try: () => JSON.parse(response.body) as T,
    catch: () =>
      new SourceRecallProtocolError({
        detail: `expected JSON, got a ${response.body.length}-byte non-JSON body (status ${response.status})`,
      }),
  });
}

/** A GET returning the decoded JSON body, or a typed transport/protocol error. */
export function getJson<T>(
  http: SourceRecallHttp,
  path: string,
): Effect.Effect<T, SourceRecallProviderError> {
  return request(http, path).pipe(Effect.flatMap((response) => parseJson<T>(response)));
}

/** Classifies a caught fetch/abort failure into a typed transport error (never leaks the raw cause). */
function classifyTransport(cause: unknown, timeoutMs: number): SourceRecallProviderError {
  if (isAbort(cause)) {
    return new SourceRecallTimeoutError({ timeoutMs });
  }
  return new SourceRecallUnreachableError({ detail: shortCause(cause) });
}

function isAbort(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === "AbortError" || /abort/i.test(cause.message));
}

/** A short, non-leaky label for a transport failure - the error name or first line, capped. */
function shortCause(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message || cause.name : String(cause);
  const firstLine = raw.split("\n", 1)[0] ?? "connection failed";
  return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
}
