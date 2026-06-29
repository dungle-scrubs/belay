import assert from "node:assert/strict";
import { test } from "vitest";
import { type Corpus, DOCS_CORPUS_VERSION, staleAfterFrom } from "./corpus";
import { DEFAULT_FRESHNESS_HOURS, decideRefresh, isCorpusStale, isStaleAt } from "./freshness";

/**
 * The freshness policy: a corpus stays fresh for 24 hours after its last fetch, the staleness boundary
 * is reached inclusively, an unprovable timestamp is treated as stale, and the reuse decision (reuse
 * fresh, serve stale, or refresh) is computed without any clock or network. The policy is deliberately
 * separate from query ranking, so it is exercised here in isolation.
 */

const UPDATED = "2026-06-29T00:00:00.000Z";

function corpusStaleAfter(hours: number): Corpus {
  const staleAfter = staleAfterFrom(UPDATED, hours);

  return {
    version: DOCS_CORPUS_VERSION,
    corpusId: "acme-000000000000",
    subject: "Acme",
    name: "Acme",
    source: { rootUrl: "https://docs.acme.dev/guide", host: "docs.acme.dev" },
    createdAt: UPDATED,
    updatedAt: UPDATED,
    staleAfter,
    policy: { maxPages: 40, fetchMode: "auto", freshnessHours: hours },
    pageCount: 1,
    byteCount: 10,
    truncated: false,
    partial: false,
    provenance: "test",
    skipped: [],
    failed: [],
  };
}

test("the default freshness window is 24 hours", () => {
  assert.equal(DEFAULT_FRESHNESS_HOURS, 24);
});

test("a corpus is fresh up to its 24-hour horizon and stale at or past it", () => {
  const horizon = staleAfterFrom(UPDATED, 24);

  assert.equal(isStaleAt(horizon, UPDATED), false);
  assert.equal(isStaleAt(horizon, "2026-06-29T23:59:59.999Z"), false);
  assert.equal(isStaleAt(horizon, horizon), true);
  assert.equal(isStaleAt(horizon, "2026-06-30T00:00:00.001Z"), true);
});

test("an unparseable timestamp is treated as stale, not silently fresh", () => {
  assert.equal(isStaleAt("not-a-date", UPDATED), true);
  assert.equal(isStaleAt(staleAfterFrom(UPDATED, 24), "not-a-date"), true);
});

test("isCorpusStale reads the corpus's own freshness horizon", () => {
  const corpus = corpusStaleAfter(24);

  assert.equal(isCorpusStale(corpus, "2026-06-29T12:00:00.000Z"), false);
  assert.equal(isCorpusStale(corpus, "2026-06-30T12:00:00.000Z"), true);
});

test("decideRefresh refreshes when no corpus is cached", () => {
  assert.equal(
    decideRefresh({ exists: false, stale: false, allowRefresh: false, allowStale: false }),
    "refresh",
  );
});

test("decideRefresh reuses a fresh corpus and refreshes a stale one by default", () => {
  assert.equal(
    decideRefresh({ exists: true, stale: false, allowRefresh: false, allowStale: false }),
    "reuse-fresh",
  );
  assert.equal(
    decideRefresh({ exists: true, stale: true, allowRefresh: false, allowStale: false }),
    "refresh",
  );
});

test("decideRefresh forces a refresh when allowRefresh is set, even on a fresh corpus", () => {
  assert.equal(
    decideRefresh({ exists: true, stale: false, allowRefresh: true, allowStale: false }),
    "refresh",
  );
});

test("decideRefresh serves a stale corpus without a network attempt when allowStale is set", () => {
  assert.equal(
    decideRefresh({ exists: true, stale: true, allowRefresh: false, allowStale: true }),
    "reuse-stale",
  );
  assert.equal(
    decideRefresh({ exists: true, stale: false, allowRefresh: false, allowStale: true }),
    "reuse-fresh",
  );
});

test("allowStale wins over allowRefresh so accepting stale never triggers a network refresh", () => {
  assert.equal(
    decideRefresh({ exists: true, stale: true, allowRefresh: true, allowStale: true }),
    "reuse-stale",
  );
});
