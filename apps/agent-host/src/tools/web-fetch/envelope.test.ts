import assert from "node:assert/strict";
import { test } from "vitest";
import { serializeResult, type WebFetchResult } from "./envelope";

/**
 * The result envelope is the web_fetch contract the model reads and the web renders. These
 * pin the full-field round-trip and that absent optional fields are omitted (a lean wire form
 * matching web_search), so the next phase's renderer and fallback ladder build on a stable shape.
 */

test("serializeResult round-trips every field, including all attempt outcomes", () => {
  const result: WebFetchResult = {
    url: "https://example.com/article",
    finalUrl: "https://example.com/article?canonical=1",
    title: "An Article",
    contentType: "text/html; charset=utf-8",
    status: 200,
    fetchedAt: "2026-06-29T00:00:00.000Z",
    byteCount: 4096,
    textLength: 1200,
    truncated: true,
    backend: "static",
    attempts: [
      { backend: "static", status: "thin", detail: "low content" },
      { backend: "static", status: "usable" },
    ],
    needsFallback: true,
    content: "# An Article\n\nbody text",
  };

  const parsed = JSON.parse(serializeResult(result));

  assert.equal(parsed.url, result.url);
  assert.equal(parsed.finalUrl, result.finalUrl);
  assert.equal(parsed.title, result.title);
  assert.equal(parsed.contentType, result.contentType);
  assert.equal(parsed.status, result.status);
  assert.equal(parsed.fetchedAt, result.fetchedAt);
  assert.equal(parsed.byteCount, result.byteCount);
  assert.equal(parsed.textLength, result.textLength);
  assert.equal(parsed.truncated, result.truncated);
  assert.equal(parsed.backend, result.backend);
  assert.equal(parsed.needsFallback, result.needsFallback);
  assert.equal(parsed.content, result.content);
  assert.deepEqual(parsed.attempts, [
    { backend: "static", status: "thin", detail: "low content" },
    { backend: "static", status: "usable" },
  ]);
});

test("serializeResult omits absent optional fields (title, contentType, status, attempt detail)", () => {
  const result: WebFetchResult = {
    url: "https://example.com/raw",
    finalUrl: "https://example.com/raw",
    fetchedAt: "2026-06-29T00:00:00.000Z",
    byteCount: 10,
    textLength: 10,
    truncated: false,
    backend: "static",
    attempts: [{ backend: "static", status: "usable" }],
    needsFallback: false,
    content: "plain text",
  };

  const parsed = JSON.parse(serializeResult(result));

  assert.ok(!("title" in parsed), "absent title is omitted");
  assert.ok(!("contentType" in parsed), "absent contentType is omitted");
  assert.ok(!("status" in parsed), "absent status is omitted");
  assert.ok(!("detail" in parsed.attempts[0]), "absent attempt detail is omitted");
});
