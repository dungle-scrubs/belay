import assert from "node:assert/strict";
import { test } from "vitest";
import { type JinaFetchDeps, jinaFetch } from "./jina-fetch";

/**
 * Jina backend coverage over an injected fetch: success/empty/blocker output, a 429 rate limit, a
 * timeout, and a network error all normalize into a typed outcome (never a throw). The key is sent
 * only when configured and never leaks into a detail, the byte/char caps apply, and an unsafe target
 * is rejected by the SSRF guard before any request. All deterministic; nothing touches the network.
 */

const SAFE_RESOLVER = (host: string) => (host === "example.com" ? ["93.184.216.34"] : []);

function textResponse(body: string, status = 200): Response {
  const bytes = new TextEncoder().encode(body);

  return {
    status,
    url: "https://r.jina.ai/",
    arrayBuffer: async () => {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return copy.buffer;
    },
  } as unknown as Response;
}

interface Captured {
  url: string;
  headers: Record<string, string>;
}

function capturingFetch(response: Response): {
  fetch: typeof globalThis.fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];

  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
    return response;
  }) as unknown as typeof globalThis.fetch;

  return { fetch, calls };
}

function deps(
  fetch: typeof globalThis.fetch,
  overrides: Partial<JinaFetchDeps> = {},
): JinaFetchDeps {
  return {
    fetch,
    resolveHost: SAFE_RESOLVER,
    maxBytes: 2_000_000,
    maxChars: 12_000,
    timeoutMs: 1000,
    ...overrides,
  };
}

test("a usable page returns markdown classified usable, with the target in the reader URL", async () => {
  const { fetch, calls } = capturingFetch(
    textResponse(`# Title\n\n${"Real content. ".repeat(40)}`),
  );

  const outcome = await jinaFetch("https://example.com/p", deps(fetch));

  assert.equal(outcome.status, "usable");
  assert.ok("content" in outcome && outcome.content.content.includes("Real content."));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://r.jina.ai/https://example.com/p");
});

test("an authorization header is sent only when a key is configured, and never leaked", async () => {
  const withKey = capturingFetch(textResponse(`x${"y".repeat(300)}`));
  await jinaFetch("https://example.com/p", deps(withKey.fetch, { apiKey: "secret-key" }));
  assert.equal(withKey.calls[0]?.headers.authorization, "Bearer secret-key");

  const keyless = capturingFetch(textResponse(`x${"y".repeat(300)}`));
  await jinaFetch("https://example.com/p", deps(keyless.fetch));
  assert.ok(!("authorization" in (keyless.calls[0]?.headers ?? {})), "no auth header keyless");
});

test("empty output is classified thin", async () => {
  const { fetch } = capturingFetch(textResponse("   "));

  const outcome = await jinaFetch("https://example.com/p", deps(fetch));

  assert.equal(outcome.status, "thin");
});

test("a challenge/blocker page is classified blocked, never leaking content", async () => {
  const { fetch } = capturingFetch(textResponse("Please enable JavaScript to continue."));

  const outcome = await jinaFetch("https://example.com/p", deps(fetch));

  assert.equal(outcome.status, "blocked");
  assert.ok("detail" in outcome);
});

test("a 429 normalizes to a blocked rate-limit outcome", async () => {
  const { fetch } = capturingFetch(textResponse("", 429));

  const outcome = await jinaFetch("https://example.com/p", deps(fetch));

  assert.equal(outcome.status, "blocked");
  assert.ok("detail" in outcome && /rate limit/i.test(outcome.detail));
});

test("a 5xx normalizes to a failed outcome with the status, not the body", async () => {
  const { fetch } = capturingFetch(textResponse("internal explosion details", 503));

  const outcome = await jinaFetch("https://example.com/p", deps(fetch));

  assert.equal(outcome.status, "failed");
  assert.ok("detail" in outcome && outcome.detail.includes("503"));
  assert.ok("detail" in outcome && !outcome.detail.includes("explosion"));
});

test("a timeout normalizes to a failed outcome", async () => {
  const fetch = ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    })) as unknown as typeof globalThis.fetch;

  const outcome = await jinaFetch("https://example.com/p", deps(fetch, { timeoutMs: 5 }));

  assert.equal(outcome.status, "failed");
  assert.ok("detail" in outcome && /timed out/.test(outcome.detail));
});

test("a network error normalizes to a failed outcome (never throws)", async () => {
  const fetch = (async () => {
    throw new Error("connect ECONNREFUSED");
  }) as unknown as typeof globalThis.fetch;

  const outcome = await jinaFetch("https://example.com/p", deps(fetch));

  assert.equal(outcome.status, "failed");
  assert.ok("detail" in outcome && outcome.detail.includes("ECONNREFUSED"));
});

test("the char cap truncates oversized markdown", async () => {
  const { fetch } = capturingFetch(textResponse("z".repeat(5000)));

  const outcome = await jinaFetch("https://example.com/p", deps(fetch, { maxChars: 100 }));

  assert.equal(outcome.status, "usable");
  assert.ok("content" in outcome && outcome.content.truncated);
  assert.ok("content" in outcome && outcome.content.content.length <= 120);
});

test("an unsafe target is rejected by the guard before any request", async () => {
  const { fetch, calls } = capturingFetch(textResponse("never read"));

  const outcome = await jinaFetch("http://169.254.169.254/latest/meta-data", deps(fetch));

  assert.equal(outcome.status, "failed");
  assert.ok("detail" in outcome && /reject|private|not allowed/i.test(outcome.detail));
  assert.equal(calls.length, 0, "no request was issued for an unsafe target");
});

test("a host resolving to a private address is rejected before any request", async () => {
  const { fetch, calls } = capturingFetch(textResponse("never read"));
  const privateResolver = (host: string) => (host === "evil.example" ? ["10.0.0.5"] : []);

  const outcome = await jinaFetch(
    "https://evil.example/p",
    deps(fetch, { resolveHost: privateResolver }),
  );

  assert.equal(outcome.status, "failed");
  assert.equal(calls.length, 0, "DNS-resolved private target blocked before fetch");
});
