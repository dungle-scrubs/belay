import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hooksAreaFindings } from "@host/doctor/hooks-status";
import { discoverLegacyHookFiles } from "@host/hooks/discovery";
import { afterEach, describe, expect, test } from "vitest";
import { type HooksRuntimeHarness, hooksRuntimeHarness } from "./runtime-fixture";

/**
 * Plan 25 M10: legacy V1 `HOOK.md` migration diagnostics. V1 kept hooks as
 * `.trevor/hooks/<id>/HOOK.md` files (project) and `~/.trevor/hooks/<id>/HOOK.md` (user), with
 * an optional `command:` in frontmatter marking an EXECUTABLE handler. V2 REPORTS them - the
 * scan never parses one into a definition and the runtime never executes one - and the report
 * feeds the discovery diagnostics + the /doctor hooks.legacy migration finding.
 *
 * Responsible for: the legacy scan over real fixture HOOK.md files and its threading through
 * statusSnapshot into the doctor fold.
 * Not for: the fold's finding shape - src/doctor/hooks-status.test.ts owns that.
 */

const EXECUTABLE_HOOK_MD = `---
name: fmt
description: format before tools run
event: PreToolUse
command: ./fmt.sh
---
Run the formatter.
`;

const PROMPT_ONLY_HOOK_MD = `---
name: note
description: a prompt-only reminder
---
Remember the lockfile.
`;

let scratch: string | undefined;
let harness: HooksRuntimeHarness | undefined;

function tempRoot(): string {
  scratch = mkdtempSync(join(tmpdir(), "trevor-legacy-hooks-"));
  return scratch;
}

afterEach(() => {
  if (scratch) {
    rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
  harness?.cleanup();
  harness = undefined;
});

function writeHookMd(dir: string, id: string, content: string): string {
  const hookDir = join(dir, id);
  mkdirSync(hookDir, { recursive: true });
  const path = join(hookDir, "HOOK.md");
  writeFileSync(path, content);
  return path;
}

describe("discoverLegacyHookFiles - the bounded V1 scan", () => {
  test("finds project HOOK.md files under .trevor/hooks and flags executable frontmatter", () => {
    const root = tempRoot();
    const workspaceRoot = join(root, "workspace");
    const hooksDir = join(workspaceRoot, ".trevor", "hooks");
    const executable = writeHookMd(hooksDir, "fmt", EXECUTABLE_HOOK_MD);
    const promptOnly = writeHookMd(hooksDir, "note", PROMPT_ONLY_HOOK_MD);

    const found = discoverLegacyHookFiles({
      workspaceRoot,
      legacyUserHooksDir: join(root, "no-such-user-dir"),
    });
    expect(found).toEqual([
      { path: executable, source: "project", executable: true },
      { path: promptOnly, source: "project", executable: false },
    ]);
  });

  test("finds user HOOK.md files under the legacy home hooks dir, attributed as user", () => {
    const root = tempRoot();
    const legacyUserHooksDir = join(root, "legacy-home", "hooks");
    const path = writeHookMd(legacyUserHooksDir, "review", EXECUTABLE_HOOK_MD);

    const found = discoverLegacyHookFiles({
      workspaceRoot: join(root, "workspace"),
      legacyUserHooksDir,
    });
    expect(found).toEqual([{ path, source: "user", executable: true }]);
  });

  test("missing directories yield an empty report, never a throw", () => {
    const root = tempRoot();
    expect(
      discoverLegacyHookFiles({
        workspaceRoot: join(root, "nowhere"),
        legacyUserHooksDir: join(root, "also-nowhere"),
      }),
    ).toEqual([]);
  });

  test("ignores entries without a HOOK.md and files at the top level", () => {
    const root = tempRoot();
    const workspaceRoot = join(root, "workspace");
    const hooksDir = join(workspaceRoot, ".trevor", "hooks");
    mkdirSync(join(hooksDir, "empty-dir"), { recursive: true });
    writeFileSync(join(hooksDir, "stray.md"), "not a hook");

    expect(
      discoverLegacyHookFiles({
        workspaceRoot,
        legacyUserHooksDir: join(root, "no-user-dir"),
      }),
    ).toEqual([]);
  });
});

describe("legacy HOOK.md files are reported through the runtime, never executed", () => {
  test("statusSnapshot carries the scan; discovery yields NO definition for a HOOK.md", () => {
    harness = hooksRuntimeHarness([]);
    const hooksDir = join(harness.workspaceRoot, ".trevor", "hooks");
    const path = writeHookMd(hooksDir, "fmt", EXECUTABLE_HOOK_MD);

    const snapshot = harness.runtime.statusSnapshot();
    expect(snapshot.legacy).toEqual([{ path, source: "project", executable: true }]);
    // The legacy file never becomes a runnable definition (reported, never executed).
    expect(snapshot.hooks).toEqual([]);
    expect(harness.runtime.discoveryReport().hooks).toEqual([]);
  });

  test("the doctor fold surfaces the migration finding from the snapshot", () => {
    harness = hooksRuntimeHarness([]);
    writeHookMd(join(harness.workspaceRoot, ".trevor", "hooks"), "fmt", EXECUTABLE_HOOK_MD);

    const findings = hooksAreaFindings(harness.runtime.statusSnapshot(), []);
    expect(findings.map((finding) => finding.id)).toEqual(["hooks.legacy"]);
    expect(findings[0]?.message).toMatch(/HOOK\.md/);
  });
});
