import type {
  ProviderDiagnostic,
  ProviderIncidentReason,
  ProviderPartialCounts,
} from "@belay/session";
import { providerFailureEvidence } from "./errors";
import { redactSecrets } from "./failure-taxonomy";
import type { ProviderProtocolDiagnostic } from "./protocol-anomaly";
import type { Provider, ProviderError } from "./types";

/**
 * Builds the structured {@link ProviderDiagnostic} a turn carries on a reconnect/terminal failure for
 * assistant events and /doctor correlation. It lives beside the failure taxonomy (not in the loop) so
 * provider-failure shape knowledge has one home: the loop just hands it the error + partials. The
 * evidence projection ({@link providerFailureEvidence}) owns the `instanceof`/`evidence?` unpacking.
 *
 * Responsible for: building the structured ProviderDiagnostic for stream failures and protocol
 * anomalies.
 * Not for: storing incidents (provider-incidents.ts) or the recent-failures ring
 * (provider-failure-log.ts).
 */

/** Maps a provider failure to its coarse incident reason for the diagnostic. */
export function incidentReasonOf(error: ProviderError): ProviderIncidentReason {
  if (error._tag === "ProviderAuthError") {
    return "auth";
  }
  if (error.classification === "transient_transport") {
    return "transport_loss";
  }
  if (error.classification === "context_overflow") {
    return "context_overflow";
  }
  return error.classification ?? "unknown";
}

/** Builds the structured incident diagnostic from a provider failure + this attempt's partial counts. */
export function providerDiagnostic(
  provider: Provider,
  error: ProviderError,
  attempt: number,
  safeToRetry: boolean,
  partials: ProviderPartialCounts,
): ProviderDiagnostic {
  const evidence = providerFailureEvidence(error);
  return {
    provider: provider.id,
    model: provider.model,
    phase: "model-step",
    reason: incidentReasonOf(error),
    retryable: evidence.retryable,
    safeToRetry,
    attempt,
    detail: redactSecrets(evidence.detail),
    partials,
    ...(evidence.status !== undefined ? { status: evidence.status } : {}),
    ...(evidence.code ? { code: evidence.code } : {}),
    ...(evidence.requestId ? { requestId: evidence.requestId } : {}),
  };
}

/**
 * Builds the diagnostic for a malformed-protocol incident (D-005): the model rendered raw tool-call
 * markup as assistant text instead of a typed tool call. Unlike a stream failure this is not a
 * {@link ProviderError}, so the loop hands the classified anomaly + the leaked-text partial counts
 * here directly. `safeToRetry` is false: by the time this builds, the bounded nudge has already been
 * spent (or was unavailable), so the turn is terminating - re-running is no longer in scope. The
 * `reason` is a templated provider name + fixed phrase (no secret), re-redacted defensively.
 */
export function protocolAnomalyDiagnostic(
  provider: Provider,
  anomaly: ProviderProtocolDiagnostic,
  partials: ProviderPartialCounts,
): ProviderDiagnostic {
  return {
    provider: provider.id,
    model: provider.model,
    phase: "tool-protocol",
    reason: "protocol_anomaly",
    retryable: anomaly.retryable,
    safeToRetry: false,
    attempt: 1,
    detail: redactSecrets(anomaly.reason),
    partials,
  };
}
