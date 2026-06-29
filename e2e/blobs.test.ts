import assert from "node:assert/strict";
import { type BootedBlob, bootBlob } from "@trevor/test-kit/boot";
import { afterAll, beforeAll, test } from "vitest";

/**
 * S-BLOB: the content-addressed artifact round-trip over real HTTP - upload returns a hash,
 * GET returns the exact bytes + content-type, re-upload dedupes, and bad/missing hashes 404.
 * This is the blob lifecycle the web upload and host vision-inlining both depend on.
 */

let blob: BootedBlob;

beforeAll(async () => {
  blob = await bootBlob();
});

afterAll(async () => {
  await blob.close();
});

async function put(body: string, contentType: string) {
  const res = await fetch(`${blob.url}/blobs`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
  return { status: res.status, json: (await res.json()) as { hash: string; deduped: boolean } };
}

test("upload then download round-trips bytes and content-type", async () => {
  const { status, json } = await put("hello blob", "text/plain");
  assert.equal(status, 201);
  assert.equal(json.deduped, false);

  const got = await fetch(`${blob.url}/blobs/${json.hash}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "text/plain");
  assert.equal(await got.text(), "hello blob");
});

test("identical bytes dedupe to the same hash (200, deduped)", async () => {
  const first = await put("same bytes", "text/plain");
  const second = await put("same bytes", "text/plain");
  assert.equal(first.json.hash, second.json.hash);
  assert.equal(second.status, 200);
  assert.equal(second.json.deduped, true);
});

test("a missing hash and a malformed hash both 404", async () => {
  const missing = await fetch(`${blob.url}/blobs/${"0".repeat(64)}`);
  assert.equal(missing.status, 404);
  const malformed = await fetch(`${blob.url}/blobs/not-a-valid-hash`);
  assert.equal(malformed.status, 404);
});
