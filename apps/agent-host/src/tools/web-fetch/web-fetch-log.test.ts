import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  errorCategoryFor,
  hostOf,
  lastWebFetchError,
  logWebFetchAttempt,
  resetWebFetchError,
} from "./web-fetch-log";

/**
 * Plan 04 M8: the web_fetch redacted observability. These pin that the one boundary log line carries
 * ONLY {backend, host, status, durationMs, bytes, caps, errorCategory} - never a key, header,
 * URL-query, or response body - that the fetched CONTENT never reaches a log, and that the doctor's
 * "last backend error" is the sanitized category only.
 */

const logs: string[] = [];
const originalLog = console.log;

function captureLogs(): void {
  logs.length = 0;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
}

afterEach(() => {
  console.log = originalLog;
  resetWebFetchError();
});

test("hostOf returns the hostname only, never the path/query", () => {
  assert.equal(
    hostOf("https://docs.example.com/secret/page?token=abc123&key=sk-XYZ"),
    "docs.example.com",
  );
  assert.equal(hostOf("not a url"), "invalid-url");
});

test("errorCategoryFor reduces a sanitized detail to its leading category token", () => {
  assert.equal(errorCategoryFor({ backend: "static", status: "usable" }), undefined);
  assert.equal(
    errorCategoryFor({ backend: "jina", status: "failed", detail: "jina error: ECONNRESET" }),
    "jina error",
  );
  assert.equal(
    errorCategoryFor({
      backend: "firecrawl",
      status: "failed",
      detail: "firecrawl unavailable (no key)",
    }),
    "firecrawl unavailable",
  );
  // No detail falls back to the status classification, never an empty/blank category.
  assert.equal(errorCategoryFor({ backend: "static", status: "blocked" }), "blocked");
});

test("the log line carries only the sanitized field set - no key, header, query, or body", () => {
  captureLogs();

  logWebFetchAttempt({
    backend: "jina",
    host: "docs.example.com",
    status: "failed",
    durationMs: 1234,
    bytes: 4096,
    caps: { maxBytes: 2_000_000, maxChars: 12_000 },
    errorCategory: "jina error",
  });

  assert.equal(logs.length, 1, "exactly one boundary line");
  const line = logs[0] ?? "";

  // The expected redacted fields are present.
  assert.match(line, /backend=jina/);
  assert.match(line, /host=docs\.example\.com/);
  assert.match(line, /status=failed/);
  assert.match(line, /durationMs=1234/);
  assert.match(line, /bytes=4096/);
  assert.match(line, /maxBytes=2000000/);
  assert.match(line, /maxChars=12000/);
  assert.match(line, /errorCategory="?jina error"?/);

  // Nothing secret-bearing leaks: no Authorization/key, no full URL path/query, no response body.
  assert.ok(!/Authorization|bearer|sk-|api[_-]?key/i.test(line), "no key/header in the log");
  assert.ok(!/\?|token=|\/secret\//.test(line), "no URL query or path in the log");
});

test("fetched content is never an accepted log field (the record has no content slot)", () => {
  captureLogs();
  const body = "TOP SECRET PAGE BODY that must never be logged";

  logWebFetchAttempt({
    backend: "static",
    host: "example.com",
    status: "usable",
    durationMs: 10,
    bytes: body.length,
    caps: { maxBytes: 100, maxChars: 100 },
  });

  assert.ok(!(logs[0] ?? "").includes(body), "the page body is never written to the log");
});

test("a failed attempt records the sanitized category as the doctor's last error; usable does not", () => {
  assert.equal(lastWebFetchError(), undefined, "clean to start");

  captureLogs();
  logWebFetchAttempt({
    backend: "static",
    host: "example.com",
    status: "usable",
    durationMs: 5,
    bytes: 100,
    caps: { maxBytes: 100, maxChars: 100 },
  });
  assert.equal(lastWebFetchError(), undefined, "a usable attempt sets no last error");

  logWebFetchAttempt({
    backend: "jina",
    host: "example.com",
    status: "failed",
    durationMs: 20,
    bytes: 0,
    caps: { maxBytes: 100, maxChars: 100 },
    errorCategory: "jina error",
  });
  assert.equal(lastWebFetchError(), "jina error", "a failed attempt records its category only");
});
