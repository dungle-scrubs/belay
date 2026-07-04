import type { Provider, ProviderFailureEvidence } from "@host/providers";
import {
  buildProviderFailureLogFields,
  fingerprintObservation,
} from "@host/providers/failure-record-schema";
import type { ProviderFailureClass } from "@host/providers/failure-taxonomy";
import { describe, expect, it } from "vitest";
import { isClassifierGapFailure, observationInputFromFailure } from "./loop-failures";

/**
 * Plan 29 M6: the provider-failure observation producer. Only classifier-gap (`unknown`) shapes are
 * recorded - well-classified actionable classes never spam the corpus - and the retry decision is
 * carried faithfully. An observation and its debug failure-log line share one fingerprint so the two
 * surfaces correlate.
 */

const provider = { id: "deepseek", model: "deepseek-pro" } as unknown as Provider;

function evidence(over: Partial<ProviderFailureEvidence> = {}): ProviderFailureEvidence {
  return {
    classification: "unknown",
    retryable: false,
    status: 502,
    code: "ECONNRESET",
    shapeFields: ["error", "status"],
    detail: "connection reset before response 12345",
    ...over,
  };
}

describe("isClassifierGapFailure", () => {
  it("records unknown shapes (the classifier gap)", () => {
    expect(isClassifierGapFailure("unknown")).toBe(true);
  });

  it("does NOT record well-classified actionable classes (no corpus spam)", () => {
    const actionable: ProviderFailureClass[] = [
      "auth",
      "quota_billing",
      "context_overflow",
      "model_unavailable",
      "local_runtime_unavailable",
      "request_rejected",
      "rate_limited",
      "transient_transport",
    ];
    for (const cls of actionable) {
      expect(isClassifierGapFailure(cls)).toBe(false);
    }
    expect(isClassifierGapFailure(undefined)).toBe(false);
  });
});

describe("observationInputFromFailure", () => {
  it("carries the retry decision for a non-retryable unknown shape", () => {
    const input = observationInputFromFailure(provider, evidence({ retryable: false }), false);
    expect(input.classification).toBe("unknown");
    expect(input.retryable).toBe(false);
    expect(input.provider).toBe("deepseek");
    expect(input.shapeFields).toEqual(["error", "status"]);
  });

  it("carries the retry decision for a retry-exhausted (retryable) unknown shape", () => {
    const input = observationInputFromFailure(provider, evidence({ retryable: true }), true);
    expect(input.retryable).toBe(true);
    expect(input.outputStarted).toBe(true);
  });

  it("shares its fingerprint with the debug failure-log line for the same shape", () => {
    const ev = evidence();
    const observationFp = fingerprintObservation(observationInputFromFailure(provider, ev, false));
    const logFp = buildProviderFailureLogFields({
      ...ev,
      provider: provider.id,
      model: provider.model,
      phase: "model-step",
      attempt: 0,
      outcome: "terminal",
    }).fingerprint;
    expect(observationFp).toBe(logFp);
  });
});
