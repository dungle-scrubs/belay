import assert from "node:assert/strict";
import { Effect, Either, Schema } from "effect";
import { afterEach, test } from "vitest";
import { ToolInputError } from "../errors";
import type { FetchLikeResponse } from "./static-fetch";
import {
  runWebFetch,
  type WebFetchArgs,
  type WebFetchDeps,
  WebFetchParams,
  webFetchTool,
} from "./web-fetch";
import { lastWebFetchError, resetWebFetchError } from "./web-fetch-log";

/**
 * Tool-entry coverage: the param schema accepts/normalizes input (M1), the tool declares read-only,
 * and the wired path (guard -> static -> extract -> classify -> envelope) produces the right
 * envelope for usable, thin, blocked, and unsafe inputs, including the auto-vs-static fallback signal.
 * IO is injected so nothing touches the network or DNS.
 */

function decode(input: unknown): Either.Either<WebFetchArgs, unknown> {
  return Schema.decodeUnknownEither(WebFetchParams)(input);
}

function htmlResponse(body: string, url = "https://example.com/p"): FetchLikeResponse {
  const bytes = new TextEncoder().encode(body);
  return {
    status: 200,
    url,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/html" : null) },
    arrayBuffer: async () => {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return copy.buffer;
    },
  };
}

function deps(response: FetchLikeResponse): WebFetchDeps {
  return {
    fetch: (async () => response) as unknown as typeof globalThis.fetch,
    resolveHost: async () => ["93.184.216.34"],
    now: () => "2026-06-29T00:00:00.000Z",
  };
}

async function run(
  args: WebFetchArgs,
  response: FetchLikeResponse,
): Promise<Record<string, unknown>> {
  const out = await runWebFetch(args, deps(response));
  return JSON.parse(out);
}

test("the param schema accepts a bare URL and defaults the rest", () => {
  const decoded = decode({ url: "https://example.com" });
  assert.ok(Either.isRight(decoded));
  assert.equal(decoded.right.url, "https://example.com");
  assert.equal(decoded.right.mode, undefined);
});

test("the param schema accepts mode and lenient numeric caps", () => {
  const decoded = decode({ url: "https://x.com", mode: "static", maxBytes: 4096, maxChars: 2000 });
  assert.ok(Either.isRight(decoded));
  assert.equal(decoded.right.mode, "static");
  assert.equal(decoded.right.maxBytes, 4096);
  assert.equal(decoded.right.maxChars, 2000);
});

test("the param schema rejects a missing URL and an unknown mode", () => {
  assert.ok(Either.isLeft(decode({})));
  assert.ok(Either.isLeft(decode({ url: "https://x.com", mode: "browser" })));
});

test("the tool is registered read-only", () => {
  assert.equal(webFetchTool.name, "web_fetch");
  assert.equal(webFetchTool.readOnly, true);
});

test("a usable static page builds a complete envelope and does not request fallback", async () => {
  const parsed = await run(
    { url: "https://example.com/p" },
    htmlResponse(
      `<html><head><title>Doc</title></head><body><article><p>${"Real content. ".repeat(40)}</p></article></body></html>`,
    ),
  );

  assert.equal(parsed.url, "https://example.com/p");
  assert.equal(parsed.finalUrl, "https://example.com/p");
  assert.equal(parsed.title, "Doc");
  assert.equal(parsed.status, 200);
  assert.equal(parsed.backend, "static");
  assert.equal(parsed.needsFallback, false);
  assert.equal(parsed.fetchedAt, "2026-06-29T00:00:00.000Z");
  assert.ok(String(parsed.content).includes("Real content."));
  assert.deepEqual(parsed.attempts, [{ backend: "static", status: "usable" }]);
});

