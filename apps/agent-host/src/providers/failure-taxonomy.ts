import { isAuthFailure, isContextOverflow, isRetryable } from "./error-classifier";

// The secret redactor now lives in the shared telemetry contract (plan 13); re-export it here so the
// provider callsites (provider-diagnostic, lmstudio-client, failure-record-schema, pi-ai) keep importing
// it from the taxonomy module. The shared version is a strict superset (it also redacts `dsn:` values).
export { redactSecrets } from "@belay/session/telemetry";

/**
 * The normalized provider-failure taxonomy (D-076 M1). One vocabulary across every provider shape -
 * OAuth subscription, SDK, gateway catalog, direct API key, and local runtime - so the agent loop,
 * the redacted observation store (M5), and `/doctor` (M6) all read the SAME classification instead of
 * re-matching raw messages per surface. The provider boundary normalizes its inconsistent failures
 * into this set (M2); the loop derives its retry decision from `retryable`; unknown or low-confidence
 * shapes default to NON-retryable and are recorded for later rule improvement.
 *
 * `ProviderAuthError` (a refused credential) and context overflow keep their own dedicated non-retry
 * paths; this taxonomy still NAMES them (`auth`, `context_overflow`) so a normalized
 * `ProviderUnavailable` that happens to be one of those reads consistently, but it never turns either
 * into an outage retry.
 *
 * Responsible for: the normalized ProviderFailureClass vocabulary and classifyProviderFailure.
 * Not for: raw-error evidence extraction (failure-evidence.ts) or the low-level text predicates
 * (error-classifier.ts).
 */
export type ProviderFailureClass =
  | "auth" // credential refused / re-auth needed (terminal)
  | "transient_transport" // dropped socket, reset, timeout, premature close (retryable)
  | "rate_limited" // 429 / rate window (retryable, honor retry-after)
  | "provider_overloaded" // capacity / overloaded (retryable)
  | "provider_unavailable" // 5xx / upstream down (retryable)
  | "local_runtime_unavailable" // LM Studio not running / unreachable (terminal, actionable)
  | "model_unavailable" // model not loaded / unknown model id (terminal, actionable)
  | "quota_billing" // out of credits / billing / hard quota (terminal, actionable)
  | "request_rejected" // 400 bad request / invalid params (terminal)
  | "context_overflow" // prompt too big (overflow recovery owns it, NOT outage retry)
  | "unknown"; // unclassified shape -> non-retryable, observed for later rules

/** The single actionable hint per class, surfaced by `/doctor` and the terminal error block. */
export type ProviderUserAction =
  | "reauth"
  | "retry"
  | "wait"
  | "start_local_runtime"
  | "load_model"
  | "check_billing"
  | "fix_request"
  | "compact"
  | "none";

/**
 * Structured signals from the provider boundary, used BEFORE falling back to message matching (M2).
 * Every field is optional: with only `detail` the classifier matches the sanitized text; when the
 * adapter can surface an HTTP status, an SDK error code, a retry-after, or that the provider is a
 * LOCAL runtime, those refine the verdict (e.g. a connection refusal is a transient transport fault
 * for a cloud provider but a not-running runtime for a local one).
 */
export interface ProviderFailureSignals {
  /** Host provider id, when provider-scoped rules are needed (e.g. DeepSeek's generic stream drop). */
  readonly provider?: string;
  /** The sanitized failure text (already redacted of secrets by the boundary or {@link redactSecrets}). */
  readonly detail: string;
  /** HTTP-like status when known (401, 429, 503, …). */
  readonly status?: number;
  /** SDK error code / type when known (e.g. `insufficient_quota`, `ECONNREFUSED`). */
  readonly code?: string;
  /** Retry-After, in ms, when the provider supplied one. */
  readonly retryAfterMs?: number;
  /** Whether the failing provider is a local runtime (LM Studio), which changes how a
   *  connection refusal classifies (not-running vs transient transport). */
  readonly local?: boolean;
}

/** The classification verdict: the class, whether to auto-retry, the user action, and retry-after. */
export interface ProviderFailureClassification {
  readonly class: ProviderFailureClass;
  readonly retryable: boolean;
  readonly userAction: ProviderUserAction;
  readonly retryAfterMs?: number;
}

const QUOTA_BILLING =
  /insufficient[\s_-]*quota|quota[\s_-]*exceeded|out of (credits?|quota)|billing|payment required|\b402\b|exceeded your current quota|hard limit|spending limit/i;

