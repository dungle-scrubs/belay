import assert from "node:assert/strict";
import { test } from "vitest";
import { storagePathByName } from "./node-paths";
import { resolveTelemetryConfig, telemetrySuppressedReason } from "./telemetry";

/**
 * Telemetry config defaults + parsing (plan 13 M1): the safe posture is local/free with nothing remote,
 * no Sentry, and a hard test/CI guard so the suite never emits remotely. Plus the state-root correction:
 * detached service logs resolve under TREVOR_STATE_HOME, not TREVOR_HOME.
 */

// A non-suppressed base env (no NODE_ENV=test / VITEST / CI) so opt-ins are observable in these tests.
const BASE = { NODE_ENV: "production" } as const;

test("the default telemetry config is fully local: nothing remote, no Sentry, no exporter", () => {
  const config = resolveTelemetryConfig({ ...BASE });
  assert.deepEqual(config, {
    otelExporter: "none",
    otlpEndpoint: null,
    remoteEnabled: false,
    sentryDsn: null,
    webSentryDsn: null,
    providerTrace: false,
    suppressedReason: null,
  });
});

test("a loopback OTLP endpoint is honored, but a remote one needs TREVOR_ALLOW_REMOTE_OTEL", () => {
  const loopback = resolveTelemetryConfig({
    ...BASE,
    TREVOR_OTEL_EXPORTER: "otlp",
    TREVOR_OTEL_ENDPOINT: "http://localhost:4318",
  });
  assert.equal(loopback.otelExporter, "otlp");
  assert.equal(loopback.otlpEndpoint, "http://localhost:4318");

  // A NON-loopback endpoint without the opt-in is downgraded to none (never ships remotely by accident).
  const blocked = resolveTelemetryConfig({
    ...BASE,
    TREVOR_OTEL_EXPORTER: "otlp",
    TREVOR_OTEL_ENDPOINT: "https://collector.example.com",
  });
  assert.equal(blocked.otelExporter, "none", "a remote OTLP endpoint is refused without opt-in");
  assert.equal(blocked.otlpEndpoint, null);

  // With the explicit opt-in, the remote endpoint is honored.
  const allowed = resolveTelemetryConfig({
    ...BASE,
    TREVOR_OTEL_EXPORTER: "otlp",
    TREVOR_OTEL_ENDPOINT: "https://collector.example.com",
    TREVOR_ALLOW_REMOTE_OTEL: "1",
  });
  assert.equal(allowed.otelExporter, "otlp");
  assert.equal(allowed.otlpEndpoint, "https://collector.example.com");
});

test("even with the opt-in, a remote OTLP endpoint is refused under test/CI", () => {
  const config = resolveTelemetryConfig({
    NODE_ENV: "test",
    TREVOR_OTEL_EXPORTER: "otlp",
    TREVOR_OTEL_ENDPOINT: "https://collector.example.com",
    TREVOR_ALLOW_REMOTE_OTEL: "1",
  });
  assert.equal(config.otelExporter, "none", "the suite never ships to a remote collector");
});

test("provider tracing is opt-in via TREVOR_PROVIDER_TRACE and local-only (on even under test/CI)", () => {
  assert.equal(resolveTelemetryConfig({ ...BASE }).providerTrace, false);
  assert.equal(resolveTelemetryConfig({ ...BASE, TREVOR_PROVIDER_TRACE: "1" }).providerTrace, true);
  // It is a LOCAL trace, so the test/CI remote guard does not force it off.
  assert.equal(
    resolveTelemetryConfig({ NODE_ENV: "test", TREVOR_PROVIDER_TRACE: "true" }).providerTrace,
    true,
  );
});

