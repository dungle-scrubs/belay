import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

/**
 * Characterization tests for the shared workspace search iterator (M3 / D-006). The iterator owns
 * the glob(cwd)+SKIP_DIRS walk that glob and grep used to each copy, plus the capped-collect with
 * an honest "more exist" flag. TREVOR_WORKSPACE is set before the dynamic import (the tools read
 * the root at module load), against a throwaway tree.
 */

const ws = mkdtempSync(join(tmpdir(), "belay-search-"));
const prevWorkspace = process.env.TREVOR_WORKSPACE;
process.env.TREVOR_WORKSPACE = ws;

const { mkdirSync, writeFileSync } = await import("node:fs");
mkdirSync(join(ws, "src"), { recursive: true });
mkdirSync(join(ws, "node_modules", "pkg"), { recursive: true });
writeFileSync(join(ws, "src", "a.ts"), "a");
writeFileSync(join(ws, "src", "b.ts"), "b");
writeFileSync(join(ws, "src", "c.ts"), "c");
writeFileSync(join(ws, "node_modules", "pkg", "index.ts"), "skip me");

const { walkWorkspace, collectWorkspace } = await import("./search");

afterAll(() => {
  if (prevWorkspace === undefined) delete process.env.TREVOR_WORKSPACE;
  else process.env.TREVOR_WORKSPACE = prevWorkspace;
  rmSync(ws, { recursive: true, force: true });
});

test("walkWorkspace yields matching entries and skips SKIP_DIRS (node_modules)", async () => {
  const entries: string[] = [];
  for await (const entry of walkWorkspace("**/*.ts")) {
    entries.push(entry);
  }
  entries.sort();
  assert.deepEqual(entries, ["src/a.ts", "src/b.ts", "src/c.ts"]);
  assert.ok(!entries.some((e) => e.includes("node_modules")), "node_modules is skipped");
});

test("collectWorkspace reports truncated=false when under the cap", async () => {
  const { items, truncated } = await collectWorkspace("src/*.ts", 10, (e) => e);
  assert.equal(items.length, 3);
  assert.equal(truncated, false);
});

test("collectWorkspace stops at the cap and reports truncated=true when more exist", async () => {
  const { items, truncated } = await collectWorkspace("src/*.ts", 2, (e) => e);
  assert.equal(items.length, 2);
  assert.equal(truncated, true, "a third match existed past the cap");
});

test("collectWorkspace skips entries where select returns undefined (uncounted)", async () => {
  const { items, truncated } = await collectWorkspace("src/*.ts", 10, (e) =>
    e.endsWith("b.ts") ? undefined : e,
  );
  assert.deepEqual(items.sort(), ["src/a.ts", "src/c.ts"]);
  assert.equal(truncated, false);
});
