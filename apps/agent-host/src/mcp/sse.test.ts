import { describe, expect, test } from "vitest";
import { createSseParser } from "./sse";

describe("SSE parser", () => {
  test("parses a single data event", () => {
    const parser = createSseParser();
    expect(parser.push('data: {"ok":true}\n\n')).toEqual(['{"ok":true}']);
  });

  test("joins multi-line data with newlines", () => {
    const parser = createSseParser();
    expect(parser.push("data: first\ndata: second\n\n")).toEqual(["first\nsecond"]);
  });

  test("returns multiple events completed in one chunk, in order", () => {
    const parser = createSseParser();
    expect(parser.push("data: one\n\ndata: two\n\n")).toEqual(["one", "two"]);
  });

  test("assembles an event split across chunks", () => {
    const parser = createSseParser();
    expect(parser.push("data: par")).toEqual([]);
    expect(parser.push("tial\n")).toEqual([]);
    expect(parser.push("\n")).toEqual(["partial"]);
  });

  test("handles \\r\\n line endings, including one split across chunks", () => {
    const parser = createSseParser();
    expect(parser.push("data: a\r")).toEqual([]);
    expect(parser.push("\ndata: b\r\n\r\n")).toEqual(["a\nb"]);
  });

  test("ignores comments and non-data fields", () => {
    const parser = createSseParser();
    expect(parser.push(": keep-alive\nevent: message\nid: 3\nretry: 100\ndata: x\n\n")).toEqual([
      "x",
    ]);
  });

  test("a blank line without data emits nothing", () => {
    const parser = createSseParser();
    expect(parser.push("\n\n: ping\n\n")).toEqual([]);
  });

  test("strips exactly one leading space from a data value", () => {
    const parser = createSseParser();
    expect(parser.push("data:  padded\n\n")).toEqual([" padded"]);
  });

  test("a bare `data` line contributes an empty data line", () => {
    const parser = createSseParser();
    expect(parser.push("data\ndata: x\n\n")).toEqual(["\nx"]);
  });

  test("buffered() reports pending characters awaiting a complete line", () => {
    const parser = createSseParser();
    parser.push("data: pend");
    expect(parser.buffered()).toBeGreaterThan(0);
    parser.push("ing\n\n");
    expect(parser.buffered()).toBe(0);
  });
});
