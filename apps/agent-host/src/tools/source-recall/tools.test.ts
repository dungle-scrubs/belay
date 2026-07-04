import assert from "node:assert/strict";
import {
  decodeSourceRecallIndexStatus,
  decodeSourceRecallRefreshResult,
  decodeSourceRecallResult,
} from "@trevor/session";
import { Effect, JSONSchema } from "effect";
import { test } from "vitest";
import type { Tool } from "../types";
import { normalizeSourceRecallConfig } from "./config";
import type { SourceRecallFetch } from "./http";
import { createSourceRecallRegistry } from "./registry";
import {
  buildSourceRecallTools,
  SOURCE_INDEX_REFRESH_TOOL_NAME,
  SOURCE_INDEX_STATUS_TOOL_NAME,
  SOURCE_RECALL_TOOL_NAME,
} from "./tools";

/**
 * Plan 38 M7: the model-facing source-recall tools over a fake-fetch registry. Proves the JSON
 * envelope the model reads / the web renders for query, status, refresh, provider-unavailable,
 * timeout, and no-results - and that output is capped + cited, never silently injected as context.
 */

const QUERY_ROW = {
  chunk_id: "c1",
  file_path: "src/auth.ts",
  symbol_name: "verify",
  symbol_type: "function",
  content: "y".repeat(3000),
  score: 0.9,
  start_line: 5,
  end_line: 30,
  search_quality: "ast",
  match_reason: "bm25+vector",
};

function toolsFor(
  routes: (path: string, method: string) => { status?: number; body: unknown } | "throw",
): Record<string, Tool<unknown>> {
  const fetch: SourceRecallFetch = async (url, init) => {
    const u = new URL(url);
    const outcome = routes(u.pathname + u.search, init?.method ?? "GET");
    if (outcome === "throw") {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    const status = outcome.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () =>
        typeof outcome.body === "string" ? outcome.body : JSON.stringify(outcome.body),
    };
  };
  const config = normalizeSourceRecallConfig({
    providers: { local: { kind: "source-recall", endpoint: "http://127.0.0.1:7249" } },
  });
  const registry = createSourceRecallRegistry(config, { fetch, nowMs: () => 0 });
  const built = buildSourceRecallTools(registry);
  return Object.fromEntries(built.map((t) => [t.name, t as unknown as Tool<unknown>]));
}

const run = (tool: Tool<unknown>, args: unknown) =>
  Effect.runPromise(tool.execute(args as never, { workspaceRoot: "/dev/app" }));

test("M2: source_recall guidance distinguishes it from session recall, grep, file mention, and LSP", () => {
  const tools = toolsFor(() => ({ status: 404, body: {} }));
  const description = (tools[SOURCE_RECALL_TOOL_NAME] as Tool<unknown>).description;
  // The prompt guidance names each neighbor it must NOT be confused with (D-001).
  assert.match(description, /session_recall/i);
  assert.match(description, /grep/i);
  assert.match(description, /file-mention/i);
  assert.match(description, /LSP/i);
  // ...and states its own purpose: conceptual indexed lookup returning cited candidates.
  assert.match(description, /cited|candidates/i);
  assert.match(description, /index/i);
});

test("M2: the base query schema stays provider-neutral (only query/repo/provider/top_k)", () => {
  const tools = toolsFor(() => ({ status: 404, body: {} }));
  const schema = JSONSchema.make((tools[SOURCE_RECALL_TOOL_NAME] as Tool<unknown>).params) as {
    properties?: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [
    "provider",
    "query",
    "repo",
    "top_k",
  ]);
  // No source-recall / Aleutian backend internals leak into the model-facing description either.
  const description = (tools[SOURCE_RECALL_TOOL_NAME] as Tool<unknown>).description;
  assert.ok(
    !/chunk_max_chars|weaviate|graph_id|rerank/i.test(description),
    "no backend internals leak",
  );
});

