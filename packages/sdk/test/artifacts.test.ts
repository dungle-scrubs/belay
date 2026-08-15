import { type BootedBlob, bootBlob } from "@belay/test-kit/boot";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTrevorClient } from "../src/index";

/**
 * SDK artifact client over a REAL blob-store (plan 28 M3 integration): upload returns a content-addressed
 * ref, download returns the exact bytes, identical bytes dedupe to the same hash, and a HEAD probe reads
 * size + content type without transferring the body. The same blob lifecycle the web upload and host
 * vision-inlining depend on, driven through the SDK's typed helpers.
 */

let blob: BootedBlob;

beforeAll(async () => {
  blob = await bootBlob();
});

afterAll(async () => {
  await blob.close();
});

describe("artifact round-trip over a real blob-store (M3)", () => {
  it("uploads bytes to a structured ref and downloads them back exactly", async () => {
    const client = createTrevorClient({ sessionUrl: "http://127.0.0.1:1", blobUrl: blob.url });
    const bytes = new TextEncoder().encode("artifact payload");
    const ref = await client.uploadArtifact(bytes, "text/plain", {
      kind: "document",
      name: "note.txt",
    });

    expect(ref).toMatchObject({
      kind: "document",
      name: "note.txt",
      mimeType: "text/plain",
      size: bytes.length,
    });
    expect(ref.hash).toMatch(/^[0-9a-f]{64}$/);

    const roundTripped = await client.downloadArtifact(ref);
    expect(new TextDecoder().decode(roundTripped)).toBe("artifact payload");
  });

  it("dedupes identical bytes to the same hash and probes metadata via HEAD", async () => {
    const client = createTrevorClient({ sessionUrl: "http://127.0.0.1:1", blobUrl: blob.url });
    const bytes = new TextEncoder().encode("same content");
    const first = await client.uploadArtifact(bytes, "text/plain");
    const second = await client.uploadArtifact(bytes, "text/plain");
    expect(second.hash).toBe(first.hash);

    const probe = await client.headArtifact(first.hash);
    expect(probe).toMatchObject({ size: bytes.length, mimeType: "text/plain" });
    expect(await client.headArtifact("0".repeat(64))).toBeNull();
  });
});
