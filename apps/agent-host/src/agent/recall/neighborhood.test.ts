import assert from "node:assert/strict";
import { test } from "vitest";
import { expandNeighborhoods } from "./neighborhood";
import type { RecallAnchor, RecallRecord, RecallSessionRef } from "./types";

/**
 * D-044 M3: anchor-to-neighborhood expansion with per-neighborhood and total-budget caps. Pure
 * over the corpus + anchors, so these pin the windowing + budget contracts directly.
 */

/** Array index with an assertion, for the repo's noUncheckedIndexedAccess. */
function at<T>(arr: readonly T[], i: number): T {
  const value = arr[i];
  assert.ok(value, `expected an element at index ${i}`);
  return value;
}

const REF: RecallSessionRef = {
  sessionId: "s",
  label: "session",
  project: "p",
  origin: "sibling-session",
};

function rec(seq: number, session: RecallSessionRef = REF): RecallRecord {
  return {
    id: `${session.sessionId}#${seq}`,
    session,
    seq,
    range: { fromSeq: seq, toSeq: seq },
    kind: "user",
    runId: null,
    tool: null,
    foldId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    text: `record ${seq}`,
  };
}

function anchorOf(record: RecallRecord, score = 1): RecallAnchor {
  return { record, score, excerpt: record.text };
}

test("expandNeighborhoods centres a bounded window around the anchor", () => {
  const corpus = Array.from({ length: 10 }, (_, i) => rec(i));
  const { neighborhoods } = expandNeighborhoods(corpus, [anchorOf(rec(5))], { radius: 2 });

  const seqs = at(neighborhoods, 0).records.map((r) => r.seq);
  assert.deepEqual(seqs, [3, 4, 5, 6, 7], "radius 2 yields the anchor plus two each side");
});

test("expandNeighborhoods clamps the window at the start of the log", () => {
  const corpus = Array.from({ length: 5 }, (_, i) => rec(i));
  const { neighborhoods } = expandNeighborhoods(corpus, [anchorOf(rec(0))], { radius: 3 });

  const seqs = at(neighborhoods, 0).records.map((r) => r.seq);
  assert.deepEqual(seqs, [0, 1, 2, 3], "no negative seqs; window clamps to the log head");
});

test("expandNeighborhoods caps per-neighborhood size, keeping the anchor centred", () => {
  const corpus = Array.from({ length: 20 }, (_, i) => rec(i));
  const { neighborhoods } = expandNeighborhoods(corpus, [anchorOf(rec(10))], {
    radius: 5,
    perNeighborhood: 3,
  });

  const seqs = at(neighborhoods, 0).records.map((r) => r.seq);
  assert.equal(seqs.length, 3, "trimmed to the per-neighborhood cap");
  assert.ok(seqs.includes(10), "the anchor stays in the kept window");
});

test("expandNeighborhoods enforces the total-records budget and reports dropped anchors", () => {
  const corpus = Array.from({ length: 60 }, (_, i) => rec(i));
  const anchors = [anchorOf(rec(5)), anchorOf(rec(25)), anchorOf(rec(45))];

  const { neighborhoods, droppedAnchors } = expandNeighborhoods(corpus, anchors, {
    radius: 3,
    totalRecords: 7,
  });

  const total = neighborhoods.reduce((n, nb) => n + nb.records.length, 0);
  assert.ok(total <= 7, "the total recall context never exceeds the budget");
  assert.ok(droppedAnchors >= 1, "anchors past the budget are reported, not silently lost");
});

test("expandNeighborhoods does not double-count records shared by nearby anchors", () => {
  const corpus = Array.from({ length: 10 }, (_, i) => rec(i));
  // Two anchors 2 apart with radius 2 overlap; the second should add only its fresh records.
  const { neighborhoods } = expandNeighborhoods(corpus, [anchorOf(rec(4)), anchorOf(rec(6))], {
    radius: 2,
  });

  const allIds = neighborhoods.flatMap((nb) => nb.records.map((r) => r.id));
  assert.equal(new Set(allIds).size, allIds.length, "no record appears in two neighborhoods");
});
