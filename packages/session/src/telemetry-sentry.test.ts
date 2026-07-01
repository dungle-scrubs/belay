import assert from "node:assert/strict";
import { test } from "vitest";
import { REDACTED } from "./telemetry-contract";
import { type SanitizableSentryEvent, scrubSentryEvent } from "./telemetry-sentry";

/**
 * The Sentry beforeSend scrubber (plan 13 M9/M10): even when Sentry is configured, prompt text, tool
 * output, env values, auth headers, raw provider bodies, and raw paths must never reach it.
 */

test("scrubSentryEvent drops the request (auth headers + body) entirely", () => {
  const scrubbed = scrubSentryEvent({
    message: "boom",
    request: {
      url: "https://api.example.com/v1?token=deadbeefcafe",
      headers: { authorization: "Bearer sk-abcdefgh12345678" },
      cookies: "session=abc",
      data: { prompt: "the user's secret" },
    },
  });
  assert.equal(scrubbed.request, undefined, "the whole request block is dropped");
});

test("scrubSentryEvent strips sensitive/high-cardinality keys from extra/tags/contexts", () => {
  const scrubbed = scrubSentryEvent({
    extra: {
      provider: "lmstudio",
      attempts: 3,
      prompt: "secret prompt",
      tool_output: "big output",
      session_id: "s-1",
      cwd: "/Users/x/secret",
    },
    tags: { model: "qwen", run_id: "r-1" },
    contexts: { turn: { provider: "lmstudio", command: "rm -rf /" } },
  });
  assert.deepEqual(scrubbed.extra, { provider: "lmstudio", attempts: 3 });
  assert.deepEqual(scrubbed.tags, { model: "qwen" });
  assert.deepEqual(scrubbed.contexts?.turn, { provider: "lmstudio" });
});

test("scrubSentryEvent secret-redacts the message, exception values, and breadcrumbs", () => {
  const scrubbed = scrubSentryEvent({
    message: "failed with key sk-abcdefgh12345678",
    exception: { values: [{ type: "Error", value: "auth failed: Bearer sk-abcdefgh12345678" }] },
    breadcrumbs: [{ message: "loaded /Users/kevin/dev/secret.ts", data: { prompt: "x", ok: 1 } }],
  });
  assert.ok(!scrubbed.message?.includes("sk-abcdefgh"), "message secret redacted");
  assert.ok(scrubbed.message?.includes(REDACTED));
  assert.ok(
    !scrubbed.exception?.values?.[0]?.value?.includes("sk-abcdefgh"),
    "exception value redacted",
  );
  const crumb = scrubbed.breadcrumbs?.[0];
  assert.ok(!crumb?.message?.includes("/Users/kevin"), "breadcrumb path collapsed");
  assert.deepEqual(crumb?.data, { ok: 1 }, "breadcrumb prompt dropped, benign kept");
});

test("a minimal event passes through unchanged except for the always-dropped request", () => {
  const event: SanitizableSentryEvent = {
    exception: { values: [{ type: "Error", value: "plain" }] },
  };
  const scrubbed = scrubSentryEvent(event);
  assert.equal(scrubbed.exception?.values?.[0]?.value, "plain");
  assert.equal(scrubbed.request, undefined);
});
