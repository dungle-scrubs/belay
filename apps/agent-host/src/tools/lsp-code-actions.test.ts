import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_LSP_CODE_ACTIONS, MAX_LSP_PROPOSAL_TEXT_CHARS } from "@host/lsp/caps";
import type { LspClient } from "@host/lsp/client";
import { degraded, type LspOutcome, type LspServerStatus, ok } from "@host/lsp/contract";
import type { LspManager } from "@host/lsp/manager";
import { READ_ONLY_TOOL_NAMES, TOOL_DESCRIPTORS } from "@trevor/session";
import { Effect } from "effect";
import { afterAll, test } from "vitest";
import { buildLspCodeActionsTool, type LspCodeActionsArgs } from "./lsp-code-actions";

/**
 * The lsp_code_actions tool (plan 24 M5), unit-tested against a fake manager - no child
 * processes. Pins the D-005 proposal contract: title/kind/range metadata with edits serialized
 * as reviewable TEXT (never applied - the fs-proof test), command-only and edit-less actions
 * surfaced with a clear unsupported-mutating status, and caps on action count and preview
 * size. Live fixture-server behavior (including the before/after fs snapshot) lives in
 * test/lsp/tools-code-actions.test.ts.
 */

const root = mkdtempSync(join(tmpdir(), "trevor-lsp-actions-unit-"));
const target = join(root, "fixable.ts");
writeFileSync(target, "oops line\n");
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

function fakeManager(
  request: (method: string, params?: unknown) => Promise<LspOutcome<unknown>>,
): LspManager {
  const snapshot: LspServerStatus = { workspaceRoot: root, status: "ready", restarts: 0 };
  return {
    acquire: () => Promise.resolve({ kind: "ready", client: fakeClient, server: "fake-ls" }),
    request,
    status: () => snapshot,
    statusSnapshot: () => [snapshot],
    close: () => Promise.resolve(),
  };
}

const wireRange = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 4 },
};

const quickfix = {
  title: "Fix the oops",
  kind: "quickfix",
  isPreferred: true,
  edit: {
    changes: {
      [`file://${target}`]: [{ range: wireRange, newText: "okay" }],
    },
  },
};

const ARGS: LspCodeActionsArgs = { file: "fixable.ts", startLine: 1, endLine: 1 };

const run = (manager: LspManager, args: LspCodeActionsArgs): Promise<string> =>
  Effect.runPromise(buildLspCodeActionsTool(manager).execute(args));

test("lsp_code_actions is read-only (D-007) and registered in the shared table", () => {
  const tool = buildLspCodeActionsTool(fakeManager(() => Promise.resolve(ok([]))));
  assert.equal(tool.name, "lsp_code_actions");
  assert.equal(tool.readOnly, true);
  assert.ok(READ_ONLY_TOOL_NAMES.has("lsp_code_actions"));
  assert.equal(TOOL_DESCRIPTORS.find((entry) => entry.name === "lsp_code_actions")?.readOnly, true);
});

test("sends the 1-based range as a 0-based wire range with an empty diagnostics context", async () => {
  const requests: { method: string; params: unknown }[] = [];
  const manager = fakeManager((method, params) => {
    requests.push({ method, params });
    return Promise.resolve(ok([]));
  });
  await run(manager, {
    file: "fixable.ts",
    startLine: 2,
    startColumn: 3,
    endLine: 4,
    endColumn: 5,
  });
  assert.deepEqual(requests, [
    {
      method: "textDocument/codeAction",
      params: {
        textDocument: { uri: `file://${target}` },
        range: { start: { line: 1, character: 2 }, end: { line: 3, character: 4 } },
        context: { diagnostics: [] },
      },
    },
  ]);
});

test("renders edit-carrying actions as reviewable proposal text and NEVER mutates the file", async () => {
  const before = readFileSync(target, "utf8");
  const manager = fakeManager(() => Promise.resolve(ok([quickfix])));
  const result = await run(manager, ARGS);

  assert.match(result, /1 code action proposal/);
  assert.match(result, /proposals only/i);
  assert.match(result, /Fix the oops \[quickfix\] \(preferred\)/);
  assert.match(result, /fixable\.ts 1:1-1:5 -> "okay"/);
  assert.equal(readFileSync(target, "utf8"), before, "the workspace edit is never applied");
});

