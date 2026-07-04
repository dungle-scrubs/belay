import assert from "node:assert/strict";
import { fireEvent, render } from "@testing-library/react";
import type {
  SourceRecallIndexStatus,
  SourceRecallRefreshResult,
  SourceRecallResult,
} from "@trevor/session";
import { test } from "vitest";
import type { ToolMessage as ToolMessageData } from "@/transcript";
import { SourceRecallRefresh, SourceRecallResults, SourceRecallStatus } from "./source-recall";
import { ToolRenderer } from "./tool-message";

/**
 * Plan 38 M9: the indexed source-recall transcript surface. Pins that cited candidates render with a
 * clickable file path, that the freshness/stale + unavailable/no-results/error states show, that the
 * status + refresh surfaces render, and that the tool dispatch routes the three tools here (and NOT
 * to the session-recall surface).
 */

const NOW = Date.parse("2026-07-05T12:00:00.000Z");

function result(over: Partial<SourceRecallResult>): SourceRecallResult {
  return {
    status: "ok",
    providerId: "source-recall:local",
    providerKind: "source-recall",
    query: "how are sessions verified",
    repo: "api",
    results: [],
    freshness: null,
    latencyMs: 42,
    capped: false,
    truncated: false,
    diagnostics: [],
    ...over,
  };
}

const HIT = result({
  results: [
    {
      providerId: "source-recall:local",
      filePath: "src/auth/session.ts",
      startLine: 10,
      endLine: 42,
      symbolName: "verifySession",
      symbolType: "function",
      snippet: "export function verifySession(token: string) { return check(token); }",
      score: 0.9,
      matchReason: "bm25+vector",
      searchQuality: "ast",
      repoName: "api",
    },
  ],
  freshness: {
    indexedAt: new Date(NOW - 1000 * 60 * 30).toISOString(),
    lastCommit: null,
    fileCount: 120,
    chunkCount: 1400,
    vectorCount: 1400,
    stale: false,
  },
});

test("renders a cited candidate with file path, line range, and symbol", () => {
  const { container } = render(<SourceRecallResults query={HIT.query} result={HIT} nowMs={NOW} />);
  const text = container.textContent ?? "";
  assert.ok(text.includes("src/auth/session.ts"), "the file path is cited");
  assert.ok(text.includes("L10-42"), "the line range is cited");
  assert.ok(text.includes("verifySession"), "the symbol is named");
  assert.ok(text.includes("source-recall:local"), "the provider is shown in the meta line");
});

test("a cited file path is clickable and calls onOpenPath", () => {
  const opened: string[] = [];
  const { getByRole } = render(
    <SourceRecallResults
      query={HIT.query}
      result={HIT}
      nowMs={NOW}
      onOpenPath={(p) => opened.push(p)}
    />,
  );
  fireEvent.click(getByRole("button", { name: /src\/auth\/session\.ts/ }));
  assert.deepEqual(opened, ["src/auth/session.ts"]);
});

test("a stale index shows the refresh hint", () => {
  const stale = result({
    status: "stale",
    results: HIT.results,
    freshness: {
      indexedAt: new Date(NOW - 1000 * 60 * 60 * 30).toISOString(),
      lastCommit: null,
      fileCount: 120,
      chunkCount: 1400,
      vectorCount: 1400,
      stale: true,
    },
  });
  const { container } = render(
    <SourceRecallResults query={stale.query} result={stale} nowMs={NOW} />,
  );
  assert.ok((container.textContent ?? "").includes("stale"), "the stale flag renders");
});

test("an unavailable result shows a neutral provider note (not an error crash)", () => {
  const un = result({
    status: "unavailable",
    providerId: null,
    providerKind: null,
    diagnostics: [
      { kind: "unconfigured", detail: "no source-recall provider is configured or enabled" },
    ],
  });
  const { container } = render(<SourceRecallResults query={un.query} result={un} nowMs={NOW} />);
  assert.ok((container.textContent ?? "").includes("no source-recall provider"));
});

test("no_results renders a neutral empty note", () => {
  const { container } = render(
    <SourceRecallResults query="q" result={result({ status: "no_results" })} nowMs={NOW} />,
  );
  assert.ok((container.textContent ?? "").includes("No indexed code matched"));
});

