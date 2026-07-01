import { appendFileSync, mkdirSync, statSync } from "node:fs";
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

/**
 * The local FILE telemetry exporter (plan 13 M5). When `TREVOR_OTEL_EXPORTER=file`, a service installs
 * this sink and its spans + metrics are appended as one JSON object per line to
 * `TREVOR_STATE_HOME/otel/<service>.jsonl`. This is the free, no-network baseline (escape hatch: local
 * JSONL first, an OTel SDK exporter later) - so a trace is inspectable with `tail -f` and no collector.
 *
 * Node-only (fs) and reached through the `@trevor/session/telemetry-file-sink` subpath, so it never
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
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = opts.now ?? Date.now;
  const path = join(dir, `${opts.service}.jsonl`);
  let written = 0;
  let dropped = 0;
  let dirReady = false;
  // Track the file size in-process so the cap check is a comparison, not a stat per write. Seed from the
  // existing file (a prior run's artifacts count toward the cap) and grow by each written line's length.
  let bytes = currentSize(path);

  const append = (record: object): void => {
    let line = "";
    try {
      line = `${JSON.stringify({ ...record, service: opts.service, at: new Date(now()).toISOString() })}\n`;
    } catch {
      dropped += 1;
      return;
    }
    if (bytes + line.length > maxBytes) {
      dropped += 1;
      return;
    }
    try {
      if (!dirReady) {
        mkdirSync(dir, { recursive: true });
        dirReady = true;
      }
      appendFileSync(path, line);
      bytes += line.length;
      written += 1;
    } catch {
      // A telemetry write failure (full disk, permissions) must never fail user work.
      dropped += 1;
    }
  };

  return {
    // `t` discriminates the record TYPE (span vs metric); a metric's own `kind` (counter/histogram) is
    // preserved by the spread, so the two must not share a field name.
    span: (record: SpanRecord) => append({ t: "span", ...record }),
    metric: (record: MetricRecord) => append({ t: "metric", ...record }),
    stats: () => ({ written, dropped, path }),
  };
}

/** The current size of `path` in bytes, or 0 when it does not exist yet. */
function currentSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Builds the telemetry sink a Node service installs at startup, per {@link resolveTelemetryConfig}: a
 * {@link createFileSink} when `TREVOR_OTEL_EXPORTER=file`, otherwise the {@link NOOP_SINK} (the disabled
 * default, and the placeholder for the not-yet-wired `otlp` exporter - M8). The one place a service turns
 * its config into a concrete sink, so instrumentation stays exporter-agnostic.
 */
export function createTelemetrySink(
  service: TelemetryService,
  opts: { readonly env?: TelemetryEnv; readonly dir?: string; readonly maxBytes?: number } = {},
): TelemetrySink {
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
