import assert from "node:assert/strict";
import { test } from "vitest";
import type { RecallResult } from "./recall";
import { decodeRecallResult } from "./recall";
import {
  decodeSourceRecallIndexStatus,
  decodeSourceRecallRefreshResult,
  decodeSourceRecallResult,
  type SourceRecallIndexStatus,
  type SourceRecallRefreshResult,
  type SourceRecallResult,
} from "./source-recall";

/**
 * Plan 38 M1: the source-recall wire contract, and the guarantee that indexed source recall and
 * session recall (D-044) are DISJOINT contracts - neither result decodes as the other, so the two
 * feature names can never blur (D-001).
 */

const QUERY_RESULT: SourceRecallResult = {
  status: "ok",
  providerId: "source-recall:local",
  providerKind: "source-recall",
  query: "how does authentication work",
  repo: "api",
  results: [
    {
      providerId: "source-recall:local",
      filePath: "src/auth/session.ts",
      startLine: 10,
      endLine: 42,
      symbolName: "verifySession",
      symbolType: "function",
      snippet: "export function verifySession(token: string) { /* ... */ }",
      score: 0.87,
      matchReason: "bm25+vector",
      searchQuality: "ast",
      repoName: "api",
    },
  ],
  freshness: {
    indexedAt: "2026-07-01T00:00:00.000Z",
    lastCommit: "abc123",
    fileCount: 120,
    chunkCount: 1400,
    vectorCount: 1400,
    stale: false,
  },
  latencyMs: 42,
  capped: false,
  truncated: false,
  diagnostics: [],
};

const RECALL_RESULT: RecallResult = {
  status: "ok",
  query: "which database did we choose",
  findings: [{ summary: "We chose SQLite.", citations: ["s#1"] }],
  sources: [
    {
      id: "s#1",
      sessionId: "s",
      sessionLabel: "store setup",
      origin: "sibling-session",
      seq: 1,
      range: { fromSeq: 1, toSeq: 1 },
      kind: "assistant",
      timestamp: "2026-07-01T00:00:00.000Z",
      excerpt: "SQLite in WAL mode",
    },
  ],
  diagnostics: [],
  activity: {
    searchedSessions: 1,
    searchedFolds: 0,
    searchedRecords: 10,
    anchors: 1,
    neighborhoods: 1,
  },
};

test("a source-recall query result round-trips through its decoder", () => {
  const decoded = decodeSourceRecallResult(JSON.stringify(QUERY_RESULT));
  assert.ok(decoded, "expected a source-recall result");
  assert.equal(decoded.providerKind, "source-recall");
  assert.equal(decoded.results.length, 1);
  assert.equal(decoded.results[0]?.filePath, "src/auth/session.ts");
});

test("a session-recall result is NOT decodable as a source-recall result (contracts are disjoint)", () => {
  // A RecallResult carries `findings`/`sources`/`activity` and NEVER a `results` array, so the
  // source-recall decoder rejects it: the two contracts cannot be silently interchanged.
  assert.equal(decodeSourceRecallResult(JSON.stringify(RECALL_RESULT)), null);
});

test("a source-recall result is NOT decodable as a session-recall result (contracts are disjoint)", () => {
  // A SourceRecallResult carries `results` and NEVER a `findings` array, so the session-recall
  // decoder rejects it.
  assert.equal(decodeRecallResult(JSON.stringify(QUERY_RESULT)), null);
});

test("the three source-recall envelopes do not cross-decode as each other", () => {
  const status: SourceRecallIndexStatus = {
    status: "ok",
    providerId: "source-recall:local",
    providerKind: "source-recall",
    capabilities: ["chunk_search", "status", "refresh"],
    repos: [
      {
        name: "api",
        readiness: "ready",
        freshness: {
          indexedAt: "2026-07-01T00:00:00.000Z",
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
  const refresh: SourceRecallRefreshResult = {
    status: "ok",
    providerId: "source-recall:local",
    providerKind: "source-recall",
    repo: "api",
    filesUpdated: 3,
    refreshMs: 120,
    diagnostics: [],
  };

  // Each decoder accepts only its own envelope.
  assert.ok(decodeSourceRecallIndexStatus(JSON.stringify(status)));
  assert.ok(decodeSourceRecallRefreshResult(JSON.stringify(refresh)));

  assert.equal(decodeSourceRecallResult(JSON.stringify(status)), null);
  assert.equal(decodeSourceRecallResult(JSON.stringify(refresh)), null);
  assert.equal(decodeSourceRecallIndexStatus(JSON.stringify(QUERY_RESULT)), null);
  assert.equal(decodeSourceRecallIndexStatus(JSON.stringify(refresh)), null);
  assert.equal(decodeSourceRecallRefreshResult(JSON.stringify(QUERY_RESULT)), null);
  assert.equal(decodeSourceRecallRefreshResult(JSON.stringify(status)), null);
});

test("decoders return null for running (undefined) and error-line bodies", () => {
  assert.equal(decodeSourceRecallResult(undefined), null);
  assert.equal(decodeSourceRecallResult("error: source recall failed"), null);
  assert.equal(decodeSourceRecallResult("{not json"), null);
  assert.equal(decodeSourceRecallIndexStatus(undefined), null);
  assert.equal(decodeSourceRecallRefreshResult(undefined), null);
});

test("the source-recall result type is not assignable from a session-recall result at compile time", () => {
  // @ts-expect-error - a RecallResult (findings/sources/activity) is not a SourceRecallResult
  // (results/providerId/freshness). The compiler enforces the D-001 separation the decoders assert
  // at runtime; if this line ever stops erroring, the two contracts have converged and drifted.
  const bad: SourceRecallResult = RECALL_RESULT;
  assert.ok(bad);
});
