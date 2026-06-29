import assert from "node:assert/strict";
import { test } from "vitest";
import {
  type DocsResult,
  notImplementedResult,
  serializeDocsResult,
  unavailableResult,
} from "./envelope";

/**
 * The result envelope is the docs contract the model reads. These pin the typed outcomes wired in
 * Phase 1 (unavailable, not-implemented) and that absent optional payloads are omitted, so later
 * phases attach corpus/query/page payloads without changing the base shape.
 */

test("unavailableResult is a typed unavailable outcome listing the missing dependencies", () => {
  const result = unavailableResult("resolve", ["web_fetch", "docs corpus root"]);

  assert.equal(result.action, "resolve");
  assert.equal(result.outcome, "unavailable");
  assert.deepEqual(result.missing, ["web_fetch", "docs corpus root"]);
  assert.match(result.detail, /unavailable/u);
});

test("notImplementedResult is a typed not-implemented outcome", () => {
  const result = notImplementedResult("search");

  assert.equal(result.action, "search");
  assert.equal(result.outcome, "not-implemented");
});

test("serializeDocsResult emits the base fields and omits absent optional payloads", () => {
  const parsed = JSON.parse(serializeDocsResult(notImplementedResult("list")));

  assert.equal(parsed.action, "list");
  assert.equal(parsed.outcome, "not-implemented");
  assert.equal(typeof parsed.detail, "string");
  for (const key of ["missing", "corpus", "corpora", "query", "page", "diagnostics"]) {
    assert.ok(!(key in parsed), `absent ${key} is omitted`);
  }
});

test("serializeDocsResult round-trips the unavailable outcome's missing list", () => {
  const parsed = JSON.parse(serializeDocsResult(unavailableResult("status", ["web_fetch"])));

  assert.equal(parsed.outcome, "unavailable");
  assert.deepEqual(parsed.missing, ["web_fetch"]);
});

test("serializeDocsResult carries an attached corpus payload when present", () => {
  const result: DocsResult = {
    action: "status",
    outcome: "ok",
    detail: "found",
    corpus: {
      corpusId: "c-1",
      subject: "Effect",
      rootUrl: "https://effect.website/docs",
      pageCount: 3,
      updatedAt: "2026-06-29T00:00:00.000Z",
      staleAfter: "2026-07-06T00:00:00.000Z",
      partial: false,
    },
  };

  const parsed = JSON.parse(serializeDocsResult(result));

  assert.equal(parsed.corpus.corpusId, "c-1");
  assert.equal(parsed.corpus.pageCount, 3);
});
