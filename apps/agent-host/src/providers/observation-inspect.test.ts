import { describe, expect, it } from "vitest";
import type { ObservationInput } from "./failure-record-schema";
import type { ObservationIndex } from "./observation-corpus";
import {
  loopPatternEnvelope,
  type ObservationEnvelope,
  providerFailureEnvelope,
} from "./observation-envelope";
import {
  buildObservationBundle,
  countByKind,
  formatObservationReport,
  isDeleteConfirmed,
} from "./observation-inspect";

/**
 * Plan 29 M5: the inspect/export/delete command paths. Redacted listing, a redacted export bundle with
 * schema version and per-kind counts, and the delete-confirm gate.
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

function indexOf(...records: ObservationEnvelope[]): ObservationIndex {
  return Object.fromEntries(records.map((r) => [r.fingerprint, r]));
}

describe("formatObservationReport", () => {
  it("lists redacted shape ids and counts, busiest first", () => {
    const a = { ...providerFailureEnvelope(input(), NOW), count: 5 };
    const b = { ...providerFailureEnvelope(input({ status: 503 }), NOW), count: 2 };
    const report = formatObservationReport(indexOf(a, b));
    expect(report).toContain("2 shapes");
    expect(report.indexOf(a.fingerprint)).toBeLessThan(report.indexOf(b.fingerprint));
    // No raw secret or auth value in the report.
    expect(report).not.toMatch(/bearer|sk-|api_key/i);
  });

  it("reports an empty corpus", () => {
    expect(formatObservationReport({})).toBe("observation corpus: empty");
  });
});

describe("buildObservationBundle", () => {
  it("carries the schema version, per-kind counts, and redacted records", () => {
    const a = providerFailureEnvelope(
      input({ message: "Authorization: Bearer sk-ant-BUNDLELEAK001 died" }),
      NOW,
    );
    const b = loopPatternEnvelope({ pattern: "stall", phase: "loop" }, NOW);
    const bundle = buildObservationBundle(indexOf(a, b), NOW);
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.generatedAt).toBe(NOW);
    expect(bundle.counts.byKind.provider_failure).toBe(1);
    expect(bundle.counts.byKind.loop_pattern).toBe(1);
    expect(bundle.records).toHaveLength(2);
    expect(JSON.stringify(bundle)).not.toContain("sk-ant-BUNDLELEAK001");
  });
});

describe("countByKind", () => {
  it("sums sightings per producer kind", () => {
    const a = { ...providerFailureEnvelope(input(), NOW), count: 4 };
    expect(countByKind(indexOf(a))).toEqual({ provider_failure: 4 });
  });
});

describe("isDeleteConfirmed", () => {
  it("requires an explicit confirm token", () => {
    expect(isDeleteConfirmed("confirm")).toBe(true);
    expect(isDeleteConfirmed("  CONFIRM ")).toBe(true);
    expect(isDeleteConfirmed("")).toBe(false);
    expect(isDeleteConfirmed("yes")).toBe(false);
  });
});
