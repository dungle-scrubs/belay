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
 * The authoritative relocation inventory (plan 22.1 M1, D-004): every loose `src/` root file and
 * the by-domain dir it moves to in M3/M4. Sorted by filename. THIS LIST MUST ONLY SHRINK - the
 * guard fails when a file is moved but stays listed, and when a NEW loose file appears that is in
 * neither the allowlist nor this ledger. When the list is empty the guard is the plain
 * "main.ts only" rule (M6).
 */
const RELOCATION_DEBT: ReadonlyMap<string, string> = new Map([
  ["agents.test.ts", "subagents/"],
  ["agents.ts", "subagents/ (as discovery.ts)"],
  ["args.ts", "boot/"],
  ["artifacts.ts", "agent/ (as image-resolution.ts)"],
  ["clip.test.ts", "tools/"],
  ["clip.ts", "tools/"],
  ["coerce.ts", "boot/"],
  ["commands.test.ts", "commands/"],
  ["commands.ts", "commands/"],
  ["config-file.test.ts", "boot/ (as config.test.ts)"],
  ["config-file.ts", "boot/ (as config.ts)"],
  ["control-model.test.ts", "session/"],
  ["control-model.ts", "session/"],
  ["cwd-lock.test.ts", "session/"],
  ["cwd-lock.ts", "session/"],
  ["debug-commands.test.ts", "commands/"],
  ["debug-commands.ts", "commands/"],
  ["delta-buffer.ts", "transport/"],
  ["env.ts", "boot/"],
  ["fork-flow.test.ts", "session/"],
  ["fork-flow.ts", "session/"],
  ["git-status.test.ts", "worktrees/"],
  ["git-status.ts", "worktrees/"],
  ["handoff-flow.test.ts", "handoff/"],
  ["handoff-flow.ts", "handoff/"],
  ["handoff-generate.test.ts", "handoff/"],
  ["handoff-generate.ts", "handoff/"],
  ["handoff.test.ts", "handoff/"],
  ["handoff.ts", "handoff/"],
  ["interpolation.test.ts", "commands/"],
  ["interpolation.ts", "commands/"],
  ["lease.test.ts", "session/"],
  ["lease.ts", "session/"],
  ["log.ts", "transport/"],
  ["manifest-discovery.ts", "boot/"],
  ["messages.ts", "transport/"],
  ["paths.ts", "boot/"],
  ["process-liveness.ts", "processes/"],
  ["process-registry.test.ts", "processes/"],
  ["process-registry.ts", "processes/"],
  ["processes.test.ts", "processes/"],
  ["processes.ts", "processes/"],
  ["services.ts", "transport/"],
  ["session-lifecycle.test.ts", "session/"],
  ["session-lifecycle.ts", "session/"],
  ["skill-registry.test.ts", "skills/"],
  ["skills.test.ts", "skills/"],
  ["skills.ts", "skills/"],
  ["startup.test.ts", "boot/"],
  ["startup.ts", "boot/"],
  ["tasks.test.ts", "tools/tasks/"],
  ["tasks.ts", "tools/tasks/"],
  ["turn-preflight.ts", "agent/"],
  ["turn-termination.test.ts", "agent/"],
  ["turn.ts", "agent/"],
  ["workspace-switch.test.ts", "session/"],
  ["workspace-switch.ts", "session/"],
]);

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
