import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READ_ONLY_TOOL_NAMES, TOOL_DESCRIPTORS } from "@belay/session";
import { MAX_LSP_DOCUMENT_SYMBOLS } from "@host/lsp/caps";
import type { LspClient } from "@host/lsp/client";
import { degraded, type LspOutcome, type LspServerStatus, ok } from "@host/lsp/contract";
import type { LspManager } from "@host/lsp/manager";
import { Effect } from "effect";
import { afterAll, test } from "vitest";
import { buildLspDocumentSymbolsTool, type LspDocumentSymbolsArgs } from "./lsp-document-symbols";

/**
 * The lsp_document_symbols tool (plan 24 M4 tasks 3-4), unit-tested against a fake manager -
 * no child processes. Pins the nested outline rendering (kinds, 1-based ranges, indentation),
 * the flat SymbolInformation fallback, the MAX_LSP_DOCUMENT_SYMBOLS cap counted across nesting,
 * and the D-006 degraded outcomes as bounded SUCCESS text. Live fixture-server behavior lives
 * in test/lsp/tools-hover-symbols.test.ts.
 */

const root = mkdtempSync(join(tmpdir(), "belay-lsp-docsym-unit-"));
writeFileSync(join(root, "outline.ts"), "export class Widget {}\n");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const fakeClient: LspClient = {
  initialize: () => Promise.resolve({ capabilities: {} }),
  request: () => Promise.resolve(null),
  notify: () => {},
  openDocument: () => {},
  closeDocument: () => {},
  diagnosticsFor: () => undefined,
  waitForDiagnostics: () => Promise.resolve(undefined),
  diagnosticsSnapshot: () => [],
  capabilities: () => ({
    hoverProvider: true,
    documentSymbolProvider: true,
    workspaceSymbolProvider: true,
    codeActionProvider: true,
  }),
  shutdown: () => Promise.resolve(),
  state: () => ({ alive: true, initialized: true, stderrTail: "" }),
};

function fakeManager(request: () => Promise<LspOutcome<unknown>>): LspManager {
  const snapshot: LspServerStatus = { workspaceRoot: root, status: "ready", restarts: 0 };
  return {
    acquire: () => Promise.resolve({ kind: "ready", client: fakeClient, server: "fake-ls" }),
    request,
    status: () => snapshot,
    statusSnapshot: () => [snapshot],
    close: () => Promise.resolve(),
  };
}

const wireRange = (line: number) => ({
  start: { line, character: 0 },
  end: { line: line + 1, character: 1 },
});

const run = (manager: LspManager, args: LspDocumentSymbolsArgs): Promise<string> =>
  Effect.runPromise(buildLspDocumentSymbolsTool(manager).execute(args));

test("lsp_document_symbols is read-only (D-007) and registered in the shared table", () => {
  const tool = buildLspDocumentSymbolsTool(fakeManager(() => Promise.resolve(ok([]))));
  assert.equal(tool.name, "lsp_document_symbols");
  assert.equal(tool.readOnly, true);
  assert.ok(READ_ONLY_TOOL_NAMES.has("lsp_document_symbols"));
  assert.equal(
    TOOL_DESCRIPTORS.find((entry) => entry.name === "lsp_document_symbols")?.readOnly,
    true,
  );
});

test("renders a nested outline with kind names, 1-based ranges, and indentation", async () => {
  const manager = fakeManager(() =>
    Promise.resolve(
      ok([
        {
          name: "Widget",
          kind: 5,
          detail: "class Widget",
          range: { start: { line: 0, character: 0 }, end: { line: 9, character: 1 } },
          children: [
            {
              name: "render",
              kind: 6,
              range: { start: { line: 1, character: 2 }, end: { line: 3, character: 3 } },
              children: [],
            },
          ],
        },
      ]),
    ),
  );
  const result = await run(manager, { file: "outline.ts" });
  assert.match(result, /outline\.ts/);
  assert.match(result, /^class Widget 1:1-10:2 - class Widget$/m);
  assert.match(result, /^ {2}method render 2:3-4:4$/m);
});

test("flat SymbolInformation results render as a flat outline", async () => {
  const manager = fakeManager(() =>
    Promise.resolve(
      ok([{ name: "flatFn", kind: 12, location: { uri: "file:///x.ts", range: wireRange(4) } }]),
    ),
  );
  const result = await run(manager, { file: "outline.ts" });
  assert.match(result, /^function flatFn 5:1-6:2$/m);
});

test("the outline caps at MAX_LSP_DOCUMENT_SYMBOLS across nesting levels", async () => {
  const children = Array.from({ length: MAX_LSP_DOCUMENT_SYMBOLS + 5 }, (_, index) => ({
    name: `member${index}`,
    kind: 7,
    range: wireRange(index + 1),
    children: [],
  }));
  const manager = fakeManager(() =>
    Promise.resolve(ok([{ name: "Big", kind: 5, range: wireRange(0), children }])),
  );
  const result = await run(manager, { file: "outline.ts" });
  assert.match(result, new RegExp(`capped at ${MAX_LSP_DOCUMENT_SYMBOLS}`));
  // The root plus the first MAX-1 children render; the rest are cut.
  assert.ok(result.includes(`member${MAX_LSP_DOCUMENT_SYMBOLS - 2}`));
  assert.ok(!result.includes(`member${MAX_LSP_DOCUMENT_SYMBOLS + 4}`));
});

test("no symbols is a bounded success", async () => {
  const result = await run(
    fakeManager(() => Promise.resolve(ok([]))),
    { file: "outline.ts" },
  );
  assert.match(result, /no symbols reported in outline\.ts/);
});

test("a missing file degrades to bounded text", async () => {
  const result = await run(
    fakeManager(() => Promise.resolve(ok([]))),
    { file: "gone.ts" },
  );
  assert.match(result, /file not found/i);
});

test("a degraded request renders as bounded SUCCESS text (D-006)", async () => {
  const manager = fakeManager(() => Promise.resolve(degraded("server_error", "boom")));
  const result = await run(manager, { file: "outline.ts" });
  assert.match(result, /language server error: boom/);
});