test("auto mode flags needsFallback for a thin page; static mode does not", async () => {
  const thinHtml = `<html><body><div id="root"></div>${"<script>var a=1;</script>".repeat(20)}</body></html>`;

  // The fallback backends also come up empty here, so auto mode exhausts the ladder and still flags
  // needsFallback - the static attempt stays the reported result.
  const autoFetch = multiplexedFetch({
    static: { text: thinHtml, contentType: "text/html" },
    jina: { text: "" },
  });
  const auto = await runLadder({ url: "https://example.com/p" }, ladderDeps(autoFetch.fetch));
  assert.equal(auto.needsFallback, true);
  const autoAttempts = auto.attempts as { status: string }[];
  assert.equal(autoAttempts[0]?.status, "thin");

  const fixed = await run({ url: "https://example.com/p", mode: "static" }, htmlResponse(thinHtml));
  assert.equal(fixed.needsFallback, false, "static mode never falls back");
});

test("a blocked challenge page is classified blocked and flagged for fallback in auto mode", async () => {
  const { fetch } = multiplexedFetch({
    static: {
      text: "<html><body>Checking your browser. Please enable JavaScript.</body></html>",
      contentType: "text/html",
    },
    jina: { text: "" },
  });

  const blocked = await runLadder({ url: "https://example.com/p" }, ladderDeps(fetch));

  const attempts = blocked.attempts as { status: string }[];
  assert.equal(attempts[0]?.status, "blocked");
  assert.equal(blocked.needsFallback, true);
});

test("an exhausted ladder emits no body, only the fallback signal", async () => {
  // Static is blocked, Jina 403s, Firecrawl has no key: every backend is unusable. The winner's body
  // is a challenge/chrome page, not the source, so content is suppressed rather than shipped as noise.
  const { fetch } = multiplexedFetch({
    static: {
      text: "<html><body>Access denied. Request blocked.</body></html>",
      contentType: "text/html",
    },
    jina: { status: 403, text: "" },
  });

  const result = await runLadder({ url: "https://example.com/p" }, ladderDeps(fetch));

  const attempts = result.attempts as { backend: string; status: string }[];
  assert.equal(attempts[0]?.status, "blocked");
  assert.equal(result.needsFallback, true);
  assert.equal(result.content, "", "a blocked/failed winner carries no body");
  assert.equal(result.textLength, 0);
});

test("an unsafe URL raises an input failure before any fetch (no network)", async () => {
  let fetched = false;
  const blockingDeps: WebFetchDeps = {
    fetch: (async () => {
      fetched = true;
      return htmlResponse("x");
    }) as unknown as typeof globalThis.fetch,
    resolveHost: async () => ["10.0.0.1"],
    now: () => "2026-06-29T00:00:00.000Z",
  };

  await assert.rejects(
    () => runWebFetch({ url: "http://169.254.169.254/latest/meta-data" }, blockingDeps),
    /private|not allowed/,
  );
  assert.equal(fetched, false, "no fetch was issued");
});

test("a hostname resolving to a private address is rejected before fetch", async () => {
  let fetched = false;
  const blockingDeps: WebFetchDeps = {
    fetch: (async () => {
      fetched = true;
      return htmlResponse("x");
    }) as unknown as typeof globalThis.fetch,
    resolveHost: async () => ["192.168.1.10"],
    now: () => "2026-06-29T00:00:00.000Z",
  };

  await assert.rejects(() => runWebFetch({ url: "https://evil.example.com/" }, blockingDeps));
  assert.equal(fetched, false, "DNS-resolved private target blocked before fetch");
});

test("the live tool renders an unsafe URL as a typed input error through simpleTool", async () => {
  // The simpleTool wrapper turns the toolInput failure into a ToolInputError in the E channel; this
  // proves the scheme rejection reaches the model as a typed input error, with no network.
  const error = await Effect.runPromise(
    Effect.flip(webFetchTool.execute({ url: "ftp://example.com" })),
  );
  assert.ok(error instanceof ToolInputError);
  assert.equal(error.tool, "web_fetch");
  assert.ok(error.detail.includes("scheme"), `scheme rejection surfaced: ${error.detail}`);
});

/**
 * Ladder coverage (M5/M6): a routing fetch serves the static origin, the Jina reader, and the
 * Firecrawl scrape endpoint independently, so each test asserts which backends were spent. The
 * invariant is static -> Jina -> Firecrawl, each only when the prior is unusable, with every attempt
 * recorded in `attempts[]`.
 */

