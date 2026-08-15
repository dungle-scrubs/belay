import { SPAN_NAMES } from "@belay/session/telemetry";
import { recordingTelemetrySink } from "@belay/test-kit";
import { assert, test } from "vitest";
import { uploadArtifact } from "./blob";
import { bootstrapTelemetry, telemetryConfig, telemetrySink } from "./telemetry";

/**
 * Browser telemetry bootstrap + artifact-upload span (plan 13 M4). The bootstrap resolves config and
 * installs a (currently NOOP) sink; the upload span carries the artifact kind + size only, never the
 * file name or bytes.
 */

test("bootstrapTelemetry resolves config and installs a sink (disabled/local -> NOOP)", () => {
  const sink = bootstrapTelemetry({ NODE_ENV: "production" });
  assert.equal(typeof sink.span, "function");
  assert.equal(telemetrySink(), sink, "the installed sink is the active one");
  // Under a test/CI env, remote telemetry is force-off.
  assert.equal(
    bootstrapTelemetry({ VITEST: "true", TREVOR_SENTRY_DSN: "https://x@y/1" }) &&
      telemetryConfig().sentryDsn,
    null,
  );
});

test("uploadArtifact emits a belay.blob.io upload span with kind + size, never the file name", async () => {
  const recorder = recordingTelemetrySink();
  const file = new File([new Uint8Array([1, 2, 3, 4])], "my-secret-diagram.png", {
    type: "image/png",
  });
  // The span is recorded whether or not the store is reachable - ignore the upload outcome here.
  await uploadArtifact(file, recorder.sink).catch(() => {});

  const [span] = recorder.named(SPAN_NAMES.blobIo);
  assert.ok(span, "an upload span was recorded");
  assert.equal(span?.attributes.op, "upload");
  assert.equal(span?.attributes.kind, "image");
  assert.equal(typeof span?.attributes.bytes, "number");
  assert.ok(
    !JSON.stringify(span).includes("my-secret-diagram"),
    "the file name never enters the span",
  );
});