test("a command-only action gets a clear unsupported-mutating status (D-005)", async () => {
  const manager = fakeManager(() =>
    Promise.resolve(
      ok([
        {
          title: "Move to a new file",
          kind: "refactor.move",
          command: { title: "Move", command: "_typescript.applyRefactoring", arguments: [] },
        },
        // The bare Command shape (no kind, command is a string).
        { title: "Run fix-all", command: "eslint.applyAllFixes" },
      ]),
    ),
  );
  const result = await run(manager, ARGS);
  assert.match(result, /Move to a new file \[refactor\.move\]/);
  assert.match(result, /command-only.*not executed/i);
  assert.match(result, /Run fix-all/);
});

test("an edit-less action reads as proposal metadata only", async () => {
  const manager = fakeManager(() =>
    Promise.resolve(ok([{ title: "Organize imports", kind: "source.organizeImports" }])),
  );
  const result = await run(manager, ARGS);
  assert.match(result, /Organize imports \[source\.organizeImports\]/);
  assert.match(result, /no edit attached/i);
});

test("documentChanges edits and file operations serialize as labeled proposal lines", async () => {
  const manager = fakeManager(() =>
    Promise.resolve(
      ok([
        {
          title: "Restructure",
          kind: "refactor",
          edit: {
            documentChanges: [
              {
                textDocument: { uri: `file://${target}`, version: 2 },
                edits: [{ range: wireRange, newText: "renamed" }],
              },
              { kind: "create", uri: `file://${join(root, "new.ts")}` },
              {
                kind: "rename",
                oldUri: `file://${target}`,
                newUri: `file://${join(root, "moved.ts")}`,
              },
              { kind: "delete", uri: `file://${target}` },
            ],
          },
        },
      ]),
    ),
  );
  const result = await run(manager, ARGS);
  assert.match(result, /fixable\.ts 1:1-1:5 -> "renamed"/);
  assert.match(result, /create new\.ts/);
  assert.match(result, /rename fixable\.ts -> moved\.ts/);
  assert.match(result, /delete fixable\.ts/);
  assert.match(result, /not applied/i);
});

test("proposals cap at MAX_LSP_CODE_ACTIONS and previews at MAX_LSP_PROPOSAL_TEXT_CHARS", async () => {
  const many = Array.from({ length: MAX_LSP_CODE_ACTIONS + 5 }, (_, index) => ({
    title: `Action ${index}`,
    kind: "quickfix",
  }));
  const capped = await run(
    fakeManager(() => Promise.resolve(ok(many))),
    ARGS,
  );
  assert.match(capped, new RegExp(`first ${MAX_LSP_CODE_ACTIONS}`));
  assert.ok(capped.includes(`Action ${MAX_LSP_CODE_ACTIONS - 1}`));
  assert.ok(!capped.includes(`Action ${MAX_LSP_CODE_ACTIONS + 4}`));

  const huge = {
    title: "Huge edit",
    kind: "quickfix",
    edit: {
      changes: {
        [`file://${target}`]: [
          { range: wireRange, newText: "z".repeat(MAX_LSP_PROPOSAL_TEXT_CHARS * 2) },
        ],
      },
    },
  };
  const preview = await run(
    fakeManager(() => Promise.resolve(ok([huge]))),
    ARGS,
  );
  assert.ok(
    preview.length < MAX_LSP_PROPOSAL_TEXT_CHARS + 1_000,
    "the serialized preview stays bounded",
  );
});

test("no actions is a bounded success", async () => {
  const result = await run(
    fakeManager(() => Promise.resolve(ok([]))),
    ARGS,
  );
  assert.match(result, /no code actions/i);
});

test("missing file and degraded outcomes render as bounded SUCCESS text (D-006)", async () => {
  const missing = await run(
    fakeManager(() => Promise.resolve(ok([]))),
    { ...ARGS, file: "gone.ts" },
  );
  assert.match(missing, /file not found/i);

  const down = await run(
    fakeManager(() => Promise.resolve(degraded("unavailable", "not installed"))),
    ARGS,
  );
  assert.match(down, /unavailable/);
});
