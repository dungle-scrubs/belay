// Verifies write/edit/glob/grep and workspace confinement against a temp
// workspace. Sets TREVOR_WORKSPACE before importing the tools (workspace root is
// read at module load). Run: pnpm exec tsx scripts/verify-tools.ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

const ws = await mkdtemp(join(tmpdir(), "trevor-ws-"));
process.env.TREVOR_WORKSPACE = ws;
// write resolves against cwd (it is deliberately unconfined - the confinement guard is
// edit/glob/grep's, asserted below), so run from the workspace to keep its output here.
process.chdir(ws);
const { executeTool } = await import("../src/tools");

const call = (name: string, args: Record<string, unknown>) =>
  Effect.runPromise(executeTool(name, JSON.stringify(args)));

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (!ok) {
    console.error(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
    failures += 1;
  }
};

const write = await call("write", {
  path: "src/app.ts",
  content: "export const x = 1;\nexport const y = 2;\n",
});
check("write", write.startsWith("wrote"), write);
check("write-content", (await readFile(join(ws, "src/app.ts"), "utf8")).includes("const x = 1;"));

const edit = await call("edit", { path: "src/app.ts", old: "const x = 1;", new: "const x = 42;" });
check("edit", edit.startsWith("edited"), edit);
check("edit-applied", (await readFile(join(ws, "src/app.ts"), "utf8")).includes("const x = 42;"));

check(
  "edit-notfound",
  (await call("edit", { path: "src/app.ts", old: "nope", new: "x" })).includes("not found"),
);
await call("write", { path: "dup.ts", content: "a\na\n" });
check(
  "edit-ambiguous",
  (await call("edit", { path: "dup.ts", old: "a", new: "b" })).includes("appears 2 times"),
);

const glob = await call("glob", { pattern: "**/*.ts" });
check("glob", glob.includes("src/app.ts") && glob.includes("dup.ts"), glob);

const grep = await call("grep", { pattern: "const x = 42", glob: "**/*.ts" });
check("grep", grep.includes("src/app.ts:1:"), grep);

// Confinement is the edit/glob/grep guard (write is intentionally unconfined), so assert
// it on edit for both a relative and an absolute escape, before they ever read a file.
check(
  "confine-relative",
  (await call("edit", { path: "../escape.txt", old: "a", new: "b" })).includes("escapes workspace"),
);
check(
  "confine-absolute",
  (await call("edit", { path: "/etc/hosts", old: "a", new: "b" })).includes("escapes workspace"),
);
check(
  "confine-edit",
  (await call("edit", { path: "../../etc/hosts", old: "a", new: "b" })).includes(
    "escapes workspace",
  ),
);

await rm(ws, { recursive: true, force: true });
if (failures === 0) {
  console.log("TOOLS PASS (write, edit, glob, grep, confinement)");
} else {
  console.error(`TOOLS FAIL (${failures})`);
  process.exit(1);
}