test("source_recall returns a cited, capped JSON envelope", async () => {
  const tools = toolsFor((path, method) => {
    if (method === "POST" && path === "/query") {
      return { body: { results: [QUERY_ROW], query_ms: 12 } };
    }
    if (path.startsWith("/status")) {
      return {
        body: {
          repo_path: "/p",
          file_count: 10,
          chunk_count: 40,
          vector_count: 40,
          embed_model: "m",
          embed_dimensions: 768,
          db_size_bytes: 1,
          indexed_at: "1970-01-01T00:00:00.000Z",
        },
      };
    }
    return { status: 404, body: {} };
  });
  const raw = await run(tools[SOURCE_RECALL_TOOL_NAME] as Tool<unknown>, { query: "auth" });
  const decoded = decodeSourceRecallResult(raw);
  assert.ok(decoded, "envelope decodes as a source-recall result");
  assert.equal(decoded.status, "ok");
  assert.equal(decoded.providerId, "local");
  assert.equal(decoded.results[0]?.filePath, "src/auth.ts");
  // Cited: file + line range present. Capped/truncated: the long snippet was bounded.
  assert.ok(decoded.results[0]?.startLine === 5);
  assert.equal(decoded.truncated, true);
  assert.ok((decoded.results[0]?.snippet.length ?? 0) < 3000);
});

test("source_recall degrades to an unavailable envelope when the daemon is unreachable", async () => {
  const tools = toolsFor(() => "throw");
  const raw = await run(tools[SOURCE_RECALL_TOOL_NAME] as Tool<unknown>, { query: "auth" });
  const decoded = decodeSourceRecallResult(raw);
  assert.equal(decoded?.status, "unavailable");
  assert.equal(decoded?.diagnostics[0]?.kind, "timeout");
  // Never a thrown turn failure - the result is a normal JSON body, not an "error:" line.
  assert.ok(!raw.startsWith("error:"));
});

test("source_recall with an empty result set reports no_results", async () => {
  const tools = toolsFor((path, method) => {
    if (method === "POST" && path === "/query") {
      return { body: { results: [], query_ms: 3 } };
    }
    return { status: 500, body: "x" };
  });
  const raw = await run(tools[SOURCE_RECALL_TOOL_NAME] as Tool<unknown>, { query: "nothing" });
  assert.equal(decodeSourceRecallResult(raw)?.status, "no_results");
});

test("source_index_status returns a repos/readiness envelope", async () => {
  const tools = toolsFor((path) => {
    if (path === "/repos") {
      return {
        body: {
          repos: [{ name: "api", path: "/p", file_count: 10, chunk_count: 40, vector_count: 40 }],
        },
      };
    }
    return { status: 404, body: {} };
  });
  const raw = await run(tools[SOURCE_INDEX_STATUS_TOOL_NAME] as Tool<unknown>, {});
  const decoded = decodeSourceRecallIndexStatus(raw);
  assert.equal(decoded?.status, "ok");
  assert.equal(decoded?.repos[0]?.name, "api");
  assert.ok((decoded?.capabilities.length ?? 0) > 0);
});

test("source_index_refresh returns a refresh envelope", async () => {
  const tools = toolsFor((path, method) => {
    if (method === "POST" && path.startsWith("/refresh")) {
      return { body: { files_updated: 4, refresh_ms: 88 } };
    }
    return { status: 404, body: {} };
  });
  const raw = await run(tools[SOURCE_INDEX_REFRESH_TOOL_NAME] as Tool<unknown>, { repo: "api" });
  const decoded = decodeSourceRecallRefreshResult(raw);
  assert.equal(decoded?.status, "ok");
  assert.equal(decoded?.filesUpdated, 4);
});

test("source_index_refresh rate-limited returns a structured rate_limited envelope", async () => {
  const tools = toolsFor((path, method) => {
    if (method === "POST" && path.startsWith("/refresh")) {
      return { status: 429, body: { detail: "Refresh rate limited. Retry in 8.0s." } };
    }
    return { status: 404, body: {} };
  });
  const raw = await run(tools[SOURCE_INDEX_REFRESH_TOOL_NAME] as Tool<unknown>, {});
  assert.equal(decodeSourceRecallRefreshResult(raw)?.status, "rate_limited");
});
