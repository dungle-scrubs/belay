import { join } from "node:path";
import { storagePathByName } from "./node-paths";
import { resolveTelemetryConfig, type TelemetryEnv } from "./telemetry";
import {
  type MetricRecord,
  NOOP_SINK,
  type SpanRecord,
  type TelemetryService,
  type TelemetrySink,
} from "./telemetry-contract";
import { createCappedJsonlWriter } from "./telemetry-jsonl";

/**
 * The local FILE telemetry exporter (plan 13 M5). When `BELAY_OTEL_EXPORTER=file`, a service installs
 * this sink and its spans + metrics are appended as one JSON object per line to
 * `BELAY_STATE_HOME/otel/<service>.jsonl`. This is the free, no-network baseline (escape hatch: local
 * JSONL first, an OTel SDK exporter later) - so a trace is inspectable with `tail -f` and no collector.
 *
 * Node-only (fs) and reached through the `@belay/session/telemetry-file-sink` subpath, so it never
 * bundles into the browser. Best-effort by construction: it is BOUNDED by a byte cap (writes past the cap
 * are DROPPED, not rotated, and counted), and every write is guarded so a full disk or a permission error
 * can never fail a user turn. The records it writes are already redacted by `safeAttributes` at the
 * instrumentation boundary; this sink adds no raw content.
 */

export interface FileSinkOptions {
  /** The emitting service (the JSONL file basename + a `service` field on every record). */
  readonly service: TelemetryService;
  /** Byte cap for the JSONL file; writes past it are dropped + counted. Default 8 MiB. */
  readonly maxBytes?: number;
  /** Override the otel dir (tests); defaults to the state-home `otel` inventory path. */
  readonly dir?: string;
  /** Injectable clock for the record timestamp (tests). */
  readonly now?: () => number;
}

/** Best-effort export counters, surfaced by /doctor (M7). */
export interface FileSinkStats {
  readonly written: number;
  readonly dropped: number;
  readonly path: string;
}

export interface FileSink extends TelemetrySink {
  stats(): FileSinkStats;
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export function createFileSink(opts: FileSinkOptions): FileSink {
  const dir = opts.dir ?? storagePathByName("otel");
  const path = join(dir, `${opts.service}.jsonl`);
  const writer = createCappedJsonlWriter({
    path,
    dir,
    maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
    now: opts.now ?? Date.now,
  });
  return {
    // `t` discriminates the record TYPE (span vs metric); a metric's own `kind` (counter/histogram) is
    // preserved by the spread, so the two must not share a field name.
    span: (record: SpanRecord) => writer.append({ t: "span", service: opts.service, ...record }),
    metric: (record: MetricRecord) =>
      writer.append({ t: "metric", service: opts.service, ...record }),
    stats: () => ({ ...writer.stats(), path }),
  };
}

/**
 * Builds the telemetry sink a Node service installs at startup, per {@link resolveTelemetryConfig}: a
 * {@link createFileSink} when `BELAY_OTEL_EXPORTER=file`, otherwise the {@link NOOP_SINK} (the disabled
 * default, and the placeholder for the not-yet-wired `otlp` exporter - M8). The one place a service turns
 * its config into a concrete sink, so instrumentation stays exporter-agnostic.
 */
export function createTelemetrySink(
  service: TelemetryService,
  opts: { readonly env?: TelemetryEnv; readonly dir?: string; readonly maxBytes?: number } = {},
): TelemetrySink & { readonly stats?: () => FileSinkStats } {
  const config = resolveTelemetryConfig(opts.env);
  if (config.otelExporter === "file") {
    return createFileSink({
      service,
      ...(opts.dir !== undefined ? { dir: opts.dir } : {}),
      ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
    });
  }
  return NOOP_SINK;
}
