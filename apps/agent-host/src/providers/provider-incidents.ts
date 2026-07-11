import type { ProviderDiagnostic } from "@trevor/session";

/**
 * The host's per-provider LATEST-incident state (D-007). Where {@link ProviderFailureLog} keeps a
 * bounded ring of recent terminal failures as COUNTS for the two retry buckets, this keeps the single
 * most recent structured {@link ProviderDiagnostic} per provider - including malformed-protocol
 * anomalies, which are not {@link ProviderError}s and never reach the failure ring. `/doctor` reads it
 * to show, per provider, what the last incident was and which actionable category it falls in.
 *
 * In-memory and best-effort: it informs diagnostics, never gates a turn. The diagnostic detail is
 * already redacted at the provider boundary before it arrives, so no secret, prompt body, header, or
 * raw tool result is stored here.
 *
 * Responsible for: the latest-incident-per-provider store and /doctor incident categorization.
 * Not for: the counted recent-failures ring; that lives in provider-failure-log.ts.
 */

/** The actionable category a provider incident falls into, for the `/doctor` finding it drives. */
export type ProviderIncidentCategory =
  | "auth_quota"
  | "transport"
  | "malformed_protocol"
  | "unsafe_retry";

/** One recorded incident: the structured diagnostic plus when it happened and the run it ended. */
export interface ProviderIncident {
  readonly diagnostic: ProviderDiagnostic;
  readonly at: string;
  readonly runId?: string;
}

/**
 * Maps a diagnostic to its `/doctor` category. Malformed protocol and auth/quota are named by reason;
 * an "unsafe retry" is the narrower case of a retryable transport drop that streamed output first (so
 * the bounded auto-reconnect could not fire without duplicating it); everything else is a transport
 * incident. The order is deliberate: the reason-named categories take precedence over the retry shape.
 */
export function incidentCategory(diagnostic: ProviderDiagnostic): ProviderIncidentCategory {
  if (diagnostic.reason === "protocol_anomaly") {
    return "malformed_protocol";
  }
  if (
    diagnostic.reason === "auth" ||
    diagnostic.reason === "quota_billing" ||
    diagnostic.reason === "usage_limit"
  ) {
    return "auth_quota";
  }
  const streamed = diagnostic.partials.textChars > 0 || diagnostic.partials.toolCalls > 0;
  if (diagnostic.retryable && !diagnostic.safeToRetry && streamed) {
    return "unsafe_retry";
  }
  return "transport";
}

/**
 * The in-memory latest-incident-per-provider map. A module singleton (`providerIncidents`) so the turn
 * consumer that records and the `/doctor` command that reads share one instance in the host process.
 * Resettable for tests.
 */
export class ProviderIncidentLog {
  private latest = new Map<string, ProviderIncident>();

  record(diagnostic: ProviderDiagnostic, at: string, runId?: string): void {
    this.latest.set(diagnostic.provider, { diagnostic, at, ...(runId ? { runId } : {}) });
  }

  latestByProvider(): readonly ProviderIncident[] {
    return [...this.latest.values()];
  }

  reset(): void {
    this.latest.clear();
  }
}

/** The host-process-wide latest-incident store (shared by the turn consumer and `/doctor`). */
export const providerIncidents = new ProviderIncidentLog();
