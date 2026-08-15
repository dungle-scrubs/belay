import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, test } from "vitest";

/**
 * write/edit/glob/grep and workspace confinement against a throwaway workspace. The tools'
 * workspace root is read at module load, so TREVOR_WORKSPACE is set BEFORE importing them
 * (dynamic import below). Confinement is edit/glob/grep's guard - write is deliberately
 * unconfined (host-cwd), so it runs from the workspace to keep its output here. Ported from
 * scripts/verify-tools.ts.
 */

const ws = mkdtempSync(join(tmpdir(), "belay-ws-"));
const prevCwd = process.cwd();
const prevWorkspace = process.env.TREVOR_WORKSPACE;
process.env.TREVOR_WORKSPACE = ws;
process.chdir(ws);

const { executeTool } = await import("../src/tools");
const call = (name: string, args: Record<string, unknown>) =>
  Effect.runPromise(executeTool(name, JSON.stringify(args)));

afterAll(() => {
  process.chdir(prevCwd);
  if (prevWorkspace === undefined) delete process.env.TREVOR_WORKSPACE;
  else process.env.TREVOR_WORKSPACE = prevWorkspace;
  rmSync(ws, { recursive: true, force: true });
});

test("write then edit round-trips file content", async () => {
  const wrote = await call("write", {
    path: "src/app.ts",
    content: "export const x = 1;\nexport const y = 2;\n",
  });
  assert.ok(wrote.startsWith("wrote"), wrote);
  assert.ok(readFileSync(join(ws, "src/app.ts"), "utf8").includes("const x = 1;"));

  const edited = await call("edit", {
    path: "src/app.ts",
    old: "const x = 1;",
    new: "const x = 42;",
  });
  assert.ok(edited.startsWith("edited"), edited);
  assert.ok(readFileSync(join(ws, "src/app.ts"), "utf8").includes("const x = 42;"));
});

test("edit reports not-found and ambiguous matches", async () => {
  assert.ok(
    (await call("edit", { path: "src/app.ts", old: "nope", new: "x" })).includes("not found"),
  );
  await call("write", { path: "dup.ts", content: "a\na\n" });
  assert.ok(
    (await call("edit", { path: "dup.ts", old: "a", new: "b" })).includes("appears 2 times"),
  );
});

test("glob and grep find files within the workspace", async () => {
  const glob = await call("glob", { pattern: "**/*.ts" });
  assert.ok(glob.includes("src/app.ts") && glob.includes("dup.ts"), glob);
  const grep = await call("grep", { pattern: "const x = 42", glob: "**/*.ts" });
  assert.ok(grep.includes("src/app.ts:1:"), grep);
});

test("edit refuses to escape the workspace (relative and absolute)", async () => {
  for (const path of ["../escape.txt", "/etc/hosts", "../../etc/hosts"]) {
    const result = await call("edit", { path, old: "a", new: "b" });
    assert.ok(result.includes("escapes workspace"), `${path}: ${result}`);
  }
});
