import {
  NOOP_SINK,
  resolveTelemetryConfig,
  type TelemetryConfig,
  type TelemetrySink,
} from "@trevor/session/telemetry";

/**
 * The browser telemetry bootstrap (plan 13 M4). The web app resolves its telemetry config from Vite env
 * and holds ONE process-wide sink that instrumentation reads via {@link telemetrySink}. Today the browser
 * runs in disabled/local mode: the sink is always {@link NOOP_SINK} (nothing is emitted), so a bare OSS
 * checkout and every test stay silent. The bootstrap is the SEAM a later local exporter (M5) or a browser
 * Sentry error sink (M10) plugs into; instrumentation never touches an exporter, only the sink. Browser
 * spans must never carry prompt/transcript/artifact bytes - they pass through the shared `safeAttributes`.
 */

let sink: TelemetrySink = NOOP_SINK;
let config: TelemetryConfig = resolveTelemetryConfig({});

/** The active browser telemetry sink (NOOP until an exporter is wired). */
export function telemetrySink(): TelemetrySink {
  return sink;
}

/** The resolved browser telemetry config, for the /doctor telemetry surface (M7). */
export function telemetryConfig(): TelemetryConfig {
  return config;
}

/**
 * Resolves the telemetry config from Vite env and installs the browser sink. Called once at app startup.
 * In disabled/local mode (the only mode today) the sink stays NOOP; a future exporter is selected here.
 */
export function bootstrapTelemetry(
  env: Record<string, string | undefined> = import.meta.env,
): TelemetrySink {
  config = resolveTelemetryConfig(env);
  // Local/remote exporters are not wired in the browser yet (M5/M10); disabled mode = NOOP.
  sink = NOOP_SINK;
  return sink;
}