const USABLE_HTML = `<html><head><title>Doc</title></head><body><article><p>${"Real content. ".repeat(40)}</p></article></body></html>`;
const THIN_HTML = `<html><body><div id="root"></div>${"<script>var a=1;</script>".repeat(20)}</body></html>`;

interface RouteSpec {
  readonly status?: number;
  readonly text?: string;
  readonly json?: unknown;
  readonly contentType?: string;
}

function multiplexedFetch(routes: {
  static?: RouteSpec;
  jina?: RouteSpec;
  firecrawl?: RouteSpec;
}): { fetch: typeof globalThis.fetch; hits: { static: number; jina: number; firecrawl: number } } {
  const hits = { static: 0, jina: 0, firecrawl: 0 };

  const fetch = (async (url: string) => {
    if (url.startsWith("https://r.jina.ai/")) {
      hits.jina += 1;
      return responseFor(routes.jina ?? { status: 200, text: "" }, url);
    }

    if (url.startsWith("https://api.firecrawl.dev/")) {
      hits.firecrawl += 1;
      return responseFor(routes.firecrawl ?? { status: 200, json: {} }, url);
    }

    hits.static += 1;
    return responseFor(routes.static ?? { status: 200, text: "", contentType: "text/html" }, url);
  }) as unknown as typeof globalThis.fetch;

  return { fetch, hits };
}

function responseFor(spec: RouteSpec, url: string): unknown {
  const bytes = new TextEncoder().encode(spec.text ?? "");
  const headers = new Map<string, string>();

  if (spec.contentType) {
    headers.set("content-type", spec.contentType);
  }

  return {
    status: spec.status ?? 200,
    url,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    arrayBuffer: async () => {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return copy.buffer;
    },
    json: async () => spec.json,
  };
}

function ladderDeps(
  fetch: typeof globalThis.fetch,
  keys: { jinaApiKey?: string; firecrawlApiKey?: string } = {},
): WebFetchDeps {
  return {
    fetch,
    resolveHost: async () => ["93.184.216.34"],
    now: () => "2026-06-29T00:00:00.000Z",
    ...keys,
  };
}

async function runLadder(args: WebFetchArgs, deps: WebFetchDeps): Promise<Record<string, unknown>> {
  return JSON.parse(await runWebFetch(args, deps));
}

test("auto mode does NOT call Jina or Firecrawl when static is usable", async () => {
  const { fetch, hits } = multiplexedFetch({
    static: { text: USABLE_HTML, contentType: "text/html" },
  });

  const parsed = await runLadder({ url: "https://example.com/p" }, ladderDeps(fetch));

  assert.equal(parsed.backend, "static");
  assert.equal(parsed.needsFallback, false);
  assert.equal(hits.static, 1);
  assert.equal(hits.jina, 0, "Jina is not spent on a usable static page");
  assert.equal(hits.firecrawl, 0, "Firecrawl is not spent on a usable static page");
  assert.deepEqual(parsed.attempts, [{ backend: "static", status: "usable" }]);
});

test("static mode never calls Jina or Firecrawl even when static is unusable", async () => {
  const { fetch, hits } = multiplexedFetch({
    static: { text: THIN_HTML, contentType: "text/html" },
    jina: { text: `# Recovered\n\n${"Jina body. ".repeat(40)}` },
  });

  const parsed = await runLadder(
    { url: "https://example.com/p", mode: "static" },
    ladderDeps(fetch, { jinaApiKey: "k", firecrawlApiKey: "fc" }),
  );

  assert.equal(parsed.backend, "static");
  assert.equal(parsed.needsFallback, false, "static mode is the final word");
  assert.equal(hits.jina, 0);
  assert.equal(hits.firecrawl, 0);
});

