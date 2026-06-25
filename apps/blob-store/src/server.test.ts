import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createBlobServer } from "./server";

/**
 * HTTP round-trip tests for the blob-store routes. The storage core has its own unit
 * tests (store.test.ts); this exercises the transport - in particular the GET/HEAD path
 * matching, which regressed once when the anchored HEX64 was embedded verbatim into the
 * path regex (`^/blobs/(^…$)$`) and 404'd every fetch. A round-trip catches exactly that.
 */

let dir: string;
let server: ReturnType<typeof createBlobServer>;
let baseUrl: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "blob-server-test-"));
  server = createBlobServer(dir, 25 * 1024 * 1024);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

test("PUT then GET round-trips the bytes and content-type", async () => {
  const bytes = new TextEncoder().encode("hello blob");
  const put = await fetch(`${baseUrl}/blobs`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: bytes,
  });
  assert.equal(put.status, 201);
  const stored = (await put.json()) as { hash: string; size: number; mimeType: string };
  assert.match(stored.hash, /^[0-9a-f]{64}$/);

  // The GET path the browser's <img> and the host's fetchBlobBytes both hit.
  const get = await fetch(`${baseUrl}/blobs/${stored.hash}`);
  assert.equal(get.status, 200, "a just-stored blob must be fetchable by hash");
  assert.equal(get.headers.get("content-type"), "image/png");
  assert.equal(new Uint8Array(await get.arrayBuffer()).byteLength, bytes.byteLength);

  // HEAD shares the same path matcher; it must resolve too.
  const head = await fetch(`${baseUrl}/blobs/${stored.hash}`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(stored.size));
});

test("GET an absent hash is 404; a malformed hash is 404", async () => {
  const absent = "a".repeat(64);
  assert.equal((await fetch(`${baseUrl}/blobs/${absent}`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/blobs/not-a-hash`)).status, 404);
});
