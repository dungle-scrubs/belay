import { type ArtifactRuntime, createArtifactRuntime } from "@belay/session";
import { serviceUrl } from "@belay/session/ports";

/**
 * Host binding for the shared artifact runtime.
 *
 * Responsible for: resolving the host's blob-store URL and constructing the host-side artifact runtime.
 * Not for: browser upload UI, video transcoding, or provider message shaping.
 */

export const HOST_BLOB_STORE_URL = process.env.BLOB_STORE_URL ?? serviceUrl("blob");

export function createHostArtifactRuntime(blobStoreUrl = HOST_BLOB_STORE_URL): ArtifactRuntime {
  return createArtifactRuntime({ blobStoreUrl });
}

export const hostArtifactRuntime = createHostArtifactRuntime();