test("auto mode falls back to Jina after an unusable static page and adopts a usable Jina result", async () => {
  const { fetch, hits } = multiplexedFetch({
    static: { text: THIN_HTML, contentType: "text/html" },
    jina: { text: `# Recovered\n\n${"Jina body. ".repeat(40)}` },
  });

  const parsed = await runLadder({ url: "https://example.com/p" }, ladderDeps(fetch));

  assert.equal(parsed.backend, "jina");
  assert.equal(parsed.needsFallback, false);
  assert.equal(hits.static, 1);
  assert.equal(hits.jina, 1);
  assert.equal(hits.firecrawl, 0, "Firecrawl is not reached once Jina recovers the page");
  assert.ok(String(parsed.content).includes("Jina body."));

  const attempts = parsed.attempts as { backend: string; status: string }[];
  assert.equal(attempts[0]?.backend, "static");
  assert.equal(attempts[1]?.backend, "jina");
  assert.equal(attempts[1]?.status, "usable");
});

test("auto mode reaches Firecrawl only when both static AND Jina are unusable", async () => {
  const { fetch, hits } = multiplexedFetch({
    static: { text: THIN_HTML, contentType: "text/html" },
    jina: { text: "" },
    firecrawl: { json: { data: { markdown: `# FC\n\n${"Firecrawl body. ".repeat(40)}` } } },
  });

  const parsed = await runLadder(
    { url: "https://example.com/p" },
    ladderDeps(fetch, { firecrawlApiKey: "fc" }),
  );

  assert.equal(parsed.backend, "firecrawl");
  assert.equal(parsed.needsFallback, false);
  assert.equal(hits.static, 1);
  assert.equal(hits.jina, 1);
  assert.equal(hits.firecrawl, 1);
  assert.ok(String(parsed.content).includes("Firecrawl body."));

  const attempts = parsed.attempts as { backend: string }[];
  assert.deepEqual(
    attempts.map((a) => a.backend),
    ["static", "jina", "firecrawl"],
  );
});

test("Firecrawl is recorded as unavailable (no request) when the key is missing", async () => {
  const { fetch, hits } = multiplexedFetch({
    static: { text: THIN_HTML, contentType: "text/html" },
    jina: { text: "" },
  });

  const parsed = await runLadder({ url: "https://example.com/p" }, ladderDeps(fetch));

  assert.equal(hits.firecrawl, 0, "no Firecrawl request without a key");
  assert.equal(parsed.needsFallback, true, "no backend produced usable content");

  const attempts = parsed.attempts as { backend: string; status: string; detail?: string }[];
  const firecrawl = attempts.find((a) => a.backend === "firecrawl");
  assert.ok(firecrawl, "the Firecrawl skip is still recorded as an attempt");
  assert.equal(firecrawl?.status, "failed");
  assert.ok(/unavailable|not configured/i.test(firecrawl?.detail ?? ""));
});

test("rendered mode goes straight to Firecrawl and skips Jina", async () => {
  const { fetch, hits } = multiplexedFetch({
    static: { text: USABLE_HTML, contentType: "text/html" },
    firecrawl: { json: { data: { markdown: `# FC\n\n${"Rendered body. ".repeat(40)}` } } },
  });

  const parsed = await runLadder(
    { url: "https://example.com/p", mode: "rendered" },
    ladderDeps(fetch, { firecrawlApiKey: "fc" }),
  );

  assert.equal(parsed.backend, "firecrawl");
  assert.equal(hits.jina, 0, "rendered mode does not use Jina");
  assert.equal(hits.firecrawl, 1);
  assert.ok(String(parsed.content).includes("Rendered body."));
});

test("rendered mode degrades gracefully when Firecrawl is unavailable", async () => {
  const { fetch, hits } = multiplexedFetch({
    static: { text: USABLE_HTML, contentType: "text/html" },
  });

  const parsed = await runLadder(
    { url: "https://example.com/p", mode: "rendered" },
    ladderDeps(fetch),
  );

  assert.equal(hits.firecrawl, 0, "no request without a key");
  assert.equal(parsed.needsFallback, true);

  const attempts = parsed.attempts as { backend: string; status: string }[];
  const firecrawl = attempts.find((a) => a.backend === "firecrawl");
  assert.equal(firecrawl?.status, "failed", "unavailable Firecrawl is a typed failed attempt");
});

/**
 * Plan 04 M8/M9: end-to-end redaction + provenance through the live tool path. A captured console
 * proves the per-backend log line carries only the sanitized field set (host, never the URL query;
 * no key/header/body) and that the fetched CONTENT never reaches a log; the serialized envelope
 * proves the content + provenance stay model-visible.
 */