test("TREVOR_OTEL_EXPORTER selects the local exporter; unknown values fall back to none", () => {
  assert.equal(
    resolveTelemetryConfig({ ...BASE, TREVOR_OTEL_EXPORTER: "file" }).otelExporter,
    "file",
  );
  assert.equal(
    resolveTelemetryConfig({ ...BASE, TREVOR_OTEL_EXPORTER: "OTLP" }).otelExporter,
    "otlp",
  );
  assert.equal(
    resolveTelemetryConfig({ ...BASE, TREVOR_OTEL_EXPORTER: "sentry" }).otelExporter,
    "none",
    "an unrecognized exporter is never silently remote",
  );
});

test("remote telemetry is opt-in via TREVOR_TELEMETRY_REMOTE and off by default", () => {
  assert.equal(resolveTelemetryConfig({ ...BASE }).remoteEnabled, false);
  assert.equal(
    resolveTelemetryConfig({ ...BASE, TREVOR_TELEMETRY_REMOTE: "1" }).remoteEnabled,
    true,
  );
  assert.equal(
    resolveTelemetryConfig({ ...BASE, TREVOR_TELEMETRY_REMOTE: "true" }).remoteEnabled,
    true,
  );
  assert.equal(
    resolveTelemetryConfig({ ...BASE, TREVOR_TELEMETRY_REMOTE: "0" }).remoteEnabled,
    false,
  );
});

test("Node Sentry DSN prefers TREVOR_SENTRY_DSN over SENTRY_DSN; web uses its own var", () => {
  assert.equal(
    resolveTelemetryConfig({
      ...BASE,
      TREVOR_SENTRY_DSN: "https://a@x/1",
      SENTRY_DSN: "https://b@x/2",
    }).sentryDsn,
    "https://a@x/1",
  );
  assert.equal(
    resolveTelemetryConfig({ ...BASE, SENTRY_DSN: "https://b@x/2" }).sentryDsn,
    "https://b@x/2",
  );
  assert.equal(
    resolveTelemetryConfig({ ...BASE, VITE_TREVOR_SENTRY_DSN: "https://w@x/3" }).webSentryDsn,
    "https://w@x/3",
  );
  // A blank DSN reads as unset, not an empty-string DSN that would try to init Sentry.
  assert.equal(resolveTelemetryConfig({ ...BASE, TREVOR_SENTRY_DSN: "  " }).sentryDsn, null);
});

test("test/CI forces remote off and drops both Sentry DSNs even when explicitly configured", () => {
  for (const env of [{ NODE_ENV: "test" }, { VITEST: "true" }, { CI: "1" }] as const) {
    const config = resolveTelemetryConfig({
      ...env,
      TREVOR_TELEMETRY_REMOTE: "1",
      TREVOR_SENTRY_DSN: "https://a@x/1",
      VITE_TREVOR_SENTRY_DSN: "https://w@x/3",
    });
    assert.equal(config.remoteEnabled, false, "no remote under test/CI");
    assert.equal(config.sentryDsn, null, "node Sentry dropped under test/CI");
    assert.equal(config.webSentryDsn, null, "web Sentry dropped under test/CI");
    assert.ok(config.suppressedReason, "the suppression reason is surfaced");
  }
});

test("telemetrySuppressedReason names the guard: test before ci, else null", () => {
  assert.equal(telemetrySuppressedReason({ NODE_ENV: "test" }), "test");
  assert.equal(telemetrySuppressedReason({ VITEST: "1" }), "test");
  assert.equal(telemetrySuppressedReason({ CI: "true" }), "ci");
  assert.equal(telemetrySuppressedReason({ NODE_ENV: "production" }), null);
});

test("detached service logs resolve under TREVOR_STATE_HOME/logs, not TREVOR_HOME/logs (D-004)", () => {
  const env = { TREVOR_STATE_HOME: "/state", TREVOR_HOME: "/config" };
  const logs = storagePathByName("logs", env, "/home");
  assert.equal(logs, "/state/logs", "logs are machine-local runtime state under the state home");
  assert.ok(!logs.startsWith("/config"), "logs never resolve under the config home");
});
