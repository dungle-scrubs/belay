import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Tool } from "@host/tools";
import { normalizeSourceRecallConfig } from "@host/tools/source-recall/config";
import { createSourceRecallRegistry } from "@host/tools/source-recall/registry";
import { buildSourceRecallTools } from "@host/tools/source-recall/tools";
import {
  decodeSourceRecallIndexStatus,
  decodeSourceRecallRefreshResult,
  decodeSourceRecallResult,
} from "@trevor/session";
import { Effect } from "effect";
import { afterAll, beforeAll, test } from "vitest";

/**
 * Plan 38 M10 (hermetic): drive the three model-facing source-recall tools end-to-end against a REAL
 * in-process HTTP server that mimics the `source-recall` daemon's `/query`, `/status`, `/repos`, and
 * `/refresh` endpoints on an ephemeral port. Uses the real global `fetch` (no injected transport, no
 * mocked HTTP) and no embedding download - a fully deterministic, CI-safe lane. This proves the
 * registry -> adapter -> transport -> tool envelope path works over a live socket, not just in unit
 * mocks.
 */

let server: Server;
let baseUrl = "";
const calls: string[] = [];

/** A tiny stand-in for the source-recall daemon: enough of the documented API for the tool path. */
beforeAll(async () => {
  server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const path = (req.url ?? "").split("?")[0];
    if (path === "/query" && req.method === "POST") {
      return send(200, {
        query_ms: 11.2,
        results: [
          {
            chunk_id: "c1",
            file_path: "src/turn.ts",
            symbol_name: "runTurn",
            symbol_type: "function",
            content: "export async function runTurn() { /* ... */ }",
            score: 0.88,
            start_line: 20,
            end_line: 60,
            search_quality: "ast",
            match_reason: "bm25+vector",
          },
        ],
      });
    }
    if (path === "/status") {
      return send(200, {
        repo_path: "/p",
        file_count: 42,
        chunk_count: 500,
        vector_count: 500,
        embed_model: "CodeRankEmbed",
        embed_dimensions: 768,
        db_size_bytes: 4096,
        indexed_at: new Date().toISOString(),
      });
    }
    if (path === "/repos") {
      return send(200, {
        repos: [{ name: "app", path: "/p", file_count: 42, chunk_count: 500, vector_count: 500 }],
      });
    }
    if (path === "/refresh" && req.method === "POST") {
      return send(200, { files_updated: 2, refresh_ms: 33.0 });
    }
    return send(404, { detail: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function tools(): Record<string, Tool<unknown>> {
  const config = normalizeSourceRecallConfig({
    providers: { app: { kind: "source-recall", endpoint: baseUrl } },
  });
  // No injected fetch: the registry uses the real global fetch over the live socket.
  const registry = createSourceRecallRegistry(config);
  return Object.fromEntries(
    buildSourceRecallTools(registry).map((t) => [t.name, t as unknown as Tool<unknown>]),
  );
}

const run = (t: Tool<unknown>, args: unknown) =>
  Effect.runPromise(t.execute(args as never, { workspaceRoot: "/p" }));

test("source_recall queries the live in-process daemon and returns cited results", async () => {
  const raw = await run(tools().source_recall as Tool<unknown>, { query: "how does a turn run" });
  const decoded = decodeSourceRecallResult(raw);
  assert.equal(decoded?.status, "ok");
  assert.equal(decoded?.results[0]?.filePath, "src/turn.ts");
  assert.equal(decoded?.results[0]?.symbolName, "runTurn");
  assert.ok(
    calls.some((c) => c.startsWith("POST /query")),
    "the daemon received the query",
  );
});

test("source_index_status reports the served repo over the live socket", async () => {
  const raw = await run(tools().source_index_status as Tool<unknown>, {});
  const decoded = decodeSourceRecallIndexStatus(raw);
  assert.equal(decoded?.status, "ok");
  assert.equal(decoded?.repos[0]?.name, "app");
});

test("source_index_refresh triggers a re-index over the live socket", async () => {
  const raw = await run(tools().source_index_refresh as Tool<unknown>, { repo: "app" });
  const decoded = decodeSourceRecallRefreshResult(raw);
  assert.equal(decoded?.status, "ok");
  assert.equal(decoded?.filesUpdated, 2);
});