const capturedLogs: string[] = [];
const originalLog = console.log;

function captureLogs(): void {
  capturedLogs.length = 0;
  console.log = (...args: unknown[]) => {
    capturedLogs.push(args.join(" "));
  };
}

afterEach(() => {
  console.log = originalLog;
  resetWebFetchError();
});

test("web_search then web_fetch: the fetched content + provenance are model-visible in the envelope", async () => {
  // A web_search result the model would select: a single source URL it then reads with web_fetch.
  const selectedUrl = "https://docs.example.com/guide?ref=search";
  const { fetch } = multiplexedFetch({
    static: {
      text: `<html><head><title>The Guide</title></head><body><article><p>${"Selected source body. ".repeat(40)}</p></article></body></html>`,
      contentType: "text/html",
    },
  });

  const serialized = await runWebFetch({ url: selectedUrl }, ladderDeps(fetch));
  const parsed = JSON.parse(serialized) as Record<string, unknown>;

  // Content is model-visible...
  assert.ok(
    String(parsed.content).includes("Selected source body."),
    "the fetched content is present",
  );
  // ...and so is the provenance the model reads (the resolved URL, the winning backend, the ladder).
  assert.equal(parsed.url, selectedUrl);
  assert.equal(parsed.backend, "static");
  assert.deepEqual(parsed.attempts, [{ backend: "static", status: "usable" }]);
});

test("the live path logs only redacted fields - no URL query, key, header, or fetched content", async () => {
  const url = "https://docs.example.com/page?token=sk-SECRET&key=abc123";
  const body = "PRIVATE PAGE BODY that must never be logged";
  const { fetch } = multiplexedFetch({
    static: {
      text: `<html><head><title>T</title></head><body><article><p>${body} ${"filler. ".repeat(40)}</p></article></body></html>`,
      contentType: "text/html",
    },
  });

  captureLogs();
  await runWebFetch({ url }, ladderDeps(fetch));
  const all = capturedLogs.join("\n");

  assert.ok(all.includes("web_fetch:"), "the backend-attempt boundary line is emitted");
  assert.match(all, /host=docs\.example\.com/);
  assert.ok(!all.includes("token="), "the URL query is never logged");
  assert.ok(!all.includes("sk-SECRET"), "no secret from the query leaks");
  assert.ok(!/Authorization|bearer/i.test(all), "no header is logged");
  assert.ok(!all.includes(body), "the fetched page content is never logged");
});

test("rendered mode with Firecrawl absent returns a typed-unavailable result, not a thrown turn", async () => {
  const { fetch } = multiplexedFetch({
    static: { text: USABLE_HTML, contentType: "text/html" },
  });

  // No firecrawlApiKey: the explicit rendered request must not throw - it degrades to a typed
  // failed Firecrawl attempt and a needsFallback envelope the model reads.
  const serialized = await runWebFetch(
    { url: "https://example.com/p", mode: "rendered" },
    ladderDeps(fetch),
  );
  const parsed = JSON.parse(serialized) as Record<string, unknown>;

  assert.equal(parsed.needsFallback, true, "the rendered request degrades rather than throwing");
  const attempts = parsed.attempts as { backend: string; status: string }[];
  assert.equal(
    attempts.find((a) => a.backend === "firecrawl")?.status,
    "failed",
    "an absent Firecrawl is a typed failed attempt",
  );
});

test("a failing backend records a sanitized last error the doctor reads", async () => {
  resetWebFetchError();
  // Static fails to fetch (a thrown StaticFetchError), so the static attempt is a sanitized failure.
  const failingFetch = (async () => {
    throw new Error("boom");
  }) as unknown as typeof globalThis.fetch;

  captureLogs();
  await runWebFetch({ url: "https://example.com/p", mode: "static" }, ladderDeps(failingFetch));

  const last = lastWebFetchError();
  assert.ok(last, "a last backend error is recorded");
  assert.ok(
    !/sk-|bearer|Authorization|\?/.test(last ?? ""),
    "the recorded last error is a sanitized category",
  );
});
