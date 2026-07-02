/**
 * Incremental Server-Sent Events decoding for the MCP Streamable HTTP transport (plan 23 M3):
 * a pure line-oriented parser in the ./framing tradition - feed decoded text in, get completed
 * event data payloads out. Handles `\n`, `\r`, and `\r\n` line endings (including a `\r\n`
 * split across chunks), multi-line `data:` accumulation joined with newlines, `:` comment
 * lines, and ignores non-data fields (`event:`, `id:`, `retry:`) - MCP messages ride entirely
 * in `data`. Callers own byte decoding (a streaming TextDecoder), since SSE is defined over
 * text, not byte counts.
 *
 * Responsible for: incremental SSE event-stream decoding into event data payloads.
 * Not for: JSON-RPC interpretation of those payloads - ./http-transport owns that.
 */

export interface SseParser {
  /** Feeds decoded text in; returns the data payload of every now-complete event, in order. */
  readonly push: (chunk: string) => string[];
  /** Characters currently buffered awaiting a complete line or event (diagnostic). */
  readonly buffered: () => number;
}

/** Creates an incremental parser; one instance per event stream. */
export function createSseParser(): SseParser {
  let buffer = "";
  let dataLines: string[] = [];

  const handleLine = (line: string, events: string[]): void => {
    if (line === "") {
      // A blank line dispatches the pending event; one with no data dispatches nothing.
      if (dataLines.length > 0) {
        events.push(dataLines.join("\n"));
        dataLines = [];
      }
      return;
    }
    if (line.startsWith(":")) {
      return; // comment (keep-alive)
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== "data") {
      return; // event/id/retry and unknown fields carry nothing for MCP
    }
    const raw = colon === -1 ? "" : line.slice(colon + 1);
    dataLines.push(raw.startsWith(" ") ? raw.slice(1) : raw);
  };

  return {
    push(chunk) {
      buffer += chunk;
      const events: string[] = [];
      while (true) {
        const match = /[\r\n]/.exec(buffer);
        if (!match) {
          break; // partial line - wait for more text
        }
        const at = match.index;
        if (buffer[at] === "\r" && at === buffer.length - 1) {
          break; // the next chunk may open with the "\n" of a split "\r\n"
        }
        const next = buffer[at] === "\r" && buffer[at + 1] === "\n" ? at + 2 : at + 1;
        handleLine(buffer.slice(0, at), events);
        buffer = buffer.slice(next);
      }
      return events;
    },
    buffered: () => buffer.length + dataLines.reduce((sum, line) => sum + line.length, 0),
  };
}
