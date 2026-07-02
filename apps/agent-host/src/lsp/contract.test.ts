import assert from "node:assert/strict";
import { TOOL_DESCRIPTORS, type ToolDescriptor } from "@trevor/session";
import { test } from "vitest";
import { MAX_LSP_DEGRADED_DETAIL_CHARS } from "./caps";
import {
  degraded,
  isLspDegraded,
  LSP_DEGRADED_REASONS,
  LSP_TOOL_DESCRIPTORS,
  LSP_TOOL_NAMES,
  type LspCodeActionProposal,
  type LspDiagnostic,
  type LspDocumentSymbol,
  type LspFileDiagnostics,
  type LspHover,
  type LspOutcome,
  type LspServerStatus,
  type LspWorkspaceSymbol,
  lspSeverityName,
  lspSymbolKindName,
  ok,
  rangeFromLsp,
} from "./contract";

/**
 * Plan 24 M1 tasks 1-4 + 7: the stable LSP result shapes, the typed degraded outcomes
 * (D-006), and the read-only declaration (D-007). Shape tests construct typed literals so a
 * breaking contract change fails to compile here before any tool (M3-M5) drifts.
 */

test("diagnostic results carry range, severity, source, and message", () => {
  const diagnostic: LspDiagnostic = {
    range: { start: { line: 3, column: 5 }, end: { line: 3, column: 12 } },
    severity: "error",
    source: "typescript",
    message: "Cannot find name 'foo'.",
    code: "2304",
  };
  const file: LspFileDiagnostics = {
    file: "src/main.ts",
    diagnostics: [diagnostic],
    truncated: false,
  };
  assert.equal(file.diagnostics[0]?.severity, "error");
  assert.equal(file.diagnostics[0]?.range.start.line, 3);
});

test("document symbols nest as an outline with named kinds", () => {
  const symbol: LspDocumentSymbol = {
    name: "Manager",
    kind: "class",
    range: { start: { line: 1, column: 1 }, end: { line: 40, column: 2 } },
    children: [
      {
        name: "acquire",
        kind: "method",
        range: { start: { line: 5, column: 3 }, end: { line: 12, column: 4 } },
        children: [],
      },
    ],
  };
  assert.equal(symbol.children[0]?.name, "acquire");
  assert.equal(symbol.children[0]?.kind, "method");
});

test("workspace symbols carry locations; hover and proposals are bounded text shapes", () => {
  const workspaceSymbol: LspWorkspaceSymbol = {
    name: "createLspManager",
    kind: "function",
    containerName: "manager",
    location: {
      file: "src/lsp/manager.ts",
      range: { start: { line: 10, column: 1 }, end: { line: 10, column: 24 } },
    },
  };
  const hover: LspHover = { text: "```ts\nconst x: number\n```", truncated: false };
  // D-005: a code action is a PROPOSAL - title/kind/range plus edits as reviewable text only.
  const proposal: LspCodeActionProposal = {
    title: "Add missing import",
    kind: "quickfix",
    range: { start: { line: 2, column: 1 }, end: { line: 2, column: 10 } },
    editPreview: "src/main.ts 1:1-1:1 -> \"import { x } from './x';\"",
    isPreferred: true,
  };
  assert.equal(workspaceSymbol.location.file, "src/lsp/manager.ts");
  assert.equal(hover.truncated, false);
  assert.equal(typeof proposal.editPreview, "string");
});

test("a status snapshot names the lifecycle state vocabulary", () => {
  const status: LspServerStatus = {
    workspaceRoot: "/w",
    server: "typescript-language-server",
    status: "ready",
    lastRequestMethod: "textDocument/hover",
    lastRequestAt: 1_000,
    restarts: 0,
  };
  assert.equal(status.status, "ready");
  const degradedStatus: LspServerStatus = {
    workspaceRoot: "/w",
    status: "stale",
    staleAgeMs: 600_000,
    lastError: "no response in 10 minutes",
    restarts: 1,
  };
  assert.equal(degradedStatus.status, "stale");
});

