import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HEX64, type PutBlobResult } from "@trevor/session/blob-contract";
import { NOOP_SINK, SPAN_NAMES, type TelemetrySink, withSpan } from "@trevor/session/telemetry";

/**
 * The content-addressed blob store on disk (D-028). Bytes are named by their
 * sha256, so a blob is immutable and identical content is stored exactly once -
 * which is what makes a fork copy only references (the hash) and share the bytes
 * for free. Each blob is a pair: `<root>/<ab>/<sha256>` holds the raw bytes and a
 * sibling `<sha256>.meta` holds the JSON `{ size, mimeType }` so a GET is
 * self-describing (a correct content-type for an <img> src). Directories shard by
 * the first two hex chars (git-style) to keep any one directory small.
 *
 * This is the storage core, kept free of HTTP so it is directly testable; the
 * server in `main.ts` is a thin transport over it.
 *
 * The hash format + wire result are the shared `@trevor/session/blob-contract` leaf (a zero-dep
 * subpath, the same exception ports.ts gets), so the client and this server no longer keep two
 * hand-synced copies. `StoredBlob` IS the wire `PutBlobResult`.
 */

// Re-exported so server.ts + the store tests keep importing HEX64 from this module.
export { HEX64 } from "@trevor/session/blob-contract";

/** Per-blob metadata persisted alongside the bytes. */
export interface BlobMeta {
  readonly size: number;
  readonly mimeType: string;
}

/** The result of a store: the content hash plus whether the bytes were already present (the wire shape). */
export type StoredBlob = PutBlobResult;

export class BlobStore {
  /** Telemetry is disabled by default (NOOP_SINK); `main.ts` wires the real exporter, tests a recorder.
   *  Spans carry only the operation, byte size, and hit/miss outcome - never the hash, path, or bytes. */
  constructor(
    private readonly root: string,
    private readonly sink: TelemetrySink = NOOP_SINK,
  ) {}

  private pathFor(hash: string): string {
    return join(this.root, hash.slice(0, 2), hash);
  }

  /** The sha256 a given byte string would be stored under. */
  hashOf(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
  }

  /** Stores bytes (idempotently); identical content returns the same hash, marked deduped. */
  async put(bytes: Uint8Array, mimeType: string): Promise<StoredBlob> {
    return withSpan(
      this.sink,
      SPAN_NAMES.blobIo,
      { op: "put", bytes: bytes.byteLength },
      async () => {
        const hash = this.hashOf(bytes);
        const path = this.pathFor(hash);
        const result = { hash, size: bytes.byteLength, mimeType };
        await mkdir(dirname(path), { recursive: true });
        try {
          // wx writes only if absent; content-addressed, so an existing blob is byte-identical
          // and EEXIST is the dedup case - race-free, one syscall in the common path.
          await writeFile(path, bytes, { flag: "wx" });
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
            return { ...result, deduped: true };
          }
          throw cause;
        }
        const meta: BlobMeta = { size: result.size, mimeType };
        await writeFile(`${path}.meta`, JSON.stringify(meta), "utf8");
        return { ...result, deduped: false };
      },
    );
  }

  /** Reads a blob's bytes + meta, or null if the hash is malformed or absent. */
  async get(hash: string): Promise<{ bytes: Uint8Array; meta: BlobMeta } | null> {
    return withSpan(this.sink, SPAN_NAMES.blobIo, { op: "get" }, async () => {
      if (!HEX64.test(hash)) {
        return null;
      }
      const path = this.pathFor(hash);
      try {
        const [bytes, metaRaw] = await Promise.all([
          readFile(path),
          readFile(`${path}.meta`, "utf8"),
        ]);
        return { bytes, meta: JSON.parse(metaRaw) as BlobMeta };
      } catch {
        return null;
      }
    });
  }

  /** Reads only a blob's meta (for HEAD), or null if the hash is malformed or absent. */
  async head(hash: string): Promise<BlobMeta | null> {
    return withSpan(this.sink, SPAN_NAMES.blobIo, { op: "head" }, async () => {
      if (!HEX64.test(hash)) {
        return null;
      }
      try {
        return JSON.parse(await readFile(`${this.pathFor(hash)}.meta`, "utf8")) as BlobMeta;
      } catch {
        return null;
      }
    });
  }
}
