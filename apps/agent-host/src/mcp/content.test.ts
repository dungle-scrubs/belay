import { describe, expect, test } from "vitest";
import {
  boundPromptMessages,
  boundText,
  decodePromptMessages,
  decodeResourceContents,
  decodeToolCallResult,
} from "./content";

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

describe("decodePromptMessages", () => {
  test("decodes description and role/text messages", () => {
    const outcome = decodePromptMessages({
      description: "a fixture prompt",
      messages: [
        { role: "user", content: { type: "text", text: "hello" } },
        { role: "assistant", content: { type: "text", text: "hi back" } },
      ],
    });
    expect(outcome).toEqual({
      description: "a fixture prompt",
      messages: [
        { role: "user", text: "hello" },
        { role: "assistant", text: "hi back" },
      ],
    });
  });

  test("describes non-text prompt content and tolerates malformed entries", () => {
    const outcome = decodePromptMessages({
      messages: [
        { role: "user", content: { type: "image", mimeType: "image/png", data: "AAAA" } },
        { content: { type: "text", text: "roleless" } },
        null,
      ],
    });
    expect(outcome.messages).toEqual([
      { role: "user", text: "[image image/png]" },
      { role: "user", text: "roleless" },
    ]);
    expect(outcome.description).toBeUndefined();
  });

  test("tolerates a malformed result", () => {
    expect(decodePromptMessages(undefined)).toEqual({ messages: [] });
    expect(decodePromptMessages({ messages: "nope" })).toEqual({ messages: [] });
  });
});

describe("boundPromptMessages", () => {
  test("keeps a small expansion intact", () => {
    const bounded = boundPromptMessages([{ role: "user", text: "short" }], 100);
    expect(bounded).toEqual({
      messages: [{ role: "user", text: "short" }],
      truncated: false,
    });
  });

  test("bounds the TOTAL expansion across messages and drops the overflow", () => {
    const bounded = boundPromptMessages(
      [
        { role: "user", text: "a".repeat(80) },
        { role: "user", text: "b".repeat(80) },
        { role: "user", text: "c".repeat(80) },
      ],
      100,
    );
    expect(bounded.truncated).toBe(true);
    const total = bounded.messages.reduce((sum, message) => sum + message.text.length, 0);
    expect(total).toBeLessThanOrEqual(100 + "\n…[truncated]".length);
    expect(bounded.messages.length).toBeLessThan(3);
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
