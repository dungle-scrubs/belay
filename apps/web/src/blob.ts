import {
  type ArtifactRef,
  classifyArtifactKind,
  createArtifactRuntime,
  errorMessage,
} from "@belay/session";
import { serviceUrl } from "@belay/session/ports";
import { SPAN_NAMES, type TelemetrySink, withSpan } from "@belay/session/telemetry";
import { telemetrySink } from "./telemetry";

/**
 * Web binding for the content-addressed blob store (D-028): resolves the store URL
 * from Vite env, turns a picked File into an uploaded ArtifactRef for a user.message,
 * and turns a stored hash into a GET url for rendering. The browser talks to the store
 * directly (it serves permissive CORS); the host later fetches the same bytes by hash.
 */
const BLOB_STORE_URL = import.meta.env.VITE_BLOB_STORE_URL ?? serviceUrl("blob");
const artifactRuntime = createArtifactRuntime({ blobStoreUrl: BLOB_STORE_URL });

/** Uploads a picked File to the blob store, returning its ArtifactRef for a user.message. The upload is a
 *  `belay.blob.io` span carrying the artifact KIND + byte size only - never the file name or bytes. */
export async function uploadArtifact(
  file: File,
  sink: TelemetrySink = telemetrySink(),
): Promise<ArtifactRef> {
  const mimeType = file.type || "application/octet-stream";
  const kind = classifyArtifactKind(mimeType);
  return withSpan(sink, SPAN_NAMES.blobIo, { op: "upload", kind, bytes: file.size }, async () => {
    try {
      // The File is a Blob - pass it straight through (no arrayBuffer/Uint8Array copy).
      return artifactRuntime.upload(file, mimeType, { kind, name: file.name || undefined });
    } catch (cause) {
      // A network/fetch failure here almost always means the store isn't running; turn the
      // opaque "Failed to fetch" into something actionable so the composer can show it.
      throw new Error(`blob store unreachable at ${BLOB_STORE_URL} (${errorMessage(cause)})`);
    }
  });
}

/** The GET url for a stored artifact - usable directly as an `<img>` src. */
export function artifactSrc(hash: string): string {
  return artifactRuntime.artifactUrl(hash);
}
