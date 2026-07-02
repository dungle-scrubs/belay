/**
 * Responsible for: the agent loop's provider-failure observation - the structured, redacted
 * failure/reconnect log line (logProviderFailure) and the best-effort unknown-shape observation
 * record (observeUnknownFailure).
 * Not for: classifying failures or building their evidence - that is the providers subsystem;
 * this module only emits what it produces.
 */
import type { Provider, ProviderError } from "@host/providers";
import { providerFailureEvidence } from "@host/providers";
import { buildProviderFailureLogFields } from "@host/providers/failure-record-schema";
import { recordObservation } from "@host/providers/observation-store";
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
 * Best-effort: when a model step fails terminally with an UNKNOWN provider failure shape, record it
 * as a redacted, deduped observation under TREVOR_STATE_HOME (D-076 M5). Emits nothing and never
 * fails - the underlying store swallows any write error - so it can be `concat`-ed ahead of the real
 * failure without changing the turn's outcome. Only `unknown` is observed; well-classified terminal
 * failures (auth, quota, model/runtime unavailable, request rejected) already carry their own action.
 */
export function observeUnknownFailure(
  provider: Provider,
  error: ProviderError,
  outputStarted: boolean,
): Stream.Stream<never, never> {
  if (error._tag !== "ProviderUnavailable" || error.classification !== "unknown") {
    return Stream.empty;
  }
  const evidence = providerFailureEvidence(error);
  return Stream.fromEffect(
    Effect.promise(() =>
      recordObservation(
        {
          provider: error.provider,
          model: provider.model,
          phase: "model-step",
          classification: "unknown",
          retryable: evidence.retryable,
          status: evidence.status,
          code: evidence.code,
          message: error.detail,
          shapeFields: evidence.shapeFields,
          outputStarted,
        },
        new Date().toISOString(),
      ),
    ),
  ).pipe(Stream.drain);
}
