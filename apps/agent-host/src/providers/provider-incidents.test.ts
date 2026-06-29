import assert from "node:assert/strict";
import type { ProviderDiagnostic } from "@trevor/session";
import { test } from "vitest";
import { ProviderUnavailable } from "./errors";
import { providerDiagnostic } from "./provider-diagnostic";
import { incidentCategory, ProviderIncidentLog } from "./provider-incidents";

const diag = (over: Partial<ProviderDiagnostic> = {}): ProviderDiagnostic => ({
  provider: "deepseek",
  model: "deepseek-v4",
  phase: "model-step",
  reason: "transport_loss",
  retryable: true,
  safeToRetry: true,
  attempt: 1,
  detail: "socket hang up",
  partials: { textChars: 0, thinkingChars: 0, toolCalls: 0, toolResults: 0 },
  ...over,
});

test("categorizes a malformed-protocol incident", () => {
  assert.equal(incidentCategory(diag({ reason: "protocol_anomaly" })), "malformed_protocol");
});

test("categorizes auth and quota incidents together", () => {
  assert.equal(incidentCategory(diag({ reason: "auth" })), "auth_quota");
  assert.equal(incidentCategory(diag({ reason: "quota_billing" })), "auth_quota");
});

test("a retryable transport drop AFTER partial output is an unsafe retry", () => {
  const category = incidentCategory(
    diag({
      reason: "transport_loss",
      retryable: true,
      safeToRetry: false,
      partials: { textChars: 42, thinkingChars: 0, toolCalls: 0, toolResults: 0 },
    }),
  );
  assert.equal(category, "unsafe_retry");
});

test("a clean transport drop with no partial output stays a transport incident", () => {
  assert.equal(incidentCategory(diag({ reason: "transport_loss" })), "transport");
});

test("keeps only the latest incident per provider, bounded by provider key", () => {
  const log = new ProviderIncidentLog();
  log.record(diag({ provider: "deepseek", detail: "first" }), "2026-06-29T00:00:00.000Z", "r1");
  log.record(diag({ provider: "deepseek", detail: "second" }), "2026-06-29T00:00:01.000Z", "r2");
  log.record(diag({ provider: "glm", detail: "glm-only" }), "2026-06-29T00:00:02.000Z", "r3");

  const latest = log.latestByProvider();
  assert.equal(latest.length, 2, "one per provider");
  const deepseek = latest.find((i) => i.diagnostic.provider === "deepseek");
  assert.equal(deepseek?.diagnostic.detail, "second", "the newest replaces the older");
  assert.equal(deepseek?.runId, "r2");
});

test("reset clears the per-provider map", () => {
  const log = new ProviderIncidentLog();
  log.record(diag(), "2026-06-29T00:00:00.000Z", "r1");
  assert.equal(log.latestByProvider().length, 1);
  log.reset();
  assert.equal(log.latestByProvider().length, 0);
});

test("an incident detail carries no credential into the store (redacted at the boundary)", () => {
  const error = new ProviderUnavailable({
    provider: "deepseek",
    detail: "401 from upstream: Authorization: Bearer sk-secret-deadbeef0000",
    retryable: false,
    classification: "auth",
  });
  const built = providerDiagnostic(
    { id: "deepseek", model: "deepseek-v4" } as Parameters<typeof providerDiagnostic>[0],
    error,
    1,
    false,
    { textChars: 0, thinkingChars: 0, toolCalls: 0, toolResults: 0 },
  );
  const log = new ProviderIncidentLog();
  log.record(built, "2026-06-29T00:00:00.000Z", "r1");
  const stored = log.latestByProvider()[0];
  assert.ok(stored);
  assert.ok(!stored.diagnostic.detail.includes("sk-secret-deadbeef0000"), stored.diagnostic.detail);
});
