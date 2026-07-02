/**
 * The web_fetch path's redacted observability: the one host-log line per backend attempt and the
 * module-level "last backend error" the /doctor Web area reads. Both record ONLY sanitized fields -
 * the backend, the request HOST (never the full URL with its query/secrets), the attempt status, the
 * elapsed time, byte/cap sizes, and a coarse error CATEGORY. A key, header, response body, fetched
 * CONTENT, or query string never enters a log field or the doctor; the fetched content lives only in
 * the tool result/session event, never in a debug log.
 */

import { log } from "@host/transport/log";
import type { FetchAttempt, FetchBackend } from "./envelope";

const SCOPE = "web_fetch";

/** The sanitized record of one backend attempt, with every field already safe to log. */
export interface WebFetchLogRecord {
  readonly backend: FetchBackend;
  /** The request hostname only - never the path/query that may carry secrets. */
  readonly host: string;
  readonly status: FetchAttempt["status"];
  readonly durationMs: number;
  readonly bytes: number;
  /** The applied caps (`maxBytes`/`maxChars`), so a truncation reads in context. */
  readonly caps: { readonly maxBytes: number; readonly maxChars: number };
  /** A coarse failure category (never the raw error text or any header/key). */
  readonly errorCategory?: string;
}

/** The most recent sanitized backend-error category, surfaced by /doctor. Module-level so the doctor
 *  reads it without reaching into the tool path; only a category string is ever stored here. */
let lastErrorCategory: string | undefined;

/** The sanitized category of the last web_fetch backend error, or undefined when none has occurred. */
export function lastWebFetchError(): string | undefined {
  return lastErrorCategory;
}

/** Resets the recorded last error (test seam; the live path only ever sets it). */
export function resetWebFetchError(): void {
  lastErrorCategory = undefined;
}

/**
 * Maps a backend attempt to a coarse, key-free error category for the log + the doctor. The attempt
 * status already classifies the outcome (thin/blocked/failed); the optional sanitized detail is
 * reduced to its leading category token (e.g. "jina error", "static fetch failed") - never echoed
 * whole, so no header/key/body fragment a backend may have included can leak through.
 */
export function errorCategoryFor(attempt: FetchAttempt): string | undefined {
  if (attempt.status === "usable") {
    return undefined;
  }

  const detail = attempt.detail?.trim();
  const category = detail ? detail.split(/[:(]/u)[0]?.trim() : undefined;

  return category && category.length > 0 ? category : attempt.status;
}

/** The request hostname for a URL, or "invalid-url" when it cannot be parsed (never the raw string). */
export function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "invalid-url";
  }
}

/**
 * Emits the one redacted boundary log line for a backend attempt and, on a failure, records the
 * sanitized category as the doctor's "last backend error". Only the {@link WebFetchLogRecord} fields
 * reach the log; the fetched content is never passed here, so it cannot be written to any log.
 */
export function logWebFetchAttempt(record: WebFetchLogRecord): void {
  if (record.errorCategory) {
    lastErrorCategory = record.errorCategory;
  }

  log(SCOPE, "backend attempt", {
    backend: record.backend,
    host: record.host,
    status: record.status,
    durationMs: record.durationMs,
    bytes: record.bytes,
    maxBytes: record.caps.maxBytes,
    maxChars: record.caps.maxChars,
    ...(record.errorCategory ? { errorCategory: record.errorCategory } : {}),
  });
}
