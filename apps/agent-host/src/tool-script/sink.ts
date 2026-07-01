import { NOOP_SINK, type TelemetrySink } from "@trevor/session/telemetry";

/**
 * The telemetry-sink registration seam for `tool_script` observability (plan 16, M8). The tool is a static
 * registry entry built before the host's telemetry sink exists, so main.ts registers the live sink here at
 * startup and the tool reads it at CALL time. Mirrors `doctor/source.ts`: a tiny leaf module so the tool can
 * emit its span without importing the host's telemetry bootstrap. Defaults to NOOP (no telemetry).
 */

let sink: TelemetrySink = NOOP_SINK;

/** Wires the host telemetry sink (called once by main.ts at startup). */
export function registerToolScriptSink(next: TelemetrySink): void {
  sink = next;
}

/** The current tool_script telemetry sink (NOOP until the host registers one). */
export function toolScriptSink(): TelemetrySink {
  return sink;
}
