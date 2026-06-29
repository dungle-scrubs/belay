import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

/**
 * Boundary guard (D-003): docs reads pages ONLY through the web_fetch seam, which owns the fetch
 * backend ladder; docs must never import or call a fetch backend (e.g. the rendered backend) directly.
 * This scans every non-test source file in docs/ for a direct backend import or call, and confirms
 * docs does route through web_fetch.
 */

const HERE = import.meta.dirname;

function sourceFiles(): readonly string[] {
  return readdirSync(HERE).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
}

test("no docs source imports a fetch backend directly", () => {
  for (const name of sourceFiles()) {
    const source = readFileSync(join(HERE, name), "utf8");

    assert.ok(
      !/from\s+["'][^"']*firecrawl[^"']*["']/i.test(source),
      `${name} imports a fetch backend directly; route through web_fetch instead`,
    );
  }
});

test("no docs source calls a fetch backend directly", () => {
  for (const name of sourceFiles()) {
    const source = readFileSync(join(HERE, name), "utf8");

    assert.ok(
      !/\bfirecrawl\w*\s*\(/i.test(source),
      `${name} calls a fetch backend directly; route through web_fetch instead`,
    );
  }
});

test("docs routes page reads through web_fetch", () => {
  const docs = readFileSync(join(HERE, "docs.ts"), "utf8");

  assert.ok(/runWebFetch/.test(docs), "docs binds the live reader to runWebFetch");
});
