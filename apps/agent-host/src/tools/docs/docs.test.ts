import assert from "node:assert/strict";
import { Either, Schema } from "effect";
import { test } from "vitest";
import type { DocsFs } from "./corpus-store";
import { type DocsArgs, type DocsDeps, DocsParams, docsTool, runDocs } from "./docs";
import { DOCS_ACTIONS } from "./envelope";

/**
 * Tool-entry coverage: the param schema accepts every action and rejects an unknown/absent one, the
 * tool declares read-only, the dependency gate yields a typed `unavailable` outcome (never a thrown
 * turn) when web_fetch or the corpus root is missing, and a ready call routes each query action to a
 * typed, non-thrown outcome that reads only the filesystem. resolve/refresh build/reuse and are
 * covered in docs-resolve.test.ts and docs-freshness.test.ts; the query actions are covered in
 * docs-query.test.ts. No real disk or network is touched here.
 */

/** The cached-corpus query actions; resolve/refresh build/reuse and are covered separately. */
const QUERY_ACTIONS = DOCS_ACTIONS.filter((action) => action !== "resolve" && action !== "refresh");

/** An empty `DocsFs` the query actions can read without finding any corpus (no network either way). */
const emptyFs: DocsFs = {
  mkdir: async () => {},
  writeFile: async () => assert.fail("a query action must not write"),
  readFile: async () => {
    throw new Error("ENOENT");
  },
  rename: async () => assert.fail("a query action must not rename"),
  readdir: async () => [],
  exists: async () => false,
  remove: async () => assert.fail("a query action must not remove"),
};

function decode(input: unknown): Either.Either<DocsArgs, unknown> {
  return Schema.decodeUnknownEither(DocsParams)(input);
}

/** A DocsFs that fails loudly if touched, so the Phase 1 stub path is proven not to hit the disk. */
const inertFs: DocsFs = {
  mkdir: async () => assert.fail("fs.mkdir must not run in Phase 1"),
  writeFile: async () => assert.fail("fs.writeFile must not run in Phase 1"),
  readFile: async () => assert.fail("fs.readFile must not run in Phase 1"),
  rename: async () => assert.fail("fs.rename must not run in Phase 1"),
  readdir: async () => assert.fail("fs.readdir must not run in Phase 1"),
  exists: async () => assert.fail("fs.exists must not run in Phase 1"),
  remove: async () => assert.fail("fs.remove must not run in Phase 1"),
};

const readyDeps: DocsDeps = {
  webFetch: async () => "{}",
  corpusRoot: "/state/docs",
  fs: inertFs,
  now: () => "2026-06-29T00:00:00.000Z",
};

async function run(args: DocsArgs, deps: DocsDeps): Promise<Record<string, unknown>> {
  return JSON.parse(await runDocs(args, deps));
}

test("the param schema accepts every action", () => {
  for (const action of DOCS_ACTIONS) {
    const decoded = decode({ action });
    assert.ok(Either.isRight(decoded), `action ${action} should decode`);
  }
});

test("the param schema rejects an unknown action and a missing action", () => {
  assert.ok(Either.isLeft(decode({ action: "crawl" })));
  assert.ok(Either.isLeft(decode({})));
});

test("the param schema accepts the optional fields and lenient numeric caps", () => {
  const decoded = decode({
    action: "search",
    subject: "Effect Schema",
    url: "https://effect.website/docs",
    query: "how to decode",
    corpusId: "c-1",
    pageId: "p-1",
    version: "3",
    maxPages: 12,
    maxResults: 5,
  });

  assert.ok(Either.isRight(decoded));
  if (Either.isRight(decoded)) {
    assert.equal(decoded.right.maxPages, 12);
    assert.equal(decoded.right.maxResults, 5);
  }
});

test("the tool is registered read-only", () => {
  assert.equal(docsTool.name, "docs");
  assert.equal(docsTool.readOnly, true);
});

test("a missing web_fetch dependency yields a typed unavailable outcome, not a thrown turn", async () => {
  const parsed = await run(
    { action: "resolve", subject: "Effect Schema" },
    { ...readyDeps, webFetch: undefined },
  );

  assert.equal(parsed.action, "resolve");
  assert.equal(parsed.outcome, "unavailable");
  assert.deepEqual(parsed.missing, ["web_fetch"]);
});

test("a missing corpus root yields a typed unavailable outcome listing it", async () => {
  const parsed = await run({ action: "list" }, { ...readyDeps, corpusRoot: null });

  assert.equal(parsed.outcome, "unavailable");
  assert.deepEqual(parsed.missing, ["docs corpus root"]);
});

test("both dependencies missing are reported together", async () => {
  const parsed = await run(
    { action: "status" },
    { ...readyDeps, webFetch: undefined, corpusRoot: null },
  );

  assert.equal(parsed.outcome, "unavailable");
  assert.deepEqual(parsed.missing, ["web_fetch", "docs corpus root"]);
});

test("a ready call routes each query action to a typed, non-thrown outcome (no corpus cached)", async () => {
  const deps: DocsDeps = { ...readyDeps, fs: emptyFs };

  for (const action of QUERY_ACTIONS) {
    const parsed = await run(
      { action, corpusId: "missing-000000000000", query: "x", pageId: "p-1" },
      deps,
    );
    assert.equal(parsed.action, action);
    assert.notEqual(parsed.outcome, "not-implemented", `action ${action} is implemented`);
    assert.notEqual(parsed.outcome, "unavailable", `action ${action} should not be unavailable`);
  }
});

test("list with no cached corpora is a typed ok with an empty inventory", async () => {
  const parsed = await run({ action: "list" }, { ...readyDeps, fs: emptyFs });

  assert.equal(parsed.outcome, "ok");
  assert.deepEqual(parsed.corpora, []);
  const window = parsed.window as { total: number; truncated: boolean };
  assert.equal(window.total, 0);
  assert.equal(window.truncated, false);
});
