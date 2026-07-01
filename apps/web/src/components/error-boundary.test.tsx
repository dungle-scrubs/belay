import { render, screen } from "@testing-library/react";
import { SPAN_NAMES } from "@trevor/session/telemetry";
import { recordingTelemetrySink } from "@trevor/test-kit";
import { assert, test, vi } from "vitest";
import { TelemetryErrorBoundary } from "./error-boundary";

/**
 * The React render-crash boundary (plan 13 M4): a child crash is caught, shows a fallback, and records a
 * redacted trevor.web.render error span - never the component tree, props, or a secret in the message.
 */

function Boom(): never {
  throw new Error("render crashed with key sk-abcdefgh12345678");
}

test("a render crash shows the fallback and records a redacted web.render error span", () => {
  const recorder = recordingTelemetrySink();
  // React logs the caught error to console.error; silence it for a clean test run.
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    render(
      <TelemetryErrorBoundary sink={recorder.sink} fallback={<div>fallback shown</div>}>
        <Boom />
      </TelemetryErrorBoundary>,
    );
  } finally {
    spy.mockRestore();
  }

  assert.ok(screen.getByText("fallback shown"), "the fallback renders instead of a blank screen");
  const [span] = recorder.named(SPAN_NAMES.webRender);
  assert.ok(span, "a render-crash span was recorded");
  assert.equal(span?.status, "error");
  assert.ok(span?.error?.includes("render crashed"), "the message is captured");
  assert.ok(!span?.error?.includes("sk-abcdefgh"), "a secret in the message is redacted");
});

test("no crash renders children and records nothing", () => {
  const recorder = recordingTelemetrySink();
  render(
    <TelemetryErrorBoundary sink={recorder.sink}>
      <div>all good</div>
    </TelemetryErrorBoundary>,
  );
  assert.ok(screen.getByText("all good"));
  assert.equal(recorder.spans.length, 0, "a healthy render emits no span");
});
