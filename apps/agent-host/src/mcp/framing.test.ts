import { describe, expect, test } from "vitest";
import { createFrameParser, encodeFrame, MAX_FRAME_BODY_BYTES } from "./framing";

function frame(body: string, header = `Content-Length: ${Buffer.byteLength(body)}`): Buffer {
  return Buffer.from(`${header}\r\n\r\n${body}`, "utf8");
}

describe("encodeFrame", () => {
  test("emits a byte-counted Content-Length header", () => {
    expect(encodeFrame("{}").toString("utf8")).toBe("Content-Length: 2\r\n\r\n{}");
  });

  test("counts bytes, not code units, for multibyte bodies", () => {
    const body = "héllo 世界 🎈";
    expect(Buffer.byteLength(body)).toBeGreaterThan(body.length);
    expect(encodeFrame(body).toString("utf8")).toBe(
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  });

  test("round-trips through the parser", () => {
    const parser = createFrameParser();
    expect(parser.push(encodeFrame('{"a":"héllo 世界"}'))).toEqual(['{"a":"héllo 世界"}']);
  });
});

describe("createFrameParser", () => {
  test("parses a single complete frame", () => {
    const parser = createFrameParser();
    expect(parser.push(frame('{"id":1}'))).toEqual(['{"id":1}']);
    expect(parser.buffered()).toBe(0);
  });

  test("parses multiple frames arriving in one chunk", () => {
    const parser = createFrameParser();
    const chunk = Buffer.concat([frame("first"), frame("second"), frame("third")]);
    expect(parser.push(chunk)).toEqual(["first", "second", "third"]);
  });

  test("holds a partial frame split mid-header until the rest arrives", () => {
    const parser = createFrameParser();
    const whole = frame('{"id":2}');
    expect(parser.push(whole.subarray(0, 7))).toEqual([]);
    expect(parser.push(whole.subarray(7))).toEqual(['{"id":2}']);
  });

  test("holds a partial frame split mid-body until the rest arrives", () => {
    const parser = createFrameParser();
    const whole = frame('{"id":3}');
    expect(parser.push(whole.subarray(0, whole.length - 3))).toEqual([]);
    expect(parser.push(whole.subarray(whole.length - 3))).toEqual(['{"id":3}']);
  });

  test("reassembles a multibyte character split across chunks", () => {
    const parser = createFrameParser();
    const whole = encodeFrame('{"text":"日本語"}');
    // Split inside the final multibyte character's byte sequence.
    expect(parser.push(whole.subarray(0, whole.length - 2))).toEqual([]);
    expect(parser.push(whole.subarray(whole.length - 2))).toEqual(['{"text":"日本語"}']);
  });

  test("accepts a case-insensitive Content-Length header", () => {
    const parser = createFrameParser();
    expect(parser.push(frame("a", "content-length: 1"))).toEqual(["a"]);
    expect(parser.push(frame("b", "CONTENT-LENGTH: 1"))).toEqual(["b"]);
    expect(parser.push(frame("c", "Content-length: 1"))).toEqual(["c"]);
  });

  test("ignores additional headers in the block", () => {
    const parser = createFrameParser();
    const chunk = frame("ok", "Content-Type: application/vscode-jsonrpc\r\nContent-Length: 2");
    expect(parser.push(chunk)).toEqual(["ok"]);
  });

  test("a header block without a Content-Length is a typed framing error", () => {
    const parser = createFrameParser();
    expect(() => parser.push(Buffer.from("Content-Type: text/plain\r\n\r\nbody"))).toThrowError(
      expect.objectContaining({ _tag: "McpFramingError" }),
    );
  });

  test("a non-numeric Content-Length is a typed framing error", () => {
    const parser = createFrameParser();
    expect(() => parser.push(Buffer.from("Content-Length: lots\r\n\r\nbody"))).toThrowError(
      expect.objectContaining({ _tag: "McpFramingError" }),
    );
  });

  test("a declared body beyond the cap is a typed framing error", () => {
    const parser = createFrameParser();
    expect(() =>
      parser.push(Buffer.from(`Content-Length: ${MAX_FRAME_BODY_BYTES + 1}\r\n\r\n`)),
    ).toThrowError(expect.objectContaining({ _tag: "McpFramingError" }));
  });
});
