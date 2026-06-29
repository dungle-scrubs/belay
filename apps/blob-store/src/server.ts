import type { Server } from "node:http";
import { createService, json, type Route, readBody } from "@trevor/server-kit";
import { BLOB_PATH_PATTERN, BLOBS_PATH } from "@trevor/session/blob-contract";
import { BlobStore } from "./store";
import { heicToJpeg, isHeicMime, looksLikeHeic } from "./transcode";

/**
 * Builds the blob-store HTTP service over a `BlobStore` rooted at `root`, WITHOUT
 * listening - so `main.ts` binds the configured port and tests bind an ephemeral one
 * against a throwaway directory. The server is a thin transport over the storage core
 * (./store); the shared `createService` owns CORS / OPTIONS / `/health` / 404, so this
 * declares only the blob routes.
 *
 *   POST /blobs            (raw body, Content-Type) -> { hash, size, mimeType, deduped }
 *   GET  /blobs/<sha256>   -> bytes + stored Content-Type (immutable, hard-cached)
 *   HEAD /blobs/<sha256>   -> 200 + Content-Type/Length, or 404
 *   GET  /health           -> { ok: true }   (served by createService)
 */
export function createBlobServer(root: string, maxBytes: number): Server {
  const store = new BlobStore(root);
  // The `/blobs/<hash>` matcher (anchors already stripped for mid-pattern embedding) comes from the
  // shared contract, so the route can't drift from the client's path builder.
  const blobPath = BLOB_PATH_PATTERN;

  const routes: Route[] = [
    {
      method: "POST",
      match: BLOBS_PATH,
      handler: ({ req, res }) => {
        const mimeType = String(req.headers["content-type"] ?? "application/octet-stream");
        return readBody(req, maxBytes)
          .then(async (bytes) => {
            if (bytes.byteLength === 0) {
              json(res, 400, { error: "empty body" });
              return;
            }
            // Normalize HEIC/HEIF to JPEG on the way in (browsers can't render it, vision
            // models reject it); on any failure, store the original bytes untouched.
            let body = bytes;
            let type = mimeType;
            if (isHeicMime(mimeType) || looksLikeHeic(bytes)) {
              const jpeg = await heicToJpeg(bytes);
              if (jpeg) {
                body = jpeg;
                type = "image/jpeg";
              }
            }
            const stored = await store.put(body, type);
            json(res, stored.deduped ? 200 : 201, stored);
          })
          .catch((err: unknown) =>
            json(res, 413, { error: String((err as Error)?.message ?? err) }),
          );
      },
    },
    {
      method: "HEAD",
      match: blobPath,
      handler: ({ res, params }) =>
        store.head(params[0] as string).then((meta) => {
          if (!meta) {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, {
            "content-type": meta.mimeType,
            "content-length": String(meta.size),
          });
          res.end();
        }),
    },
    {
      method: "GET",
      match: blobPath,
      handler: ({ res, params }) =>
        store.get(params[0] as string).then((found) => {
          if (!found) {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, {
            "content-type": found.meta.mimeType,
            "content-length": String(found.meta.size),
            // Content-addressed: the bytes for a hash never change, so cache hard.
            "cache-control": "public, max-age=31536000, immutable",
          });
          res.end(found.bytes);
        }),
    },
  ];

  // The browser (trevor-web) uploads/reads cross-origin, no credentials; blobs add HEAD.
  return createService({ routes, corsMethods: "GET, HEAD, POST, OPTIONS" });
}