const MODEL_UNAVAILABLE =
  /model[\s_-]*not[\s_-]*found|unknown model|no such model|model.*(not (loaded|available)|does not exist)|model_not_found|no models loaded|failed to load model/i;

/** Connection-refusal tokens shared by LOCAL_UNREACHABLE (a down local runtime) and
 *  TRANSIENT_TRANSPORT (a transient cloud transport fault); `local` decides which class wins. */
const CONNECTION_REFUSED = /econnrefused|enotfound|connection refused/i;

const LOCAL_UNREACHABLE = new RegExp(
  `${CONNECTION_REFUSED.source}|connect(ion)? (error|failed)|fetch failed|socket hang ?up|server is not running|is the server running|not reachable|unreachable`,
  "i",
);

const RATE_LIMITED = /\b429\b|rate[\s_-]*limit|too many requests/i;

const OVERLOADED =
  /overloaded|\b529\b|at capacity|capacity|server is busy|temporarily unable to (serve|handle)/i;

const PROVIDER_UNAVAILABLE =
  /\b50[024]\b|\b503\b|service unavailable|bad gateway|gateway time ?out|upstream|temporarily unavailable/i;

const TRANSIENT_TRANSPORT = new RegExp(
  `websocket|\\bws\\b|socket hang ?up|\\b1006\\b|econnreset|${CONNECTION_REFUSED.source}|epipe|etimedout|enetunreach|connection (reset|closed|refused|aborted|error)|reset by peer|timed? ?out|fetch failed|stream (closed|interrupted|aborted unexpectedly)|premature close|aborted unexpectedly`,
  "i",
);

const DEEPSEEK_TRANSPORT =
  /stream failed|stream failure|response stream failed|upstream stream failed/i;

const REQUEST_REJECTED =
  /\b400\b|bad request|invalid request|invalid[\s_-]*param|unprocessable|malformed|validation (failed|error)/i;

function verdict(
  cls: ProviderFailureClass,
  userAction: ProviderUserAction,
  retryAfterMs?: number,
): ProviderFailureClassification {
  return { class: cls, retryable: isRetryable(cls), userAction, retryAfterMs };
}

/**
 * Classifies a normalized provider failure into the taxonomy. Order is by confidence: the terminal,
 * strongly-signalled classes (auth, overflow, quota, model, local-runtime, request-rejected) win
 * before the retryable transport family, so a 429 that is really a hard quota ("insufficient_quota")
 * is NOT retried into the same failure. A connection refusal is a local runtime being down only when
 * `local` is set; for a cloud provider it stays a transient transport fault. Anything unmatched is
 * `unknown` and NON-retryable - the safe default that also feeds the observation store.
 */
export function classifyProviderFailure(
  signals: ProviderFailureSignals,
): ProviderFailureClassification {
  const { detail, status, code, retryAfterMs, local, provider } = signals;
  const text = `${code ?? ""} ${detail}`;

  // Terminal, strongly-signalled classes first.
  if (status === 401 || status === 403 || isAuthFailure(text)) {
    return verdict("auth", "reauth");
  }
  if (isContextOverflow(text)) {
    return verdict("context_overflow", "compact");
  }
  if (status === 402 || QUOTA_BILLING.test(text)) {
    return verdict("quota_billing", "check_billing");
  }
  if (MODEL_UNAVAILABLE.test(text)) {
    return verdict("model_unavailable", "load_model");
  }
  if (local && LOCAL_UNREACHABLE.test(text)) {
    return verdict("local_runtime_unavailable", "start_local_runtime");
  }

  // Retryable transport family.
  if (status === 429 || RATE_LIMITED.test(text)) {
    return verdict("rate_limited", "wait", retryAfterMs);
  }
  if (status === 529 || OVERLOADED.test(text)) {
    return verdict("provider_overloaded", "retry", retryAfterMs);
  }
  if ((status !== undefined && status >= 500) || PROVIDER_UNAVAILABLE.test(text)) {
    return verdict("provider_unavailable", "retry", retryAfterMs);
  }
  if (TRANSIENT_TRANSPORT.test(text)) {
    return verdict("transient_transport", "retry");
  }
  if (provider === "deepseek" && DEEPSEEK_TRANSPORT.test(text)) {
    return verdict("transient_transport", "retry");
  }

  // Terminal request-shape rejection (after the transient family so a 400-with-timeout text isn't
  // misread, but before the unknown fallthrough).
  if (status === 400 || REQUEST_REJECTED.test(text)) {
    return verdict("request_rejected", "fix_request");
  }

  return verdict("unknown", "none");
}
