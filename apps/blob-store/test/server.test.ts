import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { createBlobServer } from "../src/server";

/**
 * HTTP contract for the blob-store routes (the storage core has its own unit tests in
 * src/store.test.ts). Covers the round-trip + path matching the browser <img> and the host's
 * fetchBlobBytes hit, plus the smoke gates: dedup, size limits, empty body, CORS, cache
 * headers, and a concurrent race. Boots on an ephemeral port with a small byte cap so the
 * limit cases stay tiny. (Relocated from src/server.test.ts: it boots a server, so it is an
 * integration test.)
 */

const MAX_BYTES = 1024;
let dir: string;
let server: ReturnType<typeof createBlobServer>;
let baseUrl: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "blob-server-test-"));
  server = createBlobServer(dir, MAX_BYTES);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

function post(body: string | Uint8Array, contentType = "application/octet-stream") {
  return fetch(`${baseUrl}/blobs`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

test("POST then GET round-trips the bytes and content-type; HEAD matches", async () => {
  const bytes = new TextEncoder().encode("hello blob");
  const put = await post(bytes, "image/png");
  assert.equal(put.status, 201);
  const stored = (await put.json()) as { hash: string; size: number };
  assert.match(stored.hash, /^[0-9a-f]{64}$/);

  const get = await fetch(`${baseUrl}/blobs/${stored.hash}`);
  assert.equal(get.status, 200, "a just-stored blob must be fetchable by hash");
  assert.equal(get.headers.get("content-type"), "image/png");
  assert.equal(new Uint8Array(await get.arrayBuffer()).byteLength, bytes.byteLength);

  const head = await fetch(`${baseUrl}/blobs/${stored.hash}`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(stored.size));
});

test("identical bytes dedupe: second upload is 200 + deduped, same hash", async () => {
  const first = (await (await post("dedupe me")).json()) as { hash: string; deduped: boolean };
  const res = await post("dedupe me");
  const second = (await res.json()) as { hash: string; deduped: boolean };
  assert.equal(first.hash, second.hash);
  assert.equal(res.status, 200);
  assert.equal(second.deduped, true);
});

test("a GET serves the immutable content-addressed cache header", async () => {
  const { hash } = (await (await post("cache me")).json()) as { hash: string };
  const get = await fetch(`${baseUrl}/blobs/${hash}`);
  assert.equal(get.headers.get("cache-control"), "public, max-age=31536000, immutable");
});

test("size limits: empty body 400, at-cap 201, over-cap rejected", async () => {
  assert.equal((await post("")).status, 400);
  assert.equal((await post("x".repeat(MAX_BYTES))).status, 201);
  // Over-cap: the server tears the connection down (req.destroy) once the body exceeds the
  // cap, so the client sees either a 413 or a connection error - both mean rejected, nothing
  // stored. (No partial write: the bytes never reach store.put.)
  let rejected = false;
  try {
    rejected = (await post("x".repeat(MAX_BYTES + 1))).status === 413;
  } catch {
    rejected = true;
  }
  assert.ok(rejected, "an over-cap upload must be rejected");
});

test("a missing hash and a malformed hash both 404", async () => {
  assert.equal((await fetch(`${baseUrl}/blobs/${"a".repeat(64)}`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/blobs/not-a-hash`)).status, 404);
});

test("CORS preflight is permissive so the browser can upload cross-origin", async () => {
  const res = await fetch(`${baseUrl}/blobs`, { method: "OPTIONS" });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("concurrent identical uploads race cleanly: one stores, one dedupes", async () => {
  const [a, b] = await Promise.all([post("racing bytes"), post("racing bytes")]);
  const ja = (await a.json()) as { hash: string; deduped: boolean };
  const jb = (await b.json()) as { hash: string; deduped: boolean };
  assert.equal(ja.hash, jb.hash);
  // Exactly one wrote the bytes (deduped:false) and one hit EEXIST (deduped:true).
  assert.deepEqual([ja.deduped, jb.deduped].sort(), [false, true]);
});
