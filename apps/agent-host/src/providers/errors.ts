/**
 * Typed provider failures, so callers (the agent loop, /doctor, readiness) can tell
 * *which* contract broke instead of pattern-matching a generic message. Each names the
 * failure mode and preserves the underlying cause via the standard Error `cause`.
 */

/** The provider's backend could not be reached or did not respond usably. */
export class ProviderUnavailable extends Error {
  constructor(
    readonly provider: string,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(`${provider} unavailable: ${detail}`, options);
    this.name = "ProviderUnavailable";
  }
}

/** The provider is reachable but rejected our credentials (re-auth needed). */
export class ProviderAuthError extends Error {
  constructor(
    readonly provider: string,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(`${provider} auth failed: ${detail}`, options);
    this.name = "ProviderAuthError";
  }
}

/** Loading or unloading a local model failed; the model stays at its previous load. */
export class ModelLoadError extends Error {
  constructor(
    readonly provider: string,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(`${provider} load failed: ${detail}`, options);
    this.name = "ModelLoadError";
  }
}
