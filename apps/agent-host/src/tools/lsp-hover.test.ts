import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_LSP_HOVER_CHARS } from "@host/lsp/caps";
import type { LspClient } from "@host/lsp/client";
import { degraded, type LspOutcome, type LspServerStatus, ok } from "@host/lsp/contract";
import type { LspAcquireOutcome, LspManager } from "@host/lsp/manager";
import { READ_ONLY_TOOL_NAMES, TOOL_DESCRIPTORS } from "@trevor/session";
import { Effect } from "effect";
import { afterAll, test } from "vitest";
import { buildLspHoverTool, type LspHoverArgs } from "./lsp-hover";

/**
 * The lsp_hover tool (plan 24 M4 tasks 1-2), unit-tested against fake manager/client seams -
 * no child processes. Pins the 1-based -> wire position encoding, the markdown/plaintext
 * content shapes, the MAX_LSP_HOVER_CHARS cap, the disk re-sync on every call (stale-document
 * handling), and the D-006 degraded outcomes as bounded SUCCESS text. Live fixture-server
 * behavior lives in test/lsp/tools-hover-symbols.test.ts.
 */

const root = mkdtempSync(join(tmpdir(), "trevor-lsp-hover-unit-"));
writeFileSync(join(root, "code.ts"), "export const widget = 1;\n");
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fakeClient(overrides: Partial<LspClient> = {}): LspClient {
  return {
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
    ...overrides,
  };
}

function fakeManager(options: {
  readonly acquire?: LspAcquireOutcome;
  readonly request?: (method: string, params?: unknown) => Promise<LspOutcome<unknown>>;
}): LspManager {
  const snapshot: LspServerStatus = { workspaceRoot: root, status: "ready", restarts: 0 };
  return {
    acquire: () =>
      Promise.resolve(
        options.acquire ?? { kind: "ready", client: fakeClient(), server: "fake-ls" },
      ),
    request: options.request ?? (() => Promise.resolve(ok(null))),
    status: () => snapshot,
    statusSnapshot: () => [snapshot],
    close: () => Promise.resolve(),
  };
}

const run = (manager: LspManager, args: LspHoverArgs): Promise<string> =>
  Effect.runPromise(buildLspHoverTool(manager).execute(args));

test("lsp_hover is read-only (D-007) and registered read-only in the shared table", () => {
  const tool = buildLspHoverTool(fakeManager({}));
  assert.equal(tool.name, "lsp_hover");
  assert.equal(tool.readOnly, true);
  assert.ok(READ_ONLY_TOOL_NAMES.has("lsp_hover"));
  assert.equal(TOOL_DESCRIPTORS.find((entry) => entry.name === "lsp_hover")?.readOnly, true);
});

test("sends the 1-based position as a 0-based wire position and renders markdown", async () => {
  const requests: { method: string; params: unknown }[] = [];
  const manager = fakeManager({
    request: (method, params) => {
      requests.push({ method, params });
      return Promise.resolve(
        ok({
          contents: { kind: "markdown", value: "```ts\nconst widget: number\n```" },
          range: { start: { line: 4, character: 7 }, end: { line: 4, character: 13 } },
        }),
      );
    },
  });
  const result = await run(manager, { file: "code.ts", line: 5, column: 8 });
  assert.deepEqual(requests, [
    {
      method: "textDocument/hover",
      params: {
        textDocument: { uri: `file://${join(root, "code.ts")}` },
        position: { line: 4, character: 7 },
      },
    },
  ]);
  assert.match(result, /code\.ts:5:8/);
  assert.match(result, /const widget: number/);
});

test("re-syncs the document from disk on every call (stale-document handling)", async () => {
  const opened: { uri: string; text: string }[] = [];
  const manager = fakeManager({
    acquire: {
      kind: "ready",
      server: "fake-ls",
      client: fakeClient({
        openDocument: (uri, _languageId, text) => {
          opened.push({ uri, text });
        },
      }),
    },
  });
  await run(manager, { file: "code.ts", line: 1, column: 1 });
  await run(manager, { file: "code.ts", line: 1, column: 1 });
  assert.equal(opened.length, 2, "each hover re-syncs the current disk content");
});

test("MarkedString and MarkedString[] content shapes render", async () => {
  const asArray = fakeManager({
    request: () =>
      Promise.resolve(ok({ contents: ["first part", { language: "ts", value: "const x = 1" }] })),
  });
  const result = await run(asArray, { file: "code.ts", line: 1, column: 1 });
  assert.match(result, /first part/);
  assert.match(result, /const x = 1/);
});

test("hover text is capped at MAX_LSP_HOVER_CHARS with a truncation marker", async () => {
  const manager = fakeManager({
    request: () =>
      Promise.resolve(
        ok({ contents: { kind: "markdown", value: "y".repeat(MAX_LSP_HOVER_CHARS + 500) } }),
      ),
  });
  const result = await run(manager, { file: "code.ts", line: 1, column: 1 });
  assert.ok(result.length < MAX_LSP_HOVER_CHARS + 200, "the hover body stays bounded");
  assert.match(result, /truncated/);
});

test("no hover at the position is a bounded success", async () => {
  const manager = fakeManager({ request: () => Promise.resolve(ok(null)) });
  const result = await run(manager, { file: "code.ts", line: 2, column: 3 });
  assert.match(result, /no hover information at code\.ts:2:3/);
});

test("a missing file degrades to bounded text, never a thrown failure", async () => {
  const result = await run(fakeManager({}), { file: "gone.ts", line: 1, column: 1 });
  assert.match(result, /file not found/i);
});

test("a degraded server renders as bounded SUCCESS text (D-006)", async () => {
  const manager = fakeManager({
    acquire: degraded("unavailable", "typescript-language-server is not installed"),
  });
  const result = await run(manager, { file: "code.ts", line: 1, column: 1 });
  assert.match(result, /unavailable/);
});

test("a degraded request (timeout) renders as bounded SUCCESS text", async () => {
  const manager = fakeManager({
    request: () => Promise.resolve(degraded("timeout", "hover timed out after 300ms")),
  });
  const result = await run(manager, { file: "code.ts", line: 1, column: 1 });
  assert.match(result, /timed out/);
});
