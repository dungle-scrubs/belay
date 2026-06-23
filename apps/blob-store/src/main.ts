import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { BlobStore, HEX64 } from "./store";
import { heicToJpeg, isHeicMime, looksLikeHeic } from "./transcode";

/**
 * The blob-store HTTP service: a small content-addressed artifact store that lives
 * BESIDE Richter (D-028), reachable by every participant (host + browser) so a blob
 * is as durable and shareable as the session log it is referenced from. Richter
 * never sees these bytes - events carry only `{ kind, mimeType, size, hash }`
 * references and the bytes are fetched here on demand.
 *
 *   POST /blobs            (raw body, Content-Type) -> { hash, size, mimeType, deduped }
 *   GET  /blobs/<sha256>   -> bytes + stored Content-Type (immutable, hard-cached)
 *   HEAD /blobs/<sha256>   -> 200 + Content-Type/Length, or 404
 *   GET  /health           -> { ok: true }
 *
 * Plain Node http + fs (a leaf service): no Effect, no framework, no workspace deps.
 */

const PORT = Number(process.env.BLOB_STORE_PORT ?? 17423);
const ROOT = process.env.BLOB_STORE_DIR ?? join(homedir(), ".trevor", "blobs");
const MAX_BYTES = Number(process.env.BLOB_STORE_MAX_BYTES ?? 25 * 1024 * 1024);

const store = new BlobStore(ROOT);
const BLOB_PATH = new RegExp(`^/blobs/(${HEX64.source})$`);

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

const server = createServer((req, res) => {
  cors(res);
  const method = req.method ?? "GET";
  const path = new URL(req.url ?? "/", `http://localhost:${PORT}`).pathname;

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
    readBody(req, MAX_BYTES)
      .then(async (bytes) => {
        if (bytes.byteLength === 0) {
          json(res, 400, { error: "empty body" });
          return;
        }
        // Normalize HEIC/HEIF to JPEG on the way in (browsers can't render it, vision models
        // reject it); on any failure, fall back to storing the original bytes untouched.
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
  const match = BLOB_PATH.exec(path);
  const hash = match?.[1];
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

server.listen(PORT, () => {
  console.log(`[blob-store] listening on http://127.0.0.1:${PORT} (root: ${ROOT})`);
});
