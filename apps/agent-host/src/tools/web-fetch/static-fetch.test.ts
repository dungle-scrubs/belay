import assert from "node:assert/strict";
import { test } from "vitest";
import {
  type FetchLike,
  type FetchLikeResponse,
  StaticFetchError,
  type StaticFetchInit,
  staticFetch,
} from "./static-fetch";

/**
 * Static-fetch coverage over an injected fetch: HTML/text/JSON/unknown content types, a manual
 * redirect chain (each hop guarded), 404, 5xx, timeout, and the byte cap. The injected IO also
 * lets the request itself be asserted - no cookies and no authorization header may be sent (web_fetch
 * reads only public URLs). All deterministic; nothing touches the real network.
 */

const OPTIONS = { maxBytes: 1024, maxRedirects: 5, timeoutMs: 1000 };

interface FakeResponse {
  readonly status: number;
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string | Uint8Array;
}

function response(spec: FakeResponse, requestedUrl: string): FetchLikeResponse {
  const headers = spec.headers ?? {};
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const body = spec.body ?? "";
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;

  return {
    status: spec.status,
    url: spec.url ?? requestedUrl,
    headers: { get: (name) => lower.get(name.toLowerCase()) ?? null },
    arrayBuffer: async () => {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return copy.buffer;
    },
  };
}

/** Serves a scripted response per URL and records every request's init for assertions. */
function fakeFetch(routes: Record<string, FakeResponse>): {
  fetch: FetchLike;
  requests: { url: string; init: StaticFetchInit }[];
} {
  const requests: { url: string; init: StaticFetchInit }[] = [];

  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, init });

    const spec = routes[url];

    if (!spec) {
      throw new Error(`unexpected request to ${url}`);
    }

    return response(spec, url);
  };

  return { fetch, requests };
}

test("fetches HTML and captures status, content-type, and final URL", async () => {
  const { fetch } = fakeFetch({
    "https://example.com/page": {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: "<html><body>hi</body></html>",
    },
  });

  const result = await staticFetch("https://example.com/page", { fetch, ...OPTIONS });

  assert.equal(result.status, 200);
  assert.equal(result.contentType, "text/html; charset=utf-8");
  assert.equal(result.finalUrl, "https://example.com/page");
  assert.ok(result.body.includes("hi"));
  assert.equal(result.bodyTruncated, false);
});

test("fetches plain text and JSON bodies", async () => {
  const { fetch } = fakeFetch({
    "https://example.com/note.txt": {
      status: 200,
      headers: { "content-type": "text/plain" },
      body: "just text",
    },
    "https://example.com/data.json": {
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
    },
  });

  const text = await staticFetch("https://example.com/note.txt", { fetch, ...OPTIONS });
  assert.equal(text.body, "just text");

  const json = await staticFetch("https://example.com/data.json", { fetch, ...OPTIONS });
  assert.equal(json.body, '{"ok":true}');
});

test("handles an unknown content type as raw bytes", async () => {
  const { fetch } = fakeFetch({
    "https://example.com/blob": {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
      body: "raw",
    },
  });

  const result = await staticFetch("https://example.com/blob", { fetch, ...OPTIONS });
  assert.equal(result.contentType, "application/octet-stream");
  assert.equal(result.body, "raw");
});

test("never sends cookies or an authorization header", async () => {
  const { fetch, requests } = fakeFetch({
    "https://example.com/p": { status: 200, body: "ok" },
  });

  await staticFetch("https://example.com/p", { fetch, ...OPTIONS });

  const first = requests[0];
  assert.ok(first, "the request was issued");

  const headerNames = Object.keys(first.init.headers).map((h) => h.toLowerCase());
  assert.ok(!headerNames.includes("cookie"), "no cookie header");
  assert.ok(!headerNames.includes("authorization"), "no authorization header");
  assert.equal(first.init.redirect, "manual", "redirects are followed manually");
});

test("follows a redirect chain through the guard to the final response", async () => {
  const { fetch, requests } = fakeFetch({
    "https://example.com/start": {
      status: 301,
      headers: { location: "https://example.com/mid" },
    },
    "https://example.com/mid": {
      status: 302,
      headers: { location: "https://example.com/end" },
    },
    "https://example.com/end": {
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<html>done</html>",
    },
  });

  const result = await staticFetch("https://example.com/start", { fetch, ...OPTIONS });

  assert.equal(result.status, 200);
  assert.equal(result.finalUrl, "https://example.com/end");
  assert.equal(requests.length, 3);
});

test("rejects a redirect that targets a private address", async () => {
  const { fetch } = fakeFetch({
    "https://example.com/start": {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" },
    },
  });

  await assert.rejects(
    () => staticFetch("https://example.com/start", { fetch, ...OPTIONS }),
    StaticFetchError,
  );
});

test("caps the redirect chain", async () => {
  const { fetch } = fakeFetch({
    "https://example.com/0": { status: 302, headers: { location: "https://example.com/1" } },
    "https://example.com/1": { status: 302, headers: { location: "https://example.com/2" } },
    "https://example.com/2": { status: 302, headers: { location: "https://example.com/3" } },
  });

  await assert.rejects(
    () =>
      staticFetch("https://example.com/0", {
        fetch,
        maxBytes: 1024,
        maxRedirects: 1,
        timeoutMs: 1000,
      }),
    /too many redirects/,
  );
});

test("returns a 404 response as a normal result", async () => {
  const { fetch } = fakeFetch({
    "https://example.com/missing": {
      status: 404,
      headers: { "content-type": "text/html" },
      body: "<html>not found</html>",
    },
  });

  const result = await staticFetch("https://example.com/missing", { fetch, ...OPTIONS });
  assert.equal(result.status, 404);
});

test("returns a 5xx response as a normal result", async () => {
  const { fetch } = fakeFetch({
    "https://example.com/boom": { status: 503, body: "down" },
  });

  const result = await staticFetch("https://example.com/boom", { fetch, ...OPTIONS });
  assert.equal(result.status, 503);
});

test("surfaces a timeout (aborted request) as a StaticFetchError", async () => {
  const fetch: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    });

  await assert.rejects(
    () =>
      staticFetch("https://example.com/slow", {
        fetch,
        maxBytes: 1024,
        maxRedirects: 5,
        timeoutMs: 5,
      }),
    /timed out/,
  );
});

test("caps an oversized body at maxBytes and flags truncation", async () => {
  const big = "a".repeat(5000);
  const { fetch } = fakeFetch({
    "https://example.com/big": {
      status: 200,
      headers: { "content-type": "text/plain" },
      body: big,
    },
  });

  const result = await staticFetch("https://example.com/big", {
    fetch,
    maxBytes: 100,
    maxRedirects: 5,
    timeoutMs: 1000,
  });

  assert.equal(result.byteCount, 5000);
  assert.equal(result.body.length, 100);
  assert.equal(result.bodyTruncated, true);
});
