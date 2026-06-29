import { type ArtifactRef, artifactRef, blobUrl, errorMessage, putBlob } from "@trevor/session";
import { serviceUrl } from "@trevor/session/ports";

/**
 * Web binding for the content-addressed blob store (D-028): resolves the store URL
 * from Vite env, turns a picked File into an uploaded ArtifactRef for a user.message,
 * and turns a stored hash into a GET url for rendering. The browser talks to the store
 * directly (it serves permissive CORS); the host later fetches the same bytes by hash.
 */
const BLOB_STORE_URL = import.meta.env.VITE_BLOB_STORE_URL ?? serviceUrl("blob");

function kindOf(mimeType: string): ArtifactRef["kind"] {
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType === "application/pdf" || mimeType.startsWith("text/")) {
    return "document";
  }
  return "file";
}

/** Uploads a picked File to the blob store, returning its ArtifactRef for a user.message. */
export async function uploadArtifact(file: File): Promise<ArtifactRef> {
  const mimeType = file.type || "application/octet-stream";
  try {
    // The File is a Blob - pass it straight through (no arrayBuffer/Uint8Array copy).
    const result = await putBlob(BLOB_STORE_URL, file, mimeType);
    return artifactRef(result, kindOf(mimeType), file.name || undefined);
  } catch (cause) {
    // A network/fetch failure here almost always means the store isn't running; turn the
    // opaque "Failed to fetch" into something actionable so the composer can show it.
    throw new Error(`blob store unreachable at ${BLOB_STORE_URL} (${errorMessage(cause)})`);
  }
}

/** The GET url for a stored artifact - usable directly as an `<img>` src. */
export function artifactSrc(hash: string): string {
  return blobUrl(BLOB_STORE_URL, hash);
}
