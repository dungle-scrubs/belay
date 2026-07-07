import assert from "node:assert/strict";
import type { ArtifactRef } from "@trevor/session";
import { afterEach, test } from "vitest";
import { createHistoryImageResolver } from "./image-resolution";

const ONE_BY_ONE_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

const VALID_IMAGE: ArtifactRef = {
  kind: "image",
  mimeType: "image/png",
  size: ONE_BY_ONE_PNG.byteLength,
  hash: "1".repeat(64),
};

const INVALID_IMAGE: ArtifactRef = {
  kind: "image",
  mimeType: "image/png",
  size: 4,
  hash: "2".repeat(64),
};

const UNSUPPORTED_IMAGE: ArtifactRef = {
  kind: "image",
  mimeType: "image/heic",
  size: 4,
  hash: "3".repeat(64),
};

const DOCUMENT: ArtifactRef = {
  kind: "document",
  mimeType: "application/pdf",
  size: 4,
  hash: "4".repeat(64),
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("history image resolution uses shared artifact runtime policy and skips invalid images", async () => {
  const fetched: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    fetched.push(url);
    const body = url.endsWith(VALID_IMAGE.hash) ? ONE_BY_ONE_PNG : new Uint8Array([1, 2, 3, 4]);
    return new Response(body, { status: 200, headers: { "content-type": "image/png" } });
  };

  const resolveImages = createHistoryImageResolver({ blobStoreUrl: "http://blob.test" });
  const [resolved] = await resolveImages([
    {
      role: "user",
      content: "see attached",
      artifacts: [VALID_IMAGE, INVALID_IMAGE, UNSUPPORTED_IMAGE, DOCUMENT],
    },
  ]);

  assert.equal(resolved?.images?.length, 1);
  assert.deepEqual(resolved?.images?.[0], {
    hash: VALID_IMAGE.hash,
    mimeType: "image/png",
    data: Buffer.from(ONE_BY_ONE_PNG).toString("base64"),
  });
  assert.deepEqual(fetched, [
    `http://blob.test/blobs/${VALID_IMAGE.hash}`,
    `http://blob.test/blobs/${INVALID_IMAGE.hash}`,
  ]);
});
