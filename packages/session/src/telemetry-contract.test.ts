import assert from "node:assert/strict";
import { test } from "vitest";
import {
  isDisallowedTelemetryKey,
  METRIC_NAMES,
  NOOP_SINK,
  REDACTED,
  redactAttributeValue,
  redactSecrets,
  resourceAttributes,
  SPAN_NAMES,
  type SpanRecord,
  safeAttributes,
  type TelemetrySink,
  withSpan,
} from "./telemetry-contract";

/** A recording sink for the span-core tests (the app-facing one lives in @trevor/test-kit). */
function recordingSink(): { sink: TelemetrySink; spans: SpanRecord[] } {
  const spans: SpanRecord[] = [];
  return { sink: { span: (r) => spans.push(r) }, spans };
}

/** A deterministic clock: each read advances by `step` ms. */
function fakeClock(step = 5): () => number {
  let t = 1000;
  return () => {
    const v = t;
    t += step;
    return v;
  };
}

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

test("withSpan records an ok span with sanitized attributes and timing", async () => {
  const { sink, spans } = recordingSink();
  const result = await withSpan(
    sink,
    SPAN_NAMES.tool,
    { tool: "read", duration_hint: 3, prompt: "secret", file_path: "/Users/x/secret.txt" },
    async () => "value",
    fakeClock(),
  );
  assert.equal(result, "value");
  assert.equal(spans.length, 1);
  const [span] = spans;
  assert.equal(span?.name, SPAN_NAMES.tool);
  assert.equal(span?.status, "ok");
  assert.equal(span?.durationMs, 5, "timed via the injected clock");
  assert.deepEqual(span?.attributes, { tool: "read", duration_hint: 3 }, "prompt + path dropped");
});

test("withSpan records an error span (redacted) and re-throws", async () => {
  const { sink, spans } = recordingSink();
  await assert.rejects(
    withSpan(
      sink,
      SPAN_NAMES.providerAttempt,
      { provider: "lmstudio" },
      async () => {
        throw new Error("boom with key sk-abcdefgh12345678");
      },
      fakeClock(),
    ),
    /boom/,
  );
  const [span] = spans;
  assert.equal(span?.status, "error");
  assert.ok(span?.error?.includes(REDACTED), "the error message is redacted");
  assert.ok(!span?.error?.includes("sk-abcdefgh"), "no secret in the error span");
});

test("a throwing sink never propagates into the wrapped work (telemetry is best-effort)", async () => {
  const brokenSink: TelemetrySink = {
    span: () => {
      throw new Error("sink down");
    },
  };
  // The wrapped fn's value still returns even though the sink throws.
  assert.equal(await withSpan(brokenSink, SPAN_NAMES.turn, {}, async () => 42), 42);
});

test("NOOP_SINK accepts spans and emits nothing", () => {
  assert.doesNotThrow(() =>
    NOOP_SINK.span({ name: SPAN_NAMES.turn, attributes: {}, status: "ok", durationMs: 1 }),
  );
});
