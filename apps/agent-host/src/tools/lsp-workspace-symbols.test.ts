import assert from "node:assert/strict";
import { MAX_LSP_WORKSPACE_SYMBOLS } from "@host/lsp/caps";
import type { LspClient } from "@host/lsp/client";
import { degraded, type LspOutcome, type LspServerStatus, ok } from "@host/lsp/contract";
import type { LspManager } from "@host/lsp/manager";
import { ToolInputError } from "@host/tools/errors";
import { READ_ONLY_TOOL_NAMES, TOOL_DESCRIPTORS } from "@trevor/session";
import { Effect } from "effect";
import { test } from "vitest";
import {
  buildLspWorkspaceSymbolsTool,
  type LspWorkspaceSymbolsArgs,
} from "./lsp-workspace-symbols";

/**
 * The lsp_workspace_symbols tool (plan 24 M4 tasks 5-6), unit-tested against a fake manager -
 * no child processes. Pins the D-003-style no-dump contract (a REQUIRED non-empty query is the
 * only discovery path), the limit clamp, location formatting, and the D-006 degraded outcomes
 * as bounded SUCCESS text. Also pins that the tool's description never undermines the rg/
 * ast_grep guidance for literal text search (M6 owns the full guidance). Live fixture-server
 * behavior lives in test/lsp/tools-hover-symbols.test.ts.
 */

const ROOT = "/w/symbols";

/** A capable fake client: the tool acquires only to run the capability gate (no doc sync). */
function fakeClient(): LspClient {
  return {
    initialize: () => Promise.resolve({ capabilities: {} }),
    request: () => Promise.resolve(null),
    notify: () => {},
    openDocument: () => {},
    closeDocument: () => {},
    diagnosticsFor: () => undefined,
    waitForDiagnostics: () => Promise.resolve(undefined),
    diagnosticsSnapshot: () => [],
    capabilities: () => ({ workspaceSymbolProvider: true }),
    shutdown: () => Promise.resolve(),
    state: () => ({ alive: true, initialized: true, stderrTail: "" }),
  };
}

function fakeManager(
  request: (method: string, params?: unknown) => Promise<LspOutcome<unknown>>,
): LspManager {
  const snapshot: LspServerStatus = { workspaceRoot: ROOT, status: "ready", restarts: 0 };
  return {
    acquire: () => Promise.resolve({ kind: "ready", client: fakeClient(), server: "fake-ls" }),
    request,
    status: () => snapshot,
    statusSnapshot: () => [snapshot],
    close: () => Promise.resolve(),
  };
}

const wireSymbol = (name: string, index: number) => ({
  name,
  kind: 12,
  location: {
    uri: `file://${ROOT}/src/mod${index}.ts`,
    range: { start: { line: 4, character: 0 }, end: { line: 4, character: 10 } },
  },
});

const run = (manager: LspManager, args: LspWorkspaceSymbolsArgs): Promise<string> =>
  Effect.runPromise(buildLspWorkspaceSymbolsTool(manager).execute(args));

const flip = (manager: LspManager, args: LspWorkspaceSymbolsArgs): Promise<unknown> =>
  Effect.runPromise(Effect.flip(buildLspWorkspaceSymbolsTool(manager).execute(args)));

test("lsp_workspace_symbols is read-only (D-007) and registered in the shared table", () => {
  const tool = buildLspWorkspaceSymbolsTool(fakeManager(() => Promise.resolve(ok([]))));
  assert.equal(tool.name, "lsp_workspace_symbols");
  assert.equal(tool.readOnly, true);
  assert.ok(READ_ONLY_TOOL_NAMES.has("lsp_workspace_symbols"));
  assert.equal(
    TOOL_DESCRIPTORS.find((entry) => entry.name === "lsp_workspace_symbols")?.readOnly,
    true,
  );
});

test("the description never tells the model to replace grep/rg/ast_grep with symbols", () => {
  const tool = buildLspWorkspaceSymbolsTool(fakeManager(() => Promise.resolve(ok([]))));
  assert.doesNotMatch(
    tool.description,
    /(instead of|rather than|replaces?|over) (grep|rg|ast_grep)/i,
    "literal text search guidance stays with grep/ast_grep (M6 owns full guidance)",
  );
});

test("an empty or whitespace query is a typed input error - no whole-project dump (D-003)", async () => {
  const manager = fakeManager(() => Promise.reject(new Error("must not reach the server")));
  for (const query of ["", "   "]) {
    const error = await flip(manager, { query });
    assert.ok(error instanceof ToolInputError, "an empty query is a ToolInputError");
    assert.match(String(error), /non-empty query/i);
  }
});

test("renders capped name/kind/location matches with 1-based positions", async () => {
  const manager = fakeManager((method, params) => {
    assert.equal(method, "workspace/symbol");
    assert.deepEqual(params, { query: "fix" });
    return Promise.resolve(
      ok([
        { ...wireSymbol("fixEverything", 1), containerName: "Fixer" },
        { ...wireSymbol("FixHelper", 2), kind: 5 },
      ]),
    );
  });
  const result = await run(manager, { query: "fix" });
  assert.match(result, /2 workspace symbol\(s\) matching "fix"/);
  assert.match(result, /- function fixEverything src\/mod1\.ts:5:1 \(in Fixer\)/);
  assert.match(result, /- class FixHelper src\/mod2\.ts:5:1/);
});

test("the limit clamps into [1, MAX_LSP_WORKSPACE_SYMBOLS] and cuts visibly", async () => {
  const many = Array.from({ length: MAX_LSP_WORKSPACE_SYMBOLS }, (_, index) =>
    wireSymbol(`match${index}`, index),
  );
  const manager = fakeManager(() => Promise.resolve(ok(many)));
  const result = await run(manager, { query: "match", limit: 2 });
  assert.match(result, /match0/);
  assert.match(result, /match1/);
  assert.ok(!result.includes("match2"), "matches past the limit are cut");
  assert.match(result, /first 2/);
});

test("no matches is a bounded success", async () => {
  const result = await run(
    fakeManager(() => Promise.resolve(ok([]))),
    { query: "zzz" },
  );
  assert.match(result, /no workspace symbols match "zzz"/);
});

test("a degraded server renders as bounded SUCCESS text (D-006)", async () => {
  const manager = fakeManager(() =>
    Promise.resolve(degraded("unavailable", "server is not installed")),
  );
  const result = await run(manager, { query: "fix" });
  assert.match(result, /unavailable/);
});
