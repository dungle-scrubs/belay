import { Data } from "effect";

/**
 * Typed provider failures as Data.TaggedError, so they ride the Effect `E` channel and
 * callers discriminate by `_tag` instead of pattern-matching a message. Each names the
 * failure mode, computes a human message, and preserves the underlying `cause`.
 */

/**
 * The provider's backend could not be reached or did not respond usably. `retryable` marks a
 * TRANSIENT transport fault (a dropped WebSocket, connection reset, timeout, HTTP 429/5xx) that the
 * agent loop may auto-retry before any token has streamed (D-076…D-078); a non-retryable outage is
 * terminal as before. The classifier at the provider boundary (error-classifier.ts) sets it; the
 * loop reads the boolean.
 */
export class ProviderUnavailable extends Data.TaggedError("ProviderUnavailable")<{
  readonly provider: string;
  readonly detail: string;
  readonly cause?: unknown;
  readonly retryable?: boolean;
}> {
  override get message(): string {
    return `${this.provider} unavailable: ${this.detail}`;
  }
}

/** The provider is reachable but rejected our credentials (re-auth needed). */
export class ProviderAuthError extends Data.TaggedError("ProviderAuthError")<{
  readonly provider: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return `${this.provider} auth failed: ${this.detail}`;
  }
}

/** Loading or unloading a local model failed; the model stays at its previous load. */
export class ModelLoadError extends Data.TaggedError("ModelLoadError")<{
  readonly provider: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return `${this.provider} load failed: ${this.detail}`;
  }
}
