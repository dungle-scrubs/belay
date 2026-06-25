import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
