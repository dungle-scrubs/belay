/**
 * Responsible for: the agent loop's provider-failure observation - the structured, redacted
 * failure/reconnect log line (logProviderFailure) and the best-effort unknown-shape observation
 * record (observeUnknownFailure).
 * Not for: classifying failures or building their evidence - that is the providers subsystem;
 * this module only emits what it produces.
 */

import type { ProviderDiagnostic } from "@belay/session";
import type { ProviderTraceWriter } from "@belay/session/telemetry-provider-trace";
import {
  type Provider,
  type ProviderError,
  type ProviderFailureEvidence,
  ProviderUnavailable,
  providerFailureEvidence,
} from "@host/providers";
import {
  buildProviderFailureLogFields,
  type ObservationInput,
} from "@host/providers/failure-record-schema";
import type { ProviderFailureClass } from "@host/providers/failure-taxonomy";
import { recordObservation } from "@host/providers/observation-store";
import { providerFailures } from "@host/providers/provider-failure-log";
import { providerIncidents } from "@host/providers/provider-incidents";
import { debug } from "@host/transport/log";
import { Effect, Stream } from "effect";

/**
 * Emits the structured, redacted provider-failure log line (D-076 M6): the classification, retry
 * decision, attempt number, source/model, phase, and stable fingerprint - behind the verbose
 * `provider` debug scope, where the richer shape metadata (status/code/field names) is useful. Never
 * logs a raw payload; the detail is re-redacted by the field builder.
 */
export function logProviderFailure(
  provider: Provider,
  error: ProviderError,
  attempt: number,
  outcome: "reconnect" | "terminal",
): void {
  debug(
    "provider",
    outcome === "reconnect" ? "reconnect" : "failure",
    buildProviderFailureLogFields({
      ...providerFailureEvidence(error),
      provider: provider.id,
      model: provider.model,
      phase: "model-step",
      attempt,
      outcome,
    }),
  );
}

/**
 * Whether a terminal failure is classifier-gap evidence worth recording in the observation corpus
 * (plan 29 M6). Only `unknown` shapes qualify: they are the ones the classifier could not confidently
 * place, so their redacted shape is useful for improving the rules later. Every well-classified,
 * actionable class (auth, quota/billing, context overflow, model/runtime unavailable, request
 * rejected) already carries its own user action, and the retryable transient classes are ordinary
 * outage noise - recording either would only spam the corpus without adding classifier signal.
 */
export function isClassifierGapFailure(classification: ProviderFailureClass | undefined): boolean {
  return classification === "unknown";
}

/**
 * Normalizes a terminal provider failure into the common observation input (plan 29 M6). Faithfully
 * carries the retry decision (`retryable`) and shape (status/code/field names/output-started) so the
 * corpus can later separate non-retryable from retry-exhausted unknown shapes. The message is
 * evidence.detail - the same sanitized text the debug failure-log line fingerprints - so an
 * observation and its log line share one fingerprint for correlation.
 */
export function observationInputFromFailure(
  provider: Provider,
  evidence: ProviderFailureEvidence,
  outputStarted: boolean,
): ObservationInput {
  return {
    provider: provider.id,
    model: provider.model,
    phase: "model-step",
    classification: evidence.classification ?? "unknown",
    retryable: evidence.retryable,
    status: evidence.status,
    code: evidence.code,
    message: evidence.detail,
    shapeFields: evidence.shapeFields,
    outputStarted,
  };
}

/**
 * Best-effort: when a model step fails terminally with an UNKNOWN provider failure shape, record it
 * as a redacted, deduped observation under BELAY_STATE_HOME (D-076 M5, plan 29 M6). Emits nothing and
 * never fails - the underlying store swallows any write error - so it can be `concat`-ed ahead of the
 * real failure without changing the turn's outcome. Only classifier-gap (`unknown`) shapes are
 * observed; well-classified terminal failures already carry their own action.
 */
export function observeUnknownFailure(
  provider: Provider,
  error: ProviderError,
  outputStarted: boolean,
): Stream.Stream<never, never> {
  if (error._tag !== "ProviderUnavailable" || !isClassifierGapFailure(error.classification)) {
    return Stream.empty;
  }
  const input = observationInputFromFailure(
    provider,
    providerFailureEvidence(error),
    outputStarted,
  );
  return Stream.fromEffect(
    Effect.promise(() => recordObservation(input, new Date().toISOString())),
  ).pipe(Stream.drain);
}

export function recordProviderIncident(
  incident: ProviderDiagnostic | undefined,
  options: { readonly runId: string; readonly at?: string },
): Effect.Effect<void> {
  if (!incident) {
    return Effect.void;
  }
  return Effect.sync(() => {
    providerIncidents.record(incident, options.at ?? new Date().toISOString(), options.runId);
    debug("provider", "incident", {
      runId: options.runId,
      provider: incident.provider,
      model: incident.model,
      phase: incident.phase,
      reason: incident.reason,
      retryable: incident.retryable,
      safeToRetry: incident.safeToRetry,
      attempt: incident.attempt,
    });
  });
}

export function recordTerminalProviderFailure(
  provider: Provider,
  error: ProviderError,
  options: {
    readonly reconnectAttempts: number;
    readonly runId: string;
    readonly traceWriter?: ProviderTraceWriter;
    readonly at?: string;
  },
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const at = options.at ?? new Date().toISOString();
    const evidence = providerFailureEvidence(error);
    yield* Effect.sync(() =>
      providerFailures.record({
        provider: provider.id,
        model: provider.model,
        classification: evidence.classification,
        userAction: evidence.userAction,
        retryExhausted: options.reconnectAttempts > 0,
        attempts: options.reconnectAttempts,
        status: evidence.status,
        code: evidence.code,
        shapeFields: evidence.shapeFields,
        detail: error.message,
        at,
      }),
    );
    yield* Effect.sync(() =>
      options.traceWriter?.record({
        provider: provider.id,
        model: provider.model,
        attemptId: options.runId,
        outcome: "error",
        failureClass: evidence.classification,
        retryable: evidence.retryable,
        attempt: options.reconnectAttempts + 1,
        durationMs: 0,
        detail: error.message,
      }),
    );
    yield* recordProviderIncident(
      error instanceof ProviderUnavailable ? error.diagnostic : undefined,
      { runId: options.runId, at },
    );
  });
}
