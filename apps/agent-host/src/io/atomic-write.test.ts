import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { writeFileAtomic, writeFileAtomicVia } from "./atomic-write";

test("writeFileAtomic lands the content, creates parents, and leaves no temp file", () => {
  const root = mkdtempSync(join(tmpdir(), "atomic-write-"));
  const target = join(root, "nested", "store.json");

  const bytes = writeFileAtomic(target, '{"ok":true}\n');

  assert.equal(readFileSync(target, "utf8"), '{"ok":true}\n');
  assert.equal(bytes, Buffer.byteLength('{"ok":true}\n'));
  assert.deepEqual(
    readdirSync(join(root, "nested")).filter((name) => name.endsWith(".tmp")),
    [],
    "the staging temp file is renamed away",
  );
});

test("writeFileAtomicVia stages to a temp path, then renames over the target (in that order)", async () => {
  const ops: string[] = [];
  await writeFileAtomicVia(
    {
      writeFile: async (path) => {
        ops.push(`write:${path}`);
      },
      rename: async (from, to) => {
        ops.push(`rename:${from}->${to}`);
      },
    },
    "/store/manifest.json",
    "{}\n",
  );

  assert.equal(ops.length, 2);
  assert.match(ops[0] ?? "", /^write:\/store\/manifest\.json\..+\.tmp$/);
  assert.match(ops[1] ?? "", /^rename:\/store\/manifest\.json\..+\.tmp->\/store\/manifest\.json$/);
});
