import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageServerAdapter } from "@host/lsp/adapter";
import { createLspManager, type LspManager, type LspManagerOptions } from "@host/lsp/manager";
import { buildLspDiagnosticsTool } from "@host/tools/lsp-diagnostics";
import { buildLspDocumentSymbolsTool } from "@host/tools/lsp-document-symbols";
import { buildLspHoverTool } from "@host/tools/lsp-hover";
import { buildLspWorkspaceSymbolsTool } from "@host/tools/lsp-workspace-symbols";
import { Effect } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { lspFixtureAdapter } from "./fixture-config";

/**
 * The lsp_hover / lsp_document_symbols / lsp_workspace_symbols tools against the REAL fixture
 * server (plan 24 M4): position encoding through the wire, the nested fixture outline, the
 * query-scoped symbol catalog, the stale-document re-sync (didChange republishes diagnostics),
 * and the D-006 degraded paths (missing binary, hanging request) as bounded SUCCESS strings.
 * Pure rendering lives in the co-located unit tests.
 */

const root = mkdtempSync(join(tmpdir(), "trevor-lsp-hover-sym-"));
writeFileSync(join(root, "code.ts"), "export const widget = 1;\n");
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

const runTool = (
  tool: { execute: (args: never) => Effect.Effect<string, unknown> },
  args: unknown,
): Promise<string> => Effect.runPromise(tool.execute(args as never) as Effect.Effect<string>);

describe("lsp_hover against the fixture server", () => {
  it("answers hover at the 1-based position (the fixture echoes the wire position)", async () => {
    const result = await runTool(buildLspHoverTool(manager()), {
      file: "code.ts",
      line: 5,
      column: 8,
    });
    // The fixture answers `hover:<line>:<character>` with the 0-based wire position.
    expect(result).toContain("code.ts:5:8");
    expect(result).toContain("hover:4:7");
  });

  it("re-syncs edited disk content before answering (stale-document handling)", async () => {
    const lsp = manager();
    const file = join(root, "restatable.ts");
    writeFileSync(file, "clean line\n");
    await runTool(buildLspHoverTool(lsp), { file: "restatable.ts", line: 1, column: 1 });

    // The file gains a problem on disk; the next hover re-syncs and the fixture republishes.
    writeFileSync(file, "clean line\noops now\n");
    await runTool(buildLspHoverTool(lsp), { file: "restatable.ts", line: 1, column: 1 });

    const summary = await runTool(buildLspDiagnosticsTool(lsp), {});
    expect(summary).toContain("restatable.ts");
    expect(summary).toContain("oops on line 2");
  });

  it("a hanging hover degrades to bounded timeout text and the server stays usable", async () => {
    const lsp = manager({ requestTimeoutMs: 400 });
    writeFileSync(join(root, "hang.ts"), "never answered\n");
    const timedOut = await runTool(buildLspHoverTool(lsp), { file: "hang.ts", line: 1, column: 1 });
    expect(timedOut).toMatch(/timed out/i);

    const next = await runTool(buildLspHoverTool(lsp), { file: "code.ts", line: 2, column: 3 });
    expect(next).toContain("hover:1:2");
  });

  it("a missing file and a missing server binary both degrade to bounded text", async () => {
    expect(
      await runTool(buildLspHoverTool(manager()), { file: "gone.ts", line: 1, column: 1 }),
    ).toMatch(/file not found/i);
    const unavailable = manager({ adapters: [missingBinaryAdapter] });
    expect(
      await runTool(buildLspHoverTool(unavailable), { file: "code.ts", line: 1, column: 1 }),
    ).toContain("not installed");
  });
});

describe("lsp_document_symbols against the fixture server", () => {
  it("renders the fixture's nested outline with kinds and 1-based ranges", async () => {
    const result = await runTool(buildLspDocumentSymbolsTool(manager()), { file: "code.ts" });
    expect(result).toContain("code.ts");
    expect(result).toMatch(/^class FixtureClass 1:1-10:2$/m);
    expect(result).toMatch(/^ {2}method fixtureMethod 2:3-4:4$/m);
  });

  it("a missing server binary degrades to bounded text", async () => {
    const result = await runTool(
      buildLspDocumentSymbolsTool(manager({ adapters: [missingBinaryAdapter] })),
      {
        file: "code.ts",
      },
    );
    expect(result).toContain("not installed");
  });
});

describe("lsp_workspace_symbols against the fixture server", () => {
  it("answers a query-scoped catalog slice with kinds and locations", async () => {
    const result = await runTool(buildLspWorkspaceSymbolsTool(manager()), { query: "fixture" });
    expect(result).toContain('matching "fixture"');
    expect(result).toContain("class FixtureClass");
    expect(result).toContain("function fixtureFunction");
    expect(result).toContain("constant FIXTURE_CONST");
    expect(result).toContain("/fixture/workspace/symbols.ts:5:1");
  });

  it("caps the matches at the requested limit", async () => {
    const result = await runTool(buildLspWorkspaceSymbolsTool(manager()), {
      query: "fixture",
      limit: 1,
    });
    expect(result).toContain("class FixtureClass");
    expect(result).not.toContain("fixtureFunction");
  });

  it("a missing server binary degrades to bounded text", async () => {
    const result = await runTool(
      buildLspWorkspaceSymbolsTool(manager({ adapters: [missingBinaryAdapter] })),
      {
        query: "fixture",
      },
    );
    expect(result).toContain("not installed");
  });
});
