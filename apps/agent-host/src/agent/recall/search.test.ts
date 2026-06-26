import assert from "node:assert/strict";
import { test } from "vitest";
import { buildBm25Index, tokenize } from "./bm25";
import { excerptFor, searchCorpus } from "./search";
import type { RecallRecord, RecallSessionRef } from "./types";

/**
 * D-044 M2: BM25 ranking, structured filters, neighborhood dedupe, and no-hit behavior over a
 * synthetic corpus. The pieces are pure, so these pin the ranking + filter + dedupe contracts
 * directly without any transport or provider.
 */

/** Array index with an assertion, for the repo's noUncheckedIndexedAccess. */
function at<T>(arr: readonly T[], i: number): T {
  const value = arr[i];
  assert.ok(value, `expected an element at index ${i}`);
  return value;
}

const SIB: RecallSessionRef = {
  sessionId: "sib",
  label: "sibling",
  project: "p",
  origin: "sibling-session",
};

function rec(seq: number, text: string, over: Partial<RecallRecord> = {}): RecallRecord {
  return {
    id: `${over.session?.sessionId ?? SIB.sessionId}#${seq}`,
    session: SIB,
    seq,
    range: { fromSeq: seq, toSeq: seq },
    kind: "user",
    runId: null,
    tool: null,
    foldId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    text,
    ...over,
  };
}

test("tokenize lowercases, splits on non-word chars, and drops single chars", () => {
  assert.deepEqual(tokenize("Read the BM25_index, a!"), ["read", "the", "bm25_index"]);
});

test("BM25 ranks the more query-relevant document first", () => {
  const index = buildBm25Index([
    { id: "a", text: "compaction folds older turns into a rolling summary" },
    { id: "b", text: "the weather today is sunny and warm" },
    { id: "c", text: "compaction compaction compaction summary summary" },
  ]);

  const hits = index.search("compaction summary", 10);

  assert.equal(at(hits, 0).id, "c", "the densest match ranks first");
  assert.ok(
    hits.find((h) => h.id === "a"),
    "a partial match still ranks",
  );
  assert.ok(!hits.find((h) => h.id === "b"), "a zero-overlap document never appears");
});

test("searchCorpus ranks records and attaches a query-centred excerpt", () => {
  const corpus = [
    rec(0, "we discussed the lease heartbeat and the leader election timing"),
    rec(1, "the BM25 recall index ranks records by term overlap and length"),
    rec(2, "lunch options near the office"),
  ];

  const { anchors, searchedRecords } = searchCorpus(corpus, "recall index ranks");

  assert.equal(searchedRecords, 3);
  assert.equal(at(anchors, 0).record.seq, 1, "the recall-index record ranks first");
  assert.ok(at(anchors, 0).excerpt.includes("index"), "the excerpt is centred on the match");
});

test("searchCorpus filters by session, kind, tool, fold id, and turn range", () => {
  const other: RecallSessionRef = { ...SIB, sessionId: "other" };
  const corpus = [
    rec(0, "alpha recall topic", { kind: "user" }),
    rec(1, "alpha recall topic from a tool", { kind: "tool", tool: "grep" }),
    rec(2, "alpha recall topic in another session", { session: other, id: "other#2" }),
    rec(3, "alpha recall topic inside a fold", {
      kind: "fold",
      foldId: "f1",
      range: { fromSeq: 3, toSeq: 9 },
    }),
  ];

  assert.equal(
    searchCorpus(corpus, "alpha recall", { kinds: ["tool"] }).anchors.length,
    1,
    "kind filter keeps only tool records",
  );
  assert.equal(
    at(searchCorpus(corpus, "alpha recall", { tool: "grep" }).anchors, 0).record.tool,
    "grep",
    "tool filter keeps the matching tool",
  );
  assert.equal(
    at(searchCorpus(corpus, "alpha recall", { sessionIds: ["other"] }).anchors, 0).record.session
      .sessionId,
    "other",
    "session filter scopes to the chosen session",
  );
  assert.equal(
    at(searchCorpus(corpus, "alpha recall", { foldId: "f1" }).anchors, 0).record.foldId,
    "f1",
    "fold filter keeps records in that fold",
  );
  assert.equal(
    at(searchCorpus(corpus, "alpha recall", { turnRange: { fromSeq: 5, toSeq: 6 } }).anchors, 0)
      .record.kind,
    "fold",
    "a fold straddling the requested range still matches (range overlap)",
  );
});

test("searchCorpus collapses same-neighborhood hits so one exchange does not dominate", () => {
  const corpus = [
    rec(10, "lease lease lease leader election heartbeat"),
    rec(11, "lease leader election heartbeat continued"),
    rec(12, "lease leader election heartbeat continued more"),
    rec(40, "a distant lease leader election heartbeat record"),
  ];

  const { anchors } = searchCorpus(
    corpus,
    "lease leader election",
    { kinds: ["user"] },
    { dedupeRadius: 4 },
  );

  const seqs = anchors.map((a) => a.record.seq).sort((x, y) => x - y);
  assert.deepEqual(
    seqs,
    [10, 40],
    "adjacent seqs 10-12 collapse to one; the distant seq 40 survives",
  );
});

test("searchCorpus returns no anchors for a no-hit query without erroring", () => {
  const corpus = [rec(0, "completely unrelated content")];

  const { anchors, searchedRecords } = searchCorpus(corpus, "nonexistent xyzzy terms");

  assert.equal(anchors.length, 0);
  assert.equal(searchedRecords, 1, "the record was searched, it just did not match");
});

test("excerptFor falls back to the head when no query term is present", () => {
  const text = "x".repeat(400);
  const excerpt = excerptFor(text, "absent");
  assert.ok(excerpt.endsWith("…"));
  assert.ok(excerpt.length < text.length);
});
