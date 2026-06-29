import assert from "node:assert/strict";
import { test } from "vitest";
import { type FirecrawlFetchDeps, firecrawlFetch } from "./firecrawl-fetch";

/**
 * Firecrawl backend coverage over an injected fetch: a missing key short-circuits to a typed
 * unavailable failure with no request; the request is ONLY scrape + markdown + onlyMainContent (no
 * crawl/map/search/extract/screenshots/actions/profiles/cookies/headers/proxy); and a rate limit,
 * provider error, timeout, and success all normalize into a typed outcome. The key is never echoed
 * into a detail, the char cap applies, and an unsafe target is rejected before any request.
 */

const SAFE_RESOLVER = (host: string) => (host === "example.com" ? ["93.184.216.34"] : []);

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    status,
    url: "https://api.firecrawl.dev/v1/scrape",
    json: async () => payload,
  } as unknown as Response;
}

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function capturingFetch(response: Response): {
  fetch: typeof globalThis.fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];

  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return response;
  }) as unknown as typeof globalThis.fetch;

  return { fetch, calls };
}

function deps(
  fetch: typeof globalThis.fetch,
  overrides: Partial<FirecrawlFetchDeps> = {},
): FirecrawlFetchDeps {
  return {
    fetch,
    resolveHost: SAFE_RESOLVER,
    apiKey: "fc-test-key",
    maxChars: 12_000,
    timeoutMs: 1000,
    ...overrides,
  };
}

test("a missing key returns a typed unavailable failure with no request", async () => {
  const { fetch, calls } = capturingFetch(jsonResponse({ data: { markdown: "x" } }));

  const outcome = await firecrawlFetch("https://example.com/p", deps(fetch, { apiKey: undefined }));

  assert.equal(outcome.status, "failed");
  assert.ok("detail" in outcome && /unavailable|not configured/i.test(outcome.detail));
  assert.equal(calls.length, 0, "no request when the key is absent");
});

test("the request is ONLY scrape + markdown + onlyMainContent, with no excluded features", async () => {
  const { fetch, calls } = capturingFetch(
    jsonResponse({ data: { markdown: `# Doc\n\n${"Body. ".repeat(60)}` } }),
  );

  await firecrawlFetch("https://example.com/p", deps(fetch));

  const call = calls[0];
  assert.ok(call, "a request was issued");
  assert.equal(call.url, "https://api.firecrawl.dev/v1/scrape");
  assert.equal(call.method, "POST");
  assert.equal(call.headers.authorization, "Bearer fc-test-key");

  const body = call.body as Record<string, unknown>;
  assert.deepEqual(body, {
    url: "https://example.com/p",
    formats: ["markdown"],
    onlyMainContent: true,
  });

  // No excluded Firecrawl feature may appear in the request body.
  for (const excluded of [
    "crawl",
    "map",
    "search",
    "extract",
    "json",
    "screenshot",
    "actions",
    "profile",
    "cookies",
    "headers",
    "proxy",
    "includeTags",
    "excludeTags",
  ]) {
    assert.ok(!(excluded in body), `excluded feature "${excluded}" must not be in the body`);
  }
});

test("a successful scrape returns the markdown classified usable", async () => {
  const markdown = `# Title\n\n${"Real content. ".repeat(40)}`;
  const { fetch } = capturingFetch(jsonResponse({ success: true, data: { markdown } }));

  const outcome = await firecrawlFetch("https://example.com/p", deps(fetch));

  assert.equal(outcome.status, "usable");
  assert.ok("content" in outcome && outcome.content.content.includes("Real content."));
  assert.ok("finalUrl" in outcome && outcome.finalUrl === "https://example.com/p");
});

test("a near-empty scrape is classified thin", async () => {
  const { fetch } = capturingFetch(jsonResponse({ data: { markdown: "tiny" } }));

  const outcome = await firecrawlFetch("https://example.com/p", deps(fetch));

  assert.equal(outcome.status, "thin");
});

test("a response with no markdown is a failed outcome", async () => {
  const { fetch } = capturingFetch(jsonResponse({ success: false, data: {} }));

  const outcome = await firecrawlFetch("https://example.com/p", deps(fetch));

  assert.equal(outcome.status, "failed");
  assert.ok("detail" in outcome && /no markdown/i.test(outcome.detail));
});

test("a 429 normalizes to a blocked rate-limit outcome", async () => {
  const { fetch } = capturingFetch(jsonResponse({}, 429));

  const outcome = await firecrawlFetch("https://example.com/p", deps(fetch));

  assert.equal(outcome.status, "blocked");
  assert.ok("detail" in outcome && /rate limit/i.test(outcome.detail));
});

test("a provider 5xx normalizes to a failed outcome with the status", async () => {
  const { fetch } = capturingFetch(jsonResponse({}, 502));

  const outcome = await firecrawlFetch("https://example.com/p", deps(fetch));

  assert.equal(outcome.status, "failed");
  assert.ok("detail" in outcome && outcome.detail.includes("502"));
});

test("a timeout normalizes to a failed outcome", async () => {
  const fetch = ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    })) as unknown as typeof globalThis.fetch;

  const outcome = await firecrawlFetch("https://example.com/p", deps(fetch, { timeoutMs: 5 }));

  assert.equal(outcome.status, "failed");
  assert.ok("detail" in outcome && /timed out/.test(outcome.detail));
});

test("the char cap truncates oversized markdown", async () => {
  const { fetch } = capturingFetch(jsonResponse({ data: { markdown: "z".repeat(5000) } }));

  const outcome = await firecrawlFetch("https://example.com/p", deps(fetch, { maxChars: 100 }));

  assert.equal(outcome.status, "usable");
  assert.ok("content" in outcome && outcome.content.truncated);
});

test("an unsafe target is rejected by the guard before any request", async () => {
  const { fetch, calls } = capturingFetch(jsonResponse({ data: { markdown: "never" } }));

  const outcome = await firecrawlFetch("http://169.254.169.254/latest/meta-data", deps(fetch));

  assert.equal(outcome.status, "failed");
  assert.ok("detail" in outcome && /reject|private|not allowed/i.test(outcome.detail));
  assert.equal(calls.length, 0, "no request for an unsafe target");
});
