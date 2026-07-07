import {
  type ArtifactRef,
  type BlobMetaProbe,
  createArtifactRuntime,
  HEX64,
} from "@trevor/session";
import type { TrevorClient } from "./client";

/**
 * The SDK artifact workflow (plan 28 M3): upload/download/probe over the content-addressed blob store's
 * wire contract, returning structured `ArtifactRef`s and typed failures. It reuses the `@trevor/session`
 * blob client (the same isomorphic `fetch` client the host and web use), so the SDK does not re-derive
 * the `/blobs` routes or the hash format. Artifact bytes stay OUT of the session event helpers unless a
 * caller explicitly attaches a ref to a prompt (M3 REFACTOR) - this module only moves bytes.
 *
 * Every operation is async-rejecting (never a synchronous throw), so callers uniformly `await` a typed
 * `SdkError` - including the "no blob URL configured" and "malformed hash" guards.
 */

/** The bytes accepted for an upload: a `Blob` (e.g. a picked file) or a raw `Uint8Array`. */
export type ArtifactSource = Blob | Uint8Array;

/** Uploads bytes to the blob store and returns a structured `ArtifactRef` (content-addressed). */
export function uploadArtifact(
  client: TrevorClient,
  source: ArtifactSource,
  mimeType: string,
  options?: { readonly kind?: ArtifactRef["kind"]; readonly name?: string },
): Promise<ArtifactRef> {
  return client.blobOp("uploadArtifact", async () => {
    const blobUrl = client.requireBlobUrl("uploadArtifact");
    return createArtifactRuntime({ blobStoreUrl: blobUrl }).upload(source, mimeType, {
      kind: options?.kind ?? "file",
      name: options?.name,
    });
  });
}

/** Downloads an artifact's raw bytes by hash or ref. Rejects a malformed hash before any request. */
export function downloadArtifact(
  client: TrevorClient,
  ref: string | ArtifactRef,
): Promise<Uint8Array> {
  const hash = typeof ref === "string" ? ref : ref.hash;
  return client.blobOp("downloadArtifact", async () => {
    const blobUrl = client.requireBlobUrl("downloadArtifact");
    if (!HEX64.test(hash)) {
      throw new Error(`not a valid blob hash: ${hash}`);
    }
    return createArtifactRuntime({ blobStoreUrl: blobUrl }).download(hash);
  });
}

/** Probes an artifact's size + content type by hash (HEAD), or null when the blob is absent. */
export function headArtifact(client: TrevorClient, hash: string): Promise<BlobMetaProbe | null> {
  return client.blobOp("headArtifact", async () =>
    createArtifactRuntime({ blobStoreUrl: client.requireBlobUrl("headArtifact") }).head(hash),
  );
}
