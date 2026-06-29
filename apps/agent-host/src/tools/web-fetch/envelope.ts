/**
 * The web_fetch result envelope: the structured, model-facing JSON one source read
 * produces. It mirrors web-search's "one form the model reads and the web renders"
 * shape - clean attributable fields plus the extracted content - and records which
 * backend produced the content and what each attempt did, so a later fallback ladder
 * (Jina, Firecrawl) slots in without changing the contract.
 */

/** The backends the fetch ladder can route through. Only "static" is wired today; the
 *  others reserve their slot in the envelope so M5/M6 add them without a shape change. */
export type FetchBackend = "static" | "jina" | "firecrawl";

/** One backend attempt's sanitized outcome - never the fetched body, never secrets. */
export interface FetchAttempt {
  readonly backend: FetchBackend;
  readonly status: FetchAttemptStatus;
  readonly detail?: string;
}

/** How one backend attempt resolved, classified for the model and the fallback ladder. */
export type FetchAttemptStatus = "usable" | "thin" | "blocked" | "failed";

export interface WebFetchResult {
  readonly url: string;
  readonly finalUrl: string;
  readonly title?: string;
  readonly contentType?: string;
  readonly status?: number;
  readonly fetchedAt: string;
  readonly byteCount: number;
  readonly textLength: number;
  readonly truncated: boolean;
  readonly backend: FetchBackend;
  readonly attempts: readonly FetchAttempt[];
  /**
   * True when the chosen backend's result is not usable (thin/blocked/failed) and a later
   * external backend could still recover it. In "static" mode this stays false - static
   * never falls back - so the model sees the static result as final.
   */
  readonly needsFallback: boolean;
  readonly content: string;
}

/** Serializes an envelope to the compact JSON the model reads and the web renders. Omits
 *  absent optional fields so the wire form matches web-search's lean shape. */
export function serializeResult(result: WebFetchResult): string {
  return JSON.stringify({
    url: result.url,
    finalUrl: result.finalUrl,
    ...(result.title !== undefined ? { title: result.title } : {}),
    ...(result.contentType !== undefined ? { contentType: result.contentType } : {}),
    ...(result.status !== undefined ? { status: result.status } : {}),
    fetchedAt: result.fetchedAt,
    byteCount: result.byteCount,
    textLength: result.textLength,
    truncated: result.truncated,
    backend: result.backend,
    attempts: result.attempts.map((attempt) => ({
      backend: attempt.backend,
      status: attempt.status,
      ...(attempt.detail !== undefined ? { detail: attempt.detail } : {}),
    })),
    needsFallback: result.needsFallback,
    content: result.content,
  });
}
