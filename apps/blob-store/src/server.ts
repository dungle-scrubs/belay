import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BlobStore, HEX64 } from "./store";
import { heicToJpeg, isHeicMime, looksLikeHeic } from "./transcode";

/**
 * Builds the blob-store HTTP service over a `BlobStore` rooted at `root`, WITHOUT
 * listening - so `main.ts` binds the configured port and tests bind an ephemeral one
 * against a throwaway directory. The server is a thin transport over the storage core
 * (./store); keeping the factory free of `listen` is what makes the routes testable.
 *
 *   POST /blobs            (raw body, Content-Type) -> { hash, size, mimeType, deduped }
 *   GET  /blobs/<sha256>   -> bytes + stored Content-Type (immutable, hard-cached)
 *   HEAD /blobs/<sha256>   -> 200 + Content-Type/Length, or 404
 *   GET  /health           -> { ok: true }
 */
export function createBlobServer(root: string, maxBytes: number): Server {
  const store = new BlobStore(root);
  // HEX64 is anchored (`^…$`) for use as a whole-string validator (store.get/head); strip
  // those anchors before embedding it as a capture group, or the path regex would carry
  // stray `^`/`$` mid-pattern (`^/blobs/(^…$)$`) and never match - 404ing every GET/HEAD.
  const blobPath = new RegExp(`^/blobs/(${HEX64.source.replace(/^\^|\$$/g, "")})$`);

  return createServer((req, res) => {
    cors(res);
    const method = req.method ?? "GET";
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === "/health") {
      json(res, 200, { ok: true });
      return;
    }
    if (path === "/blobs" && method === "POST") {
      const mimeType = String(req.headers["content-type"] ?? "application/octet-stream");
      readBody(req, maxBytes)
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
        .catch((err: unknown) => json(res, 413, { error: String((err as Error)?.message ?? err) }));
      return;
    }
    const hash = blobPath.exec(path)?.[1];
    if (hash && method === "HEAD") {
      store.head(hash).then((meta) => {
        if (!meta) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": meta.mimeType, "content-length": String(meta.size) });
        res.end();
      });
      return;
    }
    if (hash && method === "GET") {
      store.get(hash).then((found) => {
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
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

/** Permissive CORS: the browser (trevor-web :17420) uploads/reads cross-origin, no credentials. */
function cors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, HEAD, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Buffers a request body, rejecting once it exceeds the cap (the connection is torn down). */
function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > limit) {
        req.destroy();
        reject(new Error(`payload exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
