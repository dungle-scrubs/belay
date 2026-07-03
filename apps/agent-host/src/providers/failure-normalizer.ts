/**
 * Responsible for: normalizing a raw thrown provider-stream cause into the typed ProviderError -
 * cause-chain detail enrichment + secret redaction, structured evidence extraction, taxonomy
 * classification (retryable/class/userAction), and the structured classified-failure debug log.
 * The ONE boundary mapper every provider stream shares (pi-ai and claude-code), so a Max-plan
 * overload classifies for auto-reconnect exactly like the same failure from any other adapter.
 * Not for: the classification rules (failure-taxonomy.ts) or evidence extraction internals
 * (failure-evidence.ts).
 */
import { debug } from "@host/transport/log";
import { msg } from "@host/transport/messages";
import { ProviderAuthError, ProviderUnavailable } from "./errors";
import { causeChainDetail, extractFailureEvidence } from "./failure-evidence";
import { classifyProviderFailure, redactSecrets } from "./failure-taxonomy";
import type { ProviderError } from "./types";

/**
 * Maps any cause a provider stream failed with onto the typed ProviderError channel. An
 * already-typed failure (a classified auth refusal, or a ProviderUnavailable built upstream) rides
 * through as-is; anything else is normalized into the failure taxonomy (D-076 M1/M2) ->
 * ProviderUnavailable carrying its class + user action, with `retryable` DERIVED from the class so
 * the loop can auto-reconnect before any token streams (D-077). The detail is redacted of secrets
 * before it lands on the typed error payload (and, later, the observation store).
 */
export function normalizeProviderFailure(params: {
  readonly provider: string;
  readonly cause: unknown;
  /** Whether the provider is a local runtime (LM Studio): refines how a connection refusal
   *  classifies in the failure taxonomy (D-076 M2). Defaults to false (cloud). */
  readonly local?: boolean;
  /** Whether the provider is a gateway/catalog source proxying upstream model providers: turns on
   *  gateway-vs-upstream origin attribution on a failure (D-076 M2). Defaults to false. */
  readonly gateway?: boolean;
}): ProviderError {
  const { provider, cause, local, gateway } = params;
  if (cause instanceof ProviderAuthError || cause instanceof ProviderUnavailable) {
    return cause;
  }
  // Enrich the generic top-level message ("Connection error.") with the specific syscall code
  // recovered from the nested `.cause` chain (02.15), then redact - a nested cause can carry
  // secrets, so the enriched detail goes through `redactSecrets` exactly like the bare message.
  const detail = redactSecrets(causeChainDetail(msg(cause), cause));
  // Normalize the raw cause into sanitized structured evidence once (D-076 M2): HTTP status,
  // SDK code, retry-after, request id, gateway-vs-upstream origin, and the top-level field
  // NAMES - never a raw value. The classifier reads the strong signals; the rest is preserved.
  const evidence = extractFailureEvidence(cause, { gateway });
  const failure = classifyProviderFailure({
    provider,
    detail,
    status: evidence.status,
    code: evidence.code,
    retryAfterMs: evidence.retryAfterMs,
    local,
  });
  // Structured, redacted classification log (D-076 M6): the class, retry decision, source,
  // and preserved HTTP/code/retry-after/request-id/origin signals - never the secret-bearing
  // raw payload, only the sanitized detail.
  debug("provider", "classified-failure", {
    provider,
    class: failure.class,
    retryable: failure.retryable,
    action: failure.userAction,
    status: evidence.status,
    code: evidence.code,
    retryAfterMs: evidence.retryAfterMs,
    requestId: evidence.requestId,
    origin: evidence.origin,
    upstream: evidence.upstreamProvider,
    detail,
  });
  return new ProviderUnavailable({
    provider,
    detail,
    cause,
    retryable: failure.retryable,
    classification: failure.class,
    userAction: failure.userAction,
    retryAfterMs: failure.retryAfterMs,
    // Names + shape only, never values - the raw cause payload is never copied (D-076 M2/M5).
    evidence,
  });
}
