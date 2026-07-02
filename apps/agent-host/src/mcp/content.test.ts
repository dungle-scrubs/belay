import { describe, expect, test } from "vitest";
import { boundText, decodeResourceContents, decodeToolCallResult } from "./content";

describe("decodeToolCallResult", () => {
  test("joins text blocks and reports no error", () => {
    const outcome = decodeToolCallResult({
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    });
    expect(outcome).toEqual({ text: "first\nsecond", isError: false });
  });

  test("carries the isError flag through", () => {
    const outcome = decodeToolCallResult({
      content: [{ type: "text", text: "external service exploded" }],
      isError: true,
    });
    expect(outcome).toEqual({ text: "external service exploded", isError: true });
  });

  test("describes non-text media blocks instead of dumping bytes", () => {
    const outcome = decodeToolCallResult({
      content: [
        { type: "image", mimeType: "image/png", data: "AAAA".repeat(500) },
        { type: "audio", mimeType: "audio/wav", data: "BBBB" },
      ],
    });
    expect(outcome.text).toBe("[image image/png]\n[audio audio/wav]");
    expect(outcome.text).not.toContain("AAAA");
  });

  test("inlines embedded resource text and references a blob-only resource by uri", () => {
    const outcome = decodeToolCallResult({
      content: [
        { type: "resource", resource: { uri: "srv://a", text: "embedded text" } },
        { type: "resource", resource: { uri: "srv://b", blob: "Zm9v" } },
        { type: "resource_link", uri: "srv://c", name: "linked" },
      ],
    });
    expect(outcome.text).toBe("embedded text\n[resource srv://b]\n[resource srv://c]");
  });

  test("tolerates unknown block types and malformed shapes", () => {
    const outcome = decodeToolCallResult({
      content: [{ type: "hologram" }, null, "bare string", { text: "typeless" }],
    });
    expect(outcome).toEqual({ text: "[hologram content]", isError: false });
  });

  test("tolerates a result without content", () => {
    expect(decodeToolCallResult({})).toEqual({ text: "", isError: false });
    expect(decodeToolCallResult(undefined)).toEqual({ text: "", isError: false });
    expect(decodeToolCallResult("nope")).toEqual({ text: "", isError: false });
  });
});

describe("decodeResourceContents", () => {
  test("joins text contents and keeps the first mime type", () => {
    const outcome = decodeResourceContents({
      contents: [
        { uri: "srv://a", mimeType: "text/plain", text: "line one" },
        { uri: "srv://a", text: "line two" },
      ],
    });
    expect(outcome).toEqual({ text: "line one\nline two", mimeType: "text/plain" });
  });

  test("describes blob contents instead of dumping base64", () => {
    const blob = "QUJD".repeat(100);
    const outcome = decodeResourceContents({
      contents: [{ uri: "srv://bin", mimeType: "application/octet-stream", blob }],
    });
    expect(outcome.text).toBe(`[binary application/octet-stream, ${blob.length} base64 chars]`);
    expect(outcome.text).not.toContain("QUJD");
  });

  test("tolerates malformed results", () => {
    expect(decodeResourceContents(undefined)).toEqual({ text: "" });
    expect(decodeResourceContents({ contents: "nope" })).toEqual({ text: "" });
    expect(decodeResourceContents({ contents: [null, 4] })).toEqual({ text: "" });
  });
});

describe("boundText", () => {
  test("returns short text unchanged", () => {
    expect(boundText("hello", 10)).toEqual({ text: "hello", truncated: false });
  });

  test("bounds long text with the host truncation marker", () => {
    const bounded = boundText("z".repeat(50), 10);
    expect(bounded.truncated).toBe(true);
    expect(bounded.text).toBe(`${"z".repeat(10)}\n…[truncated]`);
  });

  test("defaults to the host MAX_OUTPUT cap", async () => {
    const { MAX_OUTPUT } = await import("@host/tools/shared");
    const bounded = boundText("y".repeat(MAX_OUTPUT + 1));
    expect(bounded.truncated).toBe(true);
    expect(bounded.text.startsWith("y".repeat(MAX_OUTPUT))).toBe(true);
  });
});
