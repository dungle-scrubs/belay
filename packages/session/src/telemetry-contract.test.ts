import assert from "node:assert/strict";
import { test } from "vitest";
import {
  isDisallowedTelemetryKey,
  METRIC_NAMES,
  REDACTED,
  redactAttributeValue,
  redactSecrets,
  resourceAttributes,
  SPAN_NAMES,
  safeAttributes,
} from "./telemetry-contract";

/**
 * The shared observability contract (plan 13 M2): redaction + safe-envelope helpers and the
 * allowed/disallowed attribute keys. Privacy is enforced by KEY (sensitive/high-cardinality keys are
 * dropped wholesale) and by VALUE (surviving strings are secret-stripped + capped).
 */

test("redactSecrets strips bearer tokens, api keys, auth headers, and query tokens (idempotent)", () => {
  const once = redactSecrets(
    "Authorization: Bearer sk-abcdefgh12345678 x-api-key=pi-zzzzzzzz9999 url?token=deadbeefcafe",
  );
  assert.ok(!/sk-abcdefgh/.test(once), "api key gone");
  assert.ok(!/deadbeefcafe/.test(once), "query token gone");
  assert.ok(!/pi-zzzzzzzz/.test(once), "header key gone");
  assert.equal(redactSecrets(once), once, "re-redacting is a no-op");
});

test("redactAttributeValue collapses raw paths and caps length", () => {
  const path = redactAttributeValue("/Users/kevin/dev/trevorV2/apps/agent-host/src/main.ts");
  assert.ok(path.includes("<path>"), "an absolute path is collapsed");
  assert.ok(!path.includes("/Users/kevin"), "the raw home path never survives");

  const long = redactAttributeValue("x".repeat(5000));
  assert.ok(long.length <= 257, "an oversized value is truncated");
});

test("disallowed keys cover prompts, tool output, auth, env, raw bodies, paths, and ids", () => {
  for (const key of [
    "prompt",
    "prompt_text",
    "messages",
    "tool_output",
    "toolResult",
    "command",
    "command_output",
    "authorization",
    "api_key",
    "x-api-key",
    "token",
    "secret",
    "env",
    "provider_body",
    "request_body",
    "response.body",
    "run_id",
    "runId",
    "session_id",
    "url",
    "path",
    "file_path",
    "cwd",
  ]) {
    assert.equal(isDisallowedTelemetryKey(key), true, `${key} must be disallowed`);
  }
  // Low-cardinality, non-sensitive keys are allowed.
  for (const key of ["provider", "model", "stop_cause", "outcome", "duration_ms", "attempt"]) {
    assert.equal(isDisallowedTelemetryKey(key), false, `${key} should be allowed`);
  }
});

test("safeAttributes drops disallowed keys, keeps numbers/booleans, and redacts string values", () => {
  const safe = safeAttributes({
    provider: "lmstudio",
    model: "qwen3.6-27b",
    duration_ms: 1234,
    ok: true,
    // all of these must be stripped:
    prompt: "the user's secret question",
    tool_output: "big output",
    session_id: "sess-123",
    file_path: "/Users/kevin/secret.txt",
    authorization: "Bearer sk-abcdefgh12345678",
    // a value carrying a stray token is still redacted:
    detail: "failed with key sk-abcdefgh12345678",
    nothing: undefined,
  });

  assert.deepEqual(Object.keys(safe).sort(), ["detail", "duration_ms", "model", "ok", "provider"]);
  assert.equal(safe.duration_ms, 1234);
  assert.equal(safe.ok, true);
  assert.ok(
    !String(safe.detail).includes("sk-abcdefgh"),
    "a stray secret in an allowed field is redacted",
  );
  assert.ok(String(safe.detail).includes(REDACTED));
});

test("span + metric names are namespaced under trevor.* and resource attributes are bounded identity", () => {
  for (const name of Object.values(SPAN_NAMES)) {
    assert.match(name, /^trevor\./);
  }
  for (const name of Object.values(METRIC_NAMES)) {
    assert.match(name, /^trevor\./);
  }
  const res = resourceAttributes("agent-host", "2.0.0");
  assert.equal(res["service.name"], "trevor-agent-host");
  assert.equal(res["service.version"], "2.0.0");
  // No host/user/path identity leaks into the resource.
  assert.ok(
    Object.keys(res).every((k) => !isDisallowedTelemetryKey(k)),
    "no disallowed key in resource attributes",
  );
  assert.equal(resourceAttributes("web", null)["service.version"], "dev", "missing version -> dev");
});
