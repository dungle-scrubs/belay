import assert from "node:assert/strict";
import { Effect, Exit } from "effect";
import { test } from "vitest";
import { createAleutianAdapter } from "./aleutian-adapter";
import {
  type AlReferenceInfo,
  type AlSymbolInfo,
  normalizeCapabilities,
  referenceToResultItem,
  symbolToResultItem,
} from "./aleutian-mapping";
import type { SourceRecallFetch, SourceRecallHttp } from "./http";

/**
 * Plan 38 M5/M6: the Aleutian Trace adapter + capability mapping, tested hermetically against a FAKE
 * `/v1/trace/*` HTTP layer. Covers capability discovery (graph-only / context / semantic / mcp-only /
 * unavailable), project-init + context + symbol resolution into cited items, graph-not-initialized,
 * and the mcp-transport degradation. No live daemon, no Weaviate, no Ollama.
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

function fakeHttp(routes: readonly Route[], opts?: { fail?: boolean }): FakeHttp {
  const calls: { method: string; url: string }[] = [];
  const fetch: SourceRecallFetch = async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    if (opts?.fail) {
      throw new Error("ECONNREFUSED 127.0.0.1:12217");
    }
    const path = new URL(url).pathname;
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
  return { calls, http: { baseUrl: "http://127.0.0.1:12217", fetch, timeoutMs: 1000 } };
}

const httpAdapter = (fh: FakeHttp, projectRoot = "/dev/app") =>
  createAleutianAdapter({ id: "aleutian:trace", http: fh.http, transport: "http", projectRoot });

const SYMBOL: AlSymbolInfo = {
  id: "sym-1",
  name: "HandleInit",
  kind: "function",
  file_path: "services/trace/handlers.go",
  start_line: 40,
  end_line: 88,
  signature: "func HandleInit(c *gin.Context)",
  doc_comment: "HandleInit initializes a code graph.",
  package: "trace",
  exported: true,
};

// -- Capability discovery (M5) -------------------------------------------------

test("discovery grants symbol/graph/context/semantic when ready + weaviate ok", async () => {
  const fh = fakeHttp([
    { method: "GET", path: "/v1/trace/health", body: { status: "healthy", version: "1.0" } },
    {
      method: "GET",
      path: "/v1/trace/ready",
      body: { ready: true, graph_count: 1, weaviate_ok: true },
    },
    { method: "GET", path: "/v1/trace/tools", body: { tools: [{ name: "semantic_search" }] } },
  ]);
  const d = await Effect.runPromise(httpAdapter(fh).discover());
  assert.equal(d.readiness, "ready");
  assert.ok(d.capabilities.includes("context_assembly"));
  assert.ok(d.capabilities.includes("semantic_index"));
  assert.ok(d.capabilities.includes("call_graph"));
});

test("graph-only (weaviate down) discovery omits semantic_index", async () => {
  const fh = fakeHttp([
    { method: "GET", path: "/v1/trace/health", body: { status: "healthy" } },
    {
      method: "GET",
      path: "/v1/trace/ready",
      body: { ready: true, graph_count: 1, weaviate_ok: false },
    },
    { method: "GET", path: "/v1/trace/tools", body: { tools: [] } },
  ]);
  const d = await Effect.runPromise(httpAdapter(fh).discover());
  assert.ok(!d.capabilities.includes("semantic_index"));
  assert.ok(d.capabilities.includes("symbol_search"));
});

test("an unready service discovers as unready with status-only capability", async () => {
  const fh = fakeHttp([
    { method: "GET", path: "/v1/trace/health", body: { status: "degraded" } },
    {
      method: "GET",
      path: "/v1/trace/ready",
      body: { ready: false, graph_count: 0, weaviate_ok: false },
    },
    { method: "GET", path: "/v1/trace/tools", body: { tools: [] } },
  ]);
  const d = await Effect.runPromise(httpAdapter(fh).discover());
  assert.equal(d.readiness, "unready");
  assert.deepEqual(d.capabilities, ["status"]);
});

test("an unreachable service is a typed unreachable error on discover", async () => {
  const fh = fakeHttp([], { fail: true });
  const exit = await Effect.runPromiseExit(httpAdapter(fh).discover());
  const err = failureOf(exit);
  assert.equal(err?._tag, "SourceRecallUnreachableError");
});

test("mcp-transport discovery advertises the static graph tool set without HTTP", async () => {
  const fh = fakeHttp([]);
  const mcp = createAleutianAdapter({ id: "aleutian:mcp", http: fh.http, transport: "mcp" });
  const d = await Effect.runPromise(mcp.discover());
  assert.equal(d.readiness, "ready");
  assert.deepEqual([...d.capabilities].sort(), ["call_graph", "status", "symbol_search"]);
  assert.equal(fh.calls.length, 0, "mcp discovery makes no HTTP calls");
});

// -- Query + context mapping (M6) ---------------------------------------------

test("query inits a graph once, assembles context, and resolves symbols to cited items", async () => {
  const fh = fakeHttp([
    {
      method: "POST",
      path: "/v1/trace/init",
      body: { graph_id: "g1", files_parsed: 120, symbols_extracted: 900, edges_built: 400 },
    },
    {
      method: "POST",
      path: "/v1/trace/context",
      body: {
        context: "# HandleInit\n...",
        tokens_used: 512,
        symbols_included: ["sym-1"],
        suggestions: ["also consider RegisterRoutes"],
      },
    },
    { method: "GET", path: "/v1/trace/symbol/sym-1", body: { symbol: SYMBOL } },
  ]);
  const adapter = httpAdapter(fh);
  const first = await Effect.runPromise(
    adapter.query({ query: "how is a graph initialized", topK: 8 }),
  );
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0]?.filePath, "services/trace/handlers.go");
  assert.equal(first.items[0]?.symbolName, "HandleInit");
  assert.equal(first.items[0]?.searchQuality, "graph");
  assert.equal(first.freshness?.fileCount, 120);

  // A second query reuses the cached graph - no second /init call.
  await Effect.runPromise(adapter.query({ query: "again", topK: 8 }));
  const initCalls = fh.calls.filter((c) => c.url.includes("/v1/trace/init"));
  assert.equal(initCalls.length, 1, "graph init is cached across queries");
});

test("query without any project root is a typed not-initialized error", async () => {
  const fh = fakeHttp([]);
  const adapter = createAleutianAdapter({ id: "aleutian:trace", http: fh.http, transport: "http" });
  const exit = await Effect.runPromiseExit(adapter.query({ query: "x", topK: 8 }));
  const err = failureOf(exit);
  assert.equal(err?._tag, "SourceRecallNotInitializedError");
});

test("GRAPH_NOT_INITIALIZED from context surfaces as a typed not-initialized error", async () => {
  const fh = fakeHttp([
    {
      method: "POST",
      path: "/v1/trace/init",
      body: { graph_id: "g1", files_parsed: 1, symbols_extracted: 1 },
    },
    {
      method: "POST",
      path: "/v1/trace/context",
      status: 400,
      body: { error: "graph expired", code: "GRAPH_NOT_INITIALIZED" },
    },
  ]);
  const exit = await Effect.runPromiseExit(httpAdapter(fh).query({ query: "x", topK: 8 }));
  const err = failureOf(exit);
  assert.equal(err?._tag, "SourceRecallNotInitializedError");
});

test("a missing symbol is skipped, not fatal (best-effort resolution)", async () => {
  const fh = fakeHttp([
    {
      method: "POST",
      path: "/v1/trace/init",
      body: { graph_id: "g1", files_parsed: 1, symbols_extracted: 2 },
    },
    {
      method: "POST",
      path: "/v1/trace/context",
      body: { context: "", tokens_used: 0, symbols_included: ["gone", "sym-1"] },
    },
    {
      method: "GET",
      path: "/v1/trace/symbol/gone",
      status: 400,
      body: { error: "not found", code: "SYMBOL_NOT_FOUND" },
    },
    { method: "GET", path: "/v1/trace/symbol/sym-1", body: { symbol: SYMBOL } },
  ]);
  const answer = await Effect.runPromise(httpAdapter(fh).query({ query: "x", topK: 8 }));
  assert.equal(answer.items.length, 1);
  assert.equal(answer.items[0]?.symbolName, "HandleInit");
});

test("mcp-transport query degrades to a typed capability-missing error (no proxy routing)", async () => {
  const fh = fakeHttp([]);
  const mcp = createAleutianAdapter({ id: "aleutian:mcp", http: fh.http, transport: "mcp" });
  const exit = await Effect.runPromiseExit(mcp.query({ query: "x", topK: 8 }));
  const err = failureOf(exit);
  assert.equal(err?._tag, "SourceRecallCapabilityMissingError");
});

// -- Pure normalization (M5/M6) -----------------------------------------------

test("normalizeCapabilities projects Aleutian breadth onto the shared capability set", () => {
  const mcp = normalizeCapabilities({
    transport: "mcp",
    reachable: true,
    ready: true,
    weaviateOk: false,
    tools: [],
  });
  assert.deepEqual([...mcp.capabilities].sort(), ["call_graph", "status", "symbol_search"]);

  const unreachable = normalizeCapabilities({
    transport: "http",
    reachable: false,
    ready: false,
    weaviateOk: false,
    tools: [],
  });
  assert.equal(unreachable.readiness, "unreachable");
  assert.deepEqual(unreachable.capabilities, []);
});

test("symbolToResultItem carries a file/line citation and provider-specific meta", () => {
  const { item } = symbolToResultItem("aleutian:trace", SYMBOL, 0, 1, 1200);
  assert.equal(item.filePath, "services/trace/handlers.go");
  assert.equal(item.startLine, 40);
  assert.equal(item.meta?.signature, "func HandleInit(c *gin.Context)");
  assert.equal(item.meta?.package, "trace");
});

test("referenceToResultItem maps a reference to a citation-only item", () => {
  const ref: AlReferenceInfo = { file_path: "cmd/main.go", line: 12, column: 4 };
  const item = referenceToResultItem("aleutian:trace", "HandleInit", ref, 0, 1);
  assert.equal(item.filePath, "cmd/main.go");
  assert.equal(item.startLine, 12);
  assert.equal(item.symbolType, "reference");
  assert.equal(item.snippet, "");
});

// biome-ignore lint/suspicious/noExplicitAny: test reads the tagged error's fields off the failure.
function failureOf(exit: Exit.Exit<unknown, unknown>): any {
  if (Exit.isFailure(exit)) {
    const cause = exit.cause;
    return (cause as { error?: unknown }).error ?? cause;
  }
  return undefined;
}
