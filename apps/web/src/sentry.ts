import { resolveTelemetryConfig, type TelemetryEnv } from "@trevor/session/telemetry";
import { type SanitizableSentryEvent, scrubSentryEvent } from "@trevor/session/telemetry-sentry";

/**
 * Browser Sentry ERROR-sink bootstrap (plan 13 M10). Mirrors the host's Node sink: opt-in + errors-only.
 * It initializes ONLY when `VITE_TREVOR_SENTRY_DSN` is configured (and `resolveTelemetryConfig` forces it
 * null under test/CI), with tracing / session-replay / profiling / logs all OFF, and every event scrubbed
 * by the shared {@link scrubSentryEvent} `beforeSend` - so a browser event never carries a prompt,
 * transcript body, artifact bytes, or a raw URL. The `@sentry/react` module is injected so this gating is
 * unit-tested without the SDK; `main.tsx` passes the real one.
 */

export interface BrowserSentryInitOptions {
  readonly dsn: string;
  readonly environment: string;
  /** The release tag (`VITE_TREVOR_RELEASE` / `SENTRY_RELEASE`) when configured, for issue grouping (M11). */
  readonly release?: string;
  readonly tracesSampleRate: 0;
  readonly replaysSessionSampleRate: 0;
  readonly replaysOnErrorSampleRate: 0;
  readonly profilesSampleRate: 0;
  readonly beforeSend: (event: SanitizableSentryEvent) => SanitizableSentryEvent | null;
}

/** The minimal `@sentry/react` surface the bootstrap drives (so it is testable without the SDK). */
export interface BrowserSentryApi {
  init(options: BrowserSentryInitOptions): void;
  captureException(error: unknown): void;
}

let captureFn: ((error: unknown) => void) | null = null;

/**
 * Initializes browser Sentry IFF a DSN is configured; returns whether it was enabled. When enabled, wires
 * {@link captureRenderCrash} so the React error boundary can report a render crash the global handler
 * would otherwise miss.
 */
export function bootstrapBrowserSentry(
  api: BrowserSentryApi,
  env: TelemetryEnv = import.meta.env,
): boolean {
  const config = resolveTelemetryConfig(env);
  if (config.webSentryDsn === null) {
    captureFn = null;
    return false;
  }
  const release = env.VITE_TREVOR_RELEASE ?? env.SENTRY_RELEASE;
  api.init({
    dsn: config.webSentryDsn,
    environment: env.MODE ?? env.NODE_ENV ?? "production",
    ...(release ? { release } : {}),
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    profilesSampleRate: 0,
    beforeSend: scrubSentryEvent,
  });
  captureFn = (error) => api.captureException(error);
  return true;
}

/** Reports a caught React render crash to Sentry when the browser sink is enabled; a no-op otherwise. */
export function captureRenderCrash(error: unknown): void {
  captureFn?.(error);
}
