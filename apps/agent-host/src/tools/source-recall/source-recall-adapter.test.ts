import assert from "node:assert/strict";
import { Effect, Exit } from "effect";
import { test } from "vitest";
import type { SourceRecallFetch, SourceRecallHttp } from "./http";
import { createSourceRecallAdapter } from "./source-recall-adapter";

/**
 * Plan 38 M3/M4: the `source-recall` daemon adapter, tested hermetically against a FAKE HTTP layer -
 * no live daemon, no embedding download. Covers /health, /repos, /status, /query, /refresh; single
 * vs multi repo; repo-not-found / not-ready / rate-limited / timeout / malformed body; and the
 * guarantee that the adapter never auto-indexes (only queries + refreshes on request).
 */

interface Route {
  readonly method: string;
  readonly path: string;
  readonly status?: number;
  readonly body: unknown;
}

interface FakeHttp {
  readonly http: SourceRecallHttp;
  readonly calls: { method: string; url: string }[];
}

/** A fake fetch that matches a request to the first route whose method + path prefix match. */
function fakeHttp(routes: readonly Route[], opts?: { timeout?: boolean }): FakeHttp {
  const calls: { method: string; url: string }[] = [];
  const fetch: SourceRecallFetch = async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    if (opts?.timeout) {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }
    const path = new URL(url).pathname + new URL(url).search;
    const route = routes.find((r) => r.method === method && path.startsWith(r.path));
    if (!route) {
      throw new Error(`no fake route for ${method} ${path}`);
    }
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof route.body === "string" ? route.body : JSON.stringify(route.body)),
    };
  };
  return {
    calls,
    http: { baseUrl: "http://127.0.0.1:7249", fetch, timeoutMs: 1000 },
  };
}

const NOW = Date.parse("2026-07-05T12:00:00.000Z");
const adapter = (fh: FakeHttp) =>
  createSourceRecallAdapter({ id: "source-recall:local", http: fh.http, nowMs: () => NOW });

const QUERY_ROW = {
  chunk_id: "c1",
  file_path: "src/auth/session.ts",
  symbol_name: "verifySession",
  symbol_type: "function",
  content: "export function verifySession(token: string) { return check(token); }",
  score: 0.91,
  start_line: 10,
  end_line: 22,
  search_quality: "ast",
  match_reason: "bm25+vector",
};

test("discover reports reachable + ready + capabilities from /health and /repos", async () => {
  const fh = fakeHttp([
    { method: "GET", path: "/health", body: { ok: true, repos: ["api"], uptime_s: 30 } },
    {
      method: "GET",
      path: "/repos",
      body: {
        repos: [{ name: "api", path: "/p/api", file_count: 12, chunk_count: 40, vector_count: 40 }],
      },
    },
  ]);
  const d = await Effect.runPromise(adapter(fh).discover());
  assert.equal(d.reachable, true);
  assert.equal(d.readiness, "ready");
  assert.deepEqual([...d.capabilities].sort(), [
    "chunk_search",
    "refresh",
    "semantic_index",
    "status",
  ]);
});

test("query on a single repo (no repo arg) maps chunks + best-effort freshness", async () => {
  const fh = fakeHttp([
    { method: "POST", path: "/query", body: { results: [QUERY_ROW], query_ms: 42.4 } },
    {
      method: "GET",
      path: "/status",
      body: {
        repo_path: "/p/api",
        file_count: 12,
        chunk_count: 40,
        vector_count: 40,
        embed_model: "CodeRankEmbed",
        embed_dimensions: 768,
        db_size_bytes: 1024,
        indexed_at: "2026-07-05T11:00:00.000Z",
      },
    },
  ]);
  const answer = await Effect.runPromise(adapter(fh).query({ query: "auth", topK: 8 }));
  assert.equal(answer.items.length, 1);
  assert.equal(answer.items[0]?.filePath, "src/auth/session.ts");
  assert.equal(answer.items[0]?.providerId, "source-recall:local");
  assert.equal(answer.items[0]?.matchReason, "bm25+vector");
  assert.equal(answer.latencyMs, 42);
  assert.equal(answer.freshness?.stale, false);
  assert.equal(answer.freshness?.chunkCount, 40);
});

test("query truncates an over-long snippet and flags nothing beyond the item cap", async () => {
  const big = "x".repeat(4000);
  const fh = fakeHttp([
    {
      method: "POST",
      path: "/query",
      body: { results: [{ ...QUERY_ROW, content: big }], query_ms: 5 },
    },
    { method: "GET", path: "/status", status: 500, body: "boom" },
  ]);
  const answer = await Effect.runPromise(adapter(fh).query({ query: "auth", topK: 8 }));
  assert.ok((answer.items[0]?.snippet.length ?? 0) < big.length);
  assert.ok(answer.items[0]?.snippet.endsWith("…"));
  // A failed best-effort freshness call degrades to null, never an error.
  assert.equal(answer.freshness, null);
});

