import assert from "node:assert/strict";
import { Effect } from "effect";
import { test } from "vitest";
import { EMPTY_SOURCE_RECALL_CONFIG, normalizeSourceRecallConfig } from "./config";
import type { SourceRecallFetch } from "./http";
import { createSourceRecallRegistry } from "./registry";

/**
 * Plan 38 M8: provider selection - priority ordering, disabled exclusion, explicit selection,
 * transport-error fallback across providers, and the guarantee that a missing/unreachable backend
 * degrades to a structured `unavailable`/`error` wire result (never a thrown turn failure).
 */

const QUERY_ROW = {
  chunk_id: "c1",
  file_path: "a.ts",
  symbol_name: "f",
  symbol_type: "function",
  content: "code",
  score: 0.5,
  start_line: 1,
  end_line: 2,
  search_quality: "ast",
  match_reason: "bm25",
};

/** A fake fetch that dispatches by URL host:port so different providers get different responses. */
function routedFetch(
  byHost: Record<
    string,
    (path: string, method: string) => { status?: number; body: unknown } | "throw"
  >,
): SourceRecallFetch {
  return async (url, init) => {
    const u = new URL(url);
    const handler = byHost[u.host];
    if (!handler) {
      throw new Error(`no handler for host ${u.host}`);
    }
    const outcome = handler(u.pathname, init?.method ?? "GET");
    if (outcome === "throw") {
      throw new Error(`ECONNREFUSED ${u.host}`);
    }
    const status = outcome.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () =>
        typeof outcome.body === "string" ? outcome.body : JSON.stringify(outcome.body),
    };
  };
}

test("a query with no configured provider is a structured unavailable result (never throws)", async () => {
  const registry = createSourceRecallRegistry(EMPTY_SOURCE_RECALL_CONFIG);
  const result = await Effect.runPromise(registry.query({ query: "x", topK: 8 }));
  assert.equal(result.status, "unavailable");
  assert.equal(result.providerId, null);
  assert.equal(result.diagnostics[0]?.kind, "unconfigured");
  assert.equal(registry.hasEnabledProvider, false);
});

test("providers are selected by priority; a disabled provider is excluded", async () => {
  const config = normalizeSourceRecallConfig({
    providers: {
      high: { kind: "source-recall", endpoint: "http://127.0.0.1:1", priority: 5 },
      low: { kind: "source-recall", endpoint: "http://127.0.0.1:2", priority: 1 },
      off: { kind: "source-recall", endpoint: "http://127.0.0.1:3", enabled: false, priority: 0 },
    },
  });
  const fetch = routedFetch({
    "127.0.0.1:2": () => ({ body: { results: [QUERY_ROW], query_ms: 1 } }),
    "127.0.0.1:1": () => ({ body: { results: [], query_ms: 1 } }),
    "127.0.0.1:3": () => "throw",
  });
  const registry = createSourceRecallRegistry(config, { fetch });
  const result = await Effect.runPromise(registry.query({ query: "x", topK: 8 }));
  // "low" (priority 1) is chosen over "high" (priority 5); "off" (priority 0) is disabled + skipped.
  assert.equal(result.providerId, "low");
  assert.equal(result.status, "ok");
});

test("explicit provider selection targets that provider and does not fall back", async () => {
  const config = normalizeSourceRecallConfig({
    providers: {
      a: { kind: "source-recall", endpoint: "http://127.0.0.1:1", priority: 0 },
      b: { kind: "source-recall", endpoint: "http://127.0.0.1:2", priority: 1 },
    },
  });
  const fetch = routedFetch({
    "127.0.0.1:1": () => ({ body: { results: [], query_ms: 1 } }),
    "127.0.0.1:2": () => ({ body: { results: [QUERY_ROW], query_ms: 1 } }),
  });
  const registry = createSourceRecallRegistry(config, { fetch });
  const result = await Effect.runPromise(registry.query({ query: "x", topK: 8 }, "b"));
  assert.equal(result.providerId, "b");
  assert.equal(result.status, "ok");
});

