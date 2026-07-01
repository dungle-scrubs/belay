import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { METRIC_NAMES, SPAN_NAMES } from "./telemetry-contract";
import { createFileSink, createTelemetrySink } from "./telemetry-file-sink";

/**
 * The local file exporter (plan 13 M5): TREVOR_OTEL_EXPORTER=file appends bounded JSONL spans + metrics
 * under the otel dir, best-effort, with a byte cap that drops (and counts) writes past it.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trevor-otel-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readLines(service: string): Array<Record<string, unknown>> {
  const raw = readFileSync(join(dir, `${service}.jsonl`), "utf8").trim();
  return raw ? raw.split("\n").map((line) => JSON.parse(line)) : [];
}

test("file sink appends one JSON line per span/metric, tagged with kind + service + timestamp", () => {
  const sink = createFileSink({ service: "agent-host", dir, now: () => 1_700_000_000_000 });
  sink.span({
    name: SPAN_NAMES.turn,
    attributes: { provider: "lmstudio" },
    status: "ok",
    durationMs: 42,
  });
  sink.metric({
    name: METRIC_NAMES.turnDuration,
    value: 42,
    kind: "histogram",
    labels: { model: "q" },
  });

  const lines = readLines("agent-host");
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.t, "span");
  assert.equal(lines[0]?.name, SPAN_NAMES.turn);
  assert.equal(lines[0]?.service, "agent-host");
  assert.equal(lines[0]?.at, "2023-11-14T22:13:20.000Z");
  assert.equal(lines[1]?.t, "metric");
  assert.equal(lines[1]?.kind, "histogram", "a metric's own counter/histogram kind is preserved");
  assert.equal(lines[1]?.value, 42);
  assert.deepEqual(sink.stats(), { written: 2, dropped: 0, path: join(dir, "agent-host.jsonl") });
});

test("writes past the byte cap are dropped and counted, never throwing", () => {
  const sink = createFileSink({ service: "blob-store", dir, maxBytes: 200 });
  // Each span line is > 40 bytes; a handful exceeds the 200-byte cap.
  for (let i = 0; i < 20; i++) {
    sink.span({
      name: SPAN_NAMES.blobIo,
      attributes: { op: "put", i },
      status: "ok",
      durationMs: i,
    });
  }
  const stats = sink.stats();
  assert.ok(stats.written >= 1, "some spans are written before the cap");
  assert.ok(stats.dropped >= 1, "the rest are dropped, not written");
  assert.equal(stats.written + stats.dropped, 20, "every write is accounted for");
});

test("createTelemetrySink honors the config: file exporter writes, everything else is NOOP", () => {
  const fileSink = createTelemetrySink("agent-host", {
    env: { NODE_ENV: "production", TREVOR_OTEL_EXPORTER: "file" },
    dir,
  });
  fileSink.span({ name: SPAN_NAMES.turn, attributes: {}, status: "ok", durationMs: 1 });
  assert.equal(readLines("agent-host").length, 1, "the file sink actually writes");

  // Default (no exporter) is a NOOP sink: it emits nothing, and there is no otel file for it.
  const noop = createTelemetrySink("blob-store", { env: { NODE_ENV: "production" }, dir });
  noop.span({ name: SPAN_NAMES.blobIo, attributes: {}, status: "ok", durationMs: 1 });
  assert.throws(() => readLines("blob-store"), "the NOOP sink writes no file");
});

test("a broken directory never fails the caller (best-effort)", () => {
  // Put a FILE where the sink needs a directory, so mkdir fails with ENOTDIR - the sink must swallow it.
  writeFileSync(join(dir, "blocker"), "x");
  const sink = createFileSink({ service: "session-store", dir: join(dir, "blocker", "sub") });
  assert.doesNotThrow(() =>
    sink.span({ name: SPAN_NAMES.storeAppend, attributes: {}, status: "ok", durationMs: 1 }),
  );
  assert.ok(sink.stats().dropped >= 1, "the failed write is counted as a drop");
});
