/**
 * The Jina Reader backend: the first external fallback the ladder reaches when the static path is
 * unusable in auto mode. It re-guards the target URL (SSRF) BEFORE any network IO, then GETs
 * `https://r.jina.ai/${target}` over the injected fetch and bounds the markdown Jina returns. Jina
 * works keyless, so the `Authorization: Bearer` header is sent ONLY when a key is configured, and a
 * key is never echoed into a sanitized detail. IO and the key are injected so the path is
 * deterministic under test.
 *
 * Responsible for: the Jina Reader backend - the ladder's first, keyless-capable fallback.
 * Not for: choosing when to fall back - web-fetch.ts owns the ladder.
 */

import type { FetchAttemptStatus } from "./envelope";
import type { BoundedContent } from "./extract";
import { boundContent } from "./extract";
import { assertSafeUrl, type ResolveHost, UnsafeUrlError } from "./url-guard";

/** The Jina backend's injected dependencies, mirroring the static backend's injectable-IO shape.
 *  `resolveHost` is the SYNC guard resolver (the caller pre-resolves the host); `apiKey` is the
 *  optional `JINA_API_KEY` - undefined means keyless mode. */
export interface JinaFetchDeps {
  readonly fetch: typeof globalThis.fetch;
  readonly resolveHost?: ResolveHost;
  readonly apiKey?: string;
  readonly maxBytes: number;
  readonly maxChars: number;
  readonly timeoutMs: number;
}

/** Jina's outcome: the bounded content plus its classification, or a sanitized failure detail. The
 *  shape matches what the ladder needs to record an attempt and (on success) adopt the content. */
export type JinaFetchOutcome =
  | {
      readonly status: Extract<FetchAttemptStatus, "usable" | "thin" | "blocked">;
      readonly content: BoundedContent;
      readonly finalUrl: string;
      readonly httpStatus: number;
      readonly byteCount: number;
    }
  | {
      readonly status: Extract<FetchAttemptStatus, "blocked" | "failed">;
      readonly detail: string;
    };

const READER_ORIGIN = "https://r.jina.ai/";

const REQUEST_HEADERS: Record<string, string> = {
  accept: "text/plain,text/markdown,*/*;q=0.8",
  "user-agent": "TrevorWebFetch/1.0 (+read-only public source fetch)",
};

const THIN_MARKDOWN_THRESHOLD = 200;

const BLOCKER_SIGNALS = [
  "captcha",
  "are you a robot",
  "verify you are human",
  "checking your browser",
  "enable javascript",
  "access denied",
  "request blocked",
];

/**
 * Reads `target` through Jina Reader. Guards `target` first (an unsafe URL fails before any request),
 * then GETs the reader endpoint and bounds the returned markdown. Never throws: every failure
 * (timeout, rate limit, provider error) returns a typed `failed`/`blocked` outcome with a sanitized
 * detail, so the ladder records it and moves on rather than crashing the turn.
 */
export async function jinaFetch(target: string, deps: JinaFetchDeps): Promise<JinaFetchOutcome> {
  let safe: URL;

  try {
    safe = assertSafeUrl(target, deps.resolveHost);
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      return { status: "failed", detail: `jina target rejected: ${error.reason}` };
    }

    throw error;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);

  let response: Response;

  try {
    response = await deps.fetch(`${READER_ORIGIN}${safe.toString()}`, {
      method: "GET",
      headers: requestHeaders(deps.apiKey),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      return { status: "failed", detail: `jina request timed out after ${deps.timeoutMs}ms` };
    }

    return { status: "failed", detail: sanitizedError(error) };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) {
    return { status: "blocked", detail: "jina rate limited (429)" };
  }

  if (response.status >= 400) {
    return { status: "failed", detail: `jina returned status ${response.status}` };
  }

  return await readBody(safe, response, deps);
}

function requestHeaders(apiKey: string | undefined): Record<string, string> {
  // Jina works keyless; the Authorization header is sent only when a key is configured, and the key
  // itself never leaves this function (no sanitized detail ever carries it).
  return apiKey
    ? { ...REQUEST_HEADERS, authorization: `Bearer ${apiKey}` }
    : { ...REQUEST_HEADERS };
}

async function readBody(
  target: URL,
  response: Response,
  deps: JinaFetchDeps,
): Promise<JinaFetchOutcome> {
  let buffer: ArrayBuffer;

  try {
    buffer = await response.arrayBuffer();
  } catch (error) {
    return { status: "failed", detail: sanitizedError(error) };
  }

  const bytes = new Uint8Array(buffer);
  const kept = bytes.byteLength > deps.maxBytes ? bytes.subarray(0, deps.maxBytes) : bytes;
  const markdown = new TextDecoder("utf-8", { fatal: false }).decode(kept).trim();
  const status = classifyJina(markdown);

  if (status === "blocked") {
    return { status, detail: "jina output looks like a challenge/blocker page" };
  }

  return {
    status,
    content: boundContent(markdown, deps.maxChars),
    finalUrl: target.toString(),
    httpStatus: response.status,
    byteCount: bytes.byteLength,
  };
}

/** Classifies Jina's markdown: a challenge/blocker signature is `blocked`; near-empty output is
 *  `thin`; otherwise `usable`. */
function classifyJina(
  markdown: string,
): Extract<FetchAttemptStatus, "usable" | "thin" | "blocked"> {
  const lower = markdown.toLowerCase();

  if (BLOCKER_SIGNALS.some((signal) => lower.includes(signal))) {
    return "blocked";
  }

  if (markdown.length < THIN_MARKDOWN_THRESHOLD) {
    return "thin";
  }

  return "usable";
}

/** Reduces an unknown thrown value to a short, key-free detail. */
function sanitizedError(error: unknown): string {
  return error instanceof Error && error.message ? `jina error: ${error.message}` : "jina error";
}
