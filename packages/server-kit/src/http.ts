import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * The transport-level HTTP helpers shared by Trevor's local stores: permissive CORS,
 * a JSON responder, and two request-body readers (parsed JSON vs raw bytes). They are
 * pure plumbing - they know nothing about sessions, blobs, routes, or any domain - so
 * every store can drop its hand-rolled copy and share one implementation.
 */

/**
 * Permissive CORS, no credentials: the browser reads/writes cross-origin. `methods` is
 * the `access-control-allow-methods` value, since each store allows a different verb set
 * (e.g. a blob store adds HEAD); the rest of the policy is identical everywhere.
 */
export function cors(res: ServerResponse, methods: string): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", methods);
  res.setHeader("access-control-allow-headers", "content-type");
}

/** Writes a JSON response with the given status and a `application/json` content-type. */
export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Buffers and parses a JSON request body; an empty body resolves to `{}`. Rejects on bad JSON. */
export function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/** Buffers a raw request body, rejecting once it exceeds `limit` bytes (the connection is torn down). */
export function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array> {
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
