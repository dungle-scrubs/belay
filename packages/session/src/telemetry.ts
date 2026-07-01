/**
 * The shared telemetry CONFIG contract (plan 13, M1). This module only PARSES environment into a
 * resolved {@link TelemetryConfig}; it initializes nothing (no OTel SDK, no Sentry) - runtime apps own
 * bootstrap (D-003). The defaults are the safe posture the plan requires (D-001/D-002): local/free,
 * nothing remote, no Sentry, no traces/logs/replays - a bare OSS checkout, tests, CI, and Storybook
 * emit nothing remote without explicit opt-in.
 *
 * Precedence + guards:
 * - `TREVOR_OTEL_EXPORTER` selects the LOCAL exporter (`none` default, `file`, or `otlp`). Whether an
 *   `otlp` endpoint may be non-loopback is gated later (M8); here it is only parsed.
 * - `TREVOR_TELEMETRY_REMOTE` is the master switch for ANY remote export; off by default.
 * - Node Sentry uses `TREVOR_SENTRY_DSN` (preferred) then `SENTRY_DSN`; web uses `VITE_TREVOR_SENTRY_DSN`.
 * - Under test/CI (`NODE_ENV=test`, `VITEST`, or `CI`) remote telemetry is FORCED off and both Sentry
 *   DSNs are dropped, so running the suite never emits anything remote regardless of the ambient env.
 */

// The shared observability contract (redaction, safe envelopes, span/metric names) is part of the same
// `@trevor/session/telemetry` surface as the config, so consumers reach both from one import.
export * from "./telemetry-contract";

export type OtelExporter = "none" | "file" | "otlp";

/** Why remote telemetry is force-disabled regardless of the configured env. */
export type TelemetrySuppressedReason = "test" | "ci";

export interface TelemetryConfig {
  /** The local OTel exporter: `none` emits nothing, `file` writes local artifacts, `otlp` targets a collector. */
  readonly otelExporter: OtelExporter;
  /** The master switch for ANY remote export (remote OTLP + Sentry). Off unless explicitly enabled and never on under test/CI. */
  readonly remoteEnabled: boolean;
  /** The Node (service) Sentry DSN for error capture, or null when unset or suppressed. */
  readonly sentryDsn: string | null;
  /** The web (browser) Sentry DSN for error capture, or null when unset or suppressed. */
  readonly webSentryDsn: string | null;
  /** Opt-in LOCAL provider-attempt JSONL tracing (`TREVOR_PROVIDER_TRACE`). Off by default; local-only
   *  (under `TREVOR_STATE_HOME`), so it is NOT force-disabled under test/CI - a test opts in explicitly. */
  readonly providerTrace: boolean;
  /** The OTLP collector endpoint (`TREVOR_OTEL_ENDPOINT`) when `otelExporter === "otlp"`, else null. A
   *  NON-loopback endpoint is only honored with `TREVOR_ALLOW_REMOTE_OTEL=1`; without it the exporter is
   *  downgraded to `none` (a bare checkout never ships traces to a remote collector by accident). */
  readonly otlpEndpoint: string | null;
  /** Why remote telemetry is force-disabled (`test`/`ci`), or null when not suppressed. */
  readonly suppressedReason: TelemetrySuppressedReason | null;
}

/** The env slice telemetry config reads (a subset of `process.env` / `import.meta.env`). */
export type TelemetryEnv = Record<string, string | undefined>;

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Whether an env value is an explicit truthy opt-in (`1`/`true`/`yes`/`on`, case-insensitive). */
function isTruthy(value: string | undefined): boolean {
  return value !== undefined && TRUTHY.has(value.trim().toLowerCase());
}

/** A trimmed non-empty string, or null - so blank env vars read as "unset" rather than an empty DSN. */
function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Whether telemetry is running under a test or CI environment, where remote export must be forced off
 * so the suite / OSS checkout never emits anything remote. Returns the reason, or null when neither.
 */
export function telemetrySuppressedReason(env: TelemetryEnv): TelemetrySuppressedReason | null {
  if (env.NODE_ENV === "test" || isTruthy(env.VITEST)) {
    return "test";
  }
  if (isTruthy(env.CI)) {
    return "ci";
  }
  return null;
}

/** Parses `TREVOR_OTEL_EXPORTER` into the local exporter mode; anything unrecognized falls back to `none`. */
function parseExporter(value: string | undefined): OtelExporter {
  const mode = value?.trim().toLowerCase();
  return mode === "file" || mode === "otlp" ? mode : "none";
}

/** Whether an OTLP endpoint targets this machine (loopback), so it needs no remote-export opt-in. */
export function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Resolves the telemetry configuration from `env` (defaults to `process.env`). Pure over its input, so
 * both service processes and the browser bootstrap resolve identically and the parsing is unit-testable.
 */
export function resolveTelemetryConfig(env: TelemetryEnv = process.env): TelemetryConfig {
  const suppressedReason = telemetrySuppressedReason(env);
  const suppressed = suppressedReason !== null;
  const requestedExporter = parseExporter(env.TREVOR_OTEL_EXPORTER);
  const otlpEndpoint = nonEmpty(env.TREVOR_OTEL_ENDPOINT);
  // A remote (non-loopback) OTLP endpoint is only honored with an explicit opt-in, and never under
  // test/CI - otherwise the exporter is downgraded to `none` so nothing is shipped to a remote collector.
  const otlpRemoteBlocked =
    requestedExporter === "otlp" &&
    otlpEndpoint !== null &&
    !isLoopbackEndpoint(otlpEndpoint) &&
    !(!suppressed && isTruthy(env.TREVOR_ALLOW_REMOTE_OTEL));
  const otelExporter: OtelExporter = otlpRemoteBlocked ? "none" : requestedExporter;
  return {
    otelExporter,
    otlpEndpoint: otelExporter === "otlp" ? otlpEndpoint : null,
    // Remote is off by default and can never be on under test/CI.
    remoteEnabled: !suppressed && isTruthy(env.TREVOR_TELEMETRY_REMOTE),
    // Sentry opts in via a DSN, but test/CI drops it so the suite never reports remotely.
    sentryDsn: suppressed ? null : nonEmpty(env.TREVOR_SENTRY_DSN ?? env.SENTRY_DSN),
    webSentryDsn: suppressed ? null : nonEmpty(env.VITE_TREVOR_SENTRY_DSN),
    // Provider tracing is local-only, so it opts in regardless of the test/CI remote guard.
    providerTrace: isTruthy(env.TREVOR_PROVIDER_TRACE),
    suppressedReason,
  };
}
