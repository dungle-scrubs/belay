import assert from "node:assert/strict";
import { SPAN_NAMES } from "@belay/session/telemetry";
import { recordingTelemetrySink } from "@belay/test-kit";
import { Effect } from "effect";
import { test } from "vitest";
import { spanEffect } from "./span";

/**
 * The host's Effect span combinator (plan 13 M3): times an effect and pushes one span on completion -
 * ok on success, error (redacted) on failure, and an `interrupted`-tagged error on cancellation.
 */

test("spanEffect records an ok span with sanitized attributes on success", async () => {
  const recorder = recordingTelemetrySink();
  const value = await Effect.runPromise(
    Effect.succeed(7).pipe(
      spanEffect(recorder.sink, SPAN_NAMES.tool, { tool: "read", prompt: "x" }),
    ),
  );
  assert.equal(value, 7);
  const [span] = recorder.named(SPAN_NAMES.tool);
  assert.equal(span?.status, "ok");
  assert.deepEqual(span?.attributes, { tool: "read" }, "the disallowed prompt attr is dropped");
});

test("spanEffect records a redacted error span on failure and preserves the failure", async () => {
  const recorder = recordingTelemetrySink();
  await assert.rejects(
    Effect.runPromise(
      Effect.fail(new Error("kaboom with key sk-abcdefgh12345678")).pipe(
        spanEffect(recorder.sink, SPAN_NAMES.providerAttempt, { provider: "lmstudio" }),
      ),
    ),
  );
  const [span] = recorder.named(SPAN_NAMES.providerAttempt);
  assert.equal(span?.status, "error");
  assert.ok(span?.error?.includes("kaboom"), "the failure cause is summarized");
  assert.ok(!span?.error?.includes("sk-abcdefgh"), "the error span is secret-redacted");
});

test("spanEffect records an interrupted error span on cancellation", async () => {
  const recorder = recordingTelemetrySink();
  await Effect.runPromise(
    Effect.interrupt.pipe(
      spanEffect(recorder.sink, SPAN_NAMES.tool, { tool: "read" }),
      Effect.exit,
    ),
  );
  const [span] = recorder.named(SPAN_NAMES.tool);
  assert.equal(span?.status, "error");
  assert.equal(span?.error, "interrupted", "a cancelled boundary is observable, not silent");
});
