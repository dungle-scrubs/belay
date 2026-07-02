import { McpFramingError } from "./errors";

/**
 * LSP-style Content-Length framing for MCP stdio (plan 23 M2): a pure incremental parser plus
 * the matching encoder. Frames are `Content-Length: <n>\r\n[other-headers\r\n]\r\n<n body
 * bytes>`; the header name is case-insensitive and the length counts BYTES, so multibyte
 * UTF-8 bodies and chunk boundaries that split a character are handled by buffering raw bytes
 * and decoding only complete bodies. Body bytes accumulate as a chunk list (no per-push
 * copying) and are assembled once per frame; the remainder after a frame is COPIED out so a
 * small tail never pins a large frame buffer; and an un-terminated header region is capped so
 * an unframed garbage stream errors instead of buffering forever.
 *
 * Responsible for: byte-exact Content-Length frame encoding and incremental decoding.
 * Not for: JSON-RPC semantics (ids, results, errors) - ./stdio-transport owns those.
 */

/** Safety cap on a declared body size, so a corrupt header cannot make the host buffer GBs. */
export const MAX_FRAME_BODY_BYTES = 32 * 1024 * 1024;

/** Safety cap on an un-terminated header region: bytes with no `\r\n\r\n` beyond this are not
 *  a frame header, they are a garbage stream. */
export const MAX_FRAME_HEADER_BYTES = 64 * 1024;

const HEADER_TERMINATOR = "\r\n\r\n";

const EMPTY = Buffer.alloc(0);

/** Encodes one frame with a byte-counted Content-Length header. */
export function encodeFrame(body: string): Buffer {
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`, "utf8");
}

export interface FrameParser {
  /** Feeds bytes in; returns every now-complete frame body, decoded as UTF-8, in order.
   *  Throws {@link McpFramingError} on a header block without a usable Content-Length, or on
   *  a header region growing past {@link MAX_FRAME_HEADER_BYTES} without its terminator. */
  readonly push: (chunk: Buffer | string) => string[];
  /** Bytes currently buffered awaiting a complete frame (diagnostic). */
  readonly buffered: () => number;
}

/** Creates an incremental parser; one instance per byte stream. */
export function createFrameParser(): FrameParser {
  /** Header-phase bytes (small: capped at MAX_FRAME_HEADER_BYTES). */
  let header: Buffer = EMPTY;
  /** Body-phase collection once a header parsed; null while reading a header. */
  let body: { readonly chunks: Buffer[]; received: number; readonly length: number } | null = null;

  return {
    push(chunk) {
      let rest = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      const frames: string[] = [];

      while (true) {
        if (body === null) {
          // Header phase: append (headers are small, so this concat is bounded) and scan for
          // the terminator, starting where the previous scan left off.
          if (rest.length === 0) {
            break;
          }
          const scanFrom = Math.max(0, header.length - (HEADER_TERMINATOR.length - 1));
          header = header.length === 0 ? rest : Buffer.concat([header, rest]);
          rest = EMPTY;
          const headerEnd = header.indexOf(HEADER_TERMINATOR, scanFrom);
          if (headerEnd === -1) {
            if (header.length > MAX_FRAME_HEADER_BYTES) {
              throw new McpFramingError({
                detail: `stream has no frame header terminator within ${MAX_FRAME_HEADER_BYTES} bytes - not a Content-Length-framed stream`,
              });
            }
            break; // partial header - wait for more bytes
          }
          const length = contentLength(header.subarray(0, headerEnd).toString("utf8"));
          rest = header.subarray(headerEnd + HEADER_TERMINATOR.length);
          header = EMPTY;
          body = { chunks: [], received: 0, length };
          continue;
        }

        // Body phase: collect chunks without copying until the declared length has arrived.
        if (rest.length > 0) {
          body.chunks.push(rest);
          body.received += rest.length;
          rest = EMPTY;
        }
        if (body.received < body.length) {
          break; // partial body - wait for more bytes
        }
        const whole =
          body.chunks.length === 1
            ? (body.chunks[0] as Buffer)
            : Buffer.concat(body.chunks, body.received);
        frames.push(whole.subarray(0, body.length).toString("utf8"));
        // COPY the remainder: a small tail must never pin the whole frame's buffer.
        rest = Buffer.from(whole.subarray(body.length));
        body = null;
      }

      return frames;
    },
    buffered: () => header.length + (body?.received ?? 0),
  };
}

function contentLength(header: string): number {
  const match = /^content-length:\s*(\d+)\s*$/im.exec(header);
  if (!match?.[1]) {
    throw new McpFramingError({
      detail: `header block lacks a numeric Content-Length: ${JSON.stringify(header.slice(0, 120))}`,
    });
  }
  const length = Number(match[1]);
  if (!Number.isSafeInteger(length) || length > MAX_FRAME_BODY_BYTES) {
    throw new McpFramingError({
      detail: `declared frame body of ${match[1]} bytes exceeds the ${MAX_FRAME_BODY_BYTES}-byte cap`,
    });
  }
  return length;
}
