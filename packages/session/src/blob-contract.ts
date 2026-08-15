/**
 * The blob-store CLIENT/SERVER contract as a zero-dependency leaf (mirroring the `ports` / `node-paths`
 * subpaths): the hash format, the wire result shape, and the `/blobs` route vocabulary. Both the
 * @belay/session blob client AND the standalone @belay/blob-store server import this ONE module, so
 * the hash regex, the result type, and the route strings stop being a hand-synced triple kept aligned
 * by comment.
 *
 * Exposed via the `@belay/session/blob-contract` subpath so the dependency-light blob-store imports it
 * without pulling in the rest of the protocol package - the same exception already granted to ports.ts.
 */

/** A blob hash: a lowercase sha256 hex digest (the content address). */
export const HEX64 = /^[0-9a-f]{64}$/;

/** The hash capture body with the `^`/`$` anchors stripped, for embedding in a whole-path matcher
 *  (embedding the anchored source mid-pattern would never match - the blob-store anchor bug). */
const HEX64_BODY = HEX64.source.replace(/^\^|\$$/g, "");

/** The collection route blobs are POSTed to. */
export const BLOBS_PATH = "/blobs";

/** The GET/HEAD route for one blob by its hash. */
export function blobPath(hash: string): string {
  return `${BLOBS_PATH}/${hash}`;
}

/** The whole-path matcher for `GET`/`HEAD /blobs/<sha256>`, capturing the hash. */
export const BLOB_PATH_PATTERN = new RegExp(`^${BLOBS_PATH}/(${HEX64_BODY})$`);

/** The wire response the store returns after a successful upload (`POST /blobs`). `deduped` is true
 *  when the bytes were already present (the store deduped, no new write). */
export interface PutBlobResult {
  readonly hash: string;
  readonly size: number;
  readonly mimeType: string;
  readonly deduped: boolean;
}
