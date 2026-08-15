import assert from "node:assert/strict";
import { READ_ONLY_TOOL_NAMES, TOOL_DESCRIPTORS } from "@belay/session";
import type { LspServerStatus, LspServerStatusKind } from "@host/lsp/contract";
import type { LspManager } from "@host/lsp/manager";
import { Effect } from "effect";
import { test } from "vitest";
import { buildLspStatusTool } from "./lsp-status";

/**
 * The lsp_status tool (plan 24 M3 tasks 1-2), unit-tested against a fake manager seam - no
 * child processes. Pins the full D-008 status vocabulary, the bounded/scrubbed last-error
 * rendering, the restart count, and the D-007 read-only registration. Live fixture-server
 * behavior lives in test/lsp/tools-status-diagnostics.test.ts.
 */

function status(overrides: Partial<LspServerStatus> = {}): LspServerStatus {
  return { workspaceRoot: "/w/project", status: "ready", restarts: 0, ...overrides };
}

function fakeManager(statuses: readonly LspServerStatus[]): LspManager {
  return {
    acquire: () => Promise.reject(new Error("unexpected acquire")),
    request: () => Promise.reject(new Error("unexpected request")),
    status: () => statuses[0] ?? status(),
    statusSnapshot: () => statuses,
    close: () => Promise.resolve(),
  };
}

const run = (manager: LspManager): Promise<string> =>
  Effect.runPromise(buildLspStatusTool(manager).execute({}));

test("lsp_status is read-only (D-007) and registered read-only in the shared table", () => {
  const tool = buildLspStatusTool(fakeManager([]));
  assert.equal(tool.name, "lsp_status");
  assert.equal(tool.readOnly, true);
  assert.ok(READ_ONLY_TOOL_NAMES.has("lsp_status"));
  const descriptor = TOOL_DESCRIPTORS.find((entry) => entry.name === "lsp_status");
  assert.equal(descriptor?.readOnly, true);
});

test("the description stays short guidance, not LSP doctrine (M6 owns guidance)", () => {
  const tool = buildLspStatusTool(fakeManager([]));
  assert.ok(tool.description.length < 400);
});

test("renders workspace root, server name, status, and restart count", async () => {
  const result = await run(
    fakeManager([status({ server: "typescript-language-server", restarts: 2 })]),
  );
  assert.match(result, /\/w\/project/);
  assert.match(result, /typescript-language-server/);
  assert.match(result, /ready/);
  assert.match(result, /restarts 2/);
});

test("every D-008 status vocabulary word renders", async () => {
  const kinds: readonly LspServerStatusKind[] = [
    "configured",
    "missing",
    "unavailable",
    "initializing",
    "ready",
    "stale",
    "error",
    "timeout",
  ];
  const result = await run(
    fakeManager(kinds.map((kind, index) => status({ workspaceRoot: `/w/${index}`, status: kind }))),
  );
  for (const kind of kinds) {
    assert.ok(result.includes(kind), `status "${kind}" should render`);
  }
});

test("last request and stale age render when present", async () => {
  const result = await run(
    fakeManager([
      status({
        status: "stale",
        staleAgeMs: 61_000,
        lastRequestMethod: "textDocument/hover",
        lastRequestAt: Date.UTC(2026, 0, 2, 3, 4, 5),
      }),
    ]),
  );
  assert.match(result, /textDocument\/hover/);
  assert.match(result, /2026-01-02T03:04:05/);
  assert.match(result, /61s/);
});

test("the last error renders bounded and scrubbed onto one line", async () => {
  const noisy = `spawn failed\n${"x".repeat(2_000)}\nmore`;
  const result = await run(fakeManager([status({ status: "error", lastError: noisy })]));
  const errorLine = result.split("\n").find((line) => line.includes("last error"));
  assert.ok(errorLine, "the error line should render");
  assert.ok(errorLine.length < 400, "the error line must stay bounded");
  assert.ok(!result.includes("\nmore"), "newlines in the error are collapsed");
});

test("a manager with no touched roots still answers with a bounded report", async () => {
  const result = await run(fakeManager([]));
  assert.match(result, /0 LSP workspace/);
});
