import type { ProviderDiagnostic } from "@trevor/session";
import { Data } from "effect";
import type { ProviderFailureClass, ProviderUserAction } from "./failure-taxonomy";

/**
 * Typed provider failures as Data.TaggedError, so they ride the Effect `E` channel and
 * callers discriminate by `_tag` instead of pattern-matching a message. Each names the
 * failure mode, computes a human message, and preserves the underlying `cause`.
 */

/**
 * The provider's backend could not be reached or did not respond usably. `retryable` marks a
 * TRANSIENT transport fault (a dropped WebSocket, connection reset, timeout, HTTP 429/5xx) that the
 * agent loop may auto-retry before any token has streamed (D-076…D-078); a non-retryable outage is
 * terminal as before. The provider boundary classifies the failure into the normalized taxonomy
 * (failure-taxonomy.ts) and carries the `classification` + `userAction` for `/doctor` and the
 * observation store; `retryable` is derived from the class so the loop's hot path reads one boolean.
 */
export class ProviderUnavailable extends Data.TaggedError("ProviderUnavailable")<{
  readonly provider: string;
  readonly detail: string;
  readonly cause?: unknown;
  readonly retryable?: boolean;
  /** The normalized taxonomy class (D-076 M1); `undefined` on legacy/un-classified construction. */
  readonly classification?: ProviderFailureClass;
  /** The actionable hint for the user (re-auth, wait, start local runtime, …). */
  readonly userAction?: ProviderUserAction;
  /** Retry-After in ms when the provider supplied one (D-076 M2), preserved for diagnostics. */
  readonly retryAfterMs?: number;
  /** Sanitized structured signals carried to the observation store (D-076 M2/M5): the HTTP-like
   *  status, the SDK error code/type, the retry-after, the provider request id, the gateway-vs-upstream
   *  origin, and the top-level field NAMES of the raw cause (names only, never values). No secrets -
   *  the boundary redacts the message and never copies raw payloads. */
  readonly evidence?: {
    readonly status?: number;
    readonly code?: string;
    readonly retryAfterMs?: number;
    readonly requestId?: string;
    readonly origin?: "gateway" | "upstream";
    readonly upstreamProvider?: string;
    readonly shapeFields?: readonly string[];
  };
  /** Structured provider incident detail for assistant events and /doctor correlation. */
  readonly diagnostic?: ProviderDiagnostic;
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
