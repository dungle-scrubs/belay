import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, test } from "vitest";

/**
 * Ripgrep-backed grep (Phase 6 M1 / D-062). The workspace root is read at module load, so
 * TREVOR_WORKSPACE is set before the dynamic import, against a throwaway tree with a gitignored
 * directory. These pin the new behavior: .gitignore is respected (overridable), literal vs regex,
 * case-insensitive, the match cap, an invalid regex as a typed input error, and the
 * workspace-relative `path:line:text` shape (no `./` prefix).
 */

const ws = mkdtempSync(join(tmpdir(), "belay-grep-"));
mkdirSync(join(ws, "src"), { recursive: true });
mkdirSync(join(ws, "ignored"), { recursive: true });
// ripgrep honors .gitignore only inside a git repo (the real Belay workspace is one); init one.
// Strip any inherited GIT_* env (a pre-commit hook exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE)
// so `git init` creates a real standalone repo in `ws` instead of attaching to the caller's repo -
// otherwise `ws` stays un-initialized and ripgrep, finding no repo, would not honor .gitignore.
const gitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);
execFileSync("git", ["init", "-q"], { cwd: ws, env: gitEnv });
writeFileSync(join(ws, ".gitignore"), "ignored/\n");
// Also write a `.ignore` file: ripgrep honors it UNCONDITIONALLY (no git-repo detection), so the
// "skipped by default" assertion stays deterministic even when a freshly-init'd repo's `.git` is
// momentarily not detected under heavy parallel CPU load (the real workspace's `.git` is stable).
writeFileSync(join(ws, ".ignore"), "ignored/\n");
writeFileSync(join(ws, "src", "a.ts"), 'const greeting = "hello";\nconst pattern = "a.b";\n');
writeFileSync(join(ws, "src", "b.ts"), 'const greeting = "hi";\nconst other = "axb";\n');
writeFileSync(join(ws, "ignored", "secret.ts"), 'const greeting = "ignored";\n');

const prev = process.env.TREVOR_WORKSPACE;
process.env.TREVOR_WORKSPACE = ws;

const { executeTool } = await import("./index");
const grep = (args: Record<string, unknown>): Promise<string> =>
  Effect.runPromise(executeTool("grep", JSON.stringify(args)));

afterAll(() => {
  if (prev === undefined) delete process.env.TREVOR_WORKSPACE;
  else process.env.TREVOR_WORKSPACE = prev;
  rmSync(ws, { recursive: true, force: true });
});

test("matches return workspace-relative path:line:text (no ./ prefix), gitignore respected", async () => {
  const out = await grep({ pattern: "greeting" });
  assert.match(out, /^src\/a\.ts:1:/m, "a workspace-relative path, no ./ prefix");
  assert.ok(out.includes("src/b.ts:1:"), "both source files match");
  assert.ok(!out.includes("ignored/"), "a gitignored directory is skipped by default");
});

test("noIgnore searches gitignored files too", async () => {
  const out = await grep({ pattern: "greeting", noIgnore: true });
  assert.ok(out.includes("ignored/secret.ts:1:"), "noIgnore overrides .gitignore");
});

test("literal treats the pattern as fixed text; a regex interprets metacharacters", async () => {
  // 'a.b' as a regex matches both "a.b" and "axb"; as a literal it matches only "a.b".
  const asRegex = await grep({ pattern: "a\\.b" });
  const asLiteralDot = await grep({ pattern: "a.b" });
  assert.ok(asRegex.includes("src/a.ts"), "the escaped-dot regex matches a.b");
  assert.ok(
    asLiteralDot.includes("axb") || asLiteralDot.includes("src/b.ts"),
    "a.b regex matches axb too",
  );
  const literal = await grep({ pattern: "a.b", literal: true });
  assert.ok(literal.includes('"a.b"') || literal.includes("src/a.ts:2:"), "literal matches a.b");
  assert.ok(!literal.includes("axb"), "literal does NOT match axb");
});

test("ignoreCase makes the match case-insensitive", async () => {
  assert.equal(await grep({ pattern: "GREETING" }), "(no matches)", "case-sensitive by default");
  assert.ok((await grep({ pattern: "GREETING", ignoreCase: true })).includes("src/a.ts"));
});

test("a no-match search returns (no matches), never an error", async () => {
  assert.equal(await grep({ pattern: "zzz-not-present" }), "(no matches)");
});

test("an invalid regex is a typed input error rendered to one error line", async () => {
  const out = await grep({ pattern: "[unclosed" });
  assert.ok(out.startsWith("error:"), out);
  assert.match(out, /invalid regular expression/i);
});

test("maxMatches caps the number of returned matches", async () => {
  const out = await grep({ pattern: "const", maxMatches: 2 });
  const lines = out.split("\n").filter((l) => /:\d+:/.test(l));
  assert.equal(lines.length, 2, "exactly maxMatches match lines");
  assert.match(out, /capped at 2 matches/);
});

test("a glob restricts the searched files", async () => {
  const out = await grep({ pattern: "greeting", glob: "src/a.ts" });
  assert.ok(out.includes("src/a.ts:1:"));
  assert.ok(!out.includes("src/b.ts"), "the glob excludes b.ts");
});
