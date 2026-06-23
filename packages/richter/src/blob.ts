import type { ArtifactRef } from "./protocol";

/**
 * The artifact (blob) transport: a thin isomorphic client for the content-addressed
 * blob store that sits BESIDE Richter (D-028). The host and the web client both
 * speak it over `fetch` (a global in the browser and Node >= 22, like the Richter
 * client here). Bytes are addressed by their sha256, so a stored blob is immutable
 * and shared across every session - and every fork - that references it.
 *
 * The blob store is NOT Richter: events carry only an ArtifactRef
 * (`{ kind, mimeType, size, hash }`); the bytes live in the store, fetched on demand.
 */

/** A blob hash: a lowercase sha256 hex digest (the content address). */
export const HEX64 = /^[0-9a-f]{64}$/;

/** What the store returns after a successful upload. */
export interface PutBlobResult {
  readonly hash: string;
  readonly size: number;
  readonly mimeType: string;
}

const trimSlash = (base: string): string => base.replace(/\/$/, "");

/** The canonical GET URL for a blob - usable directly as an `<img>` src. */
export function blobUrl(baseUrl: string, hash: string): string {
  return `${trimSlash(baseUrl)}/blobs/${hash}`;
}

/** Stores bytes and returns the content hash + size; identical bytes dedupe server-side. */
export async function putBlob(
  baseUrl: string,
  body: Blob | Uint8Array,
  mimeType: string,
): Promise<PutBlobResult> {
  const res = await fetch(`${trimSlash(baseUrl)}/blobs`, {
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
