import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageServerAdapter } from "@host/lsp/adapter";
import { createLspManager, type LspManager, type LspManagerOptions } from "@host/lsp/manager";
import { buildLspCodeActionsTool, type LspCodeActionsArgs } from "@host/tools/lsp-code-actions";
import { Effect } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { lspFixtureAdapter } from "./fixture-config";

/**
 * The lsp_code_actions tool against the REAL fixture server (plan 24 M5): proposals with a
 * serialized edit preview, the D-005 mutation proof (a byte-for-byte filesystem snapshot
 * before/after - the fixture's quickfix carries a workspace edit that must NEVER be applied),
 * the unsupported-mutating status for command-only actions, and the D-006 degraded paths as
 * bounded SUCCESS strings. Pure decode/render lives in the co-located unit tests.
 */

const root = mkdtempSync(join(tmpdir(), "trevor-lsp-actions-"));
writeFileSync(join(root, "fixable.ts"), "oops line one\nclean line two\n");
writeFileSync(join(root, "bystander.ts"), "untouched\n");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const managers: LspManager[] = [];

function manager(options: Partial<LspManagerOptions> = {}): LspManager {
  const created = createLspManager({
    adapters: [lspFixtureAdapter()],
    defaultWorkspaceRoot: root,
    requestTimeoutMs: 5_000,
    initTimeoutMs: 5_000,
    ...options,
  });
  managers.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((created) => created.close()));
});

const missingBinaryAdapter: LanguageServerAdapter = {
  id: "missing",
  displayName: "missing-language-server",
  detects: () => true,
  resolveCommand: () => undefined,
};

const run = (lsp: LspManager, args: LspCodeActionsArgs): Promise<string> =>
  Effect.runPromise(buildLspCodeActionsTool(lsp).execute(args));

/** Every file in the workspace with its exact bytes - the mutation-proof snapshot. */
function snapshotWorkspace(): ReadonlyMap<string, string> {
  return new Map(
    readdirSync(root)
      .sort()
      .map((name) => [name, readFileSync(join(root, name), "utf8")]),
  );
}

describe("lsp_code_actions against the fixture server", () => {
  it("returns proposals with an edit preview and applies NOTHING (fs snapshot proof)", async () => {
    const before = snapshotWorkspace();
    const result = await run(manager(), { file: "fixable.ts", startLine: 1, endLine: 1 });

    // Proposal metadata: the fixture's context echo (line 1 carries a published diagnostic),
    // quickfix (with edit), source action, and command action.
    expect(result).toMatch(/4 code action proposal\(s\)/);
    expect(result).toMatch(/proposals only/i);
    expect(result).toContain("Fix the oops [quickfix] (preferred)");
    expect(result).toContain('fixable.ts 1:1-1:5 -> "okay"');
    expect(result).toContain("Organize imports [source.organizeImports]");

    // The mutation proof: byte-for-byte identical workspace, no files created or removed.
    const after = snapshotWorkspace();
    expect([...after.keys()]).toEqual([...before.keys()]);
    for (const [name, bytes] of before) {
      expect(after.get(name)).toBe(bytes);
    }
  });

  it("forwards the file's overlapping published diagnostics as the request context", async () => {
    // Real servers (tsserver) derive quickfixes from context.diagnostics, so the tool must
    // forward the stored publish for the requested range - re-encoded to the 0-based wire
    // shape with a numeric severity (the fixture echoes the first one back verbatim).
    const overlapping = await run(manager(), { file: "fixable.ts", startLine: 1, endLine: 1 });
    expect(overlapping).toContain("context-echo: 1 diagnostic(s): sev2 0:0 oops on line 1");

    // And the bare line range widens to cover the WHOLE line ("oops line one" = 13 chars):
    // tsserver only returns fixes whose error span intersects the request range, so a
    // zero-width default range at column 1 would suppress every real quickfix.
    expect(overlapping).toContain("@0:0-0:13");

    // A clean range forwards nothing: no echo action, just the fixture's three canned actions.
    const clean = await run(manager(), { file: "fixable.ts", startLine: 2, endLine: 2 });
    expect(clean).not.toContain("context-echo");
    expect(clean).toMatch(/3 code action proposal\(s\)/);
  });

  it("surfaces command-only actions with a clear unsupported-mutating status", async () => {
    const result = await run(manager(), { file: "fixable.ts", startLine: 1, endLine: 2 });
    expect(result).toContain("Move to a new file [refactor.move]");
    expect(result).toMatch(/command-only.*not executed/i);
  });

  it("a missing file and a missing server binary degrade to bounded text", async () => {
    expect(await run(manager(), { file: "gone.ts", startLine: 1, endLine: 1 })).toMatch(
      /file not found/i,
    );
    expect(
      await run(manager({ adapters: [missingBinaryAdapter] }), {
        file: "fixable.ts",
        startLine: 1,
        endLine: 1,
      }),
    ).toContain("not installed");
  });
});
