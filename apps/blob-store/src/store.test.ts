import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METRIC_NAMES, SPAN_NAMES } from "@trevor/session/telemetry";
import { recordingTelemetrySink } from "@trevor/test-kit";
import { afterEach, beforeEach, test } from "vitest";
import { BlobStore, HEX64 } from "./store";

let dir: string;
let store: BlobStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "blob-store-test-"));
  store = new BlobStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("put returns a stable sha256 and round-trips bytes + mime", async () => {
  const bytes = new TextEncoder().encode("hello artifact");
  const stored = await store.put(bytes, "text/plain");
  assert.match(stored.hash, HEX64);
  assert.equal(stored.hash, store.hashOf(bytes));
  assert.equal(stored.size, bytes.byteLength);
  assert.equal(stored.mimeType, "text/plain");
  assert.equal(stored.deduped, false);

  const got = await store.get(stored.hash);
  assert.ok(got);
  assert.deepEqual(new Uint8Array(got.bytes), bytes);
  assert.equal(got.meta.mimeType, "text/plain");
  assert.equal(got.meta.size, bytes.byteLength);
});

test("identical bytes dedupe to one stored object", async () => {
  const bytes = new TextEncoder().encode("same content");
  const a = await store.put(bytes, "text/plain");
  const b = await store.put(bytes, "text/plain");
  assert.equal(a.hash, b.hash);
  assert.equal(a.deduped, false);
  assert.equal(b.deduped, true);
});

test("get and head reject malformed hashes and missing blobs", async () => {
  assert.equal(await store.get("not-a-hash"), null);
  assert.equal(await store.head("deadbeef"), null);
  assert.equal(await store.get("a".repeat(64)), null);
  assert.equal(await store.head("a".repeat(64)), null);
});

test("head returns meta without bytes", async () => {
  const bytes = new TextEncoder().encode("png");
  const { hash } = await store.put(bytes, "image/png");
  const meta = await store.head(hash);
  assert.ok(meta);
  assert.equal(meta.mimeType, "image/png");
  assert.equal(meta.size, 3);
});

test("blob IO emits an ok span per op (put/get/head) carrying no hash, path, or bytes", async () => {
  const recorder = recordingTelemetrySink();
  const instrumented = new BlobStore(dir, recorder.sink);
  const bytes = new TextEncoder().encode("telemetry blob");
  const { hash } = await instrumented.put(bytes, "text/plain");
  await instrumented.get(hash);
  await instrumented.head(hash);
  await instrumented.get("a".repeat(64)); // a miss is still an ok span, not an error

  const spans = recorder.named(SPAN_NAMES.blobIo);
  assert.equal(spans.length, 4, "one span per blob operation");
  assert.deepEqual(
    spans.map((s) => s.attributes.op),
    ["put", "get", "head", "get"],
  );
  assert.ok(
    spans.every((s) => s.status === "ok"),
    "reads/writes + a miss are ok; only a throw is an error span",
  );
  // The put span carries the byte size but never the content hash, path, or bytes.
  const put = spans[0];
  assert.equal(put?.attributes.bytes, bytes.byteLength);
  const serialized = JSON.stringify(spans);
  assert.ok(!serialized.includes(hash), "the content hash never enters a span");
  assert.ok(!serialized.includes(dir), "the on-disk path never enters a span");

  // Each op also records a low-cardinality blob-outcome counter (op + outcome, no hash/path).
  const outcomes = recorder.metric(METRIC_NAMES.blobOutcome);
  assert.deepEqual(
    outcomes.map((m) => `${m.labels.op}:${m.labels.outcome}`),
    ["put:stored", "get:hit", "head:hit", "get:miss"],
  );
  assert.ok(
    outcomes.every((m) => m.value === 1 && m.kind === "counter"),
    "each outcome is a single counter increment",
  );
});

test("a re-put of identical bytes records a deduped blob-outcome metric", async () => {
  const recorder = recordingTelemetrySink();
  const instrumented = new BlobStore(dir, recorder.sink);
  const bytes = new TextEncoder().encode("dedupe me");
  await instrumented.put(bytes, "text/plain");
  await instrumented.put(bytes, "text/plain");
  assert.deepEqual(
    recorder.metric(METRIC_NAMES.blobOutcome).map((m) => m.labels.outcome),
    ["stored", "deduped"],
  );
});
