/**
 * Normalizes a thrown provider/SDK error into the sanitized, structured evidence the failure taxonomy
 * and the observation store read (D-076 M2). It reads the common SDK/HTTP shapes - OpenAI/Anthropic
 * `status` + `headers` + `request_id`, gateway `error.metadata`, a local runtime's `code`
 * (ECONNREFUSED) - and surfaces ONLY shape, never a value that could be a secret: the HTTP-like
 * status, the SDK error code/type, the retry-after, the provider request id, the gateway-vs-upstream
 * origin, and the top-level field NAMES of the raw error. Every reader (classifier, redacted typed
 * error payload, observation store) draws from this one seam instead of re-poking the raw cause.
 *
 * Extracted from the pi-ai boundary so the shape-reading is a pure, fixture-testable function rather
 * than a closure inside the stream mapper.
 */

/** The sanitized structured evidence carried off a provider failure (names + shape, never values). */
export interface FailureEvidence {
  /** HTTP-like status when known (401, 429, 503, …). */
  readonly status?: number;
  /** SDK error code / type when known (e.g. `insufficient_quota`, `ECONNREFUSED`, `overloaded_error`). */
  readonly code?: string;
  /** Retry-After in ms when the provider supplied one (`retry-after` header in integer seconds, or a
   *  structured numeric field). */
  readonly retryAfterMs?: number;
  /** The provider's request id for support/debugging (`request_id` / `x-request-id`), never a secret. */
  readonly requestId?: string;
  /** For a GATEWAY source: whether the failure came from the gateway itself or the upstream model
   *  provider it proxies. `undefined` for non-gateway sources (the common case). */
  readonly origin?: "gateway" | "upstream";
  /** The upstream model-provider name a gateway reported (e.g. "anthropic"), when known. A provider
   *  NAME, not a credential. */
  readonly upstreamProvider?: string;
  /** Top-level field NAMES of the raw error object (names only, never values), capped. */
  readonly shapeFields?: readonly string[];
}

/**
 * Best-effort HTTP-like status off a thrown SDK/HTTP error, reading the common shapes (`status`,
 * `statusCode`, `response.status`). Returns undefined when no numeric status is present (e.g. a plain
 * transport `Error`).
 */
export function httpStatusOf(cause: unknown): number | undefined {
  if (typeof cause !== "object" || cause === null) {
    return undefined;
  }
  const c = cause as Record<string, unknown>;
  const response = c.response as Record<string, unknown> | undefined;
  const raw = c.status ?? c.statusCode ?? response?.status;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/**
 * Best-effort SDK error code/type off a thrown error (`code`, `error.code`, `error.type`), preserved
 * so the classifier can use a structured signal (e.g. `insufficient_quota`) over message matching.
 */
export function errorCodeOf(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null) {
    return undefined;
  }
  const c = cause as Record<string, unknown>;
  const error = c.error as Record<string, unknown> | undefined;
  const raw = c.code ?? error?.code ?? error?.type;
  return typeof raw === "string" && raw ? raw : undefined;
}

/**
 * Reads a header value from the common SDK/HTTP error shapes: a plain `headers` object or a
 * `response.headers` (a plain object or a fetch `Headers`/Map with `.get()`), case-insensitively.
 * Returns the first match as a string, or undefined.
 */
function headerValue(cause: unknown, name: string): string | undefined {
  if (typeof cause !== "object" || cause === null) {
    return undefined;
  }
  const c = cause as Record<string, unknown>;
  const response = c.response as Record<string, unknown> | undefined;
  const containers = [c.headers, response?.headers];
  const lower = name.toLowerCase();
  for (const container of containers) {
    if (!container || typeof container !== "object") {
      continue;
    }
    const getter = (container as { get?: unknown }).get;
    if (typeof getter === "function") {
      const value = (getter as (n: string) => unknown).call(container, name);
      if (typeof value === "string" && value) {
        return value;
      }
    }
    for (const [key, value] of Object.entries(container as Record<string, unknown>)) {
      if (key.toLowerCase() !== lower) {
        continue;
      }
      if (typeof value === "string" && value) {
        return value;
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
      }
    }
  }
  return undefined;
}

/**
 * Retry-After in ms when the provider supplied one: the `retry-after` header (integer seconds, the
 * form OpenAI/Anthropic emit), or a structured numeric `retryAfterMs` / `retryAfter` (seconds) on the
 * error. The HTTP-date form of the header is deliberately ignored so this stays deterministic and
 * clock-independent - the SDKs we target use integer seconds.
 */