test("every degraded reason constructs a plain result variant, never a throw (D-006)", () => {
  assert.deepEqual(LSP_DEGRADED_REASONS, [
    "unavailable",
    "unsupported",
    "timeout",
    "stale",
    "server_error",
  ]);
  for (const reason of LSP_DEGRADED_REASONS) {
    const outcome = degraded(reason, `the server said: ${reason}`);
    assert.equal(outcome.kind, "degraded");
    assert.equal(outcome.reason, reason);
    assert.ok(isLspDegraded(outcome));
  }
});

test("degraded details are bounded one-liners even for pathological input", () => {
  const outcome = degraded("server_error", `boom\n${"x".repeat(100_000)}`);
  assert.ok(outcome.detail.length <= MAX_LSP_DEGRADED_DETAIL_CHARS + 1);
  assert.ok(!outcome.detail.includes("\n"), "degraded detail must collapse to one line");
});

test("ok wraps a value and is distinguishable from degraded", () => {
  const outcome: LspOutcome<string> = ok("value");
  assert.equal(outcome.kind, "ok");
  assert.ok(!isLspDegraded(outcome));
  if (outcome.kind === "ok") {
    assert.equal(outcome.value, "value");
  }
});

test("rangeFromLsp converts 0-based wire positions to the 1-based contract", () => {
  assert.deepEqual(
    rangeFromLsp({ start: { line: 0, character: 0 }, end: { line: 2, character: 7 } }),
    {
      start: { line: 1, column: 1 },
      end: { line: 3, column: 8 },
    },
  );
});

test("rangeFromLsp degrades garbage to the 1:1 fallback instead of throwing", () => {
  for (const raw of [undefined, null, "nope", 42, { start: "x" }, { start: { line: -5 } }]) {
    const range = rangeFromLsp(raw);
    assert.ok(range.start.line >= 1 && range.start.column >= 1);
    assert.ok(range.end.line >= 1 && range.end.column >= 1);
  }
});

test("severity numbers decode to the named severities, unknown degrades to info", () => {
  assert.equal(lspSeverityName(1), "error");
  assert.equal(lspSeverityName(2), "warning");
  assert.equal(lspSeverityName(3), "info");
  assert.equal(lspSeverityName(4), "hint");
  for (const raw of [0, 5, undefined, null, "boom"]) {
    assert.equal(lspSeverityName(raw), "info");
  }
});

test("symbol kind numbers decode to readable names, unknown degrades to symbol", () => {
  assert.equal(lspSymbolKindName(5), "class");
  assert.equal(lspSymbolKindName(6), "method");
  assert.equal(lspSymbolKindName(12), "function");
  assert.equal(lspSymbolKindName(11), "interface");
  assert.equal(lspSymbolKindName(26), "type parameter");
  for (const raw of [0, 27, undefined, "x"]) {
    assert.equal(lspSymbolKindName(raw), "symbol");
  }
});

/**
 * D-007 read-only declaration (plan task 7/8). The packages/session TOOL_DESCRIPTORS parity
 * test pins that table 1:1 against the host's REAL tool defs, and the LSP tools only exist
 * from M3-M5 - so the six names join TOOL_DESCRIPTORS with each tool def, and THIS contract
 * pins their read-only nature now: every declared LSP tool is read-only, and the forward
 * guard fails if an M3-M5 registration ever lands one as a mutating barrier.
 */

test("the six LSP tools are declared, each read-only (D-007)", () => {
  assert.deepEqual(LSP_TOOL_NAMES, [
    "lsp_status",
    "lsp_diagnostics",
    "lsp_hover",
    "lsp_document_symbols",
    "lsp_workspace_symbols",
    "lsp_code_actions",
  ]);
  assert.equal(LSP_TOOL_DESCRIPTORS.length, 6);
  for (const descriptor of LSP_TOOL_DESCRIPTORS) {
    assert.equal(descriptor.readOnly, true, `${descriptor.name} must be read-only`);
  }
});

test("forward guard: any LSP tool registered in the shared table must be read-only", () => {
  // Widened: the literal-union table does not carry LSP names until M3-M5 register them.
  const table: readonly ToolDescriptor[] = TOOL_DESCRIPTORS;
  for (const name of LSP_TOOL_NAMES) {
    const registered = table.find((tool) => tool.name === name);
    if (registered) {
      assert.equal(registered.readOnly, true, `${name} must register as readOnly: true (D-007)`);
    }
  }
});