test("query on a multi-repo daemon without a repo is a typed ambiguity error", async () => {
  const fh = fakeHttp([
    {
      method: "POST",
      path: "/query",
      status: 400,
      body: { detail: "Multiple repos loaded. Specify 'repo': one of ['api', 'web']" },
    },
  ]);
  const exit = await Effect.runPromiseExit(adapter(fh).query({ query: "auth", topK: 8 }));
  assert.ok(Exit.isFailure(exit));
  const err = failureOf(exit);
  assert.equal(err?._tag, "SourceRecallRepoAmbiguousError");
  assert.deepEqual(err?.available, ["api", "web"]);
});

test("query for an unknown repo is a typed repo-not-found error (404)", async () => {
  const fh = fakeHttp([
    {
      method: "POST",
      path: "/query",
      status: 404,
      body: { detail: "Repo 'nope' not found. Available: ['api']" },
    },
  ]);
  const exit = await Effect.runPromiseExit(
    adapter(fh).query({ query: "auth", topK: 8, repo: "nope" }),
  );
  const err = failureOf(exit);
  assert.equal(err?._tag, "SourceRecallRepoNotFoundError");
  assert.equal(err?.repo, "nope");
});

test("a timed-out request is a typed timeout error", async () => {
  const fh = fakeHttp([{ method: "POST", path: "/query", body: {} }], { timeout: true });
  const exit = await Effect.runPromiseExit(adapter(fh).query({ query: "auth", topK: 8 }));
  const err = failureOf(exit);
  assert.equal(err?._tag, "SourceRecallTimeoutError");
});

test("a malformed (non-JSON) query body is a typed protocol error", async () => {
  const fh = fakeHttp([{ method: "POST", path: "/query", body: "<html>not json</html>" }]);
  const exit = await Effect.runPromiseExit(adapter(fh).query({ query: "auth", topK: 8 }));
  const err = failureOf(exit);
  assert.equal(err?._tag, "SourceRecallProtocolError");
});

test("status without a repo lists all served repos (multi-repo scoping)", async () => {
  const fh = fakeHttp([
    {
      method: "GET",
      path: "/repos",
      body: {
        repos: [
          { name: "api", path: "/p/api", file_count: 12, chunk_count: 40, vector_count: 40 },
          { name: "web", path: "/p/web", file_count: 30, chunk_count: 0, vector_count: 0 },
        ],
      },
    },
  ]);
  const snap = await Effect.runPromise(adapter(fh).status());
  assert.equal(snap.repos.length, 2);
  assert.equal(snap.repos.find((r) => r.name === "web")?.readiness, "unready");
  assert.equal(snap.repos.find((r) => r.name === "api")?.readiness, "ready");
});

test("status for one repo reads its indexed_at and flags a day-old index stale", async () => {
  const fh = fakeHttp([
    {
      method: "GET",
      path: "/status",
      body: {
        repo_path: "/p/api",
        file_count: 12,
        chunk_count: 40,
        vector_count: 40,
        embed_model: "CodeRankEmbed",
        embed_dimensions: 768,
        db_size_bytes: 1024,
        indexed_at: "2026-07-01T00:00:00.000Z",
      },
    },
  ]);
  const snap = await Effect.runPromise(adapter(fh).status("api"));
  assert.equal(snap.repos[0]?.freshness.stale, true);
});

test("refresh success returns files_updated + latency", async () => {
  const fh = fakeHttp([
    { method: "POST", path: "/refresh", body: { files_updated: 3, refresh_ms: 120.7 } },
  ]);
  const r = await Effect.runPromise(adapter(fh).refresh("api"));
  assert.equal(r.filesUpdated, 3);
  assert.equal(r.refreshMs, 121);
});

test("refresh rate-limited (429) is a typed rate-limit error", async () => {
  const fh = fakeHttp([
    {
      method: "POST",
      path: "/refresh",
      status: 429,
      body: { detail: "Refresh rate limited. Retry in 8.0s." },
    },
  ]);
  const exit = await Effect.runPromiseExit(adapter(fh).refresh("api"));
  const err = failureOf(exit);
  assert.equal(err?._tag, "SourceRecallRateLimitedError");
});

test("the adapter never calls an index/build endpoint (no auto-index of a huge repo)", async () => {
  const fh = fakeHttp([
    { method: "POST", path: "/query", body: { results: [], query_ms: 1 } },
    { method: "GET", path: "/status", body: emptyStatus() },
  ]);
  await Effect.runPromise(adapter(fh).query({ query: "auth", topK: 8 }));
  assert.ok(
    fh.calls.every((c) => !/\/index|\/build/.test(c.url)),
    "adapter must not hit an index/build endpoint",
  );
});

function emptyStatus() {
  return {
    repo_path: "/p/api",
    file_count: 0,
    chunk_count: 0,
    vector_count: 0,
    embed_model: "",
    embed_dimensions: 0,
    db_size_bytes: 0,
    indexed_at: "",
  };
}

// biome-ignore lint/suspicious/noExplicitAny: test reads the tagged error's fields off the failure.
function failureOf(exit: Exit.Exit<unknown, unknown>): any {
  if (Exit.isFailure(exit)) {
    const cause = exit.cause;
    return (cause as { error?: unknown }).error ?? cause;
  }
  return undefined;
}
