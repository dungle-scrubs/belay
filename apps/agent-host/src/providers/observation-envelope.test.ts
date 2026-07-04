import { describe, expect, it } from "vitest";
import type { ObservationInput } from "./failure-record-schema";
import {
  decodeObservationEnvelope,
  foldObservationDelta,
  loopPatternEnvelope,
  OBSERVATION_KIND_FILES,
  OBSERVATION_KINDS,
  OBSERVATION_REDACTION_VERSION,
  OBSERVATION_SCHEMA_VERSION,
  type ObservationEnvelope,
  providerFailureEnvelope,
  toolPatternEnvelope,
} from "./observation-envelope";

/**
 * M2 (common envelope) + M7 (later-producer schema). The versioned envelope every producer shares:
 * schemaVersion/kind/fingerprint/source/shape, defensive decode that drops corrupt lines, and the
 * shape-summary redaction that keeps raw prompts, tool outputs, and transcript text out of the corpus.
 */

const NOW = "2026-06-27T12:00:00.000Z";

function input(over: Partial<ObservationInput> = {}): ObservationInput {
  return {
    provider: "gpt",
    model: "gpt-5.5",
    authMode: "oauth",
    phase: "model-step",
    classification: "unknown",
    retryable: false,
    message: "some never-before-seen provider error 12345",
    shapeFields: ["error", "status"],
    outputStarted: false,
    ...over,
  };
}

describe("providerFailureEnvelope", () => {
  it("builds a versioned provider_failure envelope with source/shape payloads", () => {
    const env = providerFailureEnvelope(input(), NOW);
    expect(env.schemaVersion).toBe(OBSERVATION_SCHEMA_VERSION);
    expect(env.redactionVersion).toBe(OBSERVATION_REDACTION_VERSION);
    expect(env.kind).toBe("provider_failure");
    expect(env.count).toBe(1);
    expect(env.firstSeen).toBe(NOW);
    expect(env.lastSeen).toBe(NOW);
    expect(env.id).toMatch(/^obs_/);
    expect(env.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(env.source).toEqual({
      provider: "gpt",
      model: "gpt-5.5",
      authMode: "oauth",
      phase: "model-step",
    });
    expect(env.shape).toMatchObject({
      classification: "unknown",
      retryable: false,
      message: expect.any(String),
      fieldNames: ["error", "status"],
      outputStarted: false,
    });
  });

  it("re-redacts the message into the shape (no secrets reach source/shape)", () => {
    const env = providerFailureEnvelope(
      input({ message: "Authorization: Bearer sk-ant-LEAK0123456789 failed" }),
      NOW,
    );
    expect(JSON.stringify(env)).not.toContain("sk-ant-LEAK0123456789");
    expect(env.shape.message).toContain("«redacted»");
  });
});

describe("decodeObservationEnvelope", () => {
  it("round-trips a valid envelope", () => {
    const env = providerFailureEnvelope(input(), NOW);
    const decoded = decodeObservationEnvelope(JSON.stringify(env));
    expect(decoded).toEqual(env);
  });

  it("returns null for corrupt or partial lines (tolerant decode)", () => {
    expect(decodeObservationEnvelope("not json")).toBeNull();
    expect(decodeObservationEnvelope("{}")).toBeNull();
    expect(decodeObservationEnvelope(JSON.stringify({ kind: "provider_failure" }))).toBeNull();
  });

  it("rejects an unknown observation kind", () => {
    const env = providerFailureEnvelope(input(), NOW);
    const tampered = { ...env, kind: "totally_made_up" };
    expect(decodeObservationEnvelope(JSON.stringify(tampered))).toBeNull();
  });

  it("rejects an envelope whose redaction version is newer than this build supports", () => {
    const env = providerFailureEnvelope(input(), NOW);
    const tampered = { ...env, redactionVersion: OBSERVATION_REDACTION_VERSION + 1 };
    expect(decodeObservationEnvelope(JSON.stringify(tampered))).toBeNull();
  });
});

describe("foldObservationDelta", () => {
  it("aggregates repeats: count sums, firstSeen holds, lastSeen advances", () => {
    const a = providerFailureEnvelope(input(), NOW);
    const later = "2026-06-27T12:05:00.000Z";
    const b = { ...providerFailureEnvelope(input(), later), fingerprint: a.fingerprint };
    const folded = foldObservationDelta(a, b);
    expect(folded.count).toBe(2);
    expect(folded.firstSeen).toBe(NOW);
    expect(folded.lastSeen).toBe(later);
    expect(folded.id).toBe(a.id);
  });
});

describe("later producer kinds (M7, schema only, not wired)", () => {
  it("declares tool_pattern, loop_pattern, and harness_guidance kinds with jsonl files", () => {
    expect(OBSERVATION_KINDS).toContain("tool_pattern");
    expect(OBSERVATION_KINDS).toContain("loop_pattern");
    expect(OBSERVATION_KINDS).toContain("harness_guidance");
    for (const kind of OBSERVATION_KINDS) {
      expect(OBSERVATION_KIND_FILES[kind]).toMatch(/\.jsonl$/);
    }
  });

  it("tool-pattern producer accepts only a shape summary and redacts string fields", () => {
    const env = toolPatternEnvelope(
      { tool: "bash", phase: "tool-step", outcome: "error", detail: "exit 1 token=sk-leak99999" },
      NOW,
    );
    expect(env.kind).toBe("tool_pattern");
    expect(JSON.stringify(env)).not.toContain("sk-leak99999");
  });

  it("loop-pattern producer truncates an over-long field so raw transcript text can't land", () => {
    const huge = "x".repeat(5_000);
    const env = loopPatternEnvelope({ pattern: "stall", phase: "loop", detail: huge }, NOW);
    const detail = env.shape.detail;
    expect(typeof detail).toBe("string");
    expect((detail as string).length).toBeLessThan(huge.length);
  });
});

describe("envelope invariants", () => {
  it("every provider_failure envelope keeps provider fields under source/shape, not top-level", () => {
    const env: ObservationEnvelope = providerFailureEnvelope(input(), NOW);
    // The envelope surface is fixed; provider-specific fields never leak to the top level.
    expect(Object.keys(env).sort()).toEqual(
      [
        "count",
        "fingerprint",
        "firstSeen",
        "id",
        "kind",
        "lastSeen",
        "redactionVersion",
        "schemaVersion",
        "shape",
        "source",
      ].sort(),
    );
  });
});
