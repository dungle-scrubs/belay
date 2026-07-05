import { BLOBS_PATH, blobPath, type PutBlobResult } from "./blob-contract";
import type { ArtifactRef } from "./protocol";

/**
 * The artifact (blob) transport: a thin isomorphic client for the content-addressed
 * blob store that sits BESIDE Tether (D-028). The host and the web client both
 * speak it over `fetch` (a global in the browser and Node >= 22, like the Tether
 * client here). Bytes are addressed by their sha256, so a stored blob is immutable
 * and shared across every session - and every fork - that references it.
 *
 * The blob store is NOT Tether: events carry only an ArtifactRef
 * (`{ kind, mimeType, size, hash }`); the bytes live in the store, fetched on demand.
 *
 * The wire contract (HEX64, the result type, the `/blobs` routes) lives in the zero-dep
 * `./blob-contract` leaf, imported by BOTH this client and the standalone `@trevor/blob-store`
 * server (via the `@trevor/session/blob-contract` subpath) so the two can't drift.
 */

// Re-exported so existing `@trevor/session` consumers of HEX64 / PutBlobResult keep their import.
export { HEX64, type PutBlobResult } from "./blob-contract";

const trimSlash = (base: string): string => base.replace(/\/$/, "");

/** The canonical GET URL for a blob - usable directly as an `<img>` src. */
export function blobUrl(baseUrl: string, hash: string): string {
  return `${trimSlash(baseUrl)}${blobPath(hash)}`;
}

/** Stores bytes and returns the content hash + size; identical bytes dedupe server-side. */
export async function putBlob(
  baseUrl: string,
  body: Blob | Uint8Array,
  mimeType: string,
): Promise<PutBlobResult> {
  const res = await fetch(`${trimSlash(baseUrl)}${BLOBS_PATH}`, {
    method: "POST",
    headers: { "content-type": mimeType },
    // A Blob (e.g. the picked File) streams with no copy; a Uint8Array is copied into a fresh
    // ArrayBuffer to sidestep the generic Uint8Array<ArrayBufferLike> body bound (TS 5.7+).
    body: body instanceof Uint8Array ? new Uint8Array(body).buffer : body,
  });
  if (!res.ok) {
    throw new Error(`blob store rejected upload (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as PutBlobResult;
}

/** Fetches a blob's raw bytes by hash (the host feeds these to a provider as image/file parts). */
export async function fetchBlobBytes(baseUrl: string, hash: string): Promise<Uint8Array> {
  const res = await fetch(blobUrl(baseUrl, hash));
  if (!res.ok) {
    throw new Error(`blob ${hash} not available (${res.status})`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Metadata for a stored blob, as a `HEAD /blobs/<hash>` probe reports it (no bytes fetched). */
export interface BlobMetaProbe {
  readonly size: number;
  readonly mimeType: string;
}

/**
 * Probes a blob's metadata by hash via HEAD - size + content-type with no body transfer - or null
 * when the blob is absent. The client for the store's HEAD verb, so a caller can check existence/size
 * (e.g. before inlining a large image) without downloading the bytes.
 */
export async function headBlob(baseUrl: string, hash: string): Promise<BlobMetaProbe | null> {
  const res = await fetch(blobUrl(baseUrl, hash), { method: "HEAD" });
  if (!res.ok) {
    return null;
  }
  const size = Number(res.headers.get("content-length"));
  return {
    size: Number.isFinite(size) ? size : 0,
    mimeType: res.headers.get("content-type") ?? "application/octet-stream",
  };
}

/** Builds an ArtifactRef from an upload result plus the chosen kind and optional name. */
export function artifactRef(
  result: PutBlobResult,
  kind: ArtifactRef["kind"],
  name?: string,
): ArtifactRef {
  return {
    kind,
    mimeType: result.mimeType,
    size: result.size,
    hash: result.hash,
    ...(name ? { name } : {}),
  };
}
