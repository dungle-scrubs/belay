import { resolveTelemetryConfig, type TelemetryEnv } from "@trevor/session/telemetry";
import { type SanitizableSentryEvent, scrubSentryEvent } from "@trevor/session/telemetry-sentry";

/**
 * Node Sentry ERROR-sink bootstrap (plan 13 M9). App-owned (D-003): the package defines the privacy
 * contract, the app calls `Sentry.init` here. It is OPT-IN and ERROR-ONLY:
 * - it initializes ONLY when a DSN is configured (and `resolveTelemetryConfig` already forces the DSN to
 *   null under test/CI), so a bare checkout + the suite never report to Sentry;
 * - tracing / profiling / replay / logs / metrics are OFF (errors only, per D-002 cost control);
 * - every event passes through {@link scrubSentryEvent} `beforeSend`, so no prompt/tool-output/env/auth/
 *   path/provider-body can reach Sentry.
 *
 * The concrete `@sentry/node` module is injected (see {@link SentryApi}) so this gating + option shape is
 * unit-tested without the SDK, and `main.ts` passes the real one.
 *
 * Responsible for: opt-in, error-only Node Sentry initialization (DSN-gated, scrubbed beforeSend).
 * Not for: the scrubbing rules - @trevor/session/telemetry-sentry.
 */

/** The minimal `@sentry/node` surface the bootstrap drives (so it is testable without the SDK). */
export interface SentryApi {
  init(options: SentryInitOptions): void;
}

/** The error-only init options the bootstrap builds (a subset of `Sentry.NodeOptions`). */
export interface SentryInitOptions {
  readonly dsn: string;
  readonly environment: string;
  /** The release tag (`SENTRY_RELEASE` / package version) when configured, for issue grouping (M11). */
  readonly release?: string;
  /** 0 = no performance tracing (errors only). */
  readonly tracesSampleRate: 0;
  /** 0 = no profiling. */
  readonly profilesSampleRate: 0;
  /** Errors-only: no structured-log capture. */
  readonly enableLogs: false;
  readonly beforeSend: (event: SanitizableSentryEvent) => SanitizableSentryEvent | null;
}

/**
 * Initializes Node Sentry IFF a DSN is configured. Returns whether it was enabled, so the caller can log
 * the posture. A no-op (returns false) with no DSN - the default.
 */
export function bootstrapNodeSentry(api: SentryApi, env: TelemetryEnv = process.env): boolean {
  const config = resolveTelemetryConfig(env);
  if (config.sentryDsn === null) {
    return false;
  }
  const release = env.SENTRY_RELEASE ?? env.npm_package_version;
  api.init({
    dsn: config.sentryDsn,
    environment: env.NODE_ENV ?? "production",
    ...(release ? { release } : {}),
    tracesSampleRate: 0,
    profilesSampleRate: 0,
    enableLogs: false,
    beforeSend: scrubSentryEvent,
  });
  return true;
}
