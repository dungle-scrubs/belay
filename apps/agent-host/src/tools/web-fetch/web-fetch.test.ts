import assert from "node:assert/strict";
import { Effect, Either, Schema } from "effect";
import { test } from "vitest";
import { ToolInputError } from "../errors";
import type { FetchLikeResponse } from "./static-fetch";
import {
  runWebFetch,
  type WebFetchArgs,
  type WebFetchDeps,
  WebFetchParams,
  webFetchTool,
} from "./web-fetch";

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

  const auto = await run({ url: "https://example.com/p" }, htmlResponse(thinHtml));
  assert.equal(auto.needsFallback, true);
  const autoAttempts = auto.attempts as { status: string }[];
  assert.equal(autoAttempts[0]?.status, "thin");

  const fixed = await run({ url: "https://example.com/p", mode: "static" }, htmlResponse(thinHtml));
  assert.equal(fixed.needsFallback, false, "static mode never falls back");
});

test("a blocked challenge page is classified blocked and flagged for fallback in auto mode", async () => {
  const blocked = await run(
    { url: "https://example.com/p" },
    htmlResponse("<html><body>Checking your browser. Please enable JavaScript.</body></html>"),
  );

  const attempts = blocked.attempts as { status: string }[];
  assert.equal(attempts[0]?.status, "blocked");
  assert.equal(blocked.needsFallback, true);
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
