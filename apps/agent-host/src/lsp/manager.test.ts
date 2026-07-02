import assert from "node:assert/strict";
import { test } from "vitest";
import type { LanguageServerAdapter } from "./adapter";
import { createLspManager } from "./manager";

/**
 * Plan 24 M2 tasks 1-2 + 7-8 (the pure paths): per-workspace-root lookup, adapter selection,
 * and the D-006 degraded outcomes that need NO child process - no matching adapter, missing
 * binary, and a closed manager. Every miss is a plain degraded result, never a throw.
 * The spawned lifecycle paths live in test/lsp/manager.test.ts against the fixture server.
 */

const ROOT = "/w/unit-workspace";

function adapter(overrides: Partial<LanguageServerAdapter> = {}): LanguageServerAdapter {
  return {
    id: "fake",
    displayName: "fake-language-server",
    detects: () => true,
    resolveCommand: () => ({ command: "/nonexistent/fake-lsp", args: ["--stdio"] }),
    ...overrides,
  };
}

test("no matching adapter degrades to unavailable and reports status missing", async () => {
  const manager = createLspManager({
    adapters: [adapter({ detects: () => false })],
    defaultWorkspaceRoot: ROOT,
  });
  const outcome = await manager.acquire();
  assert.equal(outcome.kind, "degraded");
  if (outcome.kind === "degraded") {
    assert.equal(outcome.reason, "unavailable");
    assert.match(outcome.detail, /no language.server adapter/i);
  }
  const status = manager.status();
  assert.equal(status.status, "missing");
  assert.equal(status.workspaceRoot, ROOT);
  assert.equal(status.server, undefined);
});

test("a missing binary degrades to unavailable (bounded result, not a throw)", async () => {
  const manager = createLspManager({
    adapters: [adapter({ resolveCommand: () => undefined })],
    defaultWorkspaceRoot: ROOT,
  });
  const outcome = await manager.acquire();
  assert.equal(outcome.kind, "degraded");
  if (outcome.kind === "degraded") {
    assert.equal(outcome.reason, "unavailable");
    assert.match(outcome.detail, /fake-language-server/);
    assert.match(outcome.detail, /not installed/i);
  }
  const status = manager.status();
  assert.equal(status.status, "unavailable");
  assert.equal(status.server, "fake-language-server");
});

test("an untouched workspace with a resolvable server reports configured without spawning", () => {
  let resolved = 0;
  const manager = createLspManager({
    adapters: [
      adapter({
        resolveCommand: () => {
          resolved += 1;
          return { command: "/nonexistent/fake-lsp", args: [] };
        },
      }),
    ],
    defaultWorkspaceRoot: ROOT,
  });
  assert.equal(manager.status().status, "configured");
  assert.ok(resolved >= 1, "status probes the binary without spawning it");
});

test("adapter selection takes the first adapter that detects the workspace", () => {
  const manager = createLspManager({
    adapters: [
      adapter({ id: "never", displayName: "never-matches", detects: () => false }),
      adapter({ id: "second", displayName: "second-language-server" }),
    ],
    defaultWorkspaceRoot: ROOT,
  });
  assert.equal(manager.status().server, "second-language-server");
});

test("the manager keys state per workspace root", () => {
  const manager = createLspManager({
    adapters: [adapter({ detects: (root) => root === "/w/match" })],
    defaultWorkspaceRoot: "/w/match",
  });
  assert.equal(manager.status("/w/match").status, "configured");
  assert.equal(manager.status("/w/other").status, "missing");
  const roots = manager.statusSnapshot().map((status) => status.workspaceRoot);
  assert.ok(roots.includes("/w/match") && roots.includes("/w/other"));
});

test("request degrades instead of throwing when no server is acquirable", async () => {
  const manager = createLspManager({
    adapters: [adapter({ detects: () => false })],
    defaultWorkspaceRoot: ROOT,
  });
  const outcome = await manager.request("textDocument/hover", {});
  assert.equal(outcome.kind, "degraded");
});

test("a closed manager degrades every acquire", async () => {
  const manager = createLspManager({ adapters: [adapter()], defaultWorkspaceRoot: ROOT });
  await manager.close();
  const outcome = await manager.acquire();
  assert.equal(outcome.kind, "degraded");
  if (outcome.kind === "degraded") {
    assert.equal(outcome.reason, "unavailable");
    assert.match(outcome.detail, /closed/i);
  }
});
