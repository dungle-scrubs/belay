import assert from "node:assert/strict";
import { Either, Schema } from "effect";
import { test } from "vitest";
import type { DocsFs } from "./corpus-store";
import { type DocsArgs, type DocsDeps, DocsParams, docsTool, runDocs } from "./docs";
import { DOCS_ACTIONS } from "./envelope";

/**
 * Tool-entry coverage: the param schema accepts every action and rejects an unknown/absent one, the
 * tool declares read-only, the dependency gate yields a typed `unavailable` outcome (never a thrown
 * turn) when web_fetch or the corpus root is missing, and a ready call routes each action to its
 * service seam (a typed `not-implemented` until later phases). No real disk or network is touched.
 */

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

test("a ready call routes each action to its seam and reports not-implemented in Phase 1", async () => {
  for (const action of DOCS_ACTIONS) {
    const parsed = await run({ action }, readyDeps);
    assert.equal(parsed.action, action);
    assert.equal(parsed.outcome, "not-implemented", `action ${action} should be not-implemented`);
  }
});