export function retryAfterMsOf(cause: unknown): number | undefined {
  const header = headerValue(cause, "retry-after");
  if (header !== undefined) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }
  }
  if (typeof cause === "object" && cause !== null) {
    const c = cause as Record<string, unknown>;
    if (typeof c.retryAfterMs === "number" && Number.isFinite(c.retryAfterMs)) {
      return Math.max(0, Math.round(c.retryAfterMs));
    }
    if (typeof c.retryAfter === "number" && Number.isFinite(c.retryAfter)) {
      return Math.max(0, Math.round(c.retryAfter * 1000));
    }
  }
  return undefined;
}

/**
 * The provider's request id when present: a top-level `request_id`/`requestId`, an
 * `error.request_id`/`error.requestId`, or an `x-request-id` / `request-id` / `anthropic-request-id`
 * header. A correlation id for support, never a credential.
 */
export function requestIdOf(cause: unknown): string | undefined {
  if (typeof cause === "object" && cause !== null) {
    const c = cause as Record<string, unknown>;
    const error = c.error as Record<string, unknown> | undefined;
    const direct = c.request_id ?? c.requestId ?? error?.request_id ?? error?.requestId;
    if (typeof direct === "string" && direct) {
      return direct;
    }
  }
  for (const name of ["x-request-id", "request-id", "anthropic-request-id"]) {
    const value = headerValue(cause, name);
    if (value) {
      return value;
    }
  }
  return undefined;
}

/**
 * For a GATEWAY source, whether a failure came from the gateway itself or the upstream model provider
 * it proxies, plus the upstream provider NAME when the gateway reports it (e.g. OpenRouter's
 * `error.metadata.provider_name`, or an "upstream"/"provider error" message). Only call this for a
 * gateway source; for a direct source the origin is meaningless and stays undefined.
 */
export function gatewayOriginOf(cause: unknown): {
  origin: "gateway" | "upstream";
  upstreamProvider?: string;
} {
  if (typeof cause !== "object" || cause === null) {
    return { origin: "gateway" };
  }
  const c = cause as Record<string, unknown>;
  const error = c.error as Record<string, unknown> | undefined;
  const metadata = error?.metadata as Record<string, unknown> | undefined;
  const provider = metadata?.provider_name ?? metadata?.providerName ?? metadata?.provider;
  if (typeof provider === "string" && provider) {
    return { origin: "upstream", upstreamProvider: provider };
  }
  const message =
    (typeof error?.message === "string" && error.message) ||
    (typeof c.message === "string" && c.message) ||
    "";
  if (/upstream|provider error|model provider/i.test(message)) {
    return { origin: "upstream" };
  }
  return { origin: "gateway" };
}

/**
 * The top-level field NAMES of a thrown error object (never their values), so an unknown failure
 * shape can be observed (D-076 M5) - "which fields did this error carry?" - without copying any raw
 * payload that might hold secrets. Sorted and capped so a pathological object can't bloat the record.
 */
export function topLevelFields(cause: unknown): readonly string[] | undefined {
  if (typeof cause !== "object" || cause === null) {
    return undefined;
  }
  return Object.keys(cause as Record<string, unknown>)
    .sort()
    .slice(0, 24);
}

/**
 * Normalizes a raw provider/SDK error into {@link FailureEvidence}. The single seam the provider
 * boundary uses: it feeds the structured signals (status/code/retryAfter) into the classifier and
 * carries the whole evidence onto the typed error + observation record. `gateway` opts in to
 * origin (gateway-vs-upstream) attribution for a gateway source; it is omitted for direct/local
 * sources where the distinction has no meaning.
 */
export function extractFailureEvidence(
  cause: unknown,
  opts: { readonly gateway?: boolean } = {},
): FailureEvidence {
  const gateway = opts.gateway ? gatewayOriginOf(cause) : undefined;
  return {
    status: httpStatusOf(cause),
    code: errorCodeOf(cause),
    retryAfterMs: retryAfterMsOf(cause),
    requestId: requestIdOf(cause),
    origin: gateway?.origin,
    upstreamProvider: gateway?.upstreamProvider,
    shapeFields: topLevelFields(cause),
  };
}
