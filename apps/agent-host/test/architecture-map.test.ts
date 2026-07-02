import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

/**
 * Responsible for: keeping `apps/agent-host/ARCHITECTURE.md` honest (plan 22.1 M5, D-010) - the map
 * must describe every subsystem dir that actually exists under `src/`, so the doc cannot silently
 * fall behind the tree.
 * Not for: header-format enforcement (header-check.test.ts) or root flatness (structure.test.ts).
 */

const HOST_ROOT = join(import.meta.dirname, "..");

function subsystemDirs(): string[] {
  return readdirSync(join(HOST_ROOT, "src"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function allDirsUnderSrc(): Set<string> {
  const dirs = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        dirs.add(entry.name);
        walk(join(dir, entry.name));
      }
    }
  };
  walk(join(HOST_ROOT, "src"));
  dirs.add("src");
  return dirs;
}

test("ARCHITECTURE.md exists and describes every subsystem dir under src/", () => {
  const mapPath = join(HOST_ROOT, "ARCHITECTURE.md");
  assert.ok(existsSync(mapPath), "apps/agent-host/ARCHITECTURE.md is missing");
  const map = readFileSync(mapPath, "utf8");

  const missing = subsystemDirs().filter((dir) => !map.includes(`\`${dir}/\``));
  assert.deepEqual(
    missing,
    [],
    `ARCHITECTURE.md lacks a \`dir/\` mention for: ${missing.join(", ")}`,
  );

  // The reverse direction: a dir the map still names must exist somewhere under src/, so a
  // rename/deletion cannot leave its paragraph behind undetected.
  const real = allDirsUnderSrc();
  const stale = [...map.matchAll(/`([a-z][a-z0-9-]*)\/`/g)]
    .map((match) => match[1] as string)
    .filter((dir) => !real.has(dir));
  assert.deepEqual(
    stale,
    [],
    `ARCHITECTURE.md names dirs that no longer exist: ${stale.join(", ")}`,
  );
});
