import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

// This file lives at packages/session/src/<this>; the repo root is three levels up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// The config-home dirname (`.trevorV2`) is owned by exactly one module. Any OTHER runtime source that
// spells it is a re-spelled home-relative root, which must instead resolve through resolveRootPolicy /
// the storage inventory (D-006/D-009). Display-only fixtures, stories, and tests may show example paths.
const HOME_DIRNAME = ".trevorV2";
const OWNER = join("packages", "session", "src", "node-paths.ts");

function collectSourceFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
      continue;
    }

    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, out);
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name) &&
      !/\.stories\.tsx?$/.test(entry.name) &&
      !entry.name.includes("fixtures")
    ) {
      out.push(full);
    }
  }
}

test("no runtime source re-spells the ~/.trevorV2 home root outside the root-policy owner", () => {
  const files: string[] = [];
  for (const root of ["apps", "packages"]) {
    collectSourceFiles(join(REPO_ROOT, root), files);
  }

  const offenders = files
    .map((file) => relative(REPO_ROOT, file))
    .filter((rel) => rel !== OWNER)
    .filter((rel) => readFileSync(join(REPO_ROOT, rel), "utf8").includes(HOME_DIRNAME));

  assert.deepEqual(
    offenders,
    [],
    `re-spelled "${HOME_DIRNAME}" - resolve through the root policy instead: ${offenders.join(", ")}`,
  );
});