test("an error result renders the failure detail", () => {
  const errored = result({
    status: "error",
    diagnostics: [{ kind: "malformed_response", detail: "backend returned a non-JSON body" }],
  });
  const { container } = render(
    <SourceRecallResults query={errored.query} result={errored} nowMs={NOW} />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("Source recall failed"));
  assert.ok(text.includes("non-JSON body"));
});

test("shows the searching indicator with the query while running", () => {
  const { container } = render(
    <SourceRecallResults query="where is auth" result={null} status="running" nowMs={NOW} />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.toLowerCase().includes("searching the code index"));
  assert.ok(text.includes("where is auth"), "the running label names the specific query");
});

test("the status surface lists per-repo readiness and capabilities", () => {
  const status: SourceRecallIndexStatus = {
    status: "ok",
    providerId: "source-recall:local",
    providerKind: "source-recall",
    capabilities: ["chunk_search", "semantic_index"],
    repos: [
      {
        name: "api",
        readiness: "ready",
        freshness: {
          indexedAt: null,
          lastCommit: null,
          fileCount: 120,
          chunkCount: 1400,
          vectorCount: 1400,
          stale: false,
        },
      },
    ],
    diagnostics: [],
  };
  const { container } = render(<SourceRecallStatus result={status} nowMs={NOW} />);
  const text = container.textContent ?? "";
  assert.ok(text.includes("api"));
  assert.ok(text.includes("ready"));
  assert.ok(text.includes("chunk_search"));
});

test("the refresh surface reports files updated, and rate-limit as a yellow note", () => {
  const ok: SourceRecallRefreshResult = {
    status: "ok",
    providerId: "source-recall:local",
    providerKind: "source-recall",
    repo: "api",
    filesUpdated: 3,
    refreshMs: 120,
    diagnostics: [],
  };
  assert.ok(
    (render(<SourceRecallRefresh result={ok} />).container.textContent ?? "").includes(
      "Re-indexed 3 files",
    ),
  );

  const limited: SourceRecallRefreshResult = {
    ...ok,
    status: "rate_limited",
    filesUpdated: null,
    refreshMs: null,
    diagnostics: [{ kind: "rate_limited", detail: "retry in 8s" }],
  };
  assert.ok(
    (render(<SourceRecallRefresh result={limited} />).container.textContent ?? "").includes(
      "rate-limited",
    ),
  );
});

test("the tool dispatch routes source_recall here, not to session recall", () => {
  const message: ToolMessageData = {
    kind: "tool",
    id: "t1",
    name: "source_recall",
    args: JSON.stringify({ query: "how are sessions verified" }),
    result: JSON.stringify(HIT),
    done: true,
  };
  const { container } = render(<ToolRenderer message={message} onOpenPath={() => {}} />);
  const text = container.textContent ?? "";
  assert.ok(text.includes("src/auth/session.ts"), "the cited file renders via dispatch");
  assert.ok(text.includes("verifySession"), "the symbol renders via dispatch");
});

test("the tool dispatch routes source_index_status and source_index_refresh", () => {
  const statusMsg: ToolMessageData = {
    kind: "tool",
    id: "s1",
    name: "source_index_status",
    args: "{}",
    result: JSON.stringify({
      status: "ok",
      providerId: "source-recall:local",
      providerKind: "source-recall",
      capabilities: ["chunk_search"],
      repos: [
        {
          name: "api",
          readiness: "ready",
          freshness: {
            indexedAt: null,
            lastCommit: null,
            fileCount: 1,
            chunkCount: 1,
            vectorCount: 1,
            stale: false,
          },
        },
      ],
      diagnostics: [],
    }),
    done: true,
  };
  assert.ok(
    (
      render(<ToolRenderer message={statusMsg} onOpenPath={() => {}} />).container.textContent ?? ""
    ).includes("api"),
  );

  const refreshMsg: ToolMessageData = {
    kind: "tool",
    id: "r1",
    name: "source_index_refresh",
    args: "{}",
    result: JSON.stringify({
      status: "ok",
      providerId: "source-recall:local",
      providerKind: "source-recall",
      repo: "api",
      filesUpdated: 2,
      refreshMs: 50,
      diagnostics: [],
    }),
    done: true,
  };
  assert.ok(
    (
      render(<ToolRenderer message={refreshMsg} onOpenPath={() => {}} />).container.textContent ??
      ""
    ).includes("Re-indexed 2 files"),
  );
});
