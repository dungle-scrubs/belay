import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageServerAdapter } from "@host/lsp/adapter";
import { MAX_LSP_DIAGNOSTICS } from "@host/lsp/caps";
import { createLspManager, type LspManager, type LspManagerOptions } from "@host/lsp/manager";
import { buildLspDiagnosticsTool, type LspDiagnosticsArgs } from "@host/tools/lsp-diagnostics";
import { buildLspStatusTool } from "@host/tools/lsp-status";
import { Effect } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { lspFixtureAdapter } from "./fixture-config";

/**
 * The lsp_status + lsp_diagnostics tools against the REAL fixture server (plan 24 M3): the
 * spawned pull path - didOpen document sync, publishDiagnostics collection, severity filter,
 * caps - plus the D-006 degraded paths (missing binary, silent server) as bounded SUCCESS
 * strings the turn continues past. Pure rendering lives in the co-located unit tests.
 */

const root = mkdtempSync(join(tmpdir(), "belay-lsp-tools-"));
writeFileSync(join(root, "clean.ts"), "const fine = 1;\n");
writeFileSync(join(root, "problems.ts"), "const a = 1; // oops here\nfine\nanother oops\n");
writeFileSync(join(root, "silent.ts"), "oops but the server stays quiet\n");
writeFileSync(
  join(root, "many.ts"),
  Array.from({ length: MAX_LSP_DIAGNOSTICS + 10 }, () => "oops").join("\n"),
);
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

/** An adapter whose server binary can never resolve (the unavailable-server path). */
const missingBinaryAdapter: LanguageServerAdapter = {
  id: "missing",
  displayName: "missing-language-server",
  detects: () => true,
  resolveCommand: () => undefined,
};

const status = (lsp: LspManager): Promise<string> =>
  Effect.runPromise(buildLspStatusTool(lsp).execute({}));

const diagnostics = (lsp: LspManager, args: LspDiagnosticsArgs): Promise<string> =>
  Effect.runPromise(buildLspDiagnosticsTool(lsp).execute(args));

describe("lsp_status against the fixture server", () => {
  it("reports configured before first use, ready after a pull", async () => {
    const lsp = manager();
    const before = await status(lsp);
    expect(before).toContain(root);
    expect(before).toContain("configured");
    expect(before).toContain("belay-lsp-fixture");

    await diagnostics(lsp, { file: "problems.ts" });
    const after = await status(lsp);
    expect(after).toContain("ready");
    expect(after).toContain("restarts 0");
  });

  it("reports a missing server binary as unavailable, not a failure", async () => {
    const lsp = manager({ adapters: [missingBinaryAdapter] });
    const report = await status(lsp);
    expect(report).toContain("unavailable");
    expect(report).toContain("missing-language-server");
  });
});

describe("lsp_diagnostics against the fixture server", () => {
  it("pulls one file's diagnostics with 1-based ranges and the server's source", async () => {
    const result = await diagnostics(manager(), { file: "problems.ts" });
    expect(result).toContain("2 diagnostic(s) in problems.ts");
    // The fixture flags "oops" at 0-based line 0 col 16 and line 2 col 8 -> 1-based 1:17, 3:9.
    expect(result).toContain("1:17-1:21 warning [fixture] oops on line 1");
    expect(result).toContain("3:9-3:13 warning [fixture] oops on line 3");
  });

  it("a clean file answers with no diagnostics", async () => {
    const result = await diagnostics(manager(), { file: "clean.ts" });
    expect(result).toContain("no diagnostics in clean.ts");
  });

  it("filters by severity", async () => {
    const result = await diagnostics(manager(), { file: "problems.ts", severity: "error" });
    expect(result).toMatch(/no error diagnostics in problems\.ts/);
    expect(result).not.toContain("oops on line 1");
  });

  it("caps a noisy file at MAX_LSP_DIAGNOSTICS and says so", async () => {
    const result = await diagnostics(manager(), { file: "many.ts" });
    expect(result).toContain(`${MAX_LSP_DIAGNOSTICS + 10} diagnostic(s)`);
    expect(result).toContain(`first ${MAX_LSP_DIAGNOSTICS}`);
  });

  it("a server that never publishes degrades to bounded text within the wait window", async () => {
    const lsp = manager({ requestTimeoutMs: 400 });
    const result = await diagnostics(lsp, { file: "silent.ts" });
    expect(result).toMatch(/no diagnostics published/i);
  });

  it("summarizes the workspace per file after pulls, and filters by severity", async () => {
    const lsp = manager();
    await diagnostics(lsp, { file: "problems.ts" });
    await diagnostics(lsp, { file: "clean.ts" });

    const summary = await diagnostics(lsp, {});
    expect(summary).toContain("problems.ts");
    expect(summary).toContain("2 warnings");
    expect(summary).not.toContain("clean.ts");

    const errorsOnly = await diagnostics(lsp, { severity: "error" });
    expect(errorsOnly).toMatch(/no .*diagnostics/i);
  });

  it("summary names how many files the per-file budget left out", async () => {
    const lsp = manager();
    await diagnostics(lsp, { file: "many.ts" });
    await diagnostics(lsp, { file: "problems.ts" });

    // many.ts alone exhausts the MAX_LSP_DIAGNOSTICS budget, so problems.ts never renders;
    // the summary must say a file was omitted rather than silently dropping it.
    const summary = await diagnostics(lsp, {});
    expect(summary).toContain("(1 more file(s) not shown)");
    expect(summary).not.toContain("problems.ts (");
  });

  it("summary before any pull explains itself without spawning the server", async () => {
    const lsp = manager();
    const summary = await diagnostics(lsp, {});
    expect(summary).toMatch(/no diagnostics pulled yet/i);
    expect((await status(lsp)).includes("configured")).toBe(true);
  });

  it("a missing file is bounded text, not a thrown failure", async () => {
    const result = await diagnostics(manager(), { file: "nope/missing.ts" });
    expect(result).toMatch(/file not found/i);
  });

  it("a missing server binary degrades each mode to bounded text and the turn continues", async () => {
    const lsp = manager({ adapters: [missingBinaryAdapter] });
    const fileResult = await diagnostics(lsp, { file: "problems.ts" });
    expect(fileResult).toContain("unavailable");
    expect(fileResult).toContain("not installed");

    const summary = await diagnostics(lsp, {});
    expect(summary).toMatch(/no diagnostics pulled yet/i);
  });
});
