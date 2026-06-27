import { describe, expect, it } from "vitest";
import {
  ProviderFailureLog,
  providerFailureLogFields,
  type RecordFailureInput,
  summarizeFailures,
} from "./provider-failure-log";

/**
 * D-076 M6: the recent-provider-failure diagnostics. The structured log line carries classification,
 * retry decision, attempt, source/model, phase, and a stable fingerprint with no secret; the
 * recent-failures ring keeps retry-exhausted and non-retryable-terminal failures in two DISTINCT
 * buckets so `/doctor` can report them separately.
 */

describe("providerFailureLogFields", () => {
  it("records classification, retry decision, attempt, source/model, phase, and a fingerprint", () => {
    const fields = providerFailureLogFields({
      provider: "codex",
      model: "gpt-5.5",
      phase: "model-step",
      classification: "rate_limited",
      retryable: true,
      userAction: "wait",
      attempt: 2,
      outcome: "reconnect",
      status: 429,
      code: "rate_limit_exceeded",
      shapeFields: ["error", "status"],
      detail: "Too Many Requests",
    });
    expect(fields.provider).toBe("codex");
    expect(fields.model).toBe("gpt-5.5");
    expect(fields.phase).toBe("model-step");
    expect(fields.class).toBe("rate_limited");
    expect(fields.retryable).toBe(true);
    expect(fields.attempt).toBe(2);
    expect(fields.outcome).toBe("reconnect");
    expect(typeof fields.fingerprint).toBe("string");
    expect((fields.fingerprint as string).length).toBe(16);
    // Richer shape metadata (behind the verbose scope) is the joined field NAMES, never values.
    expect(fields.shapeFields).toBe("error,status");
  });

  it("defaults an absent classification to unknown and re-redacts the detail", () => {
    const fields = providerFailureLogFields({
      provider: "fake",
      model: "fake-1",
      phase: "model-step",
      retryable: false,
      attempt: 0,
      outcome: "terminal",
      detail: "boom Authorization: Bearer sk-secret-deadbeef0000",
    });
    expect(fields.class).toBe("unknown");
    expect(String(fields.detail)).not.toContain("sk-secret-deadbeef0000");
    expect(String(fields.detail)).toContain("«redacted»");
  });

  it("fingerprints the same shape identically across attempts (correlatable log lines)", () => {
    const base = {
      provider: "codex",
      model: "gpt-5.5",
      phase: "model-step",
      classification: "transient_transport" as const,
      retryable: true,
      detail: "socket hang up",
    };
    const a = providerFailureLogFields({ ...base, attempt: 2, outcome: "reconnect" });
    const b = providerFailureLogFields({ ...base, attempt: 3, outcome: "reconnect" });
    expect(a.fingerprint).toBe(b.fingerprint);
  });
});

describe("summarizeFailures - retry exhaustion vs non-retryable terminal", () => {
  const exhausted: RecordFailureInput = {
    provider: "codex",
    model: "gpt-5.5",
    classification: "transient_transport",
    retryExhausted: true,
    attempts: 3,
    detail: "websocket 1006 closed",
    at: "2026-06-27T00:00:00.000Z",
  };
  const terminal: RecordFailureInput = {
    provider: "codex",
    model: "gpt-5.5",
    classification: "request_rejected",
    retryExhausted: false,
    attempts: 0,
    detail: "invalid request",
    at: "2026-06-27T00:00:01.000Z",
  };

  it("counts the two categories distinctly and keeps the latest of each", () => {
    const log = new ProviderFailureLog();
    log.record(exhausted);
    log.record(terminal);
    log.record({ ...exhausted, detail: "ECONNRESET", at: "2026-06-27T00:00:02.000Z" });
    const summary = log.summary();
    expect(summary.retryExhausted).toBe(2);
    expect(summary.nonRetryableTerminal).toBe(1);
    expect(summary.lastRetryExhausted?.detail).toBe("ECONNRESET");
    expect(summary.lastTerminal?.detail).toBe("invalid request");
  });

  it("re-redacts a recorded detail and computes a fingerprint", () => {
    const log = new ProviderFailureLog();
    const record = log.record({
      ...terminal,
      detail: "rejected key x-api-key: pi-7f2a91c4e3b8aa00bb11",
    });
    expect(record.detail).not.toContain("pi-7f2a91c4e3b8aa00bb11");
    expect(record.fingerprint.length).toBe(16);
  });

  it("an empty log summarizes to zero of each", () => {
    expect(summarizeFailures([])).toEqual({
      retryExhausted: 0,
      nonRetryableTerminal: 0,
      lastRetryExhausted: undefined,
      lastTerminal: undefined,
    });
  });

  it("reset clears the ring", () => {
    const log = new ProviderFailureLog();
    log.record(exhausted);
    expect(log.list().length).toBe(1);
    log.reset();
    expect(log.list().length).toBe(0);
  });

  it("bounds the ring so it cannot grow unbounded", () => {
    const log = new ProviderFailureLog();
    for (let i = 0; i < 120; i += 1) {
      log.record({ ...exhausted, at: `2026-06-27T00:${String(i).padStart(2, "0")}:00.000Z` });
    }
    expect(log.list().length).toBeLessThanOrEqual(50);
    expect(log.summary().retryExhausted).toBeLessThanOrEqual(50);
  });
});
