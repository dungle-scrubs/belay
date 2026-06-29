import type {
  ProviderDiagnostic,
  ProviderIncidentReason,
  ProviderPartialCounts,
} from "@trevor/session";
import { providerFailureEvidence } from "./errors";
import { redactSecrets } from "./failure-taxonomy";
import type { Provider, ProviderError } from "./types";

/**
 * Builds the structured {@link ProviderDiagnostic} a turn carries on a reconnect/terminal failure for
 * assistant events and /doctor correlation. It lives beside the failure taxonomy (not in the loop) so
 * provider-failure shape knowledge has one home: the loop just hands it the error + partials. The
 * evidence projection ({@link providerFailureEvidence}) owns the `instanceof`/`evidence?` unpacking.
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
