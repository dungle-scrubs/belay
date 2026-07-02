/**
 * The stdio Content-Length frame plumbing the protocol fixture SERVERS share (the MCP stdio
 * fixture and both LSP fixtures): a stdin pump that reassembles framed JSON-RPC bodies and the
 * stdout writers that frame replies. Deliberately independent of src/mcp/framing - the
 * production parser - so fixture traffic stays cross-implementation, never self-confirming;
 * this module is the fixtures' OWN tiny implementation, shared only among them.
 *
 * Responsible for: fixture-side stdin frame pumping and stdout frame writing.
 * Not for: fixture method dispatch (each fixture owns its behavior) or production framing
 * (src/mcp/framing.ts).
 */

/**
 * Pumps framed bodies out of this process's stdin: every complete Content-Length frame invokes
 * `onBody` with its body text, a malformed header exits 2, and stdin ending exits 0 (the
 * fixture convention a closing client relies on).
 */
export function pumpStdinFrames(onBody: (body: string) => void): void {
  let buffer = Buffer.alloc(0);

  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match?.[1]) {
        process.exit(2);
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) {
        return;
      }
      const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.subarray(bodyStart + length);
      onBody(body);
    }
  });

  process.stdin.on("end", () => process.exit(0));
}

/** Writes one raw (possibly non-JSON) body to stdout as a Content-Length frame. */
export function sendRaw(body: string): void {
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

/** Writes one JSON message to stdout as a Content-Length frame. */
export function send(message: unknown): void {
  sendRaw(JSON.stringify(message));
}
