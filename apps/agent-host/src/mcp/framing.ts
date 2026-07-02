import { McpFramingError } from "./errors";

/**
 * LSP-style Content-Length framing for MCP stdio (plan 23 M2): a pure incremental parser plus
 * the matching encoder. Frames are `Content-Length: <n>\r\n[other-headers\r\n]\r\n<n body
 * bytes>`; the header name is case-insensitive and the length counts BYTES, so multibyte
 * UTF-8 bodies and chunk boundaries that split a character are handled by buffering raw bytes
 * and decoding only complete bodies.
 *
 * Responsible for: byte-exact Content-Length frame encoding and incremental decoding.
 * Not for: JSON-RPC semantics (ids, results, errors) - ./stdio-transport owns those.
 */

/** Safety cap on a declared body size, so a corrupt header cannot make the host buffer GBs. */
export const MAX_FRAME_BODY_BYTES = 32 * 1024 * 1024;

const HEADER_TERMINATOR = "\r\n\r\n";

/** Encodes one frame with a byte-counted Content-Length header. */
export function encodeFrame(body: string): Buffer {
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`, "utf8");
}

export interface FrameParser {
  /** Feeds bytes in; returns every now-complete frame body, decoded as UTF-8, in order.
   *  Throws {@link McpFramingError} on a header block without a usable Content-Length. */
  readonly push: (chunk: Buffer | string) => string[];
  /** Bytes currently buffered awaiting a complete frame (diagnostic). */
  readonly buffered: () => number;
}

/** Creates an incremental parser; one instance per byte stream. */
export function createFrameParser(): FrameParser {
  let buffer: Buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      buffer = buffer.length === 0 ? bytes : Buffer.concat([buffer, bytes]);
      const frames: string[] = [];
      while (true) {
        const headerEnd = buffer.indexOf(HEADER_TERMINATOR);
        if (headerEnd === -1) {
          break; // partial header - wait for more bytes
        }
        const length = contentLength(buffer.subarray(0, headerEnd).toString("utf8"));
        const bodyStart = headerEnd + HEADER_TERMINATOR.length;
        if (buffer.length < bodyStart + length) {
          break; // partial body - wait for more bytes
        }
        frames.push(buffer.subarray(bodyStart, bodyStart + length).toString("utf8"));
        buffer = buffer.subarray(bodyStart + length);
      }
      return frames;
    },
    buffered: () => buffer.length,
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