test("an explicit unknown provider is a structured unavailable result", async () => {
  const config = normalizeSourceRecallConfig({
    providers: { a: { kind: "source-recall", endpoint: "http://127.0.0.1:1" } },
  });
  const registry = createSourceRecallRegistry(config, { fetch: routedFetch({}) });
  const result = await Effect.runPromise(registry.query({ query: "x", topK: 8 }, "ghost"));
  assert.equal(result.status, "unavailable");
  assert.match(result.diagnostics[0]?.detail ?? "", /ghost/);
});

test("an unreachable primary falls back to the next enabled provider", async () => {
  const config = normalizeSourceRecallConfig({
    providers: {
      primary: { kind: "source-recall", endpoint: "http://127.0.0.1:1", priority: 0 },
      backup: { kind: "source-recall", endpoint: "http://127.0.0.1:2", priority: 1 },
    },
  });
  const fetch = routedFetch({
    "127.0.0.1:1": () => "throw",
    "127.0.0.1:2": () => ({ body: { results: [QUERY_ROW], query_ms: 1 } }),
  });
  const registry = createSourceRecallRegistry(config, { fetch });
  const result = await Effect.runPromise(registry.query({ query: "x", topK: 8 }));
  assert.equal(result.providerId, "backup", "fell back to the reachable provider");
  assert.equal(result.status, "ok");
});

test("when all providers are unreachable the result is unavailable, not a crash", async () => {
  const config = normalizeSourceRecallConfig({
    providers: {
      a: { kind: "source-recall", endpoint: "http://127.0.0.1:1", priority: 0 },
      b: { kind: "source-recall", endpoint: "http://127.0.0.1:2", priority: 1 },
    },
  });
  const fetch = routedFetch({ "127.0.0.1:1": () => "throw", "127.0.0.1:2": () => "throw" });
  const registry = createSourceRecallRegistry(config, { fetch });
  const result = await Effect.runPromise(registry.query({ query: "x", topK: 8 }));
  assert.equal(result.status, "unavailable");
  assert.equal(result.diagnostics[0]?.kind, "unreachable");
});

test("a domain error (repo not found) does not fall back and surfaces on the chosen provider", async () => {
  const config = normalizeSourceRecallConfig({
    providers: {
      a: { kind: "source-recall", endpoint: "http://127.0.0.1:1", priority: 0 },
      b: { kind: "source-recall", endpoint: "http://127.0.0.1:2", priority: 1 },
    },
  });
  const fetch = routedFetch({
    "127.0.0.1:1": () => ({
      status: 404,
      body: { detail: "Repo 'x' not found. Available: ['api']" },
    }),
    "127.0.0.1:2": () => ({ body: { results: [QUERY_ROW], query_ms: 1 } }),
  });
  const registry = createSourceRecallRegistry(config, { fetch });
  const result = await Effect.runPromise(registry.query({ query: "x", topK: 8, repo: "x" }));
  assert.equal(result.providerId, "a", "a domain error stops at the chosen provider, no fallback");
  assert.equal(result.diagnostics[0]?.kind, "repo_not_found");
});

test("inspect() returns the redacted, priority-ordered provider list", () => {
  const config = normalizeSourceRecallConfig({
    providers: {
      b: { kind: "aleutian", endpoint: "http://127.0.0.1:12217", priority: 1 },
      a: { kind: "source-recall", endpoint: "http://u:p@127.0.0.1:7249/x?t=1", priority: 0 },
    },
  });
  const registry = createSourceRecallRegistry(config, { fetch: routedFetch({}) });
  const listed = registry.inspect();
  assert.deepEqual(
    listed.map((p) => p.id),
    ["a", "b"],
  );
  assert.equal(listed[0]?.endpoint, "http://127.0.0.1:7249/x");
});
