import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_LSP_DIAGNOSTICS } from "@host/lsp/caps";
import type { LspClient } from "@host/lsp/client";
import { degraded, type LspDiagnostic, type LspServerStatus, ok } from "@host/lsp/contract";
import type { LspAcquireOutcome, LspManager } from "@host/lsp/manager";
import { READ_ONLY_TOOL_NAMES, TOOL_DESCRIPTORS } from "@trevor/session";
import { Effect } from "effect";
import { afterAll, test } from "vitest";
import { buildLspDiagnosticsTool, type LspDiagnosticsArgs } from "./lsp-diagnostics";

/**
 * The lsp_diagnostics pull tool (plan 24 M3 tasks 3-4), unit-tested against fake manager/client
 * seams - no child processes. Pins the D-003 pull shape (one file or a capped workspace
 * summary), severity filtering, the MAX_LSP_DIAGNOSTICS cap, and the D-006 degraded outcomes
 * as bounded SUCCESS text. Live fixture-server behavior lives in
 * test/lsp/tools-status-diagnostics.test.ts.
 */

const root = mkdtempSync(join(tmpdir(), "trevor-lsp-diag-unit-"));
writeFileSync(join(root, "open.ts"), "const oops = 1;\n");
afterAll(() => rmSync(root, { recursive: true, force: true }));

function diagnostic(overrides: Partial<LspDiagnostic> = {}): LspDiagnostic {
  return {
    range: { start: { line: 3, column: 5 }, end: { line: 3, column: 9 } },
    severity: "warning",
    source: "fixture",
    message: "something is off",
    ...overrides,
  };
}

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
  readonly status?: Partial<LspServerStatus>;
}): LspManager {
  const snapshot: LspServerStatus = {
    workspaceRoot: root,
    status: "ready",
    restarts: 0,
    ...options.status,
  };
  return {
    acquire: () =>
      Promise.resolve(
        options.acquire ?? { kind: "ready", client: fakeClient(), server: "fake-ls" },
      ),
    request: () => Promise.resolve(ok(null)),
    status: () => snapshot,
    statusSnapshot: () => [snapshot],
    close: () => Promise.resolve(),
  };
}

const run = (manager: LspManager, args: LspDiagnosticsArgs): Promise<string> =>
  Effect.runPromise(buildLspDiagnosticsTool(manager).execute(args));

test("lsp_diagnostics is read-only (D-007) and registered read-only in the shared table", () => {
  const tool = buildLspDiagnosticsTool(fakeManager({}));
  assert.equal(tool.name, "lsp_diagnostics");
  assert.equal(tool.readOnly, true);
  assert.ok(READ_ONLY_TOOL_NAMES.has("lsp_diagnostics"));
  const descriptor = TOOL_DESCRIPTORS.find((entry) => entry.name === "lsp_diagnostics");
  assert.equal(descriptor?.readOnly, true);
});

test("one file: opens the document and renders its published diagnostics with 1-based ranges", async () => {
  const opened: string[] = [];
  const manager = fakeManager({
    acquire: {
      kind: "ready",
      server: "fake-ls",
      client: fakeClient({
        openDocument: (uri) => {
          opened.push(uri);
        },
        waitForDiagnostics: () =>
          Promise.resolve([
            diagnostic({ message: "cannot find name 'x'", severity: "error", code: "2304" }),
          ]),
      }),
    },
  });
  const result = await run(manager, { file: "open.ts" });
  assert.deepEqual(opened, [pathToFileURL(join(root, "open.ts")).href]);
  assert.match(result, /1 diagnostic/);
  assert.match(result, /3:5-3:9 error \[fixture 2304\] cannot find name 'x'/);
});

test("a severity filter keeps only that severity", async () => {
  const manager = fakeManager({
    acquire: {
      kind: "ready",
      server: "fake-ls",
      client: fakeClient({
        waitForDiagnostics: () =>
          Promise.resolve([
            diagnostic({ severity: "error", message: "the error" }),
            diagnostic({ severity: "warning", message: "the warning" }),
          ]),
      }),
    },
  });
  const result = await run(manager, { file: "open.ts", severity: "error" });
  assert.match(result, /the error/);
  assert.ok(!result.includes("the warning"));
});

