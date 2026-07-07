import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import {
  classifyArtifactKind,
  createArtifactRuntime,
  isModelImageArtifact,
  type PutBlobResult,
} from "./index";

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fakeRuntime() {
  const blobs = new Map<string, { readonly bytes: Uint8Array; readonly mimeType: string }>();
  const runtime = createArtifactRuntime({
    blobStoreUrl: "http://127.0.0.1:9999/",
    put: async (_baseUrl, body, mimeType): Promise<PutBlobResult> => {
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(await body.arrayBuffer());
      const blobHash = hash(bytes);
      const deduped = blobs.has(blobHash);
      blobs.set(blobHash, { bytes, mimeType });
      return { hash: blobHash, size: bytes.byteLength, mimeType, deduped };
    },
    fetchBytes: async (_baseUrl, blobHash) => {
      const record = blobs.get(blobHash);
      if (!record) {
        throw new Error(`missing ${blobHash}`);
      }
      return record.bytes;
    },
    head: async (_baseUrl, blobHash) => {
      const record = blobs.get(blobHash);
      return record ? { size: record.bytes.byteLength, mimeType: record.mimeType } : null;
    },
    validateImage: (bytes) => bytes[0] === 0x89 && bytes[1] === 0x50,
  });
  return { blobs, runtime };
}

test("classifies artifact kinds from mime type policy", () => {
  assert.equal(classifyArtifactKind("image/png"), "image");
  assert.equal(classifyArtifactKind("IMAGE/JPEG"), "image");
  assert.equal(classifyArtifactKind("application/pdf"), "document");
  assert.equal(classifyArtifactKind("text/markdown"), "document");
  assert.equal(classifyArtifactKind("application/zip"), "file");
});

test("uploads, downloads, heads, and resolves canonical blob URLs", async () => {
  const { runtime } = fakeRuntime();
  const bytes = new TextEncoder().encode("artifact payload");

  const ref = await runtime.upload(bytes, "text/plain", { name: "note.txt" });

  assert.equal(ref.kind, "document");
  assert.equal(ref.name, "note.txt");
  assert.equal(ref.size, bytes.byteLength);
  assert.equal(runtime.artifactUrl(ref.hash), `http://127.0.0.1:9999/blobs/${ref.hash}`);
  assert.deepEqual(await runtime.download(ref), bytes);
  assert.deepEqual(await runtime.head(ref.hash), {
    size: bytes.byteLength,
    mimeType: "text/plain",
  });
});

test("model-image eligibility is shared and invalid image bytes are rejected best-effort", async () => {
  const { runtime } = fakeRuntime();
  const valid = await runtime.upload(new Uint8Array([0x89, 0x50, 1, 2]), "image/png", {
    name: "frame.png",
  });
  const invalid = await runtime.upload(new Uint8Array([1, 2, 3, 4]), "image/png");
  const unsupported = await runtime.upload(new Uint8Array([0x89, 0x50]), "image/heic");

  assert.equal(isModelImageArtifact(valid), true);
  assert.equal(runtime.isModelImage(unsupported), false);
  assert.deepEqual(await runtime.tryResolveModelImage(valid), {
    hash: valid.hash,
    mimeType: "image/png",
    bytes: new Uint8Array([0x89, 0x50, 1, 2]),
  });
  assert.equal(await runtime.tryResolveModelImage(invalid), null);
  assert.equal(await runtime.tryResolveModelImage(unsupported), null);
});

test("frame artifact creation stores image refs through the same upload policy", async () => {
  const { runtime } = fakeRuntime();
  const frame = await runtime.createFrameArtifact(new Uint8Array([0x89, 0x50, 0, 1]));

  assert.equal(frame.kind, "image");
  assert.equal(frame.mimeType, "image/png");
  assert.deepEqual(await runtime.download(frame), new Uint8Array([0x89, 0x50, 0, 1]));
});
