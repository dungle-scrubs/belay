import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, test } from "vitest";

/**
 * Read-only structural search via ast-grep (Phase 6 M2 / D-062). The workspace root is read at
 * module load, so TREVOR_WORKSPACE is set before the dynamic import, against a throwaway TS tree.
 * These pin: AST matches (formatting-independent), explicit + inferred language, no-match, an
 * invalid pattern/lang as a typed input error, the match cap, workspace confinement, and read-only
 * registry inclusion.
 */

const ws = mkdtempSync(join(tmpdir(), "trevor-sg-"));
mkdirSync(join(ws, "src"), { recursive: true });
// Two console.log calls with DIFFERENT formatting - an AST pattern matches both regardless.
writeFileSync(
  join(ws, "src", "a.ts"),
  'console.log("one");\nconsole.log(\n  "two",\n  extra,\n);\nconst x = 1;\n',
);
writeFileSync(join(ws, "src", "b.tsx"), "export const C = () => <div>{console.log(123)}</div>;\n");

const prev = process.env.TREVOR_WORKSPACE;
process.env.TREVOR_WORKSPACE = ws;

const { executeTool, READ_ONLY_TOOLS, TOOL_DEFS } = await import("./index");
const sg = (args: Record<string, unknown>): Promise<string> =>
  Effect.runPromise(executeTool("ast_grep", JSON.stringify(args)));

afterAll(() => {
  if (prev === undefined) delete process.env.TREVOR_WORKSPACE;
  else process.env.TREVOR_WORKSPACE = prev;
  rmSync(ws, { recursive: true, force: true });
});

test("ast_grep is registered as a read-only tool", () => {
  assert.ok(
    TOOL_DEFS.some((t) => t.name === "ast_grep"),
    "ast_grep is advertised (the binary resolved)",
  );
  assert.ok(READ_ONLY_TOOLS.has("ast_grep"), "ast_grep is read-only");
});

test("a structural pattern matches across formatting (single- and multi-line calls)", async () => {
  const out = await sg({ pattern: "console.log($$$)", lang: "ts" });
  // The single-line and the multi-line console.log in a.ts both match.
  const aMatches = out.split("\n").filter((l) => l.startsWith("src/a.ts:"));
  assert.equal(aMatches.length, 2, "both the one-line and the multi-line call match");
  assert.match(out, /^src\/a\.ts:1:1/m, "file:line:col rows");
});

test("language is inferred from file extensions when lang is omitted", async () => {
  // No lang: ast-grep infers ts/tsx from extensions, so the .tsx match is found too.
  const out = await sg({ pattern: "console.log($$$)" });
  assert.ok(out.includes("src/b.tsx:"), "the .tsx call is matched via inferred language");
});

test("a no-match pattern returns (no matches)", async () => {
  assert.equal(await sg({ pattern: "thisFunctionDoesNotExist($$$)", lang: "ts" }), "(no matches)");
});

test("an unknown language is a typed input error", async () => {
  const out = await sg({ pattern: "console.log($$$)", lang: "klingon" });
  assert.ok(out.startsWith("error:"), out);
});

test("maxMatches caps the rows", async () => {
  const out = await sg({ pattern: "console.log($$$)", maxMatches: 1 });
  const rows = out.split("\n").filter((l) => /:\d+:\d+/.test(l));
  assert.equal(rows.length, 1);
  assert.match(out, /capped at 1 matches/);
});

test("a path escaping the workspace is refused", async () => {
  const out = await sg({ pattern: "console.log($$$)", paths: ["../../etc"] });
  assert.ok(out.startsWith("error:"), out);
  assert.match(out, /escapes workspace/);
});