test("file results are capped at MAX_LSP_DIAGNOSTICS with a visible cut", async () => {
  const many = Array.from({ length: MAX_LSP_DIAGNOSTICS + 10 }, (_, index) =>
    diagnostic({ message: `problem ${index}` }),
  );
  const manager = fakeManager({
    acquire: {
      kind: "ready",
      server: "fake-ls",
      client: fakeClient({ waitForDiagnostics: () => Promise.resolve(many) }),
    },
  });
  const result = await run(manager, { file: "open.ts" });
  assert.match(result, new RegExp(`${MAX_LSP_DIAGNOSTICS + 10} diagnostic`));
  assert.match(result, new RegExp(`first ${MAX_LSP_DIAGNOSTICS}`));
  assert.ok(result.includes(`problem ${MAX_LSP_DIAGNOSTICS - 1}`));
  assert.ok(!result.includes(`problem ${MAX_LSP_DIAGNOSTICS + 9}`), "items past the cap are cut");
});

test("a server that publishes nothing within the window is a bounded success, not an error", async () => {
  const result = await run(fakeManager({}), { file: "open.ts" });
  assert.match(result, /no diagnostics published/i);
});

test("an empty publish renders as a clean no-problems result", async () => {
  const manager = fakeManager({
    acquire: {
      kind: "ready",
      server: "fake-ls",
      client: fakeClient({ waitForDiagnostics: () => Promise.resolve([]) }),
    },
  });
  const result = await run(manager, { file: "open.ts" });
  assert.match(result, /no diagnostics in open\.ts/);
});

test("a missing file degrades to bounded text (D-006), never a thrown turn failure", async () => {
  const result = await run(fakeManager({}), { file: "nope/missing.ts" });
  assert.match(result, /file not found/i);
  assert.match(result, /missing\.ts/);
});

test("a degraded acquire (missing server) renders as bounded SUCCESS text", async () => {
  const manager = fakeManager({
    acquire: degraded("unavailable", "typescript-language-server is not installed"),
  });
  const result = await run(manager, { file: "open.ts" });
  assert.match(result, /unavailable/);
  assert.match(result, /not installed/);
});

test("workspace summary: per-file counts plus top diagnostics, capped", async () => {
  const manager = fakeManager({
    acquire: {
      kind: "ready",
      server: "fake-ls",
      client: fakeClient({
        diagnosticsSnapshot: () => [
          {
            uri: pathToFileURL(join(root, "clean.ts")).href,
            diagnostics: [],
          },
          {
            uri: pathToFileURL(join(root, "busy.ts")).href,
            diagnostics: [
              diagnostic({ severity: "error", message: "broken" }),
              diagnostic({ severity: "warning", message: "iffy" }),
            ],
          },
        ],
      }),
    },
  });
  const result = await run(manager, {});
  assert.match(result, /1 file/);
  assert.match(result, /busy\.ts/);
  assert.ok(!result.includes("clean.ts"), "files with no diagnostics stay out of the summary");
  assert.match(result, /1 error, 1 warning/);
  assert.match(result, /broken/);
});

test("workspace summary respects the severity filter", async () => {
  const manager = fakeManager({
    acquire: {
      kind: "ready",
      server: "fake-ls",
      client: fakeClient({
        diagnosticsSnapshot: () => [
          {
            uri: pathToFileURL(join(root, "busy.ts")).href,
            diagnostics: [diagnostic({ severity: "warning", message: "iffy" })],
          },
        ],
      }),
    },
  });
  const result = await run(manager, { severity: "error" });
  assert.match(result, /no .*diagnostics/i);
  assert.ok(!result.includes("iffy"));
});

test("workspace summary with an idle server explains itself without spawning", async () => {
  let acquired = 0;
  const idle: LspManager = {
    ...fakeManager({ status: { status: "configured" } }),
    acquire: () => {
      acquired += 1;
      return Promise.resolve(degraded("unavailable", "should not spawn"));
    },
  };
  const result = await run(idle, {});
  assert.equal(acquired, 0, "a summary over an idle server must not spawn it");
  assert.match(result, /configured/);
  assert.match(result, /pass file/i);
});
