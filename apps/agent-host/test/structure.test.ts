import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

/**
 * Responsible for: enforcing the host's directory structure conventions (plan 22.1) - no loose
 * source files in `src/` root beyond the allowlist, and the relocation-debt ledger that must only
 * ever shrink while the by-domain moves land.
 * Not for: header-format enforcement (header-check.test.ts) or the architecture map check
 * (architecture-map.test.ts).
 */

const SRC_ROOT = join(import.meta.dirname, "..", "src");

/** The only files allowed to live directly under `src/` root: the composition root. */
const ROOT_ALLOWLIST: readonly string[] = ["main.ts"];

/**
 * The relocation-debt ledger (plan 22.1 M1, D-004) is EMPTY: every loose file from the M1
 * inventory (57 entries) landed in its by-domain home in M3/M4. The guard is now the plain
 * "main.ts only" rule (M6) - any new loose file under `src/` root fails it. See the M1 commit
 * for the full inventory this tree was migrated against.
 */
const RELOCATION_DEBT: ReadonlyMap<string, string> = new Map();

/**
 * The pure guard: which loose `src/` root files violate the structure rule? A violation is a
 * loose file that is neither allowlisted nor tracked relocation debt, OR a debt entry that no
 * longer exists loose (the move landed - the ledger must shrink with it).
 */
export function structureViolations(
  looseFiles: readonly string[],
  allowlist: readonly string[] = ROOT_ALLOWLIST,
  debt: ReadonlyMap<string, string> = RELOCATION_DEBT,
): string[] {
  const loose = new Set(looseFiles);
  const violations: string[] = [];

  for (const file of [...looseFiles].sort()) {
    if (!allowlist.includes(file) && !debt.has(file)) {
      violations.push(`NEW loose file in src/ root: ${file} - give it a by-domain home`);
    }
  }

  for (const [file, target] of debt) {
    if (!loose.has(file)) {
      violations.push(`stale relocation debt: ${file} moved (to ${target}) - remove its entry`);
    }
  }

  return violations;
}

function looseSrcRootFiles(): string[] {
  return readdirSync(SRC_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .sort();
}

test("src/ root has no loose files beyond the allowlist and the shrinking relocation debt", () => {
  const violations = structureViolations(looseSrcRootFiles());
  assert.deepEqual(violations, [], `structure guard:\n${violations.join("\n")}`);
});

test("the guard fails a NEW loose file that is neither allowlisted nor tracked debt", () => {
  const violations = structureViolations(["main.ts", "rogue-helper.ts"], ["main.ts"], new Map());
  assert.equal(violations.length, 1);
  assert.match(violations[0] as string, /rogue-helper\.ts/);
});

test("the guard fails a debt entry whose move already landed (the ledger must shrink)", () => {
  const violations = structureViolations(["main.ts"], ["main.ts"], new Map([["gone.ts", "boot/"]]));
  assert.equal(violations.length, 1);
  assert.match(violations[0] as string, /stale relocation debt: gone\.ts/);
});
