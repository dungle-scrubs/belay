import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { buildSystemPrompt } from "../../providers/system-prompt";
import { docsTool } from "./docs";

/**
 * Plan 05 M8 regression guards (D-009). Two boundaries must not silently erode:
 *
 *  - No direct fetch-backend path. docs reads pages ONLY through the web_fetch ENTRY (which owns the
 *    static -> Jina -> Firecrawl ladder); it must never import a backend module (firecrawl/jina/static)
 *    directly. This extends the firecrawl-name guard in `no-firecrawl.test.ts` to every backend module.
 *  - No workspace-truth substitution. docs is for EXTERNAL documentation; neither the tool description
 *    nor the system prompt may invite it to stand in for reading the active workspace's own code, which
 *    stays on the local file/search/test/compiler tools.
 */

const HERE = import.meta.dirname;
const PROMPT = buildSystemPrompt([{ name: "docs", description: "x", parameters: {} }], {
  workspaceRoot: "/ws",
  cwd: "/ws",
});

function sourceFiles(): readonly string[] {
  return readdirSync(HERE).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
}

test("no docs source imports a web_fetch backend module directly (only the web_fetch entry)", () => {
  // A direct import of a backend FILE (firecrawl-fetch / jina-fetch / static-fetch) bypasses the ladder
  // and provenance the web_fetch entry owns; only `web-fetch/web-fetch` (the entry) is allowed.
  const backendImport =
    /from\s+["'][^"']*web-fetch\/(?:firecrawl-fetch|jina-fetch|static-fetch)["']/;

  for (const name of sourceFiles()) {
    const source = readFileSync(join(HERE, name), "utf8");

    assert.ok(
      !backendImport.test(source),
      `${name} imports a web_fetch backend module directly; route through the web_fetch entry instead`,
    );
  }
});

test("docs routes both network seams through the web_search/web_fetch entries", () => {
  const docs = readFileSync(join(HERE, "docs.ts"), "utf8");

  assert.ok(/runWebFetch/.test(docs), "docs binds page reads to the web_fetch entry");
  assert.ok(/runWebSearch/.test(docs), "docs binds discovery to the web_search entry");
});

test("the docs tool description forbids using it for the workspace's own code", () => {
  assert.equal(docsTool.name, "docs");
  assert.match(
    docsTool.description,
    /EXTERNAL documentation/,
    "the description scopes docs to external documentation",
  );
  assert.match(
    docsTool.description,
    /NOT to crawl, browse, or search the workspace's own code/,
    "the description forbids docs as a workspace code-search tool",
  );
});

test("the system prompt keeps workspace-truth on local tools, never substituting docs", () => {
  assert.ok(
    PROMPT.includes("Do NOT use docs for the active workspace's own source truth"),
    "the prompt forbids docs for the workspace's own source truth",
  );
  assert.ok(
    PROMPT.includes("read, glob, grep, ast_grep, the tests, and the compiler"),
    "the prompt routes workspace truth to the local file/search/test/compiler tools",
  );
  assert.ok(
    PROMPT.includes("never a substitute for reading the repo you are working in"),
    "the prompt forbids docs as a stand-in for reading the active repository",
  );
});
